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
import { PodProviderPlacement } from "./PodProviderSessions.ts";
import { layerPlacement } from "./PodProviderSessionsLive.ts";

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
          [instanceId]: { driver: claude, config: { homePath: input.configDir } },
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
}) =>
  Effect.gen(function* () {
    const placement = yield* PodProviderPlacement;
    return yield* placement.place({ instanceId, runsIn: undefined, ...input });
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

  it.effect("refuses when a new agent container still lacks the account", () =>
    withConfigDir((configDir) =>
      Effect.gen(function* () {
        const refused = yield* place({ cwd: POD_WORKTREE, driver: claude }).pipe(Effect.flip);
        expect(refused.message).toContain("enable the instance for this project");
      }).pipe(
        Effect.provide(
          makeLayer({ configDir, mountedAtStart: false, recreateMounts: false }).layer,
        ),
      ),
    ),
  );
});
