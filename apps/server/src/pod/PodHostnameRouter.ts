import type { PodHostnameProxySettings } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../config.ts";
import * as ContainerDriver from "./ContainerDriver.ts";

export interface PodRoute {
  readonly hostname: string;
  /** `<container>:<port>` on the proxy's network. */
  readonly upstream: string;
}

/** Orch's own shape, `<pod>-<service>`, so both read alike in the routes directory. */
export const podServiceHostname = (stem: string, service: string, domain: string) =>
  `${stem}-${service}.${domain}`;

export const podRouteText = (routes: ReadonlyArray<PodRoute>) =>
  routes.map((route) => `${route.hostname} {\n\treverse_proxy ${route.upstream}\n}\n`).join("\n");

// The proxy imports `*.caddy`; the candidate and check names never end so.
const ROUTE_SUFFIX = ".caddy";
const CANDIDATE_SUFFIX = ".caddy.next";
const CHECK_SUFFIX = ".validate";
const PROXY_COMMAND_TIMEOUT_MS = 60_000;
/** Caddy's refusal of an `import` whose file is gone. */
const IMPORT_VANISHED = /File to import not found|no such file/i;

/**
 * Every route file the proxy loads, the candidate in place of the pod's own
 * current one, under the proxy's own global options. If this validates, the
 * real reload with the candidate in place does too, so a bad route never
 * reaches the proxy and never breaks the next reload of anyone else's routes.
 */
export const validationConfigText = (input: {
  readonly mountTarget: string;
  readonly others: ReadonlyArray<string>;
  readonly candidate: string;
}) =>
  [
    "{",
    "\tadmin off",
    "\tlocal_certs",
    "\tskip_install_trust",
    "}",
    ...[...input.others, input.candidate].map(
      (name) => `import ${JSON.stringify(`${input.mountTarget}/${name}`)}`,
    ),
    "",
  ].join("\n");

export type PodHostnamePreparation =
  | { readonly type: "ready"; readonly dnsAddress: string }
  | { readonly type: "unavailable"; readonly reason: string };

/**
 * The host's hostname proxy, which other tools (orch) share: the router only
 * ever writes, replaces or removes route files named for this environment's
 * pods, and reloads the proxy only with a configuration it has validated.
 * Every failure is returned as a reason; none fails a pod.
 */
export class PodHostnameRouter extends Context.Service<
  PodHostnameRouter,
  {
    /** The settings with `~/` in their host paths resolved to the home directory. */
    readonly resolve: (settings: PodHostnameProxySettings) => PodHostnameProxySettings;
    /** For a pod about to be built: the proxy DNS server's address, or why hostnames cannot work. */
    readonly prepare: (
      dockerHost: string,
      proxy: PodHostnameProxySettings,
    ) => Effect.Effect<PodHostnamePreparation>;
    /** Puts `<stem>.caddy` in place; null once the proxy serves it. */
    readonly install: (input: {
      readonly dockerHost: string;
      readonly proxy: PodHostnameProxySettings;
      readonly stem: string;
      /** The container the routes reach, which must be on the proxy's network. */
      readonly upstreamContainer: string;
      readonly routes: ReadonlyArray<PodRoute>;
    }) => Effect.Effect<string | null>;
    /** Takes `<stem>.caddy` away; null once the proxy no longer serves it. */
    readonly uninstall: (input: {
      readonly dockerHost: string;
      readonly proxy: PodHostnameProxySettings;
      readonly stem: string;
      /** The proxy may still serve it: an earlier removal's reload failed. */
      readonly routed: boolean;
    }) => Effect.Effect<string | null>;
    /** Removes the files of pods named `<prefix>…` whose stem `keep`, read under the lock, lacks. */
    readonly prune: (input: {
      readonly dockerHost: string;
      readonly proxy: PodHostnameProxySettings;
      readonly prefix: string;
      readonly keep: Effect.Effect<ReadonlySet<string>>;
    }) => Effect.Effect<void>;
    /**
     * This server's Tailscale Serve takes :443 of the tailnet address, where
     * the proxy serves the pods' hostnames to other devices.
     */
    readonly tailscaleServeOnProxyPort: boolean;
  }
>()("t3/pod/PodHostnameRouter") {}

