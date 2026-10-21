import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  PodRuntimeId,
  type PodRuntimeSnapshot,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  NodeId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as PodRuntimeService from "../pod/PodRuntimeService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as PodParkingReactor from "./PodParkingReactor.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

const worktreePath = "/work/pods/feature";
const podId = PodRuntimeId.make("pod-parking1");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" } as const;

/** The pod runtime as the reactor sees it, recording what it was asked to do and in what order. */
const makePods = (initial: Partial<PodRuntimeSnapshot>) => {
  let pod: PodRuntimeSnapshot = {
    id: podId,
    projectId: ProjectId.make("project-parking"),
    worktreePath,
    state: "running",
    services: [],
    image: "docker:27-cli",
    startedAt: null,
    lastError: null,
    containerIds: [],
    volumeIds: [],
    updatedAt: "2026-10-21T00:00:00.000Z",
    ...initial,
  };
  const calls: Array<string> = [];
  const service = Layer.mock(PodRuntimeService.PodRuntimeService)({
    live: Effect.sync(() => [pod]),
    forPath: (path) => Effect.sync(() => (path === worktreePath ? pod : undefined)),
    park: (_id, options) =>
      Effect.gen(function* () {
        calls.push(`park${options.settled ? " settled" : ""}`);
        // As the runtime does: only threads that parked after the pod last started stop it.
        const stillParked = options.parkedSince.pipe(
          Effect.map(
            (since) =>
              since !== null && (pod.startedAt === null || since > Date.parse(pod.startedAt)),
          ),
        );
        if (!(yield* stillParked)) return false;
        yield* options.beforeStop;
        if (!(yield* stillParked)) return false;
        pod = { ...pod, state: "stopped", parked: true };
        return true;
      }),
    start: () =>
      Effect.sync(() => {
        calls.push("start");
        const { parked: _parked, ...unparked } = pod;
        pod = { ...unparked, state: "running" };
        return pod;
      }),
  });
  const sessions = Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
    releasePod: () => Effect.sync(() => calls.push("release sessions")),
  });
  return {
    calls,
    current: () => pod,
    layer: PodParkingReactor.layer.pipe(
      Layer.provideMerge(ProjectionStore.layerMemory),
      Layer.provide(Layer.mergeAll(service, sessions, Layer.mock(Orchestrator.OrchestratorV2)({}))),
    ),
  };
};

const thread = (
  id: string,
  now: DateTime.Utc,
  fields: Partial<OrchestrationV2AppThread> = {},
): OrchestrationV2AppThread => {
  const threadId = ThreadId.make(id);
  return {
    createdBy: "agent",
    creationSource: "mcp",
    id: threadId,
    projectId: ProjectId.make("project-parking"),
    title: id,
    providerInstanceId: instanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "pod/feature",
    worktreePath,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...fields,
  };
};

let eventCount = 0;
const put = (row: OrchestrationV2AppThread) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const exists = yield* projections.getThread(row.id).pipe(Effect.option);
    yield* projections.apply({
      id: EventId.make(`event:${row.id}:${(eventCount += 1)}`),
      type: exists._tag === "Some" ? "thread.metadata-updated" : "thread.created",
      threadId: row.id,
      providerInstanceId: instanceId,
      occurredAt: row.updatedAt,
      payload: row,
    });
  });

const putRun = (threadId: ThreadId, status: OrchestrationV2Run["status"], now: DateTime.Utc) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const runId = RunId.make(`run:${threadId}`);
    yield* projections.apply({
      id: EventId.make(`event:${runId}:${status}`),
      type: "run.updated",
      threadId,
      runId,
      providerInstanceId: instanceId,
      occurredAt: now,
      payload: {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection,
        providerThreadId: ProviderThreadId.make(`provider-thread:${threadId}`),
        userMessageId: MessageId.make(`message:${threadId}`),
        rootNodeId: NodeId.make(`node:${threadId}`),
        activeAttemptId: null,
        status,
        requestedAt: now,
        startedAt: now,
        completedAt: status === "running" ? null : now,
      } as OrchestrationV2Run,
    });
  });

const sweep = Effect.flatMap(PodParkingReactor.PodParkingReactor, (reactor) => reactor.sweep);

