// @effect-diagnostics nodeBuiltinImport:off - the stop script runs against real local processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  PodRuntimeId,
  type PodRuntimeSnapshot,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  PodRuntimeError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as PodMcpListener from "../mcp/PodMcpListener.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { ContainerDriverError } from "../pod/ContainerDriver.ts";
import { PodPaths } from "../pod/PodPaths.ts";
import * as PodRuntimeService from "../pod/PodRuntimeService.ts";
import * as PodRuntimeStore from "../pod/PodRuntimeStore.ts";
import * as WorkspaceExecutionTarget from "../pod/WorkspaceExecutionTarget.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  PodProviderPlacement,
  podRefusalReason,
  ProviderPodProcess,
} from "./PodProviderSessions.ts";
import { layerPlacement, layerProcess, POD_SESSION_ENV } from "./PodProviderSessionsLive.ts";

const podId = PodRuntimeId.make("pod-placement1");
const POD_WORKTREE = "/work/trees/pod";
const ENDPOINT = "http://host.docker.internal:40123/mcp";
const claude = ProviderDriverKind.make("claudeAgent");
const cursor = ProviderDriverKind.make("cursor");
const instanceId = ProviderInstanceId.make("claude_work");

const snapshot = (state: PodRuntimeSnapshot["state"]): PodRuntimeSnapshot => ({
  id: podId,
  projectId: ProjectId.make("project-1"),
  worktreePath: POD_WORKTREE,
  state,
  services: [],
  image: "image",
  startedAt: null,
  lastError: null,
  containerIds: [],
  volumeIds: [],
  updatedAt: "2026-10-21T00:00:00.000Z",
});

/**
 * A pod whose agent container mounts `mounted`; recreating it mounts the
 * instance's config dir, as a new agent container made from current settings would.
 */
