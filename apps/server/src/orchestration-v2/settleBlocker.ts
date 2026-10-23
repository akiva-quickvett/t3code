import * as Effect from "effect/Effect";

import type {
  ProjectionRecordFilter,
  ProjectionRecords,
  ProjectionStoreV2Shape,
  ProjectionThreadParking,
} from "./ProjectionStore.ts";

export const SETTLE_BLOCKER_FIELDS = ["runs", "runtimeRequests", "messages"] as const;
export const SETTLE_BLOCKER_FILTER: ProjectionRecordFilter = {
  turnItemTypes: [],
  messageRoles: ["user"],
};

const ACTIVE_RUN_STATUSES = new Set(["preparing", "starting", "running", "waiting"]);

/**
 * What keeps a thread from settling, and what settling it cancels instead:
 * pending requests answered by a message, and queued automatic deliveries
 * such as a child's result. Background work never blocks a settle; it keeps
 * only the pod up.
 */
export const settleBlocker = (
  projection: Omit<ProjectionRecords<(typeof SETTLE_BLOCKER_FIELDS)[number]>, "thread">,
) => {
  const automaticMessageIds = new Set(
    projection.messages
      .filter(
        (message) =>
          message.notification !== undefined || message.delegatedCompletion !== undefined,
      )
      .map((message) => message.id),
  );
  const automaticQueuedRuns = projection.runs.filter(
    (run) => run.status === "queued" && automaticMessageIds.has(run.userMessageId),
  );
  const pendingRequests = projection.runtimeRequests.filter(
    (request) => request.status === "pending",
  );
  const blocker = pendingRequests.some(
    (request) => request.kind !== "user_input" || request.responseCapability.type !== "message",
  )
    ? "is waiting on an approval or question. Answer it before settling."
    : projection.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status))
      ? "is still running. Stop it before settling."
      : projection.runs.some((run) => run.status === "queued" && !automaticQueuedRuns.includes(run))
        ? "has a queued message. Send it or remove it from the queue before settling."
        : null;
  return { blocker, automaticQueuedRuns, pendingRequests };
};

/**
 * The threads among these that a tree settle waits for. Only threads the
 * parking flag calls busy can have a blocker, so only theirs are read.
 */
export const settleBlockedThreads = (
  projections: Pick<ProjectionStoreV2Shape, "getThreadRecords">,
  threads: ReadonlyArray<ProjectionThreadParking>,
) =>
  Effect.forEach(
    threads.filter((thread) => thread.busy),
    (thread) =>
      projections
        .getThreadRecords(thread.id, SETTLE_BLOCKER_FIELDS, SETTLE_BLOCKER_FILTER)
        .pipe(
          Effect.map((projection) => (settleBlocker(projection).blocker === null ? [] : [thread])),
        ),
  ).pipe(Effect.map((blocked) => blocked.flat()));
