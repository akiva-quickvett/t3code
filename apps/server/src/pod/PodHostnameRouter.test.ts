// @effect-diagnostics-next-line nodeBuiltinImport:off -- The fake proxy reads the routes directory synchronously, mid-exec.
import * as NodeFs from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { PodHostnameProxySettings } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import * as ContainerDriver from "./ContainerDriver.ts";
import * as PodHostnameRouter from "./PodHostnameRouter.ts";
import {
  makeFakeContainerDriver,
  type FakeContainerDriver,
} from "./testkit/FakeContainerDriver.ts";

const DEFAULTS = Schema.decodeSync(PodHostnameProxySettings)({});
const STEM = "t3-envtest-pod-abc123";
const DIND = `${STEM}-dind`;
const ROUTES = [
  { hostname: `${STEM}-web.pods.internal`, upstream: `${STEM}-dind:3000` },
  { hostname: `${STEM}-api.pods.internal`, upstream: `${STEM}-dind:8000` },
];
const ORCH_ROUTE = "pod-ste1-feature.caddy";
const ORCH_TEXT =
  "pod-ste1-feature-web.pods.internal {\n\treverse_proxy pod-ste1-feature-dind:3000\n}\n";

/** Caddy and Docker are fakes; only the routes directory is real, a fresh temporary one. */
const setup = (options: { readonly serve?: { enabled: boolean; port: number } } = {}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const home = yield* fileSystem.makeTempDirectoryScoped();
    const routesDir = `${home}/routes`;
    yield* fileSystem.makeDirectory(routesDir);
    yield* fileSystem.writeFileString(`${routesDir}/${ORCH_ROUTE}`, ORCH_TEXT);
    yield* fileSystem.writeFileString(`${home}/root.crt`, "CA");
    const driver = makeFakeContainerDriver();
    driver.seedInspection("pods-proxy", {
      status: "running",
      networks: { pods: "172.21.0.4" },
      mounts: [{ source: routesDir, destination: "/routes" }],
    });
    driver.seedInspection(`${STEM}-dind`, {
      status: "running",
      networks: { "t3-pods": "172.20.0.2", pods: "172.21.0.9" },
      mounts: [],
    });
    driver.seedInspection("pods-dns-int", {
      status: "running",
      networks: { pods: "172.21.0.2" },
      mounts: [],
    });
    const context = yield* Layer.build(
      PodHostnameRouter.layer.pipe(
        Layer.provide(Layer.succeed(ContainerDriver.ContainerDriver, driver.driver)),
        Layer.provide(
          Layer.succeed(ServerConfig, {
            tailscaleServeEnabled: options.serve?.enabled ?? false,
            tailscaleServePort: options.serve?.port ?? 443,
          } as ServerConfig["Service"]),
        ),
        Layer.provide(Layer.succeed(HostProcess.HomeDirectory, home)),
      ),
    );
    const router = Context.get(context, PodHostnameRouter.PodHostnameRouter);
    const proxy = router.resolve({
      ...DEFAULTS,
      routesDir: "~/routes",
      caRootPath: "~/root.crt",
    });
    const files = () => NodeFs.readdirSync(routesDir).toSorted();
    const read = (name: string) => NodeFs.readFileSync(`${routesDir}/${name}`, "utf8");
    return { router, proxy, driver, routesDir, files, read };
  });

const proxyCommands = (driver: FakeContainerDriver) =>
  driver.calls
    .filter((call) => call.operation === "exec")
    .map((call) => call.command?.slice(0, 2).join(" "));

