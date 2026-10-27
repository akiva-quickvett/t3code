import type { ThreadId } from "@t3tools/contracts";

/**
 * "Show in parent chat" names a cell before the parent's timeline mounts. The timeline
 * resolves it on its first settled layout: it expands and scrolls to the row holding the cell,
 * or drops the request when no loaded row holds it. The next request replaces this one.
 */
export interface TimelineReveal {
  readonly threadKey: string;
  readonly childThreadId: ThreadId;
}

let pending: TimelineReveal | null = null;

export function revealSubagentInTimeline(threadKey: string, childThreadId: ThreadId) {
  pending = { threadKey, childThreadId };
}

export function pendingTimelineReveal(threadKey: string) {
  return pending?.threadKey === threadKey ? pending : null;
}

export function clearTimelineReveal(reveal: TimelineReveal) {
  if (pending === reveal) pending = null;
}
