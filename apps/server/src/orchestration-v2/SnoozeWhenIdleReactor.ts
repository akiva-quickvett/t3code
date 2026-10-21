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
import { changesParking, parkingThreadRow } from "./threadParking.ts";

/**
 * Applies a "Snooze when idle" once the work it waited for has ended: the
 * thread's own, or for a tree, every thread's in it. A wake time that passed
 * while waiting drops the request instead.
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
      .getThreadParking({ snoozeWhenIdle: true })
      .pipe(Effect.orElseSucceed(() => []))).map((thread) => thread.id),
  );

  const apply = Effect.fn("SnoozeWhenIdleReactor.apply")(function* (threadId: ThreadId) {
    const tree = yield* projections.getThreadParking({ treeOf: threadId });
    const thread = tree.find((candidate) => candidate.id === threadId);
    const request = thread?.snoozeWhenIdle ?? null;
    if (thread === undefined || request === null || thread.archived) {
      waiting.delete(threadId);
      return;
    }
    // Fresh ids each time: a snooze refused because work started meanwhile is tried again later.
    const commandId = CommandId.make(
      `server:snooze-when-idle:${threadId}:${yield* crypto.randomUUIDv4()}`,
    );
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
    const working =
      request.scope === "tree"
        ? tree.some((candidate) => !candidate.archived && !candidate.settled && candidate.busy)
        : thread.busy;
    if (working) return;
    yield* orchestrator.dispatch({
      type: "thread.snooze",
      commandId,
      threadId,
      snoozedUntil: request.snoozedUntil,
      scope: request.scope,
    });
  });

  const queued = new Set<ThreadId>();
  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    Effect.suspend(() => {
      queued.delete(threadId);
      return apply(threadId).pipe(
        Effect.catch((error) =>
          Effect.logWarning("a snooze waiting for idle could not be applied yet", {
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
      if (row.snoozeWhenIdle == null) waiting.delete(row.id);
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
        .getThreadParking({ snoozeWhenIdle: true })
        .pipe(Effect.orElseSucceed(() => [])))
        waiting.add(thread.id);
      yield* enqueueAll;
      yield* worker.drain;
    }),
  });
});

export const layer = Layer.effect(SnoozeWhenIdleReactor, make);
