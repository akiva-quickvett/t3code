import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { podParkOperation } from "../pod/PodRuntimeLifecycle.ts";
import * as PodRuntimeService from "../pod/PodRuntimeService.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import {
  changesParking,
  isThreadParked,
  lastParkedAtMs,
  parkingThreadRow,
} from "./threadParking.ts";

/**
 * A pod follows the threads on its worktree: it stops once every one of them
 * is snoozed or settled with nothing active, and starts again when one wakes.
 * Only a pod it stopped itself is started again: a pod the user stopped stays
 * stopped until a turn needs it.
 */
export class PodParkingReactor extends Context.Service<
  PodParkingReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Looks at every pod now and resolves once each has followed its threads. */
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/PodParkingReactor") {}

const PARK_DETAIL = "Every thread on the pod's worktree is snoozed or settled, so the pod stops.";

export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const pods = yield* PodRuntimeService.PodRuntimeService;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;

  const parkingOf = (worktreePath: string) =>
    projections
      .getThreadParking({ worktreePath })
      .pipe(Effect.map((threads) => threads.filter((thread) => !thread.archived)));

  const allParked = (threads: ReadonlyArray<ProjectionStore.ProjectionThreadParking>) =>
    DateTime.now.pipe(
      Effect.map(
        (now) =>
          threads.length > 0 &&
          threads.every((thread) => isThreadParked(thread, DateTime.toEpochMillis(now))),
      ),
    );

  const follow = Effect.fn("PodParkingReactor.follow")(function* (worktreePath: string) {
    const pod = yield* pods.forPath(worktreePath);
    if (pod === undefined) return;
    const threads = yield* parkingOf(pod.worktreePath);
    // Its last thread archived or deleted: the pod is the teardown's to remove.
    if (threads.length === 0) return;
    if (yield* allParked(threads)) {
      if (podParkOperation(pod, "stop") === null) return;
      yield* pods.park(pod.id, {
        settled: threads.every((thread) => thread.settled),
        // Asked again under the pod's lock: a turn that started meanwhile
        // holds a run, so its pod stays up.
        parkedSince: parkingOf(pod.worktreePath).pipe(
          Effect.flatMap((current) =>
            allParked(current).pipe(
              Effect.map((parked) => (parked ? lastParkedAtMs(current) : null)),
            ),
          ),
          Effect.orElseSucceed(() => null),
        ),
        // Closed before the stop, as a stop: dying under it would read as a
        // provider failure, which wakes the thread and starts the pod again.
        beforeStop: sessions.releasePod({ podId: pod.id, detail: PARK_DETAIL }),
      });
      return;
    }
    if (pod.parked === true && (pod.state === "stopped" || pod.state === "frozen"))
      yield* pods.start(pod.id);
  });

  const queued = new Set<string>();
  const worker = yield* makeDrainableWorker((worktreePath: string) =>
    Effect.suspend(() => {
      queued.delete(worktreePath);
      return follow(worktreePath).pipe(
        Effect.catch((error) =>
          Effect.logWarning("a pod could not follow its threads", {
            worktreePath,
            error: error._tag,
          }),
        ),
      );
    }),
  );
  const enqueue = (worktreePath: string) =>
    Effect.suspend(() => {
      if (queued.has(worktreePath)) return Effect.void;
      queued.add(worktreePath);
      return worker.enqueue(worktreePath);
    });

  const enqueueAll = pods.live.pipe(
    Effect.flatMap((live) =>
      Effect.forEach(live, (pod) => enqueue(pod.worktreePath), { discard: true }),
    ),
  );

  const onEvent = (event: Parameters<typeof changesParking>[0]) =>
    Effect.gen(function* () {
      if (!changesParking(event)) return;
      // Most servers have no pods; they never read the thread.
      if ((yield* pods.live).length === 0) return;
      const worktreePath =
        parkingThreadRow(event)?.worktreePath ??
        (yield* projections.getThread(event.threadId)).worktreePath;
      if (worktreePath !== null) yield* enqueue(worktreePath);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("pod parking could not read a thread", {
          threadId: event.threadId,
          cause,
        }),
      ),
    );

  const start: PodParkingReactor["Service"]["start"] = Effect.fn("PodParkingReactor.start")(
    function* () {
      yield* forkParked(
        Stream.runForEach(orchestrator.streamDomainEvents, onEvent).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("pod parking event stream failed", { cause }),
          ),
        ),
      );
      // A pod settling into stopped or running may meet threads that changed while it moved.
      yield* forkParked(
        Stream.runForEach(pods.subscribe, (event) =>
          event.type === "upsert" ? enqueue(event.pod.worktreePath) : enqueueAll,
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("pod parking pod stream failed", { cause }),
          ),
        ),
      );
      // Snoozes end by the clock, with no event to say so.
      yield* forkParked(enqueueAll.pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid));
    },
  );

  return PodParkingReactor.of({ start, sweep: enqueueAll.pipe(Effect.andThen(worker.drain)) });
});

export const layer = Layer.effect(PodParkingReactor, make);