const make = Effect.gen(function* () {
  const driver = yield* ContainerDriver.ContainerDriver;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const config = yield* ServerConfig;
  // One validate-and-reload at a time from this server; each sees the others' files.
  const lock = yield* Semaphore.make(1);

  const expand = (value: string) =>
    value === "~"
      ? homeDirectory
      : value.startsWith("~/")
        ? path.join(homeDirectory, value.slice(2))
        : value;

  const proxyExec = (
    dockerHost: string,
    proxy: PodHostnameProxySettings,
    command: ReadonlyArray<string>,
  ) =>
    driver
      .forHost(dockerHost)
      .exec(proxy.proxyContainer, { command, timeoutMs: PROXY_COMMAND_TIMEOUT_MS })
      .pipe(
        Effect.map((result) =>
          result.exitCode === 0
            ? null
            : result.outputTail.length > 0
              ? result.outputTail
              : result.timedOut
                ? "it timed out"
                : `exit ${result.exitCode}`,
        ),
        Effect.catch((error) => Effect.succeed(error.message)),
      );

  const reload = (dockerHost: string, proxy: PodHostnameProxySettings) =>
    proxyExec(dockerHost, proxy, [
      "caddy",
      "reload",
      "--config",
      proxy.caddyfile,
      "--adapter",
      "caddyfile",
    ]).pipe(
      Effect.map((failure) => (failure === null ? null : `reloading the proxy failed: ${failure}`)),
    );

  const sameDirectory = (left: string, right: string) =>
    Effect.gen(function* () {
      if (path.resolve(left) === path.resolve(right)) return true;
      const real = (value: string) =>
        fileSystem.realPath(value).pipe(Effect.orElseSucceed(() => path.resolve(value)));
      return (yield* real(left)) === (yield* real(right));
    });

  /** Where the proxy sees the routes directory, or why it cannot serve routes from it. */
  const probeProxy = (dockerHost: string, proxy: PodHostnameProxySettings) =>
    Effect.gen(function* () {
      const inspected = yield* driver
        .forHost(dockerHost)
        .inspect(proxy.proxyContainer)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (inspected === undefined)
        return { reason: `Docker could not inspect ${proxy.proxyContainer}` };
      if (inspected === null) return { reason: `no container is named ${proxy.proxyContainer}` };
      if (inspected.status !== "running")
        return { reason: `${proxy.proxyContainer} is not running` };
      if (inspected.networks[proxy.network] === undefined)
        return { reason: `${proxy.proxyContainer} is not on the ${proxy.network} network` };
      for (const mount of inspected.mounts)
        if (yield* sameDirectory(mount.source, proxy.routesDir))
          return { mountTarget: mount.destination.replace(/\/+$/, "") };
      return { reason: `${proxy.proxyContainer} does not mount ${proxy.routesDir}` };
    });

  const listRoutes = (proxy: PodHostnameProxySettings) =>
    fileSystem.readDirectory(proxy.routesDir).pipe(Effect.orElseSucceed(() => [] as Array<string>));

  const remove = (file: string) => fileSystem.remove(file, { force: true }).pipe(Effect.ignore);

  const prepare: PodHostnameRouter["Service"]["prepare"] = (dockerHost, proxy) =>
    Effect.gen(function* () {
      const unavailable = (reason: string) => ({ type: "unavailable" as const, reason });
      if (!(yield* fileSystem.exists(proxy.routesDir).pipe(Effect.orElseSucceed(() => false))))
        return unavailable(`the routes directory ${proxy.routesDir} does not exist`);
      const probed = yield* probeProxy(dockerHost, proxy);
      if ("reason" in probed) return unavailable(probed.reason);
      if (!(yield* fileSystem.exists(proxy.caRootPath).pipe(Effect.orElseSucceed(() => false))))
        return unavailable(`the proxy's CA root ${proxy.caRootPath} does not exist`);
      const dns = yield* driver
        .forHost(dockerHost)
        .inspect(proxy.dnsContainer)
        .pipe(Effect.orElseSucceed(() => null));
      const dnsAddress = dns?.status === "running" ? dns.networks[proxy.network] : undefined;
      if (dnsAddress === undefined || dnsAddress.length === 0)
        return unavailable(`${proxy.dnsContainer} is not running on the ${proxy.network} network`);
      return { type: "ready" as const, dnsAddress };
    });

  const install: PodHostnameRouter["Service"]["install"] = (input) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const { proxy, stem } = input;
        const routeName = `${stem}${ROUTE_SUFFIX}`;
        const file = path.join(proxy.routesDir, routeName);
        const text = podRouteText(input.routes);
        const probed = yield* probeProxy(input.dockerHost, proxy);
        if ("reason" in probed) return probed.reason;
        const upstream = yield* driver
          .forHost(input.dockerHost)
          .inspect(input.upstreamContainer)
          .pipe(Effect.orElseSucceed(() => null));
        if (upstream?.networks[proxy.network] === undefined)
          return `${input.upstreamContainer} is not on the ${proxy.network} network`;
        const previous = yield* fileSystem.readFileString(file).pipe(Effect.option);
        if (Option.isSome(previous) && previous.value === text) return null;
        const candidateName = `${stem}${CANDIDATE_SUFFIX}`;
        const candidate = path.join(proxy.routesDir, candidateName);
        const checkName = `${stem}${CHECK_SUFFIX}`;
        const check = path.join(proxy.routesDir, checkName);
        /** Null when the candidate validates beside the routes listed right now. */
        const validate = Effect.gen(function* () {
          const others = (yield* listRoutes(proxy))
            .filter((name) => name.endsWith(ROUTE_SUFFIX) && name !== routeName)
            .toSorted();
          const written = yield* fileSystem
            .writeFileString(
              check,
              validationConfigText({
                mountTarget: probed.mountTarget,
                others,
                candidate: candidateName,
              }),
            )
            .pipe(Effect.result);
          if (written._tag === "Failure") return `could not write to ${proxy.routesDir}`;
          const rejected = yield* proxyExec(input.dockerHost, proxy, [
            "caddy",
            "validate",
            "--config",
            `${probed.mountTarget}/${checkName}`,
            "--adapter",
            "caddyfile",
          ]).pipe(Effect.ensuring(remove(check)));
          return rejected === null ? null : `the proxy rejected the route: ${rejected}`;
        });
        if (
          (yield* fileSystem.writeFileString(candidate, text).pipe(Effect.result))._tag ===
          "Failure"
        ) {
          yield* remove(candidate);
          return `could not write to ${proxy.routesDir}`;
        }
        let rejected = yield* validate;
        // Another tool's route went away between the listing and the check.
        if (rejected !== null && IMPORT_VANISHED.test(rejected)) rejected = yield* validate;
        if (rejected !== null) {
          yield* remove(candidate);
          return rejected;
        }
        const placed = yield* fileSystem.rename(candidate, file).pipe(Effect.result);
        if (placed._tag === "Failure") {
          yield* remove(candidate);
          return `could not write ${file}`;
        }
        const failed = yield* reload(input.dockerHost, proxy);
        if (failed === null) return null;
        // Leaves the directory as the proxy still runs it, for everyone's next reload.
        yield* Option.match(previous, {
          onNone: () => remove(file),
          onSome: (content) =>
            fileSystem.writeFileString(candidate, content).pipe(
              Effect.andThen(fileSystem.rename(candidate, file)),
              Effect.catch(() => remove(candidate)),
            ),
        });
        return failed;
      }),
    );

  const uninstall: PodHostnameRouter["Service"]["uninstall"] = (input) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const { proxy, stem } = input;
        yield* remove(path.join(proxy.routesDir, `${stem}${CANDIDATE_SUFFIX}`));
        yield* remove(path.join(proxy.routesDir, `${stem}${CHECK_SUFFIX}`));
        const file = path.join(proxy.routesDir, `${stem}${ROUTE_SUFFIX}`);
        const exists = yield* fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false));
        if (!exists && !input.routed) return null;
        if (exists) {
          const removed = yield* fileSystem.remove(file).pipe(Effect.result);
          if (removed._tag === "Failure") return `could not remove ${file}`;
        }
        // A proxy that is down loads the directory as it now is when it comes back.
        const probed = yield* probeProxy(input.dockerHost, proxy);
        return "reason" in probed ? null : yield* reload(input.dockerHost, proxy);
      }),
    );

  const prune: PodHostnameRouter["Service"]["prune"] = (input) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        let removedRoute = false;
        const keep = yield* input.keep;
        for (const name of yield* listRoutes(input.proxy)) {
          if (!name.startsWith(input.prefix)) continue;
          const suffix = [CANDIDATE_SUFFIX, ROUTE_SUFFIX, CHECK_SUFFIX].find((end) =>
            name.endsWith(end),
          );
          if (suffix === undefined || keep.has(name.slice(0, -suffix.length))) continue;
          yield* remove(path.join(input.proxy.routesDir, name));
          if (suffix === ROUTE_SUFFIX) removedRoute = true;
        }
        if (!removedRoute) return;
        const probed = yield* probeProxy(input.dockerHost, input.proxy);
        const failed = "reason" in probed ? null : yield* reload(input.dockerHost, input.proxy);
        if (failed !== null)
          yield* Effect.logWarning("stale pod routes were removed but the proxy did not reload", {
            reason: failed,
          });
      }),
    );

  return PodHostnameRouter.of({
    resolve: (settings) => ({
      ...settings,
      routesDir: expand(settings.routesDir),
      caRootPath: expand(settings.caRootPath),
    }),
    prepare,
    install,
    uninstall,
    prune,
    tailscaleServeOnProxyPort: config.tailscaleServeEnabled && config.tailscaleServePort === 443,
  });
});

export const layer = Layer.effect(PodHostnameRouter, make);
