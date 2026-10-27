import type { ThreadId } from "@t3tools/contracts";

/**
 * "Show in parent chat" names a cell before the parent's timeline mounts. The row holding it
 * starts expanded and is scrolled to once; the next request replaces this one.
 */
export interface TimelineReveal {
  readonly threadKey: string;
  readonly childThreadId: ThreadId;
  scrolled: boolean;
  expanded: boolean;
}

let pending: TimelineReveal | null = null;

export function revealSubagentInTimeline(threadKey: string, childThreadId: ThreadId) {
  pending = { threadKey, childThreadId, scrolled: false, expanded: false };
}

export function pendingTimelineReveal(threadKey: string) {
  return pending?.threadKey === threadKey ? pending : null;
}

/** Clears the request once its row has both expanded and been scrolled to. */
export function settleTimelineReveal(reveal: TimelineReveal) {
  if (pending === reveal && reveal.scrolled && reveal.expanded) pending = null;
}
