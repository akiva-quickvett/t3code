// @effect-diagnostics nodeBuiltinImport:off - the stop script runs against real local processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  PodRuntimeId,
  type PodRuntimeSnapshot,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as PodMcpListener from "../mcp/PodMcpListener.ts";
import * as PodRuntimeService from "../pod/PodRuntimeService.ts";
import * as WorkspaceExecutionTarget from "../pod/WorkspaceExecutionTarget.ts";
import * as ServerSettings from "../serverSettings.ts";
import { PodProviderPlacement, ProviderPodProcess } from "./PodProviderSessions.ts";
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
}) => {
  const mounted = new Set(input.mountedAtStart ? [input.configDir] : []);
  const recreated: Array<PodRuntimeId> = [];
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
      Effect.succeed({ exitCode: mounted.has(spec.command[2] ?? "") ? 0 : 1, timedOut: false }),
  });
  const layer = layerPlacement.pipe(
    Layer.provide(Layer.succeed(WorkspaceExecutionTarget.WorkspaceExecutionTarget, targets)),
    Layer.provide(
      Layer.mock(PodRuntimeService.PodRuntimeService)({
        recreateAgentContainer: (id) =>
          Effect.sync(() => {
            recreated.push(id);
            if (input.recreateMounts !== false) mounted.add(input.configDir);
            return snapshot("starting");
          }),
        awaitSettled: () => Effect.succeed(snapshot("running")),
        forPath: () => Effect.succeed(snapshot("running")),
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
    Layer.provide(NodeServices.layer),
  );
  return { layer, recreated };
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

describe.skipIf(process.platform !== "linux")("pod provider process", () => {
  it.effect("marks each launch and stops every process carrying its mark", () =>
    Effect.gen(function* () {
      const launched: Array<Readonly<Record<string, string>>> = [];
      const stops: Array<{ readonly user: string | undefined; readonly exitCode: number | null }> =
        [];
      // Runs the stop command here, against this machine's /proc, as the container would.
      const targets = WorkspaceExecutionTarget.WorkspaceExecutionTarget.of({
        resolve: () => Effect.succeed({ type: "host" }),
        launch: (_target, spec) => {
          launched.push(spec.env ?? {});
          return { command: "docker", args: [], env: {} };
        },
        exec: (_target, spec) =>
          Effect.callback((resume) => {
            const child = NodeChildProcess.spawn(spec.command[0]!, spec.command.slice(1), {
              stdio: "ignore",
            });
            child.once("exit", (code) => {
              stops.push({ user: spec.user, exitCode: code });
              resume(Effect.succeed({ exitCode: code, timedOut: false }));
            });
          }),
      });
      const process_ = yield* ProviderPodProcess.pipe(
        Effect.provide(
          layerProcess.pipe(
            Layer.provide(
              Layer.succeed(WorkspaceExecutionTarget.WorkspaceExecutionTarget, targets),
            ),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
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
      expect(firstEnv?.[POD_SESSION_ENV]).toBeDefined();
      expect(firstEnv?.[POD_SESSION_ENV]).not.toBe(secondEnv?.[POD_SESSION_ENV]);

      const spawnMarked = (mark: string, script: string) =>
        NodeChildProcess.spawn("sh", ["-c", script], {
          env: { ...process.env, [POD_SESSION_ENV]: mark },
          stdio: ["ignore", "pipe", "ignore"],
        });
      const ready = (child: NodeChildProcess.ChildProcess) =>
        Effect.promise(() => new Promise((resolve) => child.stdout!.once("data", resolve)));
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
      const sessionExited = new Promise<NodeJS.Signals | null>((resolve) =>
        session.once("exit", (_code, signal) => resolve(signal)),
      );

      yield* ready(session);
      yield* ready(other);
      yield* first.stop;
      expect(yield* Effect.promise(() => sessionExited)).toBe("SIGKILL");
      expect(markedProcesses(mark)).toEqual([]);
      expect(other.exitCode).toBeNull();
      expect(other.signalCode).toBeNull();
      // Nothing carries the mark any more: the second stop says so.
      yield* first.stop;
      expect(stops).toEqual([
        { user: "0", exitCode: 0 },
        { user: "0", exitCode: 3 },
      ]);
    }).pipe(Effect.scoped),
  );
});
