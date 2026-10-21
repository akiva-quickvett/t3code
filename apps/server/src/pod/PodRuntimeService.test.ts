import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PodRuntimeId,
  ProjectId,
  type T3ProjectFile,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
import * as PodHostPorts from "./PodHostPorts.ts";
import * as PodRuntimeService from "./PodRuntimeService.ts";
import * as PodRuntimeStore from "./PodRuntimeStore.ts";
import {
  makeFakeContainerDriver,
  type FakeContainerDriver,
} from "./testkit/FakeContainerDriver.ts";

const projectId = ProjectId.make("project-pods");
const worktreePath = "/work/pods/feature";
const ENVIRONMENT = "env-test";

/** Ports something else on the host listens on, as `address:port`. */
interface FakeHostNetwork {
  readonly busy: Set<string>;
  tailnetAddress: string | null;
}

const makeFakeHostNetwork = (): FakeHostNetwork => ({ busy: new Set(), tailnetAddress: null });

const harness = (options: {
  readonly driver: FakeContainerDriver;
  readonly enabled?: boolean;
  readonly publishOnTailnet?: boolean;
  readonly projectFile?: T3ProjectFile | null;
  readonly network?: FakeHostNetwork;
}) => {
  const opened: Array<string> = [];
  const network = options.network ?? makeFakeHostNetwork();
  /** What the preview's server list probes for each pod, by owner. */
  const discovery = new Map<string, ReadonlyArray<string>>();
  const base = Layer.mergeAll(
    PodRuntimeStore.layer,
    Layer.succeed(ContainerDriver.ContainerDriver, options.driver.driver),
    ServerSettings.layerTest({
      podRuntime: {
        enabled: options.enabled ?? true,
        publishOnTailnet: options.publishOnTailnet ?? false,
      },
    }),
    Layer.mock(ProjectService.ProjectService)({
      getById: () => Effect.succeed(Option.some({ workspaceRoot: "/work/repo" } as never)),
    }),
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
  body: (pods: PodRuntimeService.PodRuntimeService["Service"]) => Effect.Effect<A, E, never>,
  options: Omit<Parameters<typeof harness>[0], "driver"> = {},
) =>
  Effect.gen(function* () {
    const pods = yield* PodRuntimeService.PodRuntimeService;
    yield* pods.drain;
    return yield* body(pods);
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
    driver.execExitCode((call) => (call.target?.endsWith("-dind") ? 1 : 0));
    return withPods(driver, (pods) =>
      Effect.gen(function* () {
        const { id } = yield* pods.create({ projectId, worktreePath });
        const settled = yield* Effect.forkChild(pods.awaitSettled(id));
        // Readiness probes are spaced a second apart; run the clock past all of them.
        for (let second = 0; second < 90; second++) yield* TestClock.adjust("1 second");
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