const makeLayer = (input: {
  readonly configDir: string;
  readonly podState?: PodRuntimeSnapshot["state"];
  readonly mountedAtStart: boolean;
  readonly recreateMounts?: boolean;
  readonly instanceEnabled?: boolean;
  /** The probe's exit code in the agent container: 0 reaches the listener. */
  readonly probeExitCode?: number | null;
  /** What the pod's snapshot says of the listener when a session is placed. */
  readonly mcpListener?: PodRuntimeSnapshot["mcpListener"];
  /** Pod snapshots the status stream sends once the layer is up. */
  readonly streamed?: ReadonlyArray<PodRuntimeSnapshot>;
  /** The server keeps per-pod files under this root; a pod made before it lacks its dir. */
  readonly filesRoot?: string;
  /** The pod's own failure when a start is asked of it. */
  readonly startFailure?: string;
}) => {
  const mounted = new Set(input.mountedAtStart ? [input.configDir] : []);
  const recreated: Array<PodRuntimeId> = [];
  const started: Array<PodRuntimeId> = [];
  const probes: Array<ReadonlyArray<string>> = [];
  const notes: Array<{ readonly startedAt: string | null; readonly status: string | null }> = [];
  const noted = Deferred.makeUnsafe<void>();
  const targets = WorkspaceExecutionTarget.WorkspaceExecutionTarget.of({
    resolve: (path) =>
      Effect.succeed(
        path.startsWith(POD_WORKTREE)
          ? {
              type: "pod",
              podId,
              state: input.podState ?? "running",
              worktreePath: POD_WORKTREE,
              dockerHost: "",
            }
          : { type: "host" },
      ),
    launch: () => ({ command: "docker", args: [], env: {} }),
    exec: (_target, spec) =>
      Effect.sync(() => {
        if (spec.command[3] === "t3-mcp-probe") {
          probes.push(spec.command.slice(4));
          return { exitCode: input.probeExitCode ?? 0, timedOut: false, outputTail: "" };
        }
        return {
          exitCode: mounted.has(spec.command[2] ?? "") ? 0 : 1,
          timedOut: false,
          outputTail: "",
        };
      }),
  });
  const placed = {
    ...snapshot("running"),
    ...(input.mcpListener === undefined ? {} : { mcpListener: input.mcpListener }),
  };
  const layer = layerPlacement.pipe(
    Layer.provide(Layer.succeed(WorkspaceExecutionTarget.WorkspaceExecutionTarget, targets)),
    Layer.provide(
      Layer.mock(PodRuntimeService.PodRuntimeService)({
        recreateAgentContainer: (id) =>
          Effect.sync(() => {
            recreated.push(id);
            if (input.recreateMounts !== false) {
              mounted.add(input.configDir);
              if (input.filesRoot !== undefined) mounted.add(`${input.filesRoot}/${id}`);
            }
            return snapshot("starting");
          }),
        awaitSettled: () => Effect.succeed(snapshot("running")),
        forPath: () => Effect.succeed(placed),
        subscribe: Stream.make({
          type: "snapshot" as const,
          enabled: true,
          pods: input.streamed ?? [],
        }),
        noteMcpListener: (_id, startedAt, status) =>
          Effect.sync(() => {
            notes.push({ startedAt, status });
          }).pipe(Effect.andThen(Deferred.succeed(noted, undefined)), Effect.asVoid),
        current: () => Effect.succeed(snapshot(input.podState ?? "running")),
        ensureRunning: (id) =>
          Effect.suspend(() => {
            started.push(id);
            return input.startFailure === undefined
              ? Effect.succeed(snapshot("running"))
              : Effect.fail(
                  new PodRuntimeError({
                    reason: "invalid-state",
                    podId: id,
                    state: "start_failed",
                    lastError: {
                      operation: "start",
                      message: input.startFailure,
                      at: "2026-10-21T00:00:00.000Z",
                    },
                  }),
                );
          }),
      }),
    ),
    Layer.provide(
      Layer.succeed(PodMcpListener.PodMcpListener, {
        endpointFor: () => Effect.succeed(ENDPOINT),
        listening: Stream.empty,
      }),
    ),
    Layer.provide(
      ServerSettings.layerTest({
        providerInstances: {
          [instanceId]: {
            driver: claude,
            enabled: input.instanceEnabled ?? true,
            config: { homePath: input.configDir },
          },
        },
      }),
    ),
    Layer.provide(
      Layer.succeed(
        PodPaths,
        input.filesRoot === undefined
          ? undefined
          : {
              t3Home: "/t3",
              providerHomesDir: "/t3/userdata/providers",
              filesRoot: input.filesRoot,
              toolsDir: `${input.filesRoot}/tools`,
            },
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
  return { layer, recreated, started, probes, notes, noted };
};

const withConfigDir = <A, E, R>(use: (configDir: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* use(yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-home-" }));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const place = (input: {
  readonly cwd: string;
  readonly driver: ProviderDriverKind;
  readonly runsIn?: "host" | "pod";
  readonly podBusy?: boolean;
}) =>
  Effect.gen(function* () {
    const placement = yield* PodProviderPlacement;
    const { podBusy, ...rest } = input;
    return yield* placement.place({
      instanceId,
      runsIn: undefined,
      podBusy: () => Effect.succeed(podBusy === true),
      ...rest,
    });
  });

describe("pod provider placement", () => {
  it.effect("runs everything on the host off a pod's worktree", () =>
    withConfigDir((configDir) =>
      Effect.gen(function* () {
        expect(yield* place({ cwd: "/work/trees/host", driver: cursor })).toEqual({
          type: "host",
        });
        expect(yield* place({ cwd: "/work/trees/host", driver: claude })).toEqual({ type: "host" });
      }).pipe(Effect.provide(makeLayer({ configDir, mountedAtStart: true }).layer)),
    ),
  );

  it.effect("runs Claude in the pod with the pod listener's endpoint", () =>
    withConfigDir((configDir) => {
      const { layer, recreated } = makeLayer({ configDir, mountedAtStart: true });
      return Effect.gen(function* () {
        expect(yield* place({ cwd: `${POD_WORKTREE}/apps/web`, driver: claude })).toEqual({
          type: "pod",
          podId,
          mcpEndpoint: ENDPOINT,
          agentRecreated: false,
        });
        expect(recreated).toEqual([]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("refuses Cursor on a pod's worktree unless its role runs on the host", () =>
    withConfigDir((configDir) =>
      Effect.gen(function* () {
        const refused = yield* place({ cwd: POD_WORKTREE, driver: cursor }).pipe(Effect.flip);
        expect(refused.message).toContain("Cursor runs inside the T3 server process");
        expect(refused.message).toContain("runsIn: host");
        const asPod = yield* place({ cwd: POD_WORKTREE, driver: cursor, runsIn: "pod" }).pipe(
          Effect.flip,
        );
        expect(asPod._tag).toBe("ProviderPodRefusedError");
        expect(yield* place({ cwd: POD_WORKTREE, driver: cursor, runsIn: "host" })).toEqual({
          type: "host",
        });
      }).pipe(Effect.provide(makeLayer({ configDir, mountedAtStart: true }).layer)),
    ),
  );

  it.effect("refuses a session while the pod is not running", () =>
    withConfigDir((configDir) =>
      Effect.gen(function* () {
        const refused = yield* place({ cwd: POD_WORKTREE, driver: claude }).pipe(Effect.flip);
        expect(refused.message).toBe("The pod is stopped; start it to run this thread's agent.");
      }).pipe(
        Effect.provide(makeLayer({ configDir, podState: "stopped", mountedAtStart: true }).layer),
      ),
    ),
  );

  it.effect("reads the pod a session would run in, and starts it unless it runs", () =>
    withConfigDir((configDir) => {
      const stopped = makeLayer({ configDir, podState: "stopped", mountedAtStart: true });
      return Effect.gen(function* () {
        const placement = yield* PodProviderPlacement;
        const podOf = (cwd: string, driver: ProviderDriverKind) =>
          placement.podOf({ cwd, driver, runsIn: undefined });
        expect((yield* podOf(POD_WORKTREE, claude))?.id).toBe(podId);
        // A host session, or one its pod refuses, has no pod to wait for; opening it says why.
        expect(yield* podOf("/work/trees/host", claude)).toBeUndefined();
        expect(yield* podOf(POD_WORKTREE, cursor)).toBeUndefined();
        yield* placement.startPod(podId);
        expect(stopped.started).toEqual([podId]);
      }).pipe(Effect.provide(stopped.layer));
    }),
  );

  it.effect("fails a pod start with the pod's own reason", () =>
    withConfigDir((configDir) =>
      Effect.gen(function* () {
        const refused = yield* Effect.flatMap(PodProviderPlacement, (placement) =>
          placement.startPod(podId),
        ).pipe(Effect.flip);
        expect(refused.message).toBe(
          "The pod did not start: Checking the pod's containers failed: volume gone.",
        );
      }).pipe(
        Effect.provide(
          makeLayer({
            configDir,
            podState: "start_failed",
            mountedAtStart: true,
            startFailure: "Checking the pod's containers failed: volume gone.",
          }).layer,
        ),
      ),
    ),
  );

  it.effect("recreates the agent container for an account it does not mount", () =>
    withConfigDir((configDir) => {
      const { layer, recreated } = makeLayer({ configDir, mountedAtStart: false });
      return Effect.gen(function* () {
        expect(yield* place({ cwd: POD_WORKTREE, driver: claude })).toMatchObject({
          type: "pod",
          agentRecreated: true,
        });
        expect(recreated).toEqual([podId]);
        // Mounted now: the next session in the pod leaves the container alone.
        expect(yield* place({ cwd: POD_WORKTREE, driver: claude })).toMatchObject({
          agentRecreated: false,
        });
        expect(recreated).toEqual([podId]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("does not recreate for an account the project has not enabled", () =>
    withConfigDir((configDir) => {
      const { layer, recreated } = makeLayer({
        configDir,
        mountedAtStart: false,
        instanceEnabled: false,
      });
      return Effect.gen(function* () {
        const refused = yield* place({ cwd: POD_WORKTREE, driver: claude }).pipe(Effect.flip);
        expect(refused.message).toContain("enable the instance for this project");
        expect(recreated).toEqual([]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("does not recreate while another agent in the pod is mid-turn", () =>
    withConfigDir((configDir) => {
      const { layer, recreated } = makeLayer({ configDir, mountedAtStart: false });
      return Effect.gen(function* () {
        const refused = yield* place({ cwd: POD_WORKTREE, driver: claude, podBusy: true }).pipe(
          Effect.flip,
        );
        expect(refused.message).toContain("Another agent in this pod is mid-turn");
        expect(recreated).toEqual([]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("tells where a session must run without preparing anything", () =>
    withConfigDir((configDir) => {
      const { layer, recreated } = makeLayer({ configDir, mountedAtStart: false });
      return Effect.gen(function* () {
        const placement = yield* PodProviderPlacement;
        expect(
          yield* placement.podFor({ cwd: POD_WORKTREE, driver: claude, runsIn: undefined }),
        ).toBe(podId);
        expect(
          yield* placement.podFor({ cwd: POD_WORKTREE, driver: cursor, runsIn: "host" }),
        ).toBeUndefined();
        expect(
          (yield* placement
            .podFor({ cwd: POD_WORKTREE, driver: cursor, runsIn: undefined })
            .pipe(Effect.flip))._tag,
        ).toBe("ProviderPodRefusedError");
        expect(recreated).toEqual([]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("refuses when a new agent container still lacks the account", () =>
    withConfigDir((configDir) =>
      Effect.gen(function* () {
        const refused = yield* place({ cwd: POD_WORKTREE, driver: claude }).pipe(Effect.flip);
        expect(refused.message).toContain("still not mounted in the new agent container");
      }).pipe(
        Effect.provide(
          makeLayer({ configDir, mountedAtStart: false, recreateMounts: false }).layer,
        ),
      ),
    ),
  );
});

describe("pod provider refusals", () => {
  it("runs every driver that spawns its own process in the pod", () => {
    for (const driver of ["claudeAgent", "codex", "pi", "grok", "acpRegistry"])
      expect(podRefusalReason(ProviderDriverKind.make(driver))).toBeUndefined();
  });

  it("says why each driver that cannot run in a pod is refused", () => {
    const reason = (driver: string) => podRefusalReason(ProviderDriverKind.make(driver));
    expect(reason("cursor")).toContain("inside the T3 server process");
    expect(reason("opencode")).toContain("one server per instance");
    expect(reason("antigravity")).toContain("bound to the host");
    expect(reason("muse")).toContain("Muse");
    expect(reason("some-future-driver")).toBe(
      "Only Claude, Codex, Pi, Grok and ACP Registry sessions run in a pod.",
    );
  });

  it.effect("places Pi, Grok and ACP Registry sessions in the pod and refuses Muse", () =>
    withConfigDir((configDir) =>
      Effect.gen(function* () {
        for (const driver of ["pi", "grok", "acpRegistry"])
          expect(
            yield* place({ cwd: POD_WORKTREE, driver: ProviderDriverKind.make(driver) }),
          ).toMatchObject({ type: "pod", podId, mcpEndpoint: ENDPOINT });
        const muse = yield* place({
          cwd: POD_WORKTREE,
          driver: ProviderDriverKind.make("muse"),
        }).pipe(Effect.flip);
        expect(muse.message).toContain("runsIn: host");
      }).pipe(Effect.provide(makeLayer({ configDir, mountedAtStart: true }).layer)),
    ),
  );
});

describe("pod placement for pods made before their providers' mounts", () => {
  it.effect(
    "recreates the agent container once for a Pi session that lacks the pod's files dir",
    () =>
      withConfigDir((configDir) => {
        const { layer, recreated } = makeLayer({
          configDir,
          mountedAtStart: true,
          filesRoot: "/t3/caches/pods",
        });
        return Effect.gen(function* () {
          expect(yield* place({ cwd: POD_WORKTREE, driver: claude })).toMatchObject({
            agentRecreated: false,
          });
          const pi = ProviderDriverKind.make("pi");
          expect(yield* place({ cwd: POD_WORKTREE, driver: pi })).toMatchObject({
            type: "pod",
            agentRecreated: true,
          });
          expect(yield* place({ cwd: POD_WORKTREE, driver: pi })).toMatchObject({
            agentRecreated: false,
          });
          expect(recreated).toEqual([podId]);
        }).pipe(Effect.provide(layer));
      }),
  );
});

describe("pod MCP listener probe", () => {
  const started = { ...snapshot("running"), startedAt: "2026-10-21T01:00:00.000Z" };

  it.effect("probes from the agent container once per start and records a blocked listener", () =>
    withConfigDir((configDir) => {
      const { layer, probes, notes, noted } = makeLayer({
        configDir,
        mountedAtStart: true,
        probeExitCode: 28,
        streamed: [started, started, snapshot("stopped")],
      });
      return Effect.gen(function* () {
        yield* PodProviderPlacement;
        yield* Deferred.await(noted);
        expect(probes).toEqual([[ENDPOINT, "host.docker.internal", "40123"]]);
        expect(notes).toEqual([{ startedAt: started.startedAt, status: "blocked" }]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect.each([
    { exitCode: 0, status: "reachable" },
    { exitCode: 125, status: null },
  ])("records exit $exitCode as $status", ({ exitCode, status }) =>
    withConfigDir((configDir) => {
      const { layer, notes, noted } = makeLayer({
        configDir,
        mountedAtStart: true,
        probeExitCode: exitCode,
        streamed: [started],
      });
      return Effect.gen(function* () {
        yield* PodProviderPlacement;
        yield* Deferred.await(noted);
        expect(notes).toEqual([{ startedAt: started.startedAt, status }]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("probes again when a session is placed while the listener was blocked", () =>
    withConfigDir((configDir) => {
      const { layer, probes, notes, noted } = makeLayer({
        configDir,
        mountedAtStart: true,
        mcpListener: "blocked",
      });
      return Effect.gen(function* () {
        yield* place({ cwd: POD_WORKTREE, driver: claude });
        yield* Deferred.await(noted);
        expect(probes).toHaveLength(1);
        expect(notes).toEqual([{ startedAt: null, status: "reachable" }]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("does not probe on placement once the listener was reachable", () =>
    withConfigDir((configDir) => {
      const { layer, probes } = makeLayer({
        configDir,
        mountedAtStart: true,
        mcpListener: "reachable",
      });
      return Effect.gen(function* () {
        yield* place({ cwd: POD_WORKTREE, driver: claude });
        expect(probes).toEqual([]);
      }).pipe(Effect.provide(layer));
    }),
  );
});

/** Live processes on this machine whose environment carries exactly this session mark. */
const markedProcesses = (mark: string) =>
  NodeFS.readdirSync("/proc").filter((entry) => {
    if (!/^\d+$/.test(entry)) return false;
    try {
      return NodeFS.readFileSync(`/proc/${entry}/environ`, "utf8")
        .split("\0")
        .includes(`${POD_SESSION_ENV}=${mark}`);
    } catch {
      return false;
    }
  });

/**
 * The process layer over this machine: stop commands run here, as the
 * container would run them, but over `procRoot`, which holds only the test's
 * own processes. Each stop's mode, user and exit code are recorded.
 */
const localProcessLayer = (procRoot: string) => {
  const launched: Array<Readonly<Record<string, string>>> = [];
  const commands: Array<ReadonlyArray<string>> = [];
  const stops: Array<{
    readonly mode: string | undefined;
    readonly user: string | undefined;
    readonly exitCode: number | null;
  }> = [];
  let stopped: () => void = () => {};
  const nextStop = () => new Promise<void>((resolve) => (stopped = resolve));
  const targets = WorkspaceExecutionTarget.WorkspaceExecutionTarget.of({
    resolve: () => Effect.succeed({ type: "host" }),
    launch: (_target, spec) => {
      launched.push(spec.env ?? {});
      commands.push(spec.command);
      return { command: "docker", args: [], env: {} };
    },
    exec: (_target, spec) =>
      Effect.callback((resume) => {
        // The launch's pid file lives in the container; here it lives beside the fake /proc.
        const args = spec.command
          .slice(1)
          .map((arg, index) =>
            index === 5 && arg !== "-" ? NodePath.join(procRoot, "launch.pid") : arg,
          );
        const child = NodeChildProcess.spawn(spec.command[0]!, [...args, procRoot], {
          stdio: "ignore",
        });
        child.once("exit", (code) => {
          stops.push({ mode: spec.command[4], user: spec.user, exitCode: code });
          stopped();
          resume(Effect.succeed({ exitCode: code, timedOut: false, outputTail: "" }));
        });
      }),
  });
  const layer = layerProcess.pipe(
    Layer.provideMerge(PodRuntimeStore.layer),
    Layer.provide(Layer.succeed(WorkspaceExecutionTarget.WorkspaceExecutionTarget, targets)),
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(NodeServices.layer),
  );
  return { layer, launched, commands, stops, nextStop };
};

const spawnMarked = (mark: string, script: string) =>
  NodeChildProcess.spawn("sh", ["-c", script], {
    env: { ...process.env, [POD_SESSION_ENV]: mark },
    stdio: ["ignore", "pipe", "ignore"],
  });

/** A /proc of only these processes, linked to their real, live entries. */
const fakeProc = (root: string, children: ReadonlyArray<NodeChildProcess.ChildProcess>) => {
  for (const child of children) {
    const pids = [String(child.pid), ...descendants(child.pid!)];
    for (const pid of pids) {
      NodeFS.mkdirSync(`${root}/${pid}`, { recursive: true });
      for (const file of ["environ", "stat"])
        NodeFS.symlinkSync(`/proc/${pid}/${file}`, `${root}/${pid}/${file}`);
    }
  }
};
const descendants = (pid: number): Array<string> =>
  NodeFS.readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
    .trim()
    .split(/\s+/)
    .flatMap((child) => (child.length > 0 ? [child, ...descendants(Number(child))] : []));
const ready = (child: NodeChildProcess.ChildProcess) =>
  Effect.promise(() => new Promise((resolve) => child.stdout!.once("data", resolve)));
/** Listens now, so an exit before the effect runs is not missed. */
const exited = (child: NodeChildProcess.ChildProcess) => {
  const signal = new Promise<NodeJS.Signals | null>((resolve) =>
    child.once("exit", (_code, exitSignal) => resolve(exitSignal)),
  );
  return Effect.promise(() => signal);
};

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("pod provider process", () => {
  it.effect("marks each launch and stops every process carrying its mark", () => {
    const procRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fake-proc-"));
    const { layer, launched, commands, stops } = localProcessLayer(procRoot);
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(procRoot, { recursive: true, force: true })),
      );
      const process_ = yield* ProviderPodProcess;
      const target = {
        type: "pod",
        podId,
        state: "running",
        worktreePath: POD_WORKTREE,
        dockerHost: "",
      } as const;
      const first = process_.launch(target, { command: ["claude"], env: { KEEP: "1" } });
      process_.launch(target, { command: ["codex"] });
      const [firstEnv, secondEnv] = launched;
      expect(firstEnv).toMatchObject({ KEEP: "1" });
      // Wrapped so the launch's own pid is recorded in the container.
      expect(commands[0]).toEqual([
        "sh",
        "-c",
        expect.any(String),
        "t3-pod-launch",
        `/tmp/t3-pod-session-${firstEnv?.[POD_SESSION_ENV]}.pid`,
        "claude",
      ]);
      // An image without a writable /tmp still starts the launch.
      const wrapper = commands[0]![2]!;
      expect(
        NodeChildProcess.execFileSync(
          "sh",
          ["-c", wrapper, "t3-pod-launch", "/nonexistent/t3/launch.pid", "echo", "started"],
          { encoding: "utf8" },
        ),
      ).toBe("started\n");
      expect(firstEnv?.[POD_SESSION_ENV]).toBeDefined();
      expect(firstEnv?.[POD_SESSION_ENV]).not.toBe(secondEnv?.[POD_SESSION_ENV]);

      // The session's process ignores TERM, so only the KILL pass ends it; its
      // child left the process group and still carries the mark.
      const mark = firstEnv![POD_SESSION_ENV]!;
      const session = spawnMarked(
        mark,
        "setsid sleep 60 & trap '' TERM; echo ready; exec sleep 60 >/dev/null",
      );
      const other = spawnMarked(`${mark}-other`, "echo ready; exec sleep 60 >/dev/null");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          session.kill("SIGKILL");
          other.kill("SIGKILL");
        }),
      );
      const sessionExited = exited(session);

      yield* ready(session);
      yield* ready(other);
      fakeProc(procRoot, [session, other]);
      yield* first.stop;
      expect(yield* sessionExited).toBe("SIGKILL");
      expect(markedProcesses(mark)).toEqual([]);
      expect(other.exitCode).toBeNull();
      expect(other.signalCode).toBeNull();
      // Nothing carries the mark any more: the second stop says so.
      yield* first.stop;
      expect(stops).toEqual([
        { mode: "session", user: "0", exitCode: 0 },
        { mode: "session", user: "0", exitCode: 3 },
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("stops what an earlier server's sessions left in a pod once it runs", () => {
    const procRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fake-proc-"));
    const { layer, launched, stops, nextStop } = localProcessLayer(procRoot);
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(procRoot, { recursive: true, force: true })),
      );
      const process_ = yield* ProviderPodProcess;
      const store = yield* PodRuntimeStore.PodRuntimeStore;
      process_.launch(
        { type: "pod", podId, state: "running", worktreePath: POD_WORKTREE, dockerHost: "" },
        { command: ["claude"] },
      );
      const own = launched[0]![POD_SESSION_ENV]!;
      const earlier = spawnMarked("an-earlier-server-1", "echo ready; exec sleep 60 >/dev/null");
      const current = spawnMarked(own, "echo ready; exec sleep 60 >/dev/null");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          earlier.kill("SIGKILL");
          current.kill("SIGKILL");
        }),
      );
      yield* ready(earlier);
      yield* ready(current);
      fakeProc(procRoot, [earlier, current]);
      const earlierExited = exited(earlier);
      const swept = Effect.promise(nextStop);

      yield* store.commit(podId, [
        {
          type: "pod.created",
          podId,
          occurredAt: "2026-10-21T00:00:00.000Z",
          projectId: ProjectId.make("project-1"),
          worktreePath: POD_WORKTREE,
          image: "image",
          dockerHost: "",
          services: [],
        },
        {
          type: "pod.observed",
          podId,
          occurredAt: "2026-10-21T00:00:01.000Z",
          state: "running",
          failedOperation: null,
          message: null,
          containerIds: [],
          volumeIds: [],
        },
      ]);
      yield* swept;
      expect(yield* earlierExited).toBe("SIGTERM");
      expect(current.exitCode).toBeNull();
      expect(current.signalCode).toBeNull();
      expect(stops).toEqual([{ mode: "others", user: "0", exitCode: 0 }]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.live("stops the children a launch started without its mark", () => {
    const procRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fake-proc-"));
    const { layer, launched, stops } = localProcessLayer(procRoot);
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(procRoot, { recursive: true, force: true })),
      );
      const process_ = yield* ProviderPodProcess;
      const launch = process_.launch(
        { type: "pod", podId, state: "running", worktreePath: POD_WORKTREE, dockerHost: "" },
        { command: ["codex"] },
      );
      const mark = launched[0]![POD_SESSION_ENV]!;
      // Codex starts its stdio MCP servers with a cleaned environment.
      const session = spawnMarked(mark, `env -u ${POD_SESSION_ENV} sleep 60 & echo ready; wait`);
      const unrelated = spawnMarked("", "echo ready; exec sleep 60 >/dev/null");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          session.kill("SIGKILL");
          unrelated.kill("SIGKILL");
        }),
      );
      yield* ready(session);
      yield* ready(unrelated);
      const child = descendants(session.pid!);
      expect(child).toHaveLength(1);
      fakeProc(procRoot, [session, unrelated]);
      NodeFS.writeFileSync(NodePath.join(procRoot, "launch.pid"), `${session.pid}\n`);
      const sessionExited = exited(session);

      const [stopTook] = yield* Effect.timed(launch.stop);
      // Everything went on TERM, so the stop did not wait out its 2 s grace.
      expect(Duration.toMillis(stopTook)).toBeLessThan(1500);
      expect(yield* sessionExited).toBe("SIGTERM");
      expect(NodeFS.existsSync(`/proc/${child[0]}/stat`) ? stateOf(child[0]!) : "gone").toMatch(
        /gone|Z/,
      );
      expect(unrelated.exitCode).toBeNull();
      expect(unrelated.signalCode).toBeNull();
      expect(stops).toEqual([{ mode: "session", user: "0", exitCode: 0 }]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });
});

/** A process's state letter; Z once it is dead and awaits its parent. */
const stateOf = (pid: string) =>
  NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.charAt(0) ?? "gone";

describe("pod sweep", () => {
  it.effect("tries a failed sweep again, and a done one never", () => {
    const attempts: Array<() => void> = [];
    const sweeps: Array<string> = [];
    const nextSweep = () => new Promise<void>((resolve) => attempts.push(resolve));
    const targets = WorkspaceExecutionTarget.WorkspaceExecutionTarget.of({
      resolve: () => Effect.succeed({ type: "host" }),
      launch: () => ({ command: "docker", args: [], env: {} }),
      exec: (target, spec) =>
        Effect.suspend(() => {
          sweeps.push(`${target.podId} ${spec.command[4]}`);
          attempts.shift()?.();
          // The daemon is down for the first sweep.
          return sweeps.length === 1
            ? Effect.fail(
                new ContainerDriverError({
                  operation: "exec",
                  exitCode: null,
                  daemonMessage: null,
                }),
              )
            : Effect.succeed({ exitCode: 3, timedOut: false, outputTail: "" });
        }),
    });
    const observed = (occurredAt: string) =>
      ({
        type: "pod.observed",
        podId,
        occurredAt,
        state: "running",
        failedOperation: null,
        message: null,
        containerIds: [],
        volumeIds: [],
      }) as const;
    return Effect.gen(function* () {
      const store = yield* PodRuntimeStore.PodRuntimeStore;
      const firstSweep = nextSweep();
      yield* store.commit(podId, [
        {
          type: "pod.created",
          podId,
          occurredAt: "2026-10-21T00:00:00.000Z",
          projectId: ProjectId.make("project-1"),
          worktreePath: POD_WORKTREE,
          image: "image",
          dockerHost: "",
          services: [],
        },
        observed("2026-10-21T00:00:01.000Z"),
      ]);
      yield* Effect.promise(() => firstSweep);
      const secondSweep = nextSweep();
      yield* store.commit(podId, [observed("2026-10-21T00:00:02.000Z")]);
      yield* Effect.promise(() => secondSweep);
      // Swept now: a third event for the same start leaves the pod alone.
      // Events are handled in order, so another pod's sweep marks its turn.
      yield* store.commit(podId, [observed("2026-10-21T00:00:03.000Z")]);
      const otherPod = PodRuntimeId.make("pod-placement2");
      const otherSweep = nextSweep();
      yield* store.commit(otherPod, [
        {
          type: "pod.created",
          podId: otherPod,
          occurredAt: "2026-10-21T00:00:04.000Z",
          projectId: ProjectId.make("project-1"),
          worktreePath: "/work/trees/other",
          image: "image",
          dockerHost: "",
          services: [],
        },
        { ...observed("2026-10-21T00:00:05.000Z"), podId: otherPod },
      ]);
      yield* Effect.promise(() => otherSweep);
      expect(sweeps).toEqual([`${podId} others`, `${podId} others`, `${otherPod} others`]);
    }).pipe(
      Effect.provide(
        layerProcess.pipe(
          Layer.provideMerge(PodRuntimeStore.layer),
          Layer.provide(Layer.succeed(WorkspaceExecutionTarget.WorkspaceExecutionTarget, targets)),
          Layer.provide(SqlitePersistence.layerMemory),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
  });
});