describe("PodParkingReactor", () => {
  it.effect("stops a pod only once every thread on its worktree is parked, sessions first", () => {
    const pods = makePods({});
    return Effect.gen(function* () {
      const now = yield* DateTime.now;
      const snoozedUntil = DateTime.add(now, { hours: 2 });
      const broker = thread("thread:broker", now, { snoozedUntil, snoozedAt: now });
      const cell = thread("thread:cell", now);
      yield* put(broker);
      yield* put(cell);
      yield* sweep;
      expect(pods.calls).toEqual([]);

      // Settling the last awake thread parks the pod; a snoozed one keeps it a snooze, not a settle.
      yield* put({ ...cell, settledOverride: "settled", settledAt: now });
      yield* sweep;
      expect(pods.calls).toEqual(["park", "release sessions"]);
      expect(pods.current()).toMatchObject({ state: "stopped", parked: true });
    }).pipe(Effect.provide(pods.layer));
  });

  it.effect("keeps the pod while a parked thread still has a run, or one starts meanwhile", () => {
    const pods = makePods({});
    return Effect.gen(function* () {
      const now = yield* DateTime.now;
      const snoozed = thread("thread:busy", now, {
        snoozedUntil: DateTime.add(now, { hours: 1 }),
        snoozedAt: now,
      });
      yield* put(snoozed);
      yield* putRun(snoozed.id, "running", now);
      yield* sweep;
      expect(pods.calls).toEqual([]);

      yield* putRun(snoozed.id, "completed", now);
      yield* sweep;
      expect(pods.current().state).toBe("stopped");
    }).pipe(Effect.provide(pods.layer));
  });

  it.effect("parks for every settled thread as a settle, which always stops", () => {
    const pods = makePods({});
    return Effect.gen(function* () {
      const now = yield* DateTime.now;
      yield* put(thread("thread:done", now, { settledOverride: "settled", settledAt: now }));
      yield* sweep;
      expect(pods.calls).toEqual(["park settled", "release sessions"]);
    }).pipe(Effect.provide(pods.layer));
  });

  it.effect("stops a pod whose threads limit recovery parked, and starts it at the reset", () => {
    const pods = makePods({});
    return Effect.gen(function* () {
      const now = yield* DateTime.now;
      const resetAt = DateTime.add(now, { hours: 1 });
      yield* put(
        thread("thread:limited", now, {
          snoozedUntil: resetAt,
          snoozedAt: now,
          limitRecovery: {
            runId: RunId.make("run:limited"),
            resetAt: DateTime.formatIso(resetAt),
            autoResume: true,
            snooze: true,
          },
        }),
      );
      yield* putRun(ThreadId.make("thread:limited"), "failed", now);
      yield* sweep;
      expect(pods.current()).toMatchObject({ state: "stopped", parked: true });

      yield* TestClock.adjust("61 minutes");
      yield* sweep;
      expect(pods.calls.at(-1)).toBe("start");
      expect(pods.current().state).toBe("running");
    }).pipe(Effect.provide(pods.layer));
  });

  it.effect("starts a pod its threads parked when one wakes, never one the user stopped", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const awake = thread("thread:woken", now, { lastSnoozeWakeAt: now });
      const parked = makePods({ state: "stopped", parked: true });
      yield* Effect.gen(function* () {
        yield* put(awake);
        // A pull request watch woke it: a run is queued for the wake.
        yield* putRun(awake.id, "queued", now);
        yield* sweep;
        expect(parked.calls).toEqual(["start"]);
      }).pipe(Effect.provide(parked.layer));

      const stoppedByUser = makePods({ state: "stopped" });
      yield* Effect.gen(function* () {
        yield* put(awake);
        yield* sweep;
        expect(stoppedByUser.calls).toEqual([]);
      }).pipe(Effect.provide(stoppedByUser.layer));
    }),
  );

  it.effect("leaves a pod that failed to stop or start to the user", () => {
    const pods = makePods({ state: "start_failed", parked: true });
    return Effect.gen(function* () {
      const now = yield* DateTime.now;
      yield* put(thread("thread:awake", now));
      yield* sweep;
      yield* put(thread("thread:awake", now, { settledOverride: "settled", settledAt: now }));
      yield* sweep;
      expect(pods.calls).toEqual([]);
    }).pipe(Effect.provide(pods.layer));
  });

  it.effect("leaves a parked pod alone once its last thread is archived", () => {
    const pods = makePods({ state: "stopped", parked: true });
    return Effect.gen(function* () {
      const now = yield* DateTime.now;
      yield* put(thread("thread:gone", now, { archivedAt: now }));
      yield* sweep;
      expect(pods.calls).toEqual([]);
    }).pipe(Effect.provide(pods.layer));
  });

  it.effect("keeps a pod the user started after its threads parked, until one parks again", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const snoozed = thread("thread:sleeping", now, {
        snoozedUntil: DateTime.add(now, { hours: 4 }),
        snoozedAt: now,
      });
      // Started from its chip a second after the snooze, to open the site or the shell.
      const pods = makePods({
        state: "running",
        startedAt: DateTime.formatIso(DateTime.add(now, { seconds: 1 })),
      });
      yield* Effect.gen(function* () {
        yield* put(snoozed);
        yield* sweep;
        // Asked, but the threads parked before the start: no sessions closed, still running.
        expect(pods.calls).toEqual(["park"]);
        expect(pods.current().state).toBe("running");

        yield* TestClock.adjust("1 minute");
        const later = yield* DateTime.now;
        yield* put({ ...snoozed, snoozedAt: later, updatedAt: later });
        yield* sweep;
        expect(pods.calls).toEqual(["park", "park", "release sessions"]);
        expect(pods.current().state).toBe("stopped");
      }).pipe(Effect.provide(pods.layer));
    }),
  );

  it.effect("stops a pod whose start failed after it came up, once its threads are parked", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const snoozed = thread("thread:kept-snoozed", now, {
        snoozedUntil: DateTime.add(now, { hours: 1 }),
        snoozedAt: now,
      });
      const failedStart = makePods({
        state: "start_failed",
        lastError: {
          operation: "start",
          message: "the stack's containers are gone",
          at: "2026-10-21T00:00:00.000Z",
        },
      });
      yield* Effect.gen(function* () {
        yield* put(snoozed);
        yield* sweep;
        expect(failedStart.calls).toEqual(["park", "release sessions"]);
        expect(failedStart.current()).toMatchObject({ state: "stopped", parked: true });
      }).pipe(Effect.provide(failedStart.layer));

      // A failed creation never brought its stack up; a stop would hide that its Retry builds it.
      const failedCreate = makePods({
        state: "start_failed",
        lastError: {
          operation: "create",
          message: "compose up failed",
          at: "2026-10-21T00:00:00.000Z",
        },
      });
      yield* Effect.gen(function* () {
        yield* put(snoozed);
        yield* sweep;
        expect(failedCreate.calls).toEqual([]);
      }).pipe(Effect.provide(failedCreate.layer));
    }),
  );
});
