import type { OrchestrationV2AppThread, OrchestrationV2DomainEvent } from "@t3tools/contracts";

import type { ProjectionThreadParking } from "./ProjectionStore.ts";
import { isSnoozed } from "./ThreadSettlementService.ts";

/**
 * Parked: snoozed or settled with no active or queued run and no pending
 * request. A pod stops only while every thread on its worktree is parked.
 */
export const isThreadParked = (thread: ProjectionThreadParking, nowMs: number): boolean =>
  !thread.busy && (thread.settled || isSnoozed({ ...thread, pendingRuntimeRequest: null }, nowMs));

/** Events that change whether a thread is parked: its row, its runs and its requests. */
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
