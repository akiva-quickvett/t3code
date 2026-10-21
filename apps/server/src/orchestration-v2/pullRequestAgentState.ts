import type { PullRequestAgentState, ThreadId } from "@t3tools/contracts";

/**
 * A tree that just went quiet is often between turns: a finished child's result is on its way
 * to the parent, which then starts again. Done waits this long so that gap is not taken for
 * the first done, which would make all later work Revising.
 */
export const AGENT_DONE_SETTLE_MS = 2 * 60 * 1_000;

/** One thread of a work tree, as the label rules see it. */
export interface WorkTreeNode {
  readonly threadId: ThreadId;
  /** The supervisor or delegating parent; null for a thread nothing launched. */
  readonly parentThreadId: ThreadId | null;
  readonly rolePresetId: string | null;
  /** A run is preparing, starting, running, waiting, or queued behind one. */
  readonly running: boolean;
  readonly latestRunRequestedAtMs: number | null;
  readonly latestRunCompletedAtMs: number | null;
}

/** The seeded reviewer presets are `review-t1` to `review-t5` and `review-t3-grok`. */
export function isReviewerRole(rolePresetId: string | null): boolean {
  return rolePresetId !== null && (rolePresetId === "review" || rolePresetId.startsWith("review-"));
}

/** The thread and every thread it launched or delegated to, transitively. */
export function workTreeOf(
  rootThreadId: ThreadId,
  nodes: ReadonlyArray<WorkTreeNode>,
): ReadonlyArray<WorkTreeNode> {
  const children = new Map<ThreadId, Array<WorkTreeNode>>();
  const byId = new Map<ThreadId, WorkTreeNode>();
  for (const node of nodes) {
    byId.set(node.threadId, node);
    if (node.parentThreadId === null) continue;
    const siblings = children.get(node.parentThreadId) ?? [];
    siblings.push(node);
    children.set(node.parentThreadId, siblings);
  }
  const root = byId.get(rootThreadId);
  if (root === undefined) return [];
  const tree: Array<WorkTreeNode> = [];
  const seen = new Set<ThreadId>();
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (seen.has(node.threadId)) continue;
    seen.add(node.threadId);
    tree.push(node);
    pending.push(...(children.get(node.threadId) ?? []));
  }
  return tree;
}

export interface AgentStateInput {
  readonly tree: ReadonlyArray<WorkTreeNode>;
  readonly linkedAtMs: number;
  /** When the tree was last seen done for this pull request; null until then. */
  readonly doneAtMs: number | null;
  readonly nowMs: number;
}

export interface AgentStateResult {
  readonly state: PullRequestAgentState;
  /**
   * Done after work the last recorded done has not seen. Recording it turns later work into
   * Revising, and starts the next revision's review phase after it.
   */
  readonly recordDone: boolean;
}

const requestedSince = (node: WorkTreeNode, sinceMs: number) =>
  node.latestRunRequestedAtMs !== null && node.latestRunRequestedAtMs >= sinceMs;

/**
 * Work is a run requested after the pull request was linked; the turn that opened and linked it
 * is still investigating while it runs. Null while the tree is quiet but may only be between
 * turns; the caller leaves the labels as they are.
 */
export function deriveAgentState(input: AgentStateInput): AgentStateResult | null {
  const doneBefore = input.doneAtMs !== null;
  const work = input.tree.filter((node) => requestedSince(node, input.linkedAtMs));
  if (work.some((node) => node.running)) {
    // Fixes between review rounds stay Reviewing: once a reviewer has worked in this phase, the
    // label stays there until the tree is done, rather than flipping every round.
    const phaseStartMs = input.doneAtMs ?? input.linkedAtMs;
    const reviewed = input.tree.some(
      (node) => isReviewerRole(node.rolePresetId) && requestedSince(node, phaseStartMs),
    );
    const state = reviewed ? "reviewing" : doneBefore ? "revising" : "building";
    return { state, recordDone: false };
  }
  // Only a run from before the link is going: the turn that is opening the pull request.
  if (input.tree.some((node) => node.running)) {
    return doneBefore ? null : { state: "investigating", recordDone: false };
  }
  // The turn that linked it counts once it ends, so a pull request built and opened in one turn
  // reaches Done; it records no done, since no work followed the link.
  const finished = input.tree.filter(
    (node) =>
      requestedSince(node, input.linkedAtMs) ||
      (node.latestRunCompletedAtMs !== null && node.latestRunCompletedAtMs >= input.linkedAtMs),
  );
  if (finished.length === 0) {
    return { state: doneBefore ? "done" : "investigating", recordDone: false };
  }
  // A run that ended without a completion time counts from its request.
  const quietSinceMs = Math.max(
    ...finished.map((node) =>
      Math.max(node.latestRunCompletedAtMs ?? 0, node.latestRunRequestedAtMs ?? 0),
    ),
  );
  if (input.nowMs - quietSinceMs < AGENT_DONE_SETTLE_MS) return null;
  const unseenWork = input.doneAtMs === null ? work.length > 0 : input.doneAtMs < quietSinceMs;
  return { state: "done", recordDone: unseenWork };
}
