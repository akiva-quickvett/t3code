import type {
  AgentRolePresetRunsIn,
  PodRuntimeId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type * as ContainerDriver from "../pod/ContainerDriver.ts";
import type * as WorkspaceExecutionTarget from "../pod/WorkspaceExecutionTarget.ts";

/** Drivers whose sessions are a process T3 spawns, which `docker exec` can put in a pod. */
const POD_DRIVERS = new Set<string>(["claudeAgent", "codex"]);

const POD_REFUSALS: Record<string, string> = {
  cursor: "Cursor runs inside the T3 server process, so its sessions cannot run in a pod.",
  opencode:
    "OpenCode serves every directory from one server per instance, so its sessions cannot run in a pod.",
  antigravity:
    "Antigravity's profile isolation and installer are bound to the host, so its sessions cannot run in a pod.",
};

/**
 * Why a session of this driver is refused on a pod's worktree unless its role
 * preset says `runsIn: host`; undefined for drivers that run in the pod.
 */
export const podRefusalReason = (driver: ProviderDriverKind): string | undefined =>
  POD_DRIVERS.has(driver)
    ? undefined
    : (POD_REFUSALS[driver] ?? "Only Claude and Codex sessions run in a pod for now.");

/** The set variables of a process environment, as `docker exec` passes them by name. */
export const podEnvironmentValues = (
  environment: NodeJS.ProcessEnv | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(environment ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

export class ProviderPodRefusedError extends Schema.TaggedError<ProviderPodRefusedError>()(
  "ProviderPodRefusedError",
  {
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export type ProviderSessionPlacement =
  | { readonly type: "host" }
  | {
      readonly type: "pod";
      readonly podId: PodRuntimeId;
      readonly mcpEndpoint: string;
      /** The agent container was replaced, ending the pod's other sessions. */
      readonly agentRecreated: boolean;
    };

export const HOST_PLACEMENT: ProviderSessionPlacement = { type: "host" };

/**
 * Where a provider session runs. A pod's worktree runs Claude and Codex in the
 * pod; another driver runs on the host only when the thread's role preset
 * says `runsIn: host`, and is refused otherwise, so nothing runs on the host
 * by accident while the worktree's stack lives in the pod.
 */
export const PodProviderPlacement = Context.Reference<{
  readonly place: (input: {
    readonly cwd: string | null;
    readonly driver: ProviderDriverKind;
    readonly instanceId: ProviderInstanceId;
    readonly runsIn: AgentRolePresetRunsIn | undefined;
  }) => Effect.Effect<ProviderSessionPlacement, ProviderPodRefusedError>;
  /** The pod whose worktree holds `cwd`. */
  readonly podOf: (cwd: string) => Effect.Effect<PodRuntimeId | undefined>;
}>("t3/provider/PodProviderSessions/PodProviderPlacement", {
  defaultValue: () => ({
    place: () => Effect.succeed(HOST_PLACEMENT),
    podOf: () => Effect.succeed(undefined),
  }),
});

/**
 * How a pod-capable driver spawns its process: the pod for a path on a pod's
 * worktree, the host otherwise. Its default is the host, as without pods.
 */
export const ProviderPodProcess = Context.Reference<{
  readonly resolve: (
    cwd: string | null | undefined,
  ) => Effect.Effect<WorkspaceExecutionTarget.PodExecutionTarget | undefined>;
  /** Where the host's provider binary runs from in the pod. */
  readonly command: (hostCommand: string) => Effect.Effect<string>;
  /** A host command that runs `spec` in the pod as the host user, with only the env it names. */
  readonly launch: (
    target: WorkspaceExecutionTarget.PodExecutionTarget,
    spec: Omit<ContainerDriver.PodExecSpec, "user">,
  ) => ContainerDriver.PodExecLaunch;
}>("t3/provider/PodProviderSessions/ProviderPodProcess", {
  defaultValue: () => ({
    resolve: () => Effect.succeed(undefined),
    command: Effect.succeed,
    launch: () => {
      throw new Error("No pod runtime is available to launch a provider process.");
    },
  }),
});
