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
  /** The tree was seen done for this pull request before. */
  readonly doneBefore: boolean;
  readonly nowMs: number;
}

/**
 * Work is a run requested after the pull request was linked: the turn that opened and linked it
 * is still investigating. Null while the tree is quiet but may only be between turns; the caller
 * leaves the labels as they are.
 */
export function deriveAgentState(input: AgentStateInput): PullRequestAgentState | null {
  const work = input.tree.filter(
    (node) =>
      node.latestRunRequestedAtMs !== null && node.latestRunRequestedAtMs >= input.linkedAtMs,
  );
  const working = work.filter((node) => node.running);
  if (working.some((node) => isReviewerRole(node.rolePresetId))) return "reviewing";
  if (working.length > 0) return input.doneBefore ? "revising" : "building";
  if (work.length === 0) return input.doneBefore ? "done" : "investigating";
  // A run that started before the link may still be going; the tree is not done while it is.
  if (input.tree.some((node) => node.running)) return null;
  const quietSinceMs = Math.max(...work.map((node) => node.latestRunCompletedAtMs ?? input.nowMs));
  return input.nowMs - quietSinceMs >= AGENT_DONE_SETTLE_MS ? "done" : null;
}
