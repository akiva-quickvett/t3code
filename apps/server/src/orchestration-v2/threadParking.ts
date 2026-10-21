import type { OrchestrationV2AppThread, OrchestrationV2DomainEvent } from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";

import type { ProjectionThreadParking } from "./ProjectionStore.ts";
import { isSnoozed } from "./ThreadSettlementService.ts";

/**
 * Parked: snoozed or settled with no active or queued run and no pending
 * request. A pod stops only while every thread on its worktree is parked.
 */
export const isThreadParked = (thread: ProjectionThreadParking, nowMs: number): boolean =>
  !thread.busy && (thread.settled || isSnoozed({ ...thread, pendingRuntimeRequest: null }, nowMs));

/**
 * When the last of these threads parked: its snooze, or for a settled thread
 * its settle. Settle bumps `updatedAt`; `settledAt` would not do, since
 * auto-settle backdates it to the last activity. A later write to a settled
 * thread (a title, a pull request sync) also moves `updatedAt`, which can
 * park a pod the user started meanwhile; a settled thread's pod has no turn
 * to serve, so that is accepted.
 */
export const lastParkedAtMs = (threads: ReadonlyArray<ProjectionThreadParking>): number =>
  Math.max(
    Number.NEGATIVE_INFINITY,
    ...threads.flatMap((thread) => {
      const at = thread.settled ? thread.updatedAt : thread.snoozedAt;
      return at === null ? [] : [DateTime.toEpochMillis(at)];
    }),
  );

/**
 * Events that change whether a thread is parked: its row, its runs, its
 * requests, and its provider thread, whose update is how background work
 * ending after the run is told. Streamed turn items are left out: they fire
 * per item, and a run's end follows them.
 */
const PARKING_EVENTS = new Set<OrchestrationV2DomainEvent["type"]>([
  "thread.archived",
  "thread.unarchived",
  "thread.settled",
  "thread.unsettled",
  "thread.snoozed",
  "thread.unsnoozed",
  "thread.pinned",
  "thread.metadata-updated",
  "run.updated",
  "runtime-request.updated",
  "provider-thread.updated",
]);

export const changesParking = (event: OrchestrationV2DomainEvent) => PARKING_EVENTS.has(event.type);

/** The thread row a parking event carries; run and request events carry none. */
export const parkingThreadRow = (
  event: OrchestrationV2DomainEvent,
): OrchestrationV2AppThread | undefined => {
  switch (event.type) {
    case "thread.archived":
    case "thread.unarchived":
    case "thread.settled":
    case "thread.unsettled":
    case "thread.snoozed":
    case "thread.unsnoozed":
    case "thread.pinned":
    case "thread.metadata-updated":
      return event.payload;
    default:
      return undefined;
  }
};
