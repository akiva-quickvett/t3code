import { CommandId, type ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { settleBlockedThreads } from "./settleBlocker.ts";
import { changesParking, parkingThreadRow } from "./threadParking.ts";

/**
 * Applies a "Snooze when idle", or a tree settle, once the work it waited for
 * has ended: the thread's own, or for a tree, every thread's in it. A wake
 * time that passed while waiting drops a snooze request instead.
 */
export class SnoozeWhenIdleReactor extends Context.Service<
  SnoozeWhenIdleReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Looks at every waiting thread now and resolves once each is handled. */
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/SnoozeWhenIdleReactor") {}

export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const crypto = yield* Crypto.Crypto;
  // The waiting threads, so a turn ending on a server with none reads nothing.
  const waiting = new Set<ThreadId>(
    (yield* projections
      .getThreadParking({ whenIdle: true })
      .pipe(Effect.orElseSucceed(() => []))).map((thread) => thread.id),
  );

  const apply = Effect.fn("SnoozeWhenIdleReactor.apply")(function* (threadId: ThreadId) {
    const tree = yield* projections.getThreadParking({ treeOf: threadId });
    const thread = tree.find((candidate) => candidate.id === threadId);
    const request = thread?.snoozeWhenIdle ?? null;
    const settle = thread?.settleWhenIdle ?? null;
    if (thread === undefined || (request === null && settle === null) || thread.archived) {
      waiting.delete(threadId);
      return;
    }
    const working = (scope: "thread" | "tree") =>
      scope === "tree"
        ? tree.some((candidate) => !candidate.archived && !candidate.settled && candidate.busy)
        : thread.busy;
    // Fresh ids each time: a command refused because work started meanwhile is tried again later.
    const uuid = yield* crypto.randomUUIDv4();
    // A settle supersedes a snooze: settling drops the snooze it waited with.
    if (settle !== null) {
      const blocked = yield* settleBlockedThreads(
        projections,
        settle.scope === "tree"
          ? tree.filter(
              (candidate) =>
                !candidate.archived && (candidate.id === threadId || !candidate.settled),
            )
          : [thread],
      );
      if (blocked.length > 0) return;
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make(`server:settle-when-idle:${threadId}:${uuid}`),
        threadId,
        scope: settle.scope,
        // A cancel or new work that lands between this read and the root's lock wins.
        whenIdleRequestedAt: settle.requestedAt,
      });
      return;
    }
    if (request === null) return;
    const commandId = CommandId.make(`server:snooze-when-idle:${threadId}:${uuid}`);
    if (Date.parse(request.snoozedUntil) <= DateTime.toEpochMillis(yield* DateTime.now)) {
      yield* orchestrator.dispatch({
        type: "thread.unsnooze",
        commandId,
        threadId,
        reason: "user",
        scope: "thread",
      });
      return;
    }
    if (working(request.scope)) return;
    yield* orchestrator.dispatch({
      type: "thread.snooze",
      commandId,
      threadId,
      snoozedUntil: request.snoozedUntil,
      scope: request.scope,
      // A cancel or new work that lands between this read and the root's lock wins.
      whenIdleRequestedAt: request.requestedAt,
    });
  });

  const queued = new Set<ThreadId>();
  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    Effect.suspend(() => {
      queued.delete(threadId);
      return apply(threadId).pipe(
        Effect.catch((error) =>
          Effect.logWarning("a snooze or settle waiting for idle could not be applied yet", {
            threadId,
            error: error._tag,
          }),
        ),
      );
    }),
  );
  const enqueueAll = Effect.suspend(() =>
    Effect.forEach(
      [...waiting].filter((threadId) => !queued.has(threadId)),
      (threadId) => {
        queued.add(threadId);
        return worker.enqueue(threadId);
      },
      { discard: true },
    ),
  );

  const onEvent = (event: Parameters<typeof changesParking>[0]) => {
    if (!changesParking(event)) return Effect.void;
    const row = parkingThreadRow(event);
    if (row !== undefined) {
      if (row.snoozeWhenIdle == null && row.settleWhenIdle == null) waiting.delete(row.id);
      else waiting.add(row.id);
    }
    // Work ending anywhere may idle a tree whose root is waiting.
    return waiting.size === 0 ? Effect.void : enqueueAll;
  };

  const start: SnoozeWhenIdleReactor["Service"]["start"] = Effect.fn("SnoozeWhenIdleReactor.start")(
    function* () {
      yield* forkParked(
        Stream.runForEach(orchestrator.streamDomainEvents, onEvent).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("snooze-when-idle event stream failed", { cause }),
          ),
        ),
      );
      // Wake times pass by the clock, with no event to say so.
      yield* forkParked(enqueueAll.pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid));
    },
  );

  return SnoozeWhenIdleReactor.of({
    start,
    sweep: Effect.gen(function* () {
      for (const thread of yield* projections
        .getThreadParking({ whenIdle: true })
        .pipe(Effect.orElseSucceed(() => [])))
        waiting.add(thread.id);
      yield* enqueueAll;
      yield* worker.drain;
    }),
  });
});

export const layer = Layer.effect(SnoozeWhenIdleReactor, make);
