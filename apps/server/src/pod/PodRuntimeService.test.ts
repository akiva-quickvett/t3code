import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_POD_RUNTIME_IMAGE,
  EnvironmentId,
  PodRuntimeId,
  ProjectId,
  type T3ProjectFile,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as DateTime from "effect/DateTime";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ContainerDriver from "./ContainerDriver.ts";
import * as PodHostnameRouter from "./PodHostnameRouter.ts";
import { podAgentImageTag } from "./PodAgentImage.ts";
import * as PodHostPorts from "./PodHostPorts.ts";
import * as PodPaths from "./PodPaths.ts";
import * as PodRuntimeService from "./PodRuntimeService.ts";
import * as PodRuntimeStore from "./PodRuntimeStore.ts";
import {
  makeFakeContainerDriver,
  type FakeContainerDriver,
} from "./testkit/FakeContainerDriver.ts";
import {
  type FakePodHostnameRouter,
  makeFakePodHostnameRouter,
} from "./testkit/FakePodHostnameRouter.ts";

const projectId = ProjectId.make("project-pods");
const worktreePath = "/work/pods/feature";
const ENVIRONMENT = "env-test";

/** Ports something else on the host listens on, as `address:port`. */
interface FakeHostNetwork {
  readonly busy: Set<string>;
  tailnetAddress: string | null;
  resolvConf: string;
}

const makeFakeHostNetwork = (): FakeHostNetwork => ({
  busy: new Set(),
  tailnetAddress: null,
  resolvConf: "",
});

const harness = (options: {
  readonly driver: FakeContainerDriver;
  readonly enabled?: boolean;
  readonly publishOnTailnet?: boolean;
  readonly dnsServers?: ReadonlyArray<string>;
  readonly dockerHost?: string;
  readonly projectFile?: T3ProjectFile | null;
  readonly network?: FakeHostNetwork;
  readonly router?: FakePodHostnameRouter;
  readonly projects?: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>;
  readonly defaultImage?: string;
  readonly filesRoot?: string;
  readonly homeDirectory?: string;
  readonly snoozeAction?: "stop" | "freeze";
}) => {
  const opened: Array<string> = [];
  const network = options.network ?? makeFakeHostNetwork();
  /** What the preview's server list probes for each pod, by owner. */
  const discovery = new Map<
    string,
    ReadonlyArray<string | { readonly url: string; readonly probeUrl: string }>
  >();
  const base = Layer.mergeAll(
    PodRuntimeStore.layer,
    Layer.succeed(ContainerDriver.ContainerDriver, options.driver.driver),
    ServerSettings.layerTest({
      podRuntime: {
        enabled: options.enabled ?? true,
        publishOnTailnet: options.publishOnTailnet ?? false,
        ...(options.dnsServers === undefined ? {} : { dnsServers: options.dnsServers }),
        ...(options.dockerHost === undefined ? {} : { dockerHost: options.dockerHost }),
        ...(options.defaultImage === undefined ? {} : { defaultImage: options.defaultImage }),
        ...(options.snoozeAction === undefined ? {} : { snoozeAction: options.snoozeAction }),
      },
    }),
    ...(options.homeDirectory === undefined
      ? []
      : [
          Layer.succeed(HostProcess.HomeDirectory, options.homeDirectory),
          // Not this process's own, which may point Claude at another config dir.
          Layer.succeed(HostProcess.Environment, {}),
        ]),
    Layer.succeed(
      PodPaths.PodPaths,
      options.filesRoot === undefined
        ? undefined
        : {
            t3Home: `${options.filesRoot}/home`,
            providerHomesDir: `${options.filesRoot}/home/userdata/providers`,
            filesRoot: options.filesRoot,
            toolsDir: `${options.filesRoot}/tools`,
          },
    ),
    Layer.mock(ProjectService.ProjectService)({
      getById: () => Effect.succeed(Option.some({ workspaceRoot: "/work/repo" } as never)),
      listShells: () => Effect.succeed((options.projects ?? []) as never),
    }),
    Layer.succeed(
      PodHostnameRouter.PodHostnameRouter,
      (options.router ?? makeFakePodHostnameRouter()).router,
    ),
    Layer.mock(T3ProjectFileLoader.T3ProjectFileLoader)({
      load: () =>
        Effect.succeed(
          options.projectFile === null
            ? Option.none()
            : Option.some(options.projectFile ?? { pod: { services: { web: 3000 } } }),
        ),
    }),
    Layer.mock(GitVcsDriver.GitVcsDriver)({
      execute: () =>
        Effect.succeed({ exitCode: 0, stdout: "/work/repo/.git\n", stderr: "" } as never),
    }),
    Layer.mock(TerminalManager.TerminalManager)({
      open: (input) => Effect.sync(() => opened.push(`${input.terminalId}:${input.cwd}`)) as never,
    }),
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make(ENVIRONMENT)),
    }),
    Layer.mock(PortScanner.PortDiscovery)({
      registerConfiguredUrls: ({ owner, urls }) =>
        Effect.sync(() => {
          if (urls.length === 0) discovery.delete(owner);
          else discovery.set(owner, urls);
        }),
    }),
    Layer.succeed(PodHostPorts.PodHostNetwork, {
      probePort: (address, port) =>
        Effect.sync(() => (network.busy.has(`${address}:${port}`) ? "in-use" : "free")),
      tailnetAddress: Effect.sync(() => network.tailnetAddress),
      resolvConf: Effect.sync(() => network.resolvConf),
    }),
  ).pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(NodeCrypto.layer),
  );
  return { base, opened, discovery };
};

const withPods = <A, E>(
  driver: FakeContainerDriver,
  body: (
    pods: PodRuntimeService.PodRuntimeService["Service"],
    settings: ServerSettings.ServerSettingsService["Service"],
  ) => Effect.Effect<A, E, never>,
  options: Omit<Parameters<typeof harness>[0], "driver"> = {},
) =>
  Effect.gen(function* () {
    const pods = yield* PodRuntimeService.PodRuntimeService;
    yield* pods.drain;
    return yield* body(pods, yield* ServerSettings.ServerSettingsService);
  }).pipe(
    Effect.provide(
      PodRuntimeService.layer.pipe(Layer.provideMerge(harness({ driver, ...options }).base)),
    ),
  );

const operations = (driver: FakeContainerDriver) =>
  driver.calls.map((call) =>
    call.operation === "exec"
      ? `exec ${call.target} ${call.command?.join(" ")}`
      : `${call.operation} ${call.target ?? ""}`.trim(),
  );

