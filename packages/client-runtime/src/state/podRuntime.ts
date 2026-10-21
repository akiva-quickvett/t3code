import {
  POD_RUNTIME_REQUESTS,
  podRuntimeRetryRequest,
  type PodRuntimeRequest,
  type PodRuntimeSnapshot,
  type PodRuntimeState,
  type PodRuntimeStreamEvent,
} from "@t3tools/contracts";

export interface PodRuntimeLiveState {
  readonly enabled: boolean;
  readonly pods: ReadonlyArray<PodRuntimeSnapshot>;
}

export const EMPTY_POD_RUNTIME_STATE: PodRuntimeLiveState = { enabled: false, pods: [] };

/** Folds the server's snapshot-then-changes stream; a removed pod leaves the list. */
export function reducePodRuntimeEvent(
  state: PodRuntimeLiveState,
  event: PodRuntimeStreamEvent,
): PodRuntimeLiveState {
  if (event.type === "snapshot") return { enabled: event.enabled, pods: event.pods };
  const others = state.pods.filter((pod) => pod.id !== event.pod.id);
  return {
    ...state,
    pods: event.pod.state === "removed" ? others : [...others, event.pod],
  };
}

const trimTrailingSeparators = (path: string) => path.replace(/[\\/]+$/, "");

/** The pod a worktree runs in, if any. */
export function podForWorktree(
  pods: ReadonlyArray<PodRuntimeSnapshot>,
  worktreePath: string | null | undefined,
): PodRuntimeSnapshot | undefined {
  if (worktreePath == null) return undefined;
  const target = trimTrailingSeparators(worktreePath);
  return pods.find((pod) => trimTrailingSeparators(pod.worktreePath) === target);
}

export type PodRuntimeTone = "running" | "busy" | "idle" | "failed";

const STATE_PRESENTATION: Readonly<
  Record<PodRuntimeState, { readonly label: string; readonly tone: PodRuntimeTone }>
> = {
  creating: { label: "creating…", tone: "busy" },
  starting: { label: "starting…", tone: "busy" },
  running: { label: "running", tone: "running" },
  stopping: { label: "stopping…", tone: "busy" },
  stopped: { label: "stopped", tone: "idle" },
  frozen: { label: "frozen", tone: "idle" },
  start_failed: { label: "failed to start", tone: "failed" },
  stop_failed: { label: "failed to stop", tone: "failed" },
  removing: { label: "removing…", tone: "busy" },
  removed: { label: "removed", tone: "idle" },
};

export function podRuntimeStatePresentation(state: PodRuntimeState) {
  return STATE_PRESENTATION[state];
}

export type PodRuntimeAction =
  | {
      readonly kind: "request";
      readonly request: PodRuntimeRequest;
      readonly label: string;
      /** Loses the stack's data or the pod's record; ask before running it. */
      readonly destructive: boolean;
      readonly force?: boolean;
    }
  | { readonly kind: "openShell"; readonly label: string };

const REQUEST_LABELS: Readonly<Record<PodRuntimeRequest, string>> = {
  start: "Start pod",
  stop: "Stop pod",
  recreate: "Recreate pod",
  recreateAgentContainer: "Recreate agent container",
  remove: "Remove pod",
};

const DESTRUCTIVE_REQUESTS = new Set<PodRuntimeRequest>(["recreate", "remove"]);

/**
 * What a pod in its current state offers, in menu order: Retry first for a
 * failure, then the requests its state allows. Each way in has its way out:
 * Stop and Start, a failure and Retry, and "Remove anyway" once a removal was
 * refused.
 */
export function podRuntimeActions(pod: PodRuntimeSnapshot): ReadonlyArray<PodRuntimeAction> {
  const actions: Array<PodRuntimeAction> = [];
  const retry = pod.lastError === null ? null : podRuntimeRetryRequest(pod.lastError);
  const failed = pod.state === "start_failed" || pod.state === "stop_failed";
  if (failed && retry !== null)
    actions.push({ kind: "request", request: retry, label: "Retry", destructive: false });
  if (pod.state === "running") actions.push({ kind: "openShell", label: "Open pod shell" });
  for (const request of Object.keys(POD_RUNTIME_REQUESTS) as PodRuntimeRequest[]) {
    if (failed && request === retry) continue;
    if (!POD_RUNTIME_REQUESTS[request].from.includes(pod.state)) continue;
    actions.push({
      kind: "request",
      request,
      label: REQUEST_LABELS[request],
      destructive: DESTRUCTIVE_REQUESTS.has(request),
    });
  }
  if (pod.state === "stop_failed" && pod.lastError?.operation === "remove")
    actions.push({
      kind: "request",
      request: "remove",
      label: "Remove anyway",
      destructive: true,
      force: true,
    });
  return actions;
}