describe("PodHostnameRouter", () => {
  it.effect("resolves ~/ against the home directory and leaves other paths alone", () =>
    Effect.gen(function* () {
      const { proxy, routesDir } = yield* setup();
      expect(proxy.routesDir).toBe(routesDir);
      expect(proxy.caddyfile).toBe("/etc/caddy/Caddyfile");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("validates a candidate beside everyone else's routes, then places it and reloads", () =>
    Effect.gen(function* () {
      const { router, proxy, driver, files, read } = yield* setup();
      let checked = "";
      driver.execExitCode((call) => {
        if (call.command?.[1] === "validate") checked = read(`${STEM}.validate`);
        return 0;
      });
      const failure = yield* router.install({
        dockerHost: "",
        proxy,
        stem: STEM,
        upstreamContainer: DIND,
        routes: ROUTES,
      });
      expect(failure).toBeNull();
      expect(files()).toEqual([ORCH_ROUTE, `${STEM}.caddy`]);
      expect(read(`${STEM}.caddy`)).toBe(
        [
          `${STEM}-web.pods.internal {`,
          `\treverse_proxy ${STEM}-dind:3000`,
          "}",
          "",
          `${STEM}-api.pods.internal {`,
          `\treverse_proxy ${STEM}-dind:8000`,
          "}",
          "",
        ].join("\n"),
      );
      expect(checked).toContain(`import "/routes/${ORCH_ROUTE}"`);
      expect(checked).toContain(`import "/routes/${STEM}.caddy.next"`);
      expect(proxyCommands(driver)).toEqual(["caddy validate", "caddy reload"]);
      expect(driver.calls.find((call) => call.command?.[1] === "reload")?.command).toEqual([
        "caddy",
        "reload",
        "--config",
        "/etc/caddy/Caddyfile",
        "--adapter",
        "caddyfile",
      ]);
      expect(read(ORCH_ROUTE)).toBe(ORCH_TEXT);

      // The same route again only looks: no validate, no reload.
      driver.calls.length = 0;
      expect(
        yield* router.install({
          dockerHost: "",
          proxy,
          stem: STEM,
          upstreamContainer: DIND,
          routes: ROUTES,
        }),
      ).toBeNull();
      expect(proxyCommands(driver)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "leaves the previous route and never reloads when the proxy rejects the candidate",
    () =>
      Effect.gen(function* () {
        const { router, proxy, driver, files, read } = yield* setup();
        yield* router.install({
          dockerHost: "",
          proxy,
          stem: STEM,
          upstreamContainer: DIND,
          routes: ROUTES.slice(0, 1),
        });
        const previous = read(`${STEM}.caddy`);
        driver.calls.length = 0;
        driver.execExitCode((call) => (call.command?.[1] === "validate" ? 1 : 0));
        driver.execOutput(() => "Error: adapting config: unrecognized directive: reverse_prox");
        const failure = yield* router.install({
          dockerHost: "",
          proxy,
          stem: STEM,
          upstreamContainer: DIND,
          routes: ROUTES,
        });
        expect(failure).toBe(
          "the proxy rejected the route: Error: adapting config: unrecognized directive: reverse_prox",
        );
        expect(proxyCommands(driver)).toEqual(["caddy validate"]);
        expect(files()).toEqual([ORCH_ROUTE, `${STEM}.caddy`]);
        expect(read(`${STEM}.caddy`)).toBe(previous);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("puts the previous route back when the reload fails", () =>
    Effect.gen(function* () {
      const { router, proxy, driver, files } = yield* setup();
      driver.execExitCode((call) => (call.command?.[1] === "reload" ? 1 : 0));
      driver.execOutput(() => "connection refused");
      const failure = yield* router.install({
        dockerHost: "",
        proxy,
        stem: STEM,
        upstreamContainer: DIND,
        routes: ROUTES,
      });
      expect(failure).toBe("reloading the proxy failed: connection refused");
      expect(files()).toEqual([ORCH_ROUTE]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("says why it cannot route, and touches nothing, when the proxy is not usable", () =>
    Effect.gen(function* () {
      const { router, proxy, driver, files, routesDir } = yield* setup();
      const reasonWith = (inspection: ContainerDriver.ContainerInspection | null) => {
        driver.seedInspection("pods-proxy", inspection);
        return router.install({
          dockerHost: "",
          proxy,
          stem: STEM,
          upstreamContainer: DIND,
          routes: ROUTES,
        });
      };
      const running = { status: "running" as const, networks: { pods: "172.21.0.4" } };
      expect(yield* reasonWith(null)).toBe("no container is named pods-proxy");
      expect(yield* reasonWith({ ...running, status: "exited", mounts: [] })).toBe(
        "pods-proxy is not running",
      );
      expect(
        yield* reasonWith({ ...running, networks: { bridge: "172.17.0.2" }, mounts: [] }),
      ).toBe("pods-proxy is not on the pods network");
      expect(
        yield* reasonWith({
          ...running,
          mounts: [{ source: "/elsewhere", destination: "/routes" }],
        }),
      ).toBe(`pods-proxy does not mount ${routesDir}`);
      expect(files()).toEqual([ORCH_ROUTE]);
      expect(driver.calls.some((call) => call.operation === "exec")).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("removes only its own route and reloads; a pod without one asks nothing", () =>
    Effect.gen(function* () {
      const { router, proxy, driver, files } = yield* setup();
      expect(
        yield* router.uninstall({ dockerHost: "", proxy, stem: STEM, routed: false }),
      ).toBeNull();
      expect(driver.calls).toEqual([]);
      yield* router.install({
        dockerHost: "",
        proxy,
        stem: STEM,
        upstreamContainer: DIND,
        routes: ROUTES,
      });
      driver.calls.length = 0;
      expect(
        yield* router.uninstall({ dockerHost: "", proxy, stem: STEM, routed: true }),
      ).toBeNull();
      expect(files()).toEqual([ORCH_ROUTE]);
      expect(proxyCommands(driver)).toEqual(["caddy reload"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reloads again for a route whose earlier removal the proxy never applied", () =>
    Effect.gen(function* () {
      const { router, proxy, driver, files } = yield* setup();
      expect(
        yield* router.uninstall({ dockerHost: "", proxy, stem: STEM, routed: true }),
      ).toBeNull();
      expect(files()).toEqual([ORCH_ROUTE]);
      expect(proxyCommands(driver)).toEqual(["caddy reload"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("routes nothing to a daemon that is not on the proxy's network", () =>
    Effect.gen(function* () {
      const { router, proxy, driver, files } = yield* setup();
      driver.seedInspection(DIND, {
        status: "running",
        networks: { "t3-pods": "172.20.0.2" },
        mounts: [],
      });
      expect(
        yield* router.install({
          dockerHost: "",
          proxy,
          stem: STEM,
          upstreamContainer: DIND,
          routes: ROUTES,
        }),
      ).toBe(`${DIND} is not on the pods network`);
      expect(files()).toEqual([ORCH_ROUTE]);
      expect(driver.calls.some((call) => call.operation === "exec")).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("checks again once when another tool's route vanished mid-check", () =>
    Effect.gen(function* () {
      const { router, proxy, driver, files } = yield* setup();
      let validations = 0;
      driver.execExitCode((call) =>
        call.command?.[1] === "validate" && ++validations === 1 ? 1 : 0,
      );
      driver.execOutput(() =>
        validations === 1 ? `Error: File to import not found: /routes/${ORCH_ROUTE}` : "",
      );
      expect(
        yield* router.install({
          dockerHost: "",
          proxy,
          stem: STEM,
          upstreamContainer: DIND,
          routes: ROUTES,
        }),
      ).toBeNull();
      expect(proxyCommands(driver)).toEqual(["caddy validate", "caddy validate", "caddy reload"]);
      expect(files()).toEqual([ORCH_ROUTE, `${STEM}.caddy`]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("prunes this environment's stale files, never another's or orch's", () =>
    Effect.gen(function* () {
      const { router, proxy, driver, files, routesDir } = yield* setup();
      for (const name of [
        `${STEM}.caddy`,
        "t3-envtest-pod-gone.caddy",
        "t3-envtest-pod-gone.caddy.next",
        "t3-otherenv-pod-def456.caddy",
      ])
        NodeFs.writeFileSync(`${routesDir}/${name}`, "");
      yield* router.prune({
        dockerHost: "",
        proxy,
        prefix: "t3-envtest-",
        keep: Effect.succeed(new Set([STEM])),
      });
      expect(files()).toEqual([ORCH_ROUTE, `${STEM}.caddy`, "t3-otherenv-pod-def456.caddy"]);
      expect(proxyCommands(driver)).toEqual(["caddy reload"]);

      driver.calls.length = 0;
      yield* router.prune({
        dockerHost: "",
        proxy,
        prefix: "t3-envtest-",
        keep: Effect.succeed(new Set([STEM])),
      });
      expect(driver.calls.some((call) => call.operation === "exec")).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("never writes, renames or removes a file it does not own, whatever happens", () =>
    Effect.gen(function* () {
      const { router, proxy, driver, files, read, routesDir } = yield* setup();
      const foreign: Record<string, string> = {
        [ORCH_ROUTE]: ORCH_TEXT,
        "pod-chat-akiva-ste476.caddy": "pod-chat-akiva-ste476-web.pods.internal {\n}\n",
        "pod-old.caddy.tmp": "orch's own temp file",
        "t3-otherenv-pod-def456.caddy": "another T3 server's route",
        "notes.txt": "someone's notes",
      };
      for (const [name, text] of Object.entries(foreign))
        NodeFs.writeFileSync(`${routesDir}/${name}`, text);
      // Whatever the proxy would import mid-operation is only ever orch's files or a whole route.
      const imported: Array<ReadonlyArray<string>> = [];
      let validateExit = 0;
      let reloadExit = 0;
      driver.execExitCode((call) => {
        imported.push(files().filter((name) => name.endsWith(".caddy")));
        return call.command?.[1] === "validate" ? validateExit : reloadExit;
      });
      const install = (routes = ROUTES) =>
        router.install({ dockerHost: "", proxy, stem: STEM, upstreamContainer: DIND, routes });

      yield* install();
      validateExit = 1;
      yield* install(ROUTES.slice(0, 1));
      validateExit = 0;
      reloadExit = 1;
      yield* install(ROUTES.slice(0, 1));
      reloadExit = 0;
      yield* router.uninstall({ dockerHost: "", proxy, stem: STEM, routed: true });
      yield* install();
      yield* router.prune({
        dockerHost: "",
        proxy,
        prefix: "t3-envtest-",
        keep: Effect.succeed(new Set<string>()),
      });

      expect(files()).toEqual(Object.keys(foreign).toSorted());
      for (const [name, text] of Object.entries(foreign)) expect(read(name)).toBe(text);
      const allowed = new Set([...Object.keys(foreign), `${STEM}.caddy`]);
      expect(imported.flat().every((name) => allowed.has(name))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("puts back the route the proxy ran when reloading a changed one fails", () =>
    Effect.gen(function* () {
      const { router, proxy, driver, files, read } = yield* setup();
      yield* router.install({
        dockerHost: "",
        proxy,
        stem: STEM,
        upstreamContainer: DIND,
        routes: ROUTES.slice(0, 1),
      });
      const previous = read(`${STEM}.caddy`);
      driver.execExitCode((call) => (call.command?.[1] === "reload" ? 1 : 0));
      expect(
        yield* router.install({
          dockerHost: "",
          proxy,
          stem: STEM,
          upstreamContainer: DIND,
          routes: ROUTES,
        }),
      ).toMatch(/^reloading the proxy failed/);
      expect(read(`${STEM}.caddy`)).toBe(previous);
      expect(files()).toEqual([ORCH_ROUTE, `${STEM}.caddy`]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("prepares a pod with the DNS server's address, or says what is missing", () =>
    Effect.gen(function* () {
      const { router, proxy, driver } = yield* setup();
      expect(yield* router.prepare("", proxy)).toEqual({
        type: "ready",
        dnsAddress: "172.21.0.2",
      });
      driver.seedInspection("pods-dns-int", null);
      expect(yield* router.prepare("", proxy)).toEqual({
        type: "unavailable",
        reason: "pods-dns-int is not running on the pods network",
      });
      expect(
        yield* router.prepare("", { ...proxy, caRootPath: `${proxy.caRootPath}.missing` }),
      ).toEqual({
        type: "unavailable",
        reason: `the proxy's CA root ${proxy.caRootPath}.missing does not exist`,
      });
      expect(
        yield* router.prepare("", { ...proxy, routesDir: `${proxy.routesDir}-missing` }),
      ).toEqual({
        type: "unavailable",
        reason: `the routes directory ${proxy.routesDir}-missing does not exist`,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("knows when this server's Tailscale Serve takes the proxy's :443", () =>
    Effect.gen(function* () {
      expect(
        (yield* setup({ serve: { enabled: true, port: 443 } })).router.tailscaleServeOnProxyPort,
      ).toBe(true);
      expect(
        (yield* setup({ serve: { enabled: true, port: 8443 } })).router.tailscaleServeOnProxyPort,
      ).toBe(false);
      expect(
        (yield* setup({ serve: { enabled: false, port: 443 } })).router.tailscaleServeOnProxyPort,
      ).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