describe("PodRuntimeService", () => {
  it.effect("creates a pod after the intent commits and brings the stack up once", () => {
    const driver = makeFakeContainerDriver();
    return withPods(driver, (pods) =>
      Effect.gen(function* () {
        const created = yield* pods.create({ projectId, worktreePath });
        expect(created.state).toBe("creating");
        yield* pods.drain;
        const running = yield* pods.awaitSettled(created.id);
        expect(running.state).toBe("running");
        expect(running.containerIds).toHaveLength(2);
        expect(driver.containers().every((container) => container.spec?.init === true)).toBe(true);
        // The stack comes up from the agent container, as the user, once compose is found there.
        expect(operations(driver).filter((step) => step.includes("compose"))).toEqual([
          `exec t3-envtest-${created.id}-agent docker compose version`,
          `exec t3-envtest-${created.id}-agent docker compose up -d`,
        ]);
        // Asking again for the same worktree returns the same pod.
        expect((yield* pods.create({ projectId, worktreePath })).id).toBe(created.id);
        const [first, second] = yield* Effect.all(
          [
            pods.create({ projectId, worktreePath: "/work/pods/other" }),
            pods.create({ projectId, worktreePath: "/work/pods/other" }),
          ],
          { concurrency: "unbounded" },
        );
        expect(second.id).toBe(first.id);
      }),
    );
  });

  it.effect("builds T3's default agent image before the first agent container only", () => {
    const driver = makeFakeContainerDriver();
    return withPods(driver, (pods) =>
      Effect.gen(function* () {
        const { id } = yield* pods.create({ projectId, worktreePath });
        yield* pods.drain;
        const steps = operations(driver);
        const build = steps.indexOf(`image ${podAgentImageTag(DEFAULT_POD_RUNTIME_IMAGE)}`);
        expect(build).toBeGreaterThan(-1);
        expect(build).toBeLessThan(steps.indexOf(`createContainer t3-envtest-${id}-agent`));
        driver.calls.length = 0;
        yield* pods.stop(id);
        yield* pods.drain;
        yield* pods.start(id);
        yield* pods.drain;
        expect(operations(driver).filter((step) => step.startsWith("image"))).toEqual([]);
      }),
    );
  });

  it.effect("makes a recreated agent container from the default image of the time", () => {
    const driver = makeFakeContainerDriver();
    return withPods(
      driver,
      (pods, settings) =>
        Effect.gen(function* () {
          const { id } = yield* pods.create({ projectId, worktreePath });
          yield* pods.drain;
          yield* settings.updateSettings({
            podRuntime: { defaultImage: DEFAULT_POD_RUNTIME_IMAGE },
          });
          yield* pods.recreateAgentContainer(id);
          yield* pods.drain;
          expect((yield* pods.awaitSettled(id)).image).toBe(DEFAULT_POD_RUNTIME_IMAGE);
          const agent = driver.containers().find((container) => container.name.endsWith("-agent"));
          expect(agent?.spec?.image).toBe(podAgentImageTag(DEFAULT_POD_RUNTIME_IMAGE));
        }),
      { defaultImage: "docker:27-cli" },
    );
  });

  it.effect(
    "fails a start on Linux when Docker cannot say which engine it is, rather than guess",
    () => {
      const driver = makeFakeContainerDriver();
      driver.setEngineOperatingSystem(null);
      return withPods(driver, (pods) =>
        Effect.gen(function* () {
          const { id } = yield* pods.create({ projectId, worktreePath });
          yield* pods.drain;
          const failed = yield* pods.awaitSettled(id);
          expect(failed.state).toBe("start_failed");
          expect(failed.lastError?.message).toContain("docker info");
          expect(operations(driver).some((step) => step.startsWith("createContainer"))).toBe(false);
        }),
      ).pipe(Effect.provideService(HostProcess.Platform, "linux"));
    },
  );

  it.effect("leaves a configured agent image to Docker", () => {
    const driver = makeFakeContainerDriver();
    return withPods(
      driver,
      (pods) =>
        Effect.gen(function* () {
          yield* pods.create({ projectId, worktreePath });
          yield* pods.drain;
          expect(operations(driver).filter((step) => step.startsWith("image"))).toEqual([]);
        }),
      { defaultImage: "registry.example/agent:2" },
    );
  });

  it.effect("mounts the pod's own files dir read-only and removes it with the pod", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const filesRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pod-files-" });
      const driver = makeFakeContainerDriver();
      yield* withPods(
        driver,
        (pods) =>
          Effect.gen(function* () {
            const { id } = yield* pods.create({ projectId, worktreePath });
            yield* pods.drain;
            const filesDir = `${filesRoot}/${id}`;
            expect(yield* fileSystem.exists(filesDir)).toBe(true);
            const agent = driver
              .containers()
              .find((container) => container.name.endsWith("-agent"));
            expect(agent?.spec?.mounts).toContainEqual({
              type: "bind",
              source: filesDir,
              target: filesDir,
              readOnly: true,
            });
            yield* pods.remove({ podId: id });
            yield* pods.drain;
            expect(yield* fileSystem.exists(filesDir)).toBe(false);
          }),
        { filesRoot },
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "copies the default Claude layout's .claude.json into the agent's home on each start",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pod-home-" });
        const filesRoot = `${home}/.t3/caches/pods`;
        yield* fileSystem.writeFileString(`${home}/.claude.json`, '{"numStartups":1}');
        const driver = makeFakeContainerDriver();
        yield* withPods(
          driver,
          (pods) =>
            Effect.gen(function* () {
              const { id } = yield* pods.create({ projectId, worktreePath });
              yield* pods.drain;
              const snapshot = `${filesRoot}/${id}/home/.claude.json`;
              expect(yield* fileSystem.readFileString(snapshot)).toBe('{"numStartups":1}');
              const copies = () =>
                operations(driver).filter((step) => step.includes(`cp -n ${snapshot}`));
              expect(copies()).toEqual([
                `exec t3-envtest-${id}-agent cp -n ${snapshot} ${home}/.claude.json`,
              ]);
              // A later start takes the host's file as it is then.
              yield* fileSystem.writeFileString(`${home}/.claude.json`, '{"numStartups":2}');
              driver.calls.length = 0;
              yield* pods.stop(id);
              yield* pods.drain;
              yield* pods.start(id);
              yield* pods.drain;
              expect(copies()).toHaveLength(1);
              expect(yield* fileSystem.readFileString(snapshot)).toBe('{"numStartups":2}');
            }),
          { filesRoot, homeDirectory: home },
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("removes the pod's files dir when Remove anyway forgets a pod Docker kept", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const filesRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pod-files-" });
      const driver = makeFakeContainerDriver();
      yield* withPods(
        driver,
        (pods) =>
          Effect.gen(function* () {
            const { id } = yield* pods.create({ projectId, worktreePath });
            yield* pods.drain;
            driver.failWhen((call) => call.operation === "removeContainer");
            yield* pods.remove({ podId: id, force: true });
            yield* pods.drain;
            expect((yield* pods.awaitSettled(id)).state).toBe("removed");
            expect(yield* fileSystem.exists(`${filesRoot}/${id}`)).toBe(false);
          }),
        { filesRoot },
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("records the listener probe for the current start only, and forgets it on stop", () => {
    const driver = makeFakeContainerDriver();
    return withPods(driver, (pods) =>
      Effect.gen(function* () {
        const { id } = yield* pods.create({ projectId, worktreePath });
        yield* pods.drain;
        const running = yield* pods.awaitSettled(id);
        yield* pods.noteMcpListener(id, "1999-01-01T00:00:00.000Z", "blocked");
        expect(yield* pods.awaitSettled(id)).not.toHaveProperty("mcpListener");
        yield* pods.noteMcpListener(id, running.startedAt, "blocked");
        expect((yield* pods.awaitSettled(id)).mcpListener).toBe("blocked");
        yield* pods.noteMcpListener(id, running.startedAt, "reachable");
        expect((yield* pods.awaitSettled(id)).mcpListener).toBe("reachable");
        yield* pods.stop(id);
        yield* pods.drain;
        expect(yield* pods.awaitSettled(id)).not.toHaveProperty("mcpListener");
      }),
    );
  });

  it.effect(
    "stops by stopping, never by removing, and starts without bringing the stack up again",
    () => {
      const driver = makeFakeContainerDriver();
      return withPods(driver, (pods) =>
        Effect.gen(function* () {
          const { id } = yield* pods.create({ projectId, worktreePath });
          yield* pods.drain;
          driver.calls.length = 0;
          expect((yield* pods.stop(id)).state).toBe("stopping");
          yield* pods.drain;
          expect((yield* pods.awaitSettled(id)).state).toBe("stopped");
          expect(operations(driver)).toEqual([
            "list t3.pod",
            "list t3.pod",
            // What a start must find again, recorded where the stack's data lives: the
            // compose services by name, never a one-off or --rm container the daemon may drop.
            expect.stringMatching(
              new RegExp(
                `^exec t3-envtest-${id}-dind sh -c rm -f .*docker ps -a --filter label=com.docker.compose.project --filter label=com.docker.compose.oneoff=False`,
              ),
            ),
            `exec t3-envtest-${id}-agent docker compose stop`,
            `stop t3-envtest-${id}-agent`,
            `stop t3-envtest-${id}-dind`,
          ]);
          expect(driver.containers()).toHaveLength(2);
          expect(driver.volumes()).toHaveLength(1);

          driver.calls.length = 0;
          yield* pods.start(id);
          yield* pods.drain;
          expect((yield* pods.awaitSettled(id)).state).toBe("running");
          const compose = operations(driver).filter((step) => step.includes("compose"));
          expect(compose).toEqual([`exec t3-envtest-${id}-agent docker compose start`]);
        }),
      );
    },
  );

  it.effect("records a failed creation and retries it as a creation", () => {
    const driver = makeFakeContainerDriver();
    driver.failWhen((call) => call.operation === "createContainer");
    return withPods(driver, (pods) =>
      Effect.gen(function* () {
        const { id } = yield* pods.create({ projectId, worktreePath });
        yield* pods.drain;
        const failed = yield* pods.awaitSettled(id);
        expect(failed).toMatchObject({
          state: "start_failed",
          lastError: {
            operation: "create",
            message: expect.stringContaining("fake createContainer refused"),
          },
        });
        const refused = yield* pods.ensureRunning(id).pipe(Effect.flip);
        expect(refused).toMatchObject({ reason: "invalid-state", state: "start_failed" });

        driver.failWhen(() => false);
        driver.calls.length = 0;
        yield* pods.start(id);
        yield* pods.drain;
        expect((yield* pods.awaitSettled(id)).state).toBe("running");
        expect(operations(driver)).toContain(`exec t3-envtest-${id}-agent docker compose up -d`);
      }),
    );
  });

  it.effect("removes the pod's own containers and volume, and keeps the record as removed", () => {
    const driver = makeFakeContainerDriver();
    return withPods(driver, (pods) =>
      Effect.gen(function* () {
        const { id } = yield* pods.create({ projectId, worktreePath });
        yield* pods.drain;
        yield* pods.remove({ podId: id });
        yield* pods.drain;
        expect((yield* pods.awaitSettled(id)).state).toBe("removed");
        expect(driver.containers()).toEqual([]);
        expect(driver.volumes()).toEqual([]);
        expect(yield* pods.forPath(worktreePath)).toBeUndefined();
        expect((yield* pods.status({})).pods).toEqual([]);
      }),
    );
  });

  it.effect("fails a creation at once when its daemon exits, with what the daemon printed", () => {
    const driver = makeFakeContainerDriver();
    driver.execExitCode((call) => {
      if (!call.target?.endsWith("-dind")) return 0;
      const dind = driver.containers().find((container) => container.name === call.target);
      if (dind !== undefined) driver.setStatus(dind.id, "exited");
      return 1;
    });
    driver.containerLogs(() =>
      [
        "starting dockerd",
        "failed to load listeners: listen tcp 127.0.0.1:2375: bind: address already in use",
      ].join("\n"),
    );
    return withPods(driver, (pods) =>
      Effect.gen(function* () {
        const { id } = yield* pods.create({ projectId, worktreePath });
        yield* pods.drain;
        expect(yield* pods.awaitSettled(id)).toMatchObject({
          state: "start_failed",
          lastError: {
            operation: "create",
            message:
              "Starting the pod's Docker daemon failed: it exited: starting dockerd | failed to load listeners: listen tcp 127.0.0.1:2375: bind: address already in use",
          },
        });
        // One readiness probe, not a minute of them.
        expect(operations(driver).filter((step) => step.endsWith("docker info"))).toHaveLength(1);
      }),
    );
  });

  it.effect("fails a creation whose daemon runs but never answers, once the probes give up", () => {
    const driver = makeFakeContainerDriver();
    let probed: Queue.Queue<void> | undefined;
    driver.execExitCode((call) => {
      if (!call.target?.endsWith("-dind")) return 0;
      if (probed !== undefined) Queue.offerUnsafe(probed, undefined);
      return 1;
    });
    return withPods(driver, (pods) =>
      Effect.gen(function* () {
        probed = yield* Queue.unbounded<void>();
        const { id } = yield* pods.create({ projectId, worktreePath });
        const settled = yield* Effect.forkChild(pods.awaitSettled(id));
        // Readiness probes are spaced a second apart: let each run, then move the clock on.
        for (let probe = 0; probe < 60; probe++) {
          yield* Queue.take(probed);
          yield* TestClock.adjust("1 second");
        }
        expect(yield* Fiber.join(settled)).toMatchObject({
          state: "start_failed",
          lastError: {
            operation: "create",
            message: "Waiting for the pod's Docker daemon failed (exit 1).",
          },
        });
      }),
    );
  });

  it.effect("ends a crashed operation in its failure state, so Retry and Remove still work", () => {
    const driver = makeFakeContainerDriver();
    driver.dieWhen((call) => call.operation === "createContainer");
    return withPods(driver, (pods) =>
      Effect.gen(function* () {
        const { id } = yield* pods.create({ projectId, worktreePath });
        yield* pods.drain;
        expect(yield* pods.awaitSettled(id)).toMatchObject({
          state: "start_failed",
          lastError: { operation: "create", message: expect.stringContaining("unexpectedly") },
        });
        driver.dieWhen((call) => call.operation === "removeVolume");
        yield* pods.remove({ podId: id });
        yield* pods.drain;
        expect(yield* pods.awaitSettled(id)).toMatchObject({
          state: "stop_failed",
          lastError: { operation: "remove" },
        });
        driver.dieWhen(() => false);
        yield* pods.remove({ podId: id });
        yield* pods.drain;
        expect((yield* pods.awaitSettled(id)).state).toBe("removed");
      }),
    );
  });

  it.effect("keeps a refused removal as stop_failed until it is forced", () => {
    const driver = makeFakeContainerDriver();
    return withPods(driver, (pods) =>
      Effect.gen(function* () {
        const { id } = yield* pods.create({ projectId, worktreePath });
        yield* pods.drain;
        driver.failWhen((call) => call.operation === "removeContainer");
        yield* pods.remove({ podId: id });
        yield* pods.drain;
        expect(yield* pods.awaitSettled(id)).toMatchObject({
          state: "stop_failed",
          lastError: { operation: "remove" },
        });
        yield* pods.remove({ podId: id, force: true });
        yield* pods.drain;
        expect((yield* pods.awaitSettled(id)).state).toBe("removed");
        // What Docker kept is now an orphan, shown and never deleted on its own.
        const status = yield* pods.status({ includeStats: true });
        expect(status.orphans.map((orphan) => orphan.podId)).toEqual([id]);
        expect(driver.containers()).toHaveLength(2);
      }),
    );
  });

  it.effect(
    "refuses to create a pod when the runtime is off or the project has no pod block",
    () => {
      const driver = makeFakeContainerDriver();
      return Effect.gen(function* () {
        expect(
          yield* withPods(
            driver,
            (pods) => pods.create({ projectId, worktreePath }).pipe(Effect.flip),
            { enabled: false },
          ),
        ).toMatchObject({ reason: "disabled" });
        expect(
          yield* withPods(
            driver,
            (pods) => pods.create({ projectId, worktreePath }).pipe(Effect.flip),
            { projectFile: {} },
          ),
        ).toMatchObject({ reason: "not-configured" });
        expect(driver.calls.filter((call) => call.operation !== "list")).toEqual([]);
      });
    },
  );

  it.effect("starts nothing once pods are off, but still stops and removes", () => {
    const driver = makeFakeContainerDriver();
    return Effect.gen(function* () {
      const { base } = harness({ driver });
      const context = yield* Layer.build(base);
      const pods = Context.get(
        yield* Layer.build(PodRuntimeService.layer).pipe(Effect.provide(context)),
        PodRuntimeService.PodRuntimeService,
      );
      const { id } = yield* pods.create({ projectId, worktreePath });
      yield* pods.drain;
      const settings = Context.get(context, ServerSettings.ServerSettingsService);
      yield* settings.updateSettings({ podRuntime: { enabled: false } });
      yield* pods.stop(id);
      yield* pods.drain;
      expect((yield* pods.awaitSettled(id)).state).toBe("stopped");
      expect(yield* pods.start(id).pipe(Effect.flip)).toMatchObject({ reason: "disabled" });
      yield* pods.remove({ podId: id });
      yield* pods.drain;
      expect((yield* pods.awaitSettled(id)).state).toBe("removed");
    }).pipe(Effect.scoped);
  });

  it.effect("opens its shell only while the pod runs", () => {
    const driver = makeFakeContainerDriver();
    return withPods(driver, (pods) =>
      Effect.gen(function* () {
        const { id } = yield* pods.create({ projectId, worktreePath });
        yield* pods.drain;
        const threadId = ThreadId.make("thread-1");
        expect(yield* pods.openShell({ podId: id, threadId })).toEqual({
          threadId,
          terminalId: "pod-shell",
        });
        yield* pods.stop(id);
        yield* pods.drain;
        expect(yield* pods.openShell({ podId: id, threadId }).pipe(Effect.flip)).toMatchObject({
          reason: "invalid-state",
          state: "stopped",
        });
      }),
    );
  });
});

describe("PodRuntimeService worktree paths", () => {
  it.effect("remembers a removed pod's path until its worktree is gone too", () => {
    const driver = makeFakeContainerDriver();
    return withPods(driver, (pods) =>
      Effect.gen(function* () {
        const { id } = yield* pods.create({ projectId, worktreePath });
        yield* pods.drain;
        yield* pods.remove({ podId: id });
        yield* pods.drain;
        expect(yield* pods.forPath(worktreePath)).toBeUndefined();
        expect((yield* pods.forPath(worktreePath, { includeRemoved: true }))?.id).toBe(id);
        yield* pods.releaseWorktree(worktreePath);
        expect(yield* pods.forPath(worktreePath, { includeRemoved: true })).toBeUndefined();
      }),
    );
  });

  it.effect("releases every earlier pod a worktree had, not only the last", () => {
    const driver = makeFakeContainerDriver();
    return withPods(driver, (pods) =>
      Effect.gen(function* () {
        // Pod A is removed from its chip while the worktree stays; pod B follows on it.
        const first = yield* pods.create({ projectId, worktreePath });
        yield* pods.drain;
        yield* pods.remove({ podId: first.id });
        yield* pods.drain;
        const second = yield* pods.create({ projectId, worktreePath });
        yield* pods.drain;
        expect(second.id).not.toBe(first.id);
        yield* pods.remove({ podId: second.id });
        yield* pods.drain;
        yield* pods.releaseWorktree(worktreePath);
        expect(yield* pods.forPath(worktreePath, { includeRemoved: true })).toBeUndefined();
      }),
    );
  });

  it.effect("starts a pod for a launch only while pods are on, and for a teardown always", () => {
    const driver = makeFakeContainerDriver();
    return Effect.gen(function* () {
      const { base } = harness({ driver });
      const context = yield* Layer.build(base);
      const pods = Context.get(
        yield* Layer.build(PodRuntimeService.layer).pipe(Effect.provide(context)),
        PodRuntimeService.PodRuntimeService,
      );
      const { id } = yield* pods.create({ projectId, worktreePath });
      yield* pods.drain;
      yield* pods.stop(id);
      yield* pods.drain;
      const settings = Context.get(context, ServerSettings.ServerSettingsService);
      yield* settings.updateSettings({ podRuntime: { enabled: false } });
      expect(yield* pods.ensureRunning(id).pipe(Effect.flip)).toMatchObject({ reason: "disabled" });
      const started = yield* Effect.all(
        [pods.ensureRunning(id, { forTeardown: true }), pods.drain],
        {
          concurrency: "unbounded",
        },
      );
      expect(started[0].state).toBe("running");
    }).pipe(Effect.scoped);
  });
});

describe("PodRuntimeService reconcile", () => {
  it.effect("lists only this environment's labelled containers and never deletes them", () => {
    const driver = makeFakeContainerDriver();
    driver.seedContainer({
      id: "foreign-1",
      name: "t3-pod-other1-dind",
      labels: { "t3.pod": "pod-other1", "t3.environment": "another-server" },
    });
    driver.seedContainer({
      id: "orch-1",
      name: "pod-ste330-email",
      labels: { "herdr-orch.pod": "pod-ste330-email" },
    });
    driver.seedContainer({
      id: "orphan-1",
      name: "t3-pod-orphan1-dind",
      labels: { "t3.pod": "pod-orphan1", "t3.environment": ENVIRONMENT, "t3.role": "dind" },
    });
    driver.seedVolume("t3-pod-orphan1-dockerlib", {
      "t3.pod": "pod-orphan1",
      "t3.environment": ENVIRONMENT,
    });
    return withPods(driver, (pods) =>
      Effect.gen(function* () {
        const status = yield* pods.status({ includeStats: true });
        expect(status.orphans).toEqual([
          {
            podId: PodRuntimeId.make("pod-orphan1"),
            containerIds: ["orphan-1"],
            volumeIds: ["t3-pod-orphan1-dockerlib"],
            running: true,
          },
        ]);
        expect(driver.calls.some((call) => call.operation.startsWith("remove"))).toBe(false);

        expect(yield* pods.remove({ podId: PodRuntimeId.make("pod-orphan1") })).toBeNull();
        expect(
          driver
            .containers()
            .map((container) => container.id)
            .sort(),
        ).toEqual(["foreign-1", "orch-1"]);
        expect((yield* pods.status({ includeStats: true })).orphans).toEqual([]);
        expect(
          yield* pods.remove({ podId: PodRuntimeId.make("pod-other1") }).pipe(Effect.flip),
        ).toMatchObject({ reason: "not-found" });
        expect(driver.containers()).toHaveLength(2);
      }),
    );
  });

  it.effect("leaves pods alone when their Docker host cannot answer at startup", () => {
    const driver = makeFakeContainerDriver();
    const { base } = harness({ driver });
    return Effect.gen(function* () {
      const context = yield* Layer.build(base);
      const startServer = Layer.build(PodRuntimeService.layer).pipe(
        Effect.provide(context),
        Effect.map((built) => Context.get(built, PodRuntimeService.PodRuntimeService)),
      );
      const pods = yield* startServer;
      const { id } = yield* pods.create({ projectId, worktreePath });
      yield* pods.drain;
      yield* pods.stop(id);
      yield* pods.drain;
      // The daemon is down when the server comes back.
      driver.failWhen((call) => call.operation === "list");
      const again = yield* startServer;
      yield* again.drain;
      expect((yield* again.forPath(worktreePath))?.state).toBe("stopped");
      // Stats skip what the host could not list, rather than failing for every pod.
      const status = yield* again.status({ includeStats: true });
      expect(status.stats).toEqual([{ podId: id, memoryBytes: null }]);
    }).pipe(Effect.scoped);
  });

  it.effect("measures only containers the host just listed", () => {
    const driver = makeFakeContainerDriver();
    return withPods(driver, (pods) =>
      Effect.gen(function* () {
        const { id } = yield* pods.create({ projectId, worktreePath });
        yield* pods.drain;
        driver.calls.length = 0;
        const status = yield* pods.status({ includeStats: true });
        expect(status.stats).toEqual([{ podId: id, memoryBytes: 2048 }]);
        expect(driver.calls.filter((call) => call.operation === "stats")).toHaveLength(1);
      }),
    );
  });

  it.effect(
    "settles a pod whose operation a restart cut off, and the journal replays to the projection",
    () => {
      const driver = makeFakeContainerDriver();
      const { base } = harness({ driver });
      return Effect.gen(function* () {
        const context = yield* Layer.build(base);
        const startServer = Layer.build(PodRuntimeService.layer).pipe(
          Effect.provide(context),
          Effect.map((built) => Context.get(built, PodRuntimeService.PodRuntimeService)),
        );
        const pods = yield* startServer;
        const { id } = yield* pods.create({ projectId, worktreePath });
        yield* pods.drain;
        const store = Context.get(context, PodRuntimeStore.PodRuntimeStore);
        // The server dies mid-stop: the intent is committed, Docker never heard of it.
        yield* store.commit(id, [
          {
            type: "pod.operation-requested",
            podId: id,
            occurredAt: "2026-10-21T00:00:00.000Z",
            operation: "stop",
          },
        ]);
        const again = yield* startServer;
        yield* again.drain;
        expect(yield* again.forPath(worktreePath)).toMatchObject({
          state: "stop_failed",
          lastError: { operation: "stop", message: "Interrupted by a server restart." },
        });
        const replayed = yield* store.replay;
        expect(replayed.get(id)).toEqual(yield* store.get(id));
      }).pipe(Effect.scoped);
    },
  );
});

const dindPublish = (driver: FakeContainerDriver, podId: string) =>
  driver.containers().find((container) => container.name === `t3-envtest-${podId}-dind`)?.spec
    ?.publish;

const twoServices: T3ProjectFile = { pod: { services: { web: 3000, api: 8000 } } };

describe("PodRuntimeService host ports", () => {
  it.effect("publishes services on stable host ports, linked only while the pod runs", () => {
    const driver = makeFakeContainerDriver();
    const { base, discovery } = harness({ driver, projectFile: twoServices });
    return Effect.gen(function* () {
      const context = yield* Layer.build(base);
      const pods = Context.get(
        yield* Layer.build(PodRuntimeService.layer).pipe(Effect.provide(context)),
        PodRuntimeService.PodRuntimeService,
      );
      const { id } = yield* pods.create({ projectId, worktreePath });
      yield* pods.drain;
      const urls = ["http://127.0.0.1:20000", "http://127.0.0.1:20001"];
      expect((yield* pods.awaitSettled(id)).services).toEqual([
        { name: "web", port: 3000, url: urls[0] },
        { name: "api", port: 8000, url: urls[1] },
      ]);
      expect(dindPublish(driver, id)).toEqual([
        { hostIp: "127.0.0.1", hostPort: 20000, containerPort: 3000 },
        { hostIp: "127.0.0.1", hostPort: 20001, containerPort: 8000 },
      ]);
      expect(discovery.get(`pod:${id}`)).toEqual(urls);

      yield* pods.stop(id);
      yield* pods.drain;
      expect((yield* pods.awaitSettled(id)).services.map((service) => service.url)).toEqual([
        null,
        null,
      ]);
      expect(discovery.has(`pod:${id}`)).toBe(false);

      yield* pods.start(id);
      yield* pods.drain;
      expect((yield* pods.awaitSettled(id)).services.map((service) => service.url)).toEqual(urls);
      yield* pods.recreate(id);
      yield* pods.drain;
      expect((yield* pods.awaitSettled(id)).services.map((service) => service.url)).toEqual(urls);
      expect(dindPublish(driver, id)?.map((port) => port.hostPort)).toEqual([20000, 20001]);

      yield* pods.remove({ podId: id });
      yield* pods.drain;
      expect(discovery.has(`pod:${id}`)).toBe(false);
      expect(
        (yield* Context.get(context, PodRuntimeStore.PodRuntimeStore).get(id))?.hostPorts,
      ).toBeUndefined();
      // Removing released the ports: the next pod gets them.
      const next = yield* pods.create({ projectId, worktreePath: "/work/pods/next" });
      yield* pods.drain;
      expect(dindPublish(driver, next.id)?.map((port) => port.hostPort)).toEqual([20000, 20001]);
    }).pipe(Effect.scoped);
  });

  it.effect("keeps a pod's ports across a server restart", () => {
    const driver = makeFakeContainerDriver();
    const { base, discovery } = harness({ driver, projectFile: twoServices });
    return Effect.gen(function* () {
      const context = yield* Layer.build(base);
      // A fresh store too: the restarted server reads the pod back from the database.
      const startServer = Layer.build(
        PodRuntimeService.layer.pipe(Layer.provideMerge(PodRuntimeStore.layer)),
      ).pipe(Effect.provide(context));
      const first = Context.get(yield* startServer, PodRuntimeService.PodRuntimeService);
      const { id } = yield* first.create({ projectId, worktreePath });
      yield* first.drain;
      const before = (yield* first.awaitSettled(id)).services;
      discovery.clear();

      const restarted = yield* startServer;
      const again = Context.get(restarted, PodRuntimeService.PodRuntimeService);
      yield* again.drain;
      expect((yield* again.awaitSettled(id)).services).toEqual(before);
      expect(discovery.get(`pod:${id}`)).toEqual(before.map((service) => service.url));
      yield* again.recreate(id);
      yield* again.drain;
      expect((yield* again.awaitSettled(id)).services).toEqual(before);
      const store = Context.get(restarted, PodRuntimeStore.PodRuntimeStore);
      expect((yield* store.replay).get(id)).toEqual(yield* store.get(id));
    }).pipe(Effect.scoped);
  });

  it.effect("skips ports another server's pods hold on the same daemon, and labels its own", () => {
    const driver = makeFakeContainerDriver();
    driver.seedContainer({
      id: "foreign-dind",
      name: "t3-other-pod-other1-dind",
      labels: { "t3.pod": "pod-other1", "t3.environment": "another-server", "t3.ports": "20000" },
      status: "exited",
    });
    return withPods(driver, (pods) =>
      Effect.gen(function* () {
        const { id } = yield* pods.create({ projectId, worktreePath });
        yield* pods.drain;
        expect(dindPublish(driver, id)?.map((port) => port.hostPort)).toEqual([20001]);
        const dind = driver
          .containers()
          .find((container) => container.name === `t3-envtest-${id}-dind`);
        expect(dind?.labels["t3.ports"]).toBe("20001");
      }),
    );
  });

  it.effect("never gives two pods starting at once the same port, nor one in use", () => {
    const driver = makeFakeContainerDriver();
    const network = makeFakeHostNetwork();
    network.busy.add("127.0.0.1:20000");
    return withPods(
      driver,
      (pods) =>
        Effect.gen(function* () {
          const [first, second] = yield* Effect.all(
            [
              pods.create({ projectId, worktreePath: "/work/pods/one" }),
              pods.create({ projectId, worktreePath: "/work/pods/two" }),
            ],
            { concurrency: "unbounded" },
          );
          yield* pods.drain;
          const ports = [first.id, second.id].flatMap(
            (id) => dindPublish(driver, id)?.map((port) => port.hostPort) ?? [],
          );
          expect(ports.toSorted()).toEqual([20001, 20002, 20003, 20004]);
        }),
      { network, projectFile: twoServices },
    );
  });

  it.effect("fails a start that finds its port taken, naming the port, and retries", () => {
    const driver = makeFakeContainerDriver();
    const network = makeFakeHostNetwork();
    return withPods(
      driver,
      (pods) =>
        Effect.gen(function* () {
          const { id } = yield* pods.create({ projectId, worktreePath });
          yield* pods.drain;
          yield* pods.stop(id);
          yield* pods.drain;
          network.busy.add("127.0.0.1:20000");
          driver.calls.length = 0;
          yield* pods.start(id);
          yield* pods.drain;
          expect(yield* pods.awaitSettled(id)).toMatchObject({
            state: "start_failed",
            lastError: {
              operation: "start",
              message: expect.stringContaining(
                "port 20000 for service web is already in use on 127.0.0.1",
              ),
            },
          });
          expect(operations(driver)).not.toContain(`start t3-envtest-${id}-dind`);

          network.busy.clear();
          yield* pods.start(id);
          yield* pods.drain;
          expect((yield* pods.awaitSettled(id)).services[0]?.url).toBe("http://127.0.0.1:20000");
        }),
      { network },
    );
  });

  it.effect("also publishes on the tailnet address when the environment asks", () => {
    const driver = makeFakeContainerDriver();
    const network = makeFakeHostNetwork();
    network.tailnetAddress = "100.101.102.103";
    const { base, discovery } = harness({ driver, network, publishOnTailnet: true });
    return Effect.gen(function* () {
      const context = yield* Layer.build(base);
      const pods = Context.get(
        yield* Layer.build(PodRuntimeService.layer).pipe(Effect.provide(context)),
        PodRuntimeService.PodRuntimeService,
      );
      const { id } = yield* pods.create({ projectId, worktreePath });
      yield* pods.drain;
      expect(dindPublish(driver, id)).toEqual([
        { hostIp: "127.0.0.1", hostPort: 20000, containerPort: 3000 },
        { hostIp: "100.101.102.103", hostPort: 20000, containerPort: 3000 },
      ]);
      expect((yield* pods.awaitSettled(id)).services).toEqual([
        {
          name: "web",
          port: 3000,
          url: "http://127.0.0.1:20000",
          tailnetUrl: "http://100.101.102.103:20000",
        },
      ]);
      // The server's own browser and port list use loopback only.
      expect(discovery.get(`pod:${id}`)).toEqual(["http://127.0.0.1:20000"]);

      // Turned off, it applies from the next recreate.
      const settings = Context.get(context, ServerSettings.ServerSettingsService);
      yield* settings.updateSettings({ podRuntime: { publishOnTailnet: false } });
      yield* pods.recreate(id);
      yield* pods.drain;
      expect(dindPublish(driver, id)?.map((port) => port.hostIp)).toEqual(["127.0.0.1"]);
      expect((yield* pods.awaitSettled(id)).services[0]).not.toHaveProperty("tailnetUrl");
    }).pipe(Effect.scoped);
  });
});

describe("PodRuntimeService .env", () => {
  const envProjectFile = (env: Record<string, string>): T3ProjectFile => ({
    pod: { services: { web: 3000, api: 8000 }, env },
  });

  it.effect("renders service placeholders into .env and the pod, and again on recreate", () => {
    const driver = makeFakeContainerDriver();
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const worktree = yield* fileSystem.makeTempDirectoryScoped();
      const dotEnv = `${worktree}/.env`;
      yield* fileSystem.writeFileString(dotEnv, "KEEP=1\nexport API_URL=old\n# note\n");
      yield* withPods(
        driver,
        (pods) =>
          Effect.gen(function* () {
            const { id } = yield* pods.create({ projectId, worktreePath: worktree });
            yield* pods.drain;
            expect((yield* pods.awaitSettled(id)).state).toBe("running");
            expect(yield* fileSystem.readFileString(dotEnv)).toBe(
              [
                "KEEP=1",
                "API_URL=http://127.0.0.1:20001/v1",
                "# note",
                "WEB_PORT=20000",
                "GREETING='hello world'",
                "",
              ].join("\n"),
            );
            const agent = driver
              .containers()
              .find((container) => container.name === `t3-envtest-${id}-agent`);
            expect(agent?.spec?.env).toMatchObject({
              API_URL: "http://127.0.0.1:20001/v1",
              WEB_PORT: "20000",
            });

            yield* fileSystem.writeFileString(dotEnv, "API_URL=edited\n");
            yield* pods.recreate(id);
            yield* pods.drain;
            expect(yield* fileSystem.readFileString(dotEnv)).toContain(
              "API_URL=http://127.0.0.1:20001/v1",
            );
          }),
        {
          projectFile: envProjectFile({
            API_URL: "{api.url}/v1",
            WEB_PORT: "{web.port}",
            GREETING: "hello world",
          }),
        },
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
  });

  it.effect("stops and removes even after t3.json gains a service the pod lacks", () => {
    const driver = makeFakeContainerDriver();
    const projectFile: T3ProjectFile = {
      pod: { services: { web: 3000 }, env: { WEB: "{web.url}" } },
    };
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const worktree = yield* fileSystem.makeTempDirectoryScoped();
      yield* withPods(
        driver,
        (pods) =>
          Effect.gen(function* () {
            const { id } = yield* pods.create({ projectId, worktreePath: worktree });
            yield* pods.drain;
            expect((yield* pods.awaitSettled(id)).state).toBe("running");
            Object.assign(projectFile, {
              pod: {
                services: { web: 3000, db: 5432 },
                env: { WEB: "{web.url}", DB: "{db.url}" },
              },
            });
            yield* pods.stop(id);
            yield* pods.drain;
            expect((yield* pods.awaitSettled(id)).state).toBe("stopped");
            yield* pods.start(id);
            yield* pods.drain;
            expect(yield* pods.awaitSettled(id)).toMatchObject({
              state: "start_failed",
              lastError: {
                message:
                  "pod.env DB: {db.url} names service db, which is new in t3.json; Recreate the pod to publish it.",
              },
            });
            yield* pods.remove({ podId: id });
            yield* pods.drain;
            expect((yield* pods.awaitSettled(id)).state).toBe("removed");
          }),
        { projectFile },
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
  });

  it.effect("fails clearly on a placeholder that names no service, before any container", () => {
    const driver = makeFakeContainerDriver();
    return withPods(
      driver,
      (pods) =>
        Effect.gen(function* () {
          const { id } = yield* pods.create({ projectId, worktreePath });
          yield* pods.drain;
          expect(yield* pods.awaitSettled(id)).toMatchObject({
            state: "start_failed",
            lastError: {
              operation: "create",
              message: "pod.env DATABASE_URL: {db.url} names no pod service (services: web, api).",
            },
          });
          expect(driver.containers()).toEqual([]);
        }),
      { projectFile: envProjectFile({ DATABASE_URL: "{db.url}" }) },
    );
  });
});

describe("PodRuntimeService hostnames", () => {
  const hostnameProject = (env: Record<string, string> = {}): T3ProjectFile => ({
    pod: { services: { web: 3000, api: 8000 }, env, hostnames: true },
  });
  const hostname = (id: string, service: string) => `t3-envtest-${id}-${service}.pods.internal`;
  /** The proxy answers a start's hostname check, as with a stack still booting. */
  const answerHostnames = (driver: FakeContainerDriver) =>
    driver.execOutput((call) =>
      call.command?.some((part) => part.includes("openssl s_client")) === true
        ? "HTTP/1.1 502 Bad Gateway"
        : "",
    );

  it.effect("serves a running pod on its hostnames and routes it only while it runs", () => {
    const driver = makeFakeContainerDriver();
    answerHostnames(driver);
    const router = makeFakePodHostnameRouter();
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const worktree = yield* fileSystem.makeTempDirectoryScoped();
      const { base, discovery } = harness({
        driver,
        router,
        projectFile: hostnameProject({ WEB: "{web.url}", WEB_PORT: "{web.port}" }),
      });
      const context = yield* Layer.build(base);
      const pods = Context.get(
        yield* Layer.build(PodRuntimeService.layer).pipe(Effect.provide(context)),
        PodRuntimeService.PodRuntimeService,
      );
      const { id } = yield* pods.create({ projectId, worktreePath: worktree });
      yield* pods.drain;
      const stem = `t3-envtest-${id}`;
      const urls = [`https://${hostname(id, "web")}`, `https://${hostname(id, "api")}`];
      const running = yield* pods.awaitSettled(id);
      expect(running.state).toBe("running");
      expect(running.services.map((service) => service.url)).toEqual(urls);
      expect(running).not.toHaveProperty("hostnameProblem");
      // The proxy reaches each service's inner port on the daemon, over its network.
      expect(router.routes.get(stem)).toEqual([
        { hostname: hostname(id, "web"), upstream: `${stem}-dind:3000` },
        { hostname: hostname(id, "api"), upstream: `${stem}-dind:8000` },
      ]);
      // Listed by hostname, probed at the loopback port the server's own fetch can reach.
      expect(discovery.get(`pod:${id}`)).toEqual([
        { url: urls[0], probeUrl: "http://127.0.0.1:20000" },
        { url: urls[1], probeUrl: "http://127.0.0.1:20001" },
      ]);
      expect(yield* fileSystem.readFileString(`${worktree}/.env`)).toBe(
        `WEB=https://${hostname(id, "web")}\nWEB_PORT=443\n`,
      );
      const dind = driver.containers().find((container) => container.name === `${stem}-dind`);
      expect(dind?.spec?.dns).toEqual(["172.21.0.2"]);
      expect(dind?.spec?.command).toEqual(expect.arrayContaining(["--dns", "172.21.0.2"]));
      expect(driver.calls).toContainEqual(
        expect.objectContaining({
          operation: "connect",
          target: `${stem}-dind`,
          command: ["pods"],
        }),
      );
      const agent = driver.containers().find((container) => container.name === `${stem}-agent`);
      expect(agent?.spec?.mounts).toContainEqual({
        type: "bind",
        source: "~/.local/state/herdr-orch/caddy/root.crt",
        target: "/usr/local/share/ca-certificates/t3-pods-proxy.crt",
        readOnly: true,
      });
      expect(operations(driver)).toContain(`exec ${stem}-agent update-ca-certificates`);

      yield* pods.stop(id);
      yield* pods.drain;
      expect((yield* pods.awaitSettled(id)).services.map((service) => service.url)).toEqual([
        null,
        null,
      ]);
      expect(router.routes.has(stem)).toBe(false);

      yield* pods.start(id);
      yield* pods.drain;
      expect((yield* pods.awaitSettled(id)).services.map((service) => service.url)).toEqual(urls);
      expect(router.routes.has(stem)).toBe(true);

      yield* pods.recreate(id);
      yield* pods.drain;
      expect((yield* pods.awaitSettled(id)).services.map((service) => service.url)).toEqual(urls);
      expect(router.routes.has(stem)).toBe(true);

      yield* pods.remove({ podId: id });
      yield* pods.drain;
      expect((yield* pods.awaitSettled(id)).state).toBe("removed");
      expect(router.routes.has(stem)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
  });

  it.effect("falls back to ports, saying why, when the host has no hostname proxy", () => {
    const driver = makeFakeContainerDriver();
    const router = makeFakePodHostnameRouter();
    router.prepareAs({ type: "unavailable", reason: "no container is named pods-proxy" });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const worktree = yield* fileSystem.makeTempDirectoryScoped();
      yield* withPods(
        driver,
        (pods) =>
          Effect.gen(function* () {
            const { id } = yield* pods.create({ projectId, worktreePath: worktree });
            yield* pods.drain;
            expect(yield* pods.awaitSettled(id)).toMatchObject({
              state: "running",
              lastError: null,
              hostnameProblem:
                "Hostnames are off for this pod: no container is named pods-proxy. Its services use ports; Recreate the pod once that is fixed.",
            });
            expect((yield* pods.awaitSettled(id)).services[0]?.url).toBe("http://127.0.0.1:20000");
            expect(yield* fileSystem.readFileString(`${worktree}/.env`)).toBe(
              "WEB=http://127.0.0.1:20000\n",
            );
            expect(driver.calls.some((call) => call.operation === "connect")).toBe(false);
            expect(router.calls.filter((call) => call.startsWith("install"))).toEqual([]);

            // The proxy is back: a stop and start keep ports; Recreate moves to hostnames.
            router.prepareAs({ type: "ready", dnsAddress: "172.21.0.2" });
            yield* pods.stop(id);
            yield* pods.drain;
            yield* pods.start(id);
            yield* pods.drain;
            expect((yield* pods.awaitSettled(id)).hostnameProblem).toContain("Hostnames are off");
            yield* pods.recreate(id);
            yield* pods.drain;
            const recreated = yield* pods.awaitSettled(id);
            expect(recreated).not.toHaveProperty("hostnameProblem");
            expect(recreated.services[0]?.url).toBe(`https://${hostname(id, "web")}`);
          }),
        { router, projectFile: hostnameProject({ WEB: "{web.url}" }) },
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
  });

  it.effect("fails a start whose daemon cannot join the proxy's network, routing nothing", () => {
    const driver = makeFakeContainerDriver();
    driver.failWhen((call) => call.operation === "connect");
    const router = makeFakePodHostnameRouter();
    return withPods(
      driver,
      (pods) =>
        Effect.gen(function* () {
          const { id } = yield* pods.create({ projectId, worktreePath });
          yield* pods.drain;
          expect(yield* pods.awaitSettled(id)).toMatchObject({
            state: "start_failed",
            lastError: {
              message: "Joining the hostname proxy's network failed: fake connect refused",
            },
          });
          expect(router.routes.size).toBe(0);
          // Joining is all it ever asks of that network.
          expect(
            driver.calls
              .filter((call) => call.command?.includes("pods"))
              .map((call) => call.operation),
          ).toEqual(["connect"]);
        }),
      { router, projectFile: hostnameProject() },
    );
  });

  it.effect("says a pod built for ports needs Recreate once t3.json asks for hostnames", () => {
    const driver = makeFakeContainerDriver();
    const projectFile: T3ProjectFile = { pod: { services: { web: 3000 } } };
    return withPods(
      driver,
      (pods) =>
        Effect.gen(function* () {
          const { id } = yield* pods.create({ projectId, worktreePath });
          yield* pods.drain;
          const restart = Effect.gen(function* () {
            yield* pods.stop(id);
            yield* pods.drain;
            yield* pods.start(id);
            yield* pods.drain;
            return yield* pods.awaitSettled(id);
          });
          Object.assign(projectFile, { pod: { services: { web: 3000 }, hostnames: true } });
          const asked = yield* restart;
          expect(asked.hostnameProblem).toBe(
            "This pod was built for ports; Recreate it to serve its services on hostnames.",
          );
          expect(asked.services[0]?.url).toBe("http://127.0.0.1:20000");
          Object.assign(projectFile, { pod: { services: { web: 3000 } } });
          expect(yield* restart).not.toHaveProperty("hostnameProblem");
        }),
      { projectFile },
    );
  });

  it.effect("keeps the route of a pod that starts while the startup prune waits", () => {
    const driver = makeFakeContainerDriver();
    answerHostnames(driver);
    const router = makeFakePodHostnameRouter();
    const { base } = harness({ driver, router, projectFile: hostnameProject() });
    return Effect.gen(function* () {
      const context = yield* Layer.build(base);
      const startServer = Layer.build(
        PodRuntimeService.layer.pipe(Layer.provideMerge(PodRuntimeStore.layer)),
      ).pipe(Effect.provide(context));
      const first = Context.get(yield* startServer, PodRuntimeService.PodRuntimeService);
      const { id } = yield* first.create({ projectId, worktreePath });
      yield* first.drain;
      yield* first.stop(id);
      yield* first.drain;

      const gate = yield* Deferred.make<void>();
      router.holdPrune(gate);
      const again = Context.get(yield* startServer, PodRuntimeService.PodRuntimeService);
      // Startup's per-pod pass found it stopped; it starts before the prune reads what to keep.
      yield* again.start(id);
      expect((yield* again.awaitSettled(id)).state).toBe("running");
      expect(router.routes.has(`t3-envtest-${id}`)).toBe(true);
      yield* Deferred.succeed(gate, undefined);
      yield* again.drain;
      expect(router.routes.has(`t3-envtest-${id}`)).toBe(true);
    }).pipe(Effect.scoped);
  });

  it.effect(
    "keeps the hostname links its stack is set up for while the route is not in place",
    () => {
      const driver = makeFakeContainerDriver();
      answerHostnames(driver);
      const router = makeFakePodHostnameRouter();
      router.failInstall("the proxy rejected the route: unrecognized directive");
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const worktree = yield* fileSystem.makeTempDirectoryScoped();
        const { base, discovery } = harness({
          driver,
          router,
          projectFile: hostnameProject({ WEB: "{web.url}" }),
        });
        const context = yield* Layer.build(base);
        const pods = Context.get(
          yield* Layer.build(PodRuntimeService.layer).pipe(Effect.provide(context)),
          PodRuntimeService.PodRuntimeService,
        );
        const { id } = yield* pods.create({ projectId, worktreePath: worktree });
        yield* pods.drain;
        const running = yield* pods.awaitSettled(id);
        expect(running).toMatchObject({
          state: "running",
          lastError: null,
          hostnameProblem:
            "Its proxy route is not in place: the proxy rejected the route: unrecognized directive. Its hostnames will not open until the pod starts again with the route.",
        });
        // The link and the stack's .env tell the same story; the list waits for the route.
        expect(running.services[0]?.url).toBe(`https://${hostname(id, "web")}`);
        expect(yield* fileSystem.readFileString(`${worktree}/.env`)).toBe(
          `WEB=https://${hostname(id, "web")}\n`,
        );
        expect(discovery.has(`pod:${id}`)).toBe(false);

        router.failInstall(null);
        yield* pods.stop(id);
        yield* pods.drain;
        yield* pods.start(id);
        yield* pods.drain;
        const routed = yield* pods.awaitSettled(id);
        expect(routed).not.toHaveProperty("hostnameProblem");
        expect(routed.services[0]?.url).toBe(`https://${hostname(id, "web")}`);
        expect(discovery.get(`pod:${id}`)).toHaveLength(2);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
    },
  );

  it.effect("puts routes back and drops stale ones of this environment on restart", () => {
    const driver = makeFakeContainerDriver();
    const router = makeFakePodHostnameRouter();
    const { base } = harness({ driver, router, projectFile: hostnameProject() });
    return Effect.gen(function* () {
      const context = yield* Layer.build(base);
      const startServer = Layer.build(
        PodRuntimeService.layer.pipe(Layer.provideMerge(PodRuntimeStore.layer)),
      ).pipe(Effect.provide(context));
      const first = Context.get(yield* startServer, PodRuntimeService.PodRuntimeService);
      const kept = yield* first.create({ projectId, worktreePath });
      const stopped = yield* first.create({ projectId, worktreePath: "/work/pods/stopped" });
      yield* first.drain;
      yield* first.stop(stopped.id);
      yield* first.drain;
      // While the server was down: the proxy's directory lost a route and kept stale ones.
      router.routes.clear();
      router.routes.set(`t3-envtest-${stopped.id}`, []);
      router.routes.set("t3-envtest-pod-gone", []);
      router.routes.set("pod-orch-feature", []);

      const again = Context.get(yield* startServer, PodRuntimeService.PodRuntimeService);
      yield* again.drain;
      expect([...router.routes.keys()].toSorted()).toEqual(
        ["pod-orch-feature", `t3-envtest-${kept.id}`].toSorted(),
      );
      expect((yield* again.awaitSettled(kept.id)).services[0]?.url).toBe(
        `https://${hostname(kept.id, "web")}`,
      );
    }).pipe(Effect.scoped);
  });

  it.effect(
    "warns only while Tailscale Serve holds :443 and a project with pods on uses hostnames",
    () => {
      const projects = [{ id: projectId, workspaceRoot: "/work/repo" }];
      const warningsFor = (options: {
        readonly serveOn443: boolean;
        readonly hostnames: boolean;
        readonly enabled?: boolean;
      }) =>
        withPods(
          makeFakeContainerDriver(),
          (pods) => pods.status({}).pipe(Effect.map((status) => status.warnings)),
          {
            projects,
            ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
            router: makeFakePodHostnameRouter({ tailscaleServeOnProxyPort: options.serveOn443 }),
            projectFile: { pod: { services: { web: 3000 }, hostnames: options.hostnames } },
          },
        );
      return Effect.gen(function* () {
        expect(yield* warningsFor({ serveOn443: true, hostnames: true })).toEqual([
          "tailscale-serve-443",
        ]);
        // A project's own status, which the composer reads, never pays for the scan.
        expect(
          yield* withPods(
            makeFakeContainerDriver(),
            (pods) => pods.status({ projectId }).pipe(Effect.map((status) => status.warnings)),
            {
              projects,
              router: makeFakePodHostnameRouter({ tailscaleServeOnProxyPort: true }),
              projectFile: { pod: { services: { web: 3000 }, hostnames: true } },
            },
          ),
        ).toBeUndefined();
        expect(yield* warningsFor({ serveOn443: false, hostnames: true })).toBeUndefined();
        expect(yield* warningsFor({ serveOn443: true, hostnames: false })).toBeUndefined();
        expect(
          yield* warningsFor({ serveOn443: true, hostnames: true, enabled: false }),
        ).toBeUndefined();
      });
    },
  );
});

describe("PodRuntimeService resolvers", () => {
  const HOST_RESOLV_CONF = [
    "nameserver 127.0.0.53",
    "nameserver 100.100.100.100",
    "nameserver 192.168.1.1",
    "nameserver 2600:4040:ac1c:5400::1",
  ].join("\n");
  const dindDns = (options: Omit<Parameters<typeof harness>[0], "driver">) => {
    const driver = makeFakeContainerDriver();
    return withPods(
      driver,
      (pods) =>
        Effect.gen(function* () {
          const { id } = yield* pods.create({ projectId, worktreePath });
          yield* pods.drain;
          const dind = driver
            .containers(options.dockerHost)
            .find((container) => container.name === `t3-envtest-${id}-dind`)?.spec;
          expect(dind).toBeDefined();
          return { dns: dind?.dns, command: dind?.command.slice(3) };
        }),
      options,
    );
  };
  const network = (resolvConf: string) => ({ ...makeFakeHostNetwork(), resolvConf });

  it.effect(
    "gives a pod of ports the host's reachable upstreams unless the setting names others",
    () =>
      Effect.gen(function* () {
        expect(yield* dindDns({ network: network(HOST_RESOLV_CONF) })).toEqual({
          dns: ["192.168.1.1"],
          command: ["--dns", "192.168.1.1"],
        });
        expect(
          yield* dindDns({ network: network(HOST_RESOLV_CONF), dnsServers: ["9.9.9.9"] }),
        ).toEqual({ dns: ["9.9.9.9"], command: ["--dns", "9.9.9.9"] });
        // A remote daemon's network may not reach this host's resolvers: Docker's own DNS.
        expect(
          yield* dindDns({ network: network(HOST_RESOLV_CONF), dockerHost: "tcp://10.0.0.5:2375" }),
        ).toEqual({ dns: undefined, command: [] });
        // Nothing reachable found: Docker's own DNS, as before.
        expect(yield* dindDns({ network: network("nameserver 127.0.0.53\n") })).toEqual({
          dns: undefined,
          command: [],
        });
      }),
  );

  it.effect("asks the proxy's DNS server first in hostname mode, then the setting only", () =>
    Effect.gen(function* () {
      const hostnames: T3ProjectFile = { pod: { services: { web: 3000 }, hostnames: true } };
      expect(
        yield* dindDns({ network: network(HOST_RESOLV_CONF), projectFile: hostnames }),
      ).toEqual({ dns: ["172.21.0.2"], command: ["--dns", "172.21.0.2"] });
      expect(
        (yield* dindDns({
          network: network(HOST_RESOLV_CONF),
          projectFile: hostnames,
          dnsServers: ["9.9.9.9"],
        })).dns,
      ).toEqual(["172.21.0.2", "9.9.9.9"]);
    }),
  );
});

describe("PodRuntimeService stack output", () => {
  it.effect("puts the end of a failing stack command's output in the pod's last error", () => {
    const driver = makeFakeContainerDriver();
    driver.execExitCode((call) => (call.command?.includes("up") ? 1 : 0));
    driver.execOutput((call) =>
      call.command?.includes("up")
        ? "Pulling web | Error response from daemon: Get https://registry-1.docker.io/v2/: dial tcp: lookup registry-1.docker.io: server misbehaving"
        : "",
    );
    return withPods(driver, (pods) =>
      Effect.gen(function* () {
        const { id } = yield* pods.create({ projectId, worktreePath });
        yield* pods.drain;
        expect(yield* pods.awaitSettled(id)).toMatchObject({
          state: "start_failed",
          lastError: {
            operation: "create",
            message:
              "Stack command 1 of 1 failed (exit 1): Pulling web | Error response from daemon: Get https://registry-1.docker.io/v2/: dial tcp: lookup registry-1.docker.io: server misbehaving",
          },
        });
      }),
    );
  });
});

describe("PodRuntimeService following threads", () => {
  // The threads parked after anything the test asked of the pod.
  const parkedSince = Effect.succeed(Number.POSITIVE_INFINITY);
  const beforeStop = Effect.void;

  it.effect("parks a running pod by stopping it, and any start clears the mark", () => {
    const driver = makeFakeContainerDriver();
    return withPods(driver, (pods) =>
      Effect.gen(function* () {
        const { id } = yield* pods.create({ projectId, worktreePath });
        yield* pods.drain;
        expect(yield* pods.park(id, { settled: false, parkedSince, beforeStop })).toBe(true);
        yield* pods.drain;
        expect(yield* pods.awaitSettled(id)).toMatchObject({ state: "stopped", parked: true });
        // Parking again changes nothing.
        expect(yield* pods.park(id, { settled: false, parkedSince, beforeStop })).toBe(false);

        yield* pods.start(id);
        yield* pods.drain;
        const started = yield* pods.awaitSettled(id);
        expect(started.state).toBe("running");
        expect(started).not.toHaveProperty("parked");

        // The user's own stop is not a parked one: no wake starts it.
        yield* pods.stop(id);
        yield* pods.drain;
        expect(yield* pods.awaitSettled(id)).not.toHaveProperty("parked");
      }),
    );
  });

  it.effect("freezes for snoozed threads when set to, and stops once they all settled", () => {
    const driver = makeFakeContainerDriver();
    return withPods(
      driver,
      (pods) =>
        Effect.gen(function* () {
          const { id } = yield* pods.create({ projectId, worktreePath });
          yield* pods.drain;
          driver.calls.length = 0;
          yield* pods.park(id, { settled: false, parkedSince, beforeStop });
          yield* pods.drain;
          expect(yield* pods.awaitSettled(id)).toMatchObject({ state: "frozen", parked: true });
          expect(operations(driver)).toEqual([
            "list t3.pod",
            `pause t3-envtest-${id}-agent`,
            `pause t3-envtest-${id}-dind`,
          ]);

          yield* pods.park(id, { settled: true, parkedSince, beforeStop });
          yield* pods.drain;
          expect(yield* pods.awaitSettled(id)).toMatchObject({ state: "stopped", parked: true });
        }),
      { snoozeAction: "freeze" },
    );
  });

  it.effect("stops a pod whose start failed after its containers came up", () => {
    const driver = makeFakeContainerDriver();
    driver.failWhen(
      (call) => call.operation === "exec" && call.command?.includes("start") === true,
    );
    return withPods(driver, (pods) =>
      Effect.gen(function* () {
        const { id } = yield* pods.create({ projectId, worktreePath });
        yield* pods.drain;
        yield* pods.stop(id);
        yield* pods.drain;
        yield* pods.start(id);
        yield* pods.drain;
        expect((yield* pods.awaitSettled(id)).state).toBe("start_failed");
        expect(yield* pods.park(id, { settled: false, parkedSince, beforeStop })).toBe(true);
        yield* pods.drain;
        expect(yield* pods.awaitSettled(id)).toMatchObject({ state: "stopped", parked: true });
      }),
    );
  });

  it.effect(
    "keeps a failed start's evidence through a parked stop, so the wake fails the same",
    () => {
      const driver = makeFakeContainerDriver();
      return withPods(driver, (pods) =>
        Effect.gen(function* () {
          const { id } = yield* pods.create({ projectId, worktreePath });
          yield* pods.drain;
          yield* pods.stop(id);
          yield* pods.drain;
          const dind = driver.containers().find((container) => container.name.endsWith("-dind"))!;
          yield* driver.driver.forHost("").removeContainer(dind.id);
          yield* pods.start(id);
          yield* pods.drain;
          const failed = (yield* pods.awaitSettled(id)).lastError?.message;
          expect(failed).toContain("Recreate the pod");

          driver.calls.length = 0;
          expect(yield* pods.park(id, { settled: false, parkedSince, beforeStop })).toBe(true);
          yield* pods.drain;
          expect((yield* pods.awaitSettled(id)).containerIds).toContain(dind.id);
          yield* pods.start(id);
          yield* pods.drain;
          const again = yield* pods.awaitSettled(id);
          expect(again.state).toBe("start_failed");
          expect(again.lastError?.message).toBe(failed);
          expect(operations(driver).some((step) => step.startsWith("createContainer"))).toBe(false);
        }),
      );
    },
  );

  it.effect("keeps the stack list of a pod whose start found containers gone", () => {
    const driver = makeFakeContainerDriver();
    const checksStack = (call: { readonly command?: ReadonlyArray<string> }) =>
      call.command?.some((part) => part.includes("--type container")) === true;
    const recordsStack = (call: { readonly command?: ReadonlyArray<string> }) =>
      call.command?.some((part) => part.includes("com.docker.compose.oneoff=False")) === true;
    return withPods(driver, (pods) =>
      Effect.gen(function* () {
        const { id } = yield* pods.create({ projectId, worktreePath });
        yield* pods.drain;
        yield* pods.stop(id);
        yield* pods.drain;
        driver.execExitCode((call) => (checksStack(call) ? 3 : 0));
        driver.execOutput((call) => (checksStack(call) ? "missing: feature-db-1" : ""));
        yield* pods.start(id);
        yield* pods.drain;
        expect((yield* pods.awaitSettled(id)).state).toBe("start_failed");

        driver.calls.length = 0;
        yield* pods.park(id, { settled: false, parkedSince, beforeStop });
        yield* pods.drain;
        expect((yield* pods.awaitSettled(id)).state).toBe("stopped");
        expect(driver.calls.some(recordsStack)).toBe(false);
        yield* pods.start(id);
        yield* pods.drain;
        expect((yield* pods.awaitSettled(id)).lastError?.message).toContain("feature-db-1");
      }),
    );
  });

  it.effect("stops only for threads that parked after the pod was last asked to run", () => {
    const driver = makeFakeContainerDriver();
    return withPods(driver, (pods) =>
      Effect.gen(function* () {
        const { id } = yield* pods.create({ projectId, worktreePath });
        yield* pods.drain;
        yield* pods.stop(id);
        yield* pods.drain;
        const before = DateTime.toEpochMillis(yield* DateTime.now);
        yield* TestClock.adjust("1 second");
        // Started from its chip after the threads parked: it stays up.
        yield* pods.start(id);
        yield* pods.drain;
        expect(
          yield* pods.park(id, { settled: false, parkedSince: Effect.succeed(before), beforeStop }),
        ).toBe(false);
        // A thread that parks while the wake's start is still running counts.
        yield* TestClock.adjust("1 second");
        const during = DateTime.toEpochMillis(yield* DateTime.now);
        expect(
          yield* pods.park(id, { settled: false, parkedSince: Effect.succeed(during), beforeStop }),
        ).toBe(true);
      }),
    );
  });

  it.effect("keeps a pod running when a turn started after its threads parked", () => {
    const driver = makeFakeContainerDriver();
    return withPods(driver, (pods) =>
      Effect.gen(function* () {
        const { id } = yield* pods.create({ projectId, worktreePath });
        yield* pods.drain;
        driver.calls.length = 0;
        expect(
          yield* pods.park(id, { settled: false, parkedSince: Effect.succeed(null), beforeStop }),
        ).toBe(false);
        yield* pods.drain;
        expect((yield* pods.awaitSettled(id)).state).toBe("running");
        expect(operations(driver)).toEqual([]);
      }),
    );
  });

  it.effect("releases sessions under the pod's lock and checks again before stopping", () => {
    const driver = makeFakeContainerDriver();
    return withPods(driver, (pods) =>
      Effect.gen(function* () {
        const { id } = yield* pods.create({ projectId, worktreePath });
        yield* pods.drain;
        // A turn that starts while the sessions are released keeps its pod.
        let checks = 0;
        const parked = yield* pods.park(id, {
          settled: false,
          parkedSince: Effect.sync(() => (++checks === 1 ? Number.POSITIVE_INFINITY : null)),
          beforeStop: Effect.void,
        });
        expect(parked).toBe(false);
        expect(checks).toBe(2);
        expect((yield* pods.current(id))?.state).toBe("running");

        // A turn reads its pod under the same lock, so it sees the stop or comes before it.
        const releasing = yield* Deferred.make<void>();
        const released = yield* Deferred.make<void>();
        const parking = yield* Effect.forkChild(
          pods.park(id, {
            settled: false,
            parkedSince,
            beforeStop: Deferred.succeed(releasing, undefined).pipe(
              Effect.andThen(Deferred.await(released)),
            ),
          }),
        );
        yield* Deferred.await(releasing);
        const read = yield* Effect.forkChild(pods.current(id));
        yield* Effect.yieldNow;
        expect(read.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(released, undefined);
        expect(yield* Fiber.join(parking)).toBe(true);
        expect((yield* Fiber.join(read))?.state).toBe("stopping");
      }),
    );
  });

  it.effect("holds a wake that meets a stop in flight until it ends, then starts the pod", () => {
    const driver = makeFakeContainerDriver();
    return withPods(driver, (pods) =>
      Effect.gen(function* () {
        const { id } = yield* pods.create({ projectId, worktreePath });
        yield* pods.drain;
        yield* pods.park(id, { settled: false, parkedSince, beforeStop });
        expect((yield* pods.ensureRunning(id)).state).toBe("running");
        const steps = operations(driver);
        expect(steps.lastIndexOf(`stop t3-envtest-${id}-dind`)).toBeLessThan(
          steps.lastIndexOf(`start t3-envtest-${id}-dind`),
        );
      }),
    );
  });

  it.effect("fails a start that finds a recorded container gone, and never builds it again", () => {
    const driver = makeFakeContainerDriver();
    return withPods(driver, (pods) =>
      Effect.gen(function* () {
        const { id } = yield* pods.create({ projectId, worktreePath });
        yield* pods.drain;
        yield* pods.stop(id);
        yield* pods.drain;
        const dind = driver.containers().find((container) => container.name.endsWith("-dind"))!;
        yield* driver.driver.forHost("").removeContainer(dind.id);
        driver.calls.length = 0;
        yield* pods.start(id);
        yield* pods.drain;
        const failed = yield* pods.awaitSettled(id);
        expect(failed.state).toBe("start_failed");
        expect(failed.lastError?.message).toContain(`container ${dind.id.slice(0, 12)}`);
        expect(failed.lastError?.message).toContain("Recreate the pod");
        expect(operations(driver).some((step) => step.startsWith("createContainer"))).toBe(false);
      }),
    );
  });

  it.effect("fails a start whose stack lost a container since it stopped", () => {
    const driver = makeFakeContainerDriver();
    return withPods(driver, (pods) =>
      Effect.gen(function* () {
        const { id } = yield* pods.create({ projectId, worktreePath });
        yield* pods.drain;
        yield* pods.stop(id);
        yield* pods.drain;
        const checksStack = (call: { readonly command?: ReadonlyArray<string> }) =>
          call.command?.some(
            (part) => part.includes("t3-stack-containers") && part.includes("missing"),
          ) === true;
        driver.execExitCode((call) => (checksStack(call) ? 3 : 0));
        driver.execOutput((call) => (checksStack(call) ? "missing: feature-db-1" : ""));
        driver.calls.length = 0;
        yield* pods.start(id);
        yield* pods.drain;
        const failed = yield* pods.awaitSettled(id);
        expect(failed.state).toBe("start_failed");
        expect(failed.lastError?.message).toContain("feature-db-1");
        expect(failed.lastError?.message).toContain("compose start cannot bring them back");
        expect(operations(driver).some((step) => step.includes("compose start"))).toBe(false);

        // Brought back by hand from the pod shell, Retry starts it.
        driver.execExitCode(() => 0);
        driver.execOutput(() => "");
        yield* pods.start(id);
        yield* pods.drain;
        expect((yield* pods.awaitSettled(id)).state).toBe("running");
      }),
    );
  });

  it.effect("fails a start whose proxy DNS moved or whose hostname does not answer", () => {
    const driver = makeFakeContainerDriver();
    const router = makeFakePodHostnameRouter();
    const probes = (call: { readonly command?: ReadonlyArray<string> }) =>
      call.command?.some((part) => part.includes("openssl s_client")) === true;
    let answers = true;
    let probed: Queue.Queue<void> | undefined;
    driver.execOutput((call) => {
      if (!probes(call)) return "";
      if (probed !== undefined) Queue.offerUnsafe(probed, undefined);
      return answers ? "HTTP/1.1 200 OK" : "";
    });
    return withPods(
      driver,
      (pods) =>
        Effect.gen(function* () {
          const { id } = yield* pods.create({ projectId, worktreePath });
          yield* pods.drain;
          yield* pods.stop(id);
          yield* pods.drain;

          router.prepareAs({ type: "ready", dnsAddress: "172.21.0.9" });
          yield* pods.start(id);
          yield* pods.drain;
          const moved = yield* pods.awaitSettled(id);
          expect(moved.state).toBe("start_failed");
          expect(moved.lastError?.message).toContain("moved from 172.21.0.2 to 172.21.0.9");

          router.prepareAs({ type: "ready", dnsAddress: "172.21.0.2" });
          answers = false;
          const attempts = yield* Queue.unbounded<void>();
          probed = attempts;
          yield* pods.start(id);
          const settled = yield* Effect.forkChild(pods.awaitSettled(id));
          // The proxy gets a few seconds to load the route's certificate: each
          // attempt waits a second after the one before.
          for (let attempt = 1; attempt < 10; attempt++) {
            yield* Queue.take(attempts);
            yield* TestClock.adjust("1 second");
          }
          const silent = yield* Fiber.join(settled);
          expect(silent.state).toBe("start_failed");
          expect(silent.lastError?.message).toContain(
            `t3-envtest-${id}-api.pods.internal does not answer`,
          );
          // A start that failed serves nothing, so its route goes with it.
          expect(router.routes.has(`t3-envtest-${id}`)).toBe(false);

          answers = true;
          yield* pods.start(id);
          yield* pods.drain;
          expect((yield* pods.awaitSettled(id)).state).toBe("running");
          expect(router.routes.has(`t3-envtest-${id}`)).toBe(true);
          const probe = driver.calls.findLast(probes);
          expect(probe?.target).toBe(`t3-envtest-${id}-dind`);
          // The proxy's DNS answers only A queries; an unpinned lookup would time out.
          expect(probe?.command?.some((part) => part.includes("openssl s_client -4 "))).toBe(true);
        }),
      {
        router,
        projectFile: { pod: { services: { web: 3000, api: 8000 }, hostnames: true } },
      },
    );
  });

  it.effect("opens a failed pod's shell, so the user can look at what went wrong", () => {
    const driver = makeFakeContainerDriver();
    driver.failWhen(
      (call) => call.operation === "exec" && call.command?.includes("start") === true,
    );
    return withPods(driver, (pods) =>
      Effect.gen(function* () {
        const { id } = yield* pods.create({ projectId, worktreePath });
        yield* pods.drain;
        yield* pods.stop(id);
        yield* pods.drain;
        yield* pods.start(id);
        yield* pods.drain;
        expect((yield* pods.awaitSettled(id)).state).toBe("start_failed");
        const threadId = ThreadId.make("thread-failed-pod");
        expect(yield* pods.openShell({ podId: id, threadId })).toEqual({
          threadId,
          terminalId: "pod-shell",
        });
      }),
    );
  });
});
