import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  type NodeId,
  ProviderInstanceId,
  ProviderTurnId,
  type OrchestrationV2DomainEvent,
  type RunId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const projectId = ProjectId.make("project:supervised");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const makeLayerTest = (supervisedWakes: boolean, runContinuationWorker = false) =>
  ThreadManagementService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerDatabase,
        ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
        EventStore.layer.pipe(Layer.provide(layerDatabase)),
        EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
        ProviderReplayHarness.layerWithRegistry(
          { name: "supervised-threads" },
          ProviderAdapterRegistry.layerFromAdapters([adapter]),
          {
            databaseLayer: layerDatabase,
            runEffectWorker: false,
            runContinuationWorker,
            supervisedWakes,
          },
        ),
      ),
    ),
    Layer.provideMerge(ServerSettings.layerTest({ supervisedWakes })),
    Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  );
const layerTest = makeLayerTest(true);

const createThread = (threadId: ThreadId, supervisorThreadId?: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId,
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      ...(supervisorThreadId === undefined ? {} : { supervisorThreadId }),
      createdBy: supervisorThreadId === undefined ? "user" : "agent",
      creationSource: supervisorThreadId === undefined ? "web" : "mcp",
    });
  });

/** An agent's t3_thread_send (sender set) or the user typing in the thread (sender omitted). */
const send = (input: {
  readonly threadId: ThreadId;
  readonly text: string;
  readonly from?: ThreadId;
  readonly mode?: "start_immediately" | "queue_after_active";
}) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const messageId = MessageId.make(`message:${input.threadId}:${input.text}`);
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${input.threadId}:${input.text}`),
      threadId: input.threadId,
      messageId,
      text: input.text,
      attachments: [],
      dispatchMode: { type: input.mode ?? "start_immediately" },
      ...(input.from === undefined
        ? { createdBy: "user" as const, creationSource: "web" as const }
        : {
            createdBy: "agent" as const,
            creationSource: "mcp" as const,
            senderThreadId: input.from,
          }),
    });
    const projection = yield* orchestrator.getThreadProjection(input.threadId);
    return projection.runs.find((run) => run.userMessageId === messageId)!;
  });

const launchSupervised = (launcherId: ThreadId, childId: ThreadId) =>
  Effect.gen(function* () {
    yield* createThread(launcherId);
    yield* send({ threadId: launcherId, text: "launch a slice" });
    yield* createThread(childId, launcherId);
    return yield* send({ threadId: childId, text: "build the feature", from: launcherId });
  });

const endRun = (threadId: ThreadId, runId: RunId, status: "completed" | "failed") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
      (candidate) => candidate.id === runId,
    )!;
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make(`event:${runId}:${status}`),
      type: "run.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: { ...run, status, startedAt: now, completedAt: now },
    });
    // The same finalization the live run listener performs, run to completion here.
    yield* orchestrator.recoverDelegatedTasks;
  });

const supervisedTasks = (launcherId: ThreadId, childId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const launcher = yield* orchestrator.getThreadProjection(launcherId);
    return launcher.subagents.filter((task) => task.childThreadId === childId);
  });

it.effect("a supervised launch is a top-level thread whose run wakes the launcher once", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const launcherId = ThreadId.make("thread:supervised-launcher");
    const childId = ThreadId.make("thread:supervised-child");
    const run = yield* launchSupervised(launcherId, childId);

    const child = yield* orchestrator.getThreadProjection(childId);
    assert.deepEqual(child.thread.lineage, {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: childId,
      supervisorThreadId: launcherId,
    });
    const [task] = yield* supervisedTasks(launcherId, childId);
    assert.equal(run.delegatedTaskId, task?.id);
    assert.include(task, { supervised: true, origin: "app_owned", completionWake: "always" });
    const launcher = yield* orchestrator.getThreadProjection(launcherId);
    assert.isFalse(launcher.nodes.some((node) => node.id === task!.id));
    assert.isFalse(launcher.turnItems.some((item) => item.type === "subagent"));

    yield* endRun(childId, run.id, "completed");
    const woken = yield* orchestrator.getThreadProjection(launcherId);
    const finished = woken.subagents.find((row) => row.id === task!.id)!;
    assert.equal(finished.status, "completed");
    assert.equal(finished.completionDelivery?.state, "claimed");
    const launcherRun = woken.runs.find((row) => row.id === task!.runId)!;
    assert.deepEqual(launcherRun.delegatedCompletion?.delivery?.taskIds, [task!.id]);
    const results = () =>
      orchestrator
        .getThreadProjection(launcherId)
        .pipe(
          Effect.map(
            (projection) =>
              projection.contextTransfers.filter(
                (transfer) =>
                  transfer.type === "subagent_result" && transfer.sourceThreadId === childId,
              ).length,
          ),
        );
    assert.equal(yield* results(), 1);

    // A restart replays recovery; the recorded result keeps the wake from being offered twice.
    yield* orchestrator.recoverDelegatedTasks;
    assert.equal(yield* results(), 1);
    assert.deepEqual(
      (yield* orchestrator.getThreadProjection(launcherId)).runs.find(
        (row) => row.id === task!.runId,
      )?.delegatedCompletion,
      launcherRun.delegatedCompletion,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("only the launcher's own sends to a supervised thread register a wake", () =>
  Effect.gen(function* () {
    const launcherId = ThreadId.make("thread:followup-launcher");
    const childId = ThreadId.make("thread:followup-child");
    const otherId = ThreadId.make("thread:followup-other");
    const launch = yield* launchSupervised(launcherId, childId);
    yield* endRun(childId, launch.id, "completed");

    const typed = yield* send({ threadId: childId, text: "user asks directly" });
    assert.isUndefined(typed.delegatedTaskId);
    yield* createThread(otherId);
    const unrelated = yield* send({
      threadId: childId,
      text: "another agent chimes in",
      from: otherId,
      mode: "queue_after_active",
    });
    assert.isUndefined(unrelated.delegatedTaskId);

    const followup = yield* send({
      threadId: childId,
      text: "next round",
      from: launcherId,
      mode: "queue_after_active",
    });
    assert.isDefined(followup.delegatedTaskId);
    // A t3_thread_send retry derives the same command id, so it replays the receipt.
    yield* send({
      threadId: childId,
      text: "next round",
      from: launcherId,
      mode: "queue_after_active",
    });
    const tasks = yield* supervisedTasks(launcherId, childId);
    assert.deepEqual(
      tasks.map((task) => task.id),
      [launch.delegatedTaskId, followup.delegatedTaskId],
    );

    yield* endRun(childId, followup.id, "failed");
    const ended = (yield* supervisedTasks(launcherId, childId)).find(
      (task) => task.id === followup.delegatedTaskId,
    );
    assert.equal(ended?.status, "failed");
    assert.equal(ended?.completionDelivery?.state, "claimed");
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "with supervisedWakes off, no supervised thread is created and sends register no wake",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const launcherId = ThreadId.make("thread:off-launcher");
      const childId = ThreadId.make("thread:off-child");
      yield* createThread(launcherId);
      yield* send({ threadId: launcherId, text: "launch a slice" });
      const refused = createThread(ThreadId.make("thread:off-refused"), launcherId);
      assert.isTrue(Exit.isFailure(yield* Effect.exit(refused)));

      // A thread supervised while the switch was on.
      yield* createThread(childId);
      const { thread } = yield* orchestrator.getThreadProjection(childId);
      yield* projections.apply({
        id: EventId.make("event:off-child:supervised"),
        type: "thread.created",
        threadId: childId,
        occurredAt: thread.createdAt,
        payload: { ...thread, lineage: { ...thread.lineage, supervisorThreadId: launcherId } },
      });
      const followup = yield* send({ threadId: childId, text: "ignored round", from: launcherId });
      assert.isUndefined(followup.delegatedTaskId);
      assert.deepEqual(yield* supervisedTasks(launcherId, childId), []);
    }).pipe(Effect.provide(makeLayerTest(false))),
);

it.effect("a launcher turn Stop holds supervised wakes until the user messages it", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const launcherId = ThreadId.make("thread:hold-launcher");
    const earlyId = ThreadId.make("thread:hold-early");
    const lateId = ThreadId.make("thread:hold-late");
    const early = yield* launchSupervised(launcherId, earlyId);
    yield* createThread(lateId, launcherId);
    const late = yield* send({ threadId: lateId, text: "longer work", from: launcherId });
    yield* endRun(earlyId, early.id, "completed");
    const launcherRun = (yield* orchestrator.getThreadProjection(launcherId)).runs[0]!;
    assert.deepEqual(launcherRun.delegatedCompletion?.delivery?.taskIds, [early.delegatedTaskId!]);

    // The Stop button: interrupt the launcher's turn and hold its queue.
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make("stop-hold-launcher"),
      threadId: launcherId,
      runId: launcherRun.id,
      holdQueue: true,
    });
    yield* endRun(lateId, late.id, "completed");
    const stopped = yield* orchestrator.getThreadProjection(launcherId);
    const wakeOf = (projection: typeof stopped, taskId: NodeId | undefined) =>
      projection.subagents.find((task) => task.id === taskId)?.completionDelivery?.state;
    assert.equal(wakeOf(stopped, early.delegatedTaskId), "pending");
    assert.equal(wakeOf(stopped, late.delegatedTaskId), "pending");
    assert.isNull(
      stopped.runs.find((run) => run.id === launcherRun.id)?.delegatedCompletion?.delivery ?? null,
    );
    assert.deepEqual(
      (yield* orchestrator.getThreadProjection(lateId)).runs.map((run) => run.status),
      ["completed"],
    );

    const back = yield* send({ threadId: launcherId, text: "what did the slices do" });
    const released = yield* orchestrator.getThreadProjection(launcherId);
    for (const taskId of [early.delegatedTaskId, late.delegatedTaskId]) {
      assert.equal(released.subagents.find((task) => task.id === taskId)?.runId, back.id);
      assert.equal(wakeOf(released, taskId), "claimed");
    }
    assert.sameMembers(
      [
        ...(released.runs.find((run) => run.id === back.id)?.delegatedCompletion?.delivery
          ?.taskIds ?? []),
      ],
      [early.delegatedTaskId!, late.delegatedTaskId!],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("Resume releases held supervised wakes on the stopped run", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const launcherId = ThreadId.make("thread:resume-launcher");
    const childId = ThreadId.make("thread:resume-child");
    const launch = yield* launchSupervised(launcherId, childId);
    const launcherRun = (yield* orchestrator.getThreadProjection(launcherId)).runs[0]!;
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make("stop-resume-launcher"),
      threadId: launcherId,
      runId: launcherRun.id,
      holdQueue: true,
    });
    yield* endRun(childId, launch.id, "completed");
    const [held] = yield* supervisedTasks(launcherId, childId);
    assert.equal(held?.completionDelivery?.state, "pending");

    yield* orchestrator.dispatch({
      type: "queue.resume",
      commandId: CommandId.make("resume-launcher"),
      threadId: launcherId,
    });
    const resumed = yield* orchestrator.getThreadProjection(launcherId);
    const [task] = yield* supervisedTasks(launcherId, childId);
    assert.equal(task?.completionDelivery?.state, "claimed");
    const cohort = resumed.runs.find((run) => run.id === task?.runId)?.delegatedCompletion;
    assert.equal(cohort?.disposition, "open");
    assert.deepEqual(cohort?.delivery?.taskIds, [task!.id]);
  }).pipe(Effect.provide(layerTest)),
);

/** A turn of the supervised thread its user started, live on the provider and steerable. */
const steerableUserTurn = (childId: ThreadId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const run = yield* send({ threadId: childId, text: "user turn" });
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make(`event:${childId}:running`),
      type: "run.updated",
      threadId: childId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "running", startedAt: now },
    });
    yield* projections.apply({
      id: EventId.make(`event:${childId}:turn`),
      type: "provider-turn.updated",
      threadId: childId,
      occurredAt: now,
      payload: {
        id: ProviderTurnId.make(`provider-turn:${childId}`),
        providerThreadId: run.providerThreadId!,
        nodeId: run.rootNodeId!,
        runAttemptId: run.activeAttemptId!,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    });
    return run;
  });

const supervisorAutoSend = (launcherId: ThreadId, childId: ThreadId) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    return yield* threads.sendToThread({
      projectId,
      commandId: CommandId.make(`auto-send:${childId}`),
      threadId: childId,
      messageId: MessageId.make(`message:auto-send:${childId}`),
      senderThreadId: launcherId,
      text: "one more thing",
      attachments: [],
      mode: "auto",
      createdBy: "agent",
      creationSource: "mcp",
    });
  });

it.effect("auto from the supervisor queues behind a turn no wake tracks", () =>
  Effect.gen(function* () {
    const launcherId = ThreadId.make("thread:auto-launcher");
    const childId = ThreadId.make("thread:auto-child");
    yield* createThread(launcherId);
    yield* send({ threadId: launcherId, text: "launch a slice" });
    yield* createThread(childId, launcherId);
    const userTurn = yield* steerableUserTurn(childId);

    const sent = yield* supervisorAutoSend(launcherId, childId);
    assert.equal(sent.delivery, "queued");
    assert.notEqual(sent.run.id, userTurn.id);
    assert.isDefined(sent.run.delegatedTaskId);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("with supervisedWakes off, auto from the supervisor steers as before", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const launcherId = ThreadId.make("thread:auto-off-launcher");
    const childId = ThreadId.make("thread:auto-off-child");
    yield* createThread(launcherId);
    yield* send({ threadId: launcherId, text: "launch a slice" });
    yield* createThread(childId);
    const { thread } = yield* orchestrator.getThreadProjection(childId);
    yield* projections.apply({
      id: EventId.make("event:auto-off-child:supervised"),
      type: "thread.created",
      threadId: childId,
      occurredAt: thread.createdAt,
      payload: { ...thread, lineage: { ...thread.lineage, supervisorThreadId: launcherId } },
    });
    yield* steerableUserTurn(childId);

    // A steer needs the live provider session this harness lacks, so the attempt fails;
    // queueing, the other choice, would have added a run.
    const sent = yield* Effect.exit(supervisorAutoSend(launcherId, childId));
    assert.isTrue(Exit.isFailure(sent));
    const error = Exit.isFailure(sent) ? Cause.squash(sent.cause) : undefined;
    assert.include(error, { _tag: "OrchestratorDispatchError", commandType: "message.dispatch" });
    assert.match(String((error as { cause?: unknown }).cause), /Provider session .* is not active/);
    assert.lengthOf((yield* orchestrator.getThreadProjection(childId)).runs, 1);
  }).pipe(Effect.provide(makeLayerTest(false))),
);

it.effect("a supervised run that ends through the event stream wakes the launcher", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const launcherId = ThreadId.make("thread:live-launcher");
    const childId = ThreadId.make("thread:live-child");
    const run = yield* launchSupervised(launcherId, childId);
    const now = yield* DateTime.now;
    const afterSequence = yield* eventSink.latestSequence();
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("event:live-child:completed"),
          type: "run.updated",
          threadId: childId,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status: "completed", startedAt: now, completedAt: now },
        },
      ],
    });
    const claimed = yield* eventSink.stream({ afterSequence, eventType: "subagent.updated" }).pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "subagent.updated" &&
          stored.event.payload.id === run.delegatedTaskId &&
          stored.event.payload.completionDelivery?.state === "claimed",
      ),
      Stream.take(1),
      Stream.runHead,
    );
    assert.isTrue(Option.isSome(claimed));
    const launcher = yield* orchestrator.getThreadProjection(launcherId);
    const task = launcher.subagents.find((row) => row.id === run.delegatedTaskId)!;
    assert.deepEqual(
      launcher.runs.find((row) => row.id === task.runId)?.delegatedCompletion?.delivery?.taskIds,
      [task.id],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("stopping the launcher drops its wake but leaves the supervised thread running", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const launcherId = ThreadId.make("thread:stop-launcher");
    const childId = ThreadId.make("thread:stop-child");
    const launch = yield* launchSupervised(launcherId, childId);
    const before = (yield* orchestrator.getThreadProjection(childId)).runs.map((run) => run.status);

    const stopCommandId = CommandId.make("stop-launcher");
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: stopCommandId,
      threadId: launcherId,
    });
    yield* threads.stopDelegatedTasks({ threadId: launcherId, commandId: stopCommandId });
    assert.deepEqual(
      (yield* orchestrator.getThreadProjection(childId)).runs.map((run) => run.status),
      before,
    );

    yield* endRun(childId, launch.id, "completed");
    const [task] = yield* supervisedTasks(launcherId, childId);
    assert.equal(task?.status, "completed");
    assert.equal(task?.completionDelivery?.state, "disposed");
    const launcher = yield* orchestrator.getThreadProjection(launcherId);
    assert.isNull(
      launcher.runs.find((run) => run.id === task?.runId)?.delegatedCompletion?.delivery ?? null,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a deleted launcher does not wedge its supervised thread's completion", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const launcherId = ThreadId.make("thread:deleted-launcher");
    const childId = ThreadId.make("thread:deleted-child");
    const launch = yield* launchSupervised(launcherId, childId);
    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete-launcher"),
      threadId: launcherId,
    });

    yield* endRun(childId, launch.id, "completed");
    const child = yield* orchestrator.getThreadProjection(childId);
    assert.equal(child.runs.find((run) => run.id === launch.id)?.status, "completed");
    // The child still takes new work once its launcher is gone.
    const next = yield* send({ threadId: childId, text: "carry on" });
    assert.isDefined(next);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses a supervisor that does not exist", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const childId = ThreadId.make("thread:orphan-supervised");
    const created = yield* Effect.exit(createThread(childId, ThreadId.make("thread:missing")));
    assert.isTrue(Exit.isFailure(created));
    assert.isTrue(Exit.isFailure(yield* Effect.exit(orchestrator.getThreadProjection(childId))));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses to promote a supervised launch to a meta, and promotes its launcher", () =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const launcherId = ThreadId.make("thread:meta-launcher");
    const childId = ThreadId.make("thread:meta-supervised");
    yield* createThread(launcherId);
    yield* createThread(childId, launcherId);
    const refused = yield* threads
      .setMeta({
        threadId: childId,
        commandId: CommandId.make("promote:supervised"),
        enabled: true,
      })
      .pipe(Effect.flip);
    assert.equal(refused._tag, "OrchestratorDispatchError");
    assert.include(String(refused.cause), "is a supervised launch");
    assert.isNull((yield* threads.getThreadShell(childId))?.metaAt ?? null);

    yield* threads.setMeta({
      threadId: launcherId,
      commandId: CommandId.make("promote:launcher"),
      enabled: true,
    });
    assert.isNotNull((yield* threads.getThreadShell(launcherId))?.metaAt ?? null);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses a meta agent's own settle mid-turn instead of deferring it", () =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const metaId = ThreadId.make("thread:meta-self-settle");
    yield* createThread(metaId);
    yield* threads.setMeta({
      threadId: metaId,
      commandId: CommandId.make("promote:self-settle"),
      enabled: true,
    });
    yield* send({ threadId: metaId, text: "relay the results" });
    assert.isNotNull((yield* threads.getThreadShell(metaId))?.activeRunId ?? null);
    for (const scope of [undefined, "tree"] as const) {
      const refused = yield* threads
        .settleThread({
          threadId: metaId,
          commandId: CommandId.make(`settle:self:${scope ?? "thread"}`),
          byOwnAgent: true,
          ...(scope === undefined ? {} : { scope }),
        })
        .pipe(Effect.flip);
      assert.equal(refused._tag, "OrchestratorDispatchError");
      assert.include(String(refused.cause), "a meta cannot be settled");
    }
    const shell = yield* threads.getThreadShell(metaId);
    assert.isUndefined(shell?.settleWhenIdle);
    assert.notEqual(shell?.settledOverride, "settled");
  }).pipe(Effect.provide(layerTest)),
);

const layerProviders = (slashCommands: ServerProvider["slashCommands"]) =>
  Layer.mock(ProviderRegistry.ProviderRegistry)({
    getProviders: Effect.succeed([{ instanceId, slashCommands } as unknown as ServerProvider]),
  });
const layerCompaction = makeLayerTest(true, true).pipe(
  Layer.provideMerge(layerProviders([{ name: "compact", description: "Compact" }])),
);

/** A launcher whose turn the user stopped while its supervised thread finished. */
const heldCohort = (launcherId: ThreadId, childId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const launch = yield* launchSupervised(launcherId, childId);
    const launcherRun = (yield* orchestrator.getThreadProjection(launcherId)).runs[0]!;
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make(`stop:${launcherId}`),
      threadId: launcherId,
      runId: launcherRun.id,
      holdQueue: true,
    });
    yield* endRun(childId, launch.id, "completed");
    const [held] = yield* supervisedTasks(launcherId, childId);
    assert.equal(held?.completionDelivery?.state, "pending");
    assert.equal(held?.runId, launcherRun.id);
    return held!;
  });

/** Ends a run the way a provider does, through the event stream the orchestrator reacts to. */
const completeLive = (threadId: ThreadId, runId: RunId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
      (candidate) => candidate.id === runId,
    )!;
    const now = yield* DateTime.now;
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`event:${runId}:live-completed`),
          type: "run.updated",
          threadId,
          runId,
          occurredAt: now,
          payload: { ...run, status: "completed", startedAt: now, completedAt: now },
        },
      ],
    });
  });

const nextEvent = (
  afterSequence: number,
  matches: (event: OrchestrationV2DomainEvent) => boolean,
) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    return yield* eventSink.stream({ afterSequence }).pipe(
      Stream.map((stored) => stored.event),
      Stream.filter(matches),
      Stream.take(1),
      Stream.runHead,
    );
  });

it.effect("a user's /compact releases held supervised wakes, which run after the compaction", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const launcherId = ThreadId.make("thread:compact-web-launcher");
    const childId = ThreadId.make("thread:compact-web-child");
    const held = yield* heldCohort(launcherId, childId);

    const afterCompact = yield* eventSink.latestSequence();
    const compaction = yield* send({
      threadId: launcherId,
      text: "/compact",
      mode: "queue_after_active",
    });
    const [task] = yield* supervisedTasks(launcherId, childId);
    assert.equal(task?.id, held.id);
    assert.equal(task?.runId, compaction.id);
    assert.equal(task?.completionDelivery?.state, "claimed");
    const delivery = (yield* orchestrator.getThreadProjection(launcherId)).runs.find(
      (run) => run.id === compaction.id,
    )?.delegatedCompletion?.delivery;
    assert.deepEqual(delivery?.taskIds, [held.id]);

    // The continuation worker queues the wake message behind the compaction.
    const queued = yield* nextEvent(
      afterCompact,
      (event) =>
        event.type === "run.created" &&
        event.threadId === launcherId &&
        event.payload.userMessageId === delivery?.messageId,
    );
    assert.isTrue(Option.isSome(queued));
    const wakeRunId = (queued as Option.Some<OrchestrationV2DomainEvent>).value.runId!;
    const wakeRun = () =>
      orchestrator
        .getThreadProjection(launcherId)
        .pipe(Effect.map((projection) => projection.runs.find((run) => run.id === wakeRunId)));
    assert.equal((yield* wakeRun())?.status, "queued");

    const afterCompaction = yield* eventSink.latestSequence();
    yield* completeLive(launcherId, compaction.id);
    const started = yield* nextEvent(
      afterCompaction,
      (event) =>
        event.type === "run.updated" &&
        event.runId === wakeRunId &&
        event.payload.status === "starting",
    );
    assert.isTrue(Option.isSome(started));
    assert.equal((yield* wakeRun())?.status, "starting");
    assert.equal((yield* wakeRun())?.threadId, launcherId);
  }).pipe(Effect.provide(layerCompaction)),
);

it.effect("an agent's compaction leaves held supervised wakes held", () =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const launcherId = ThreadId.make("thread:compact-agent-launcher");
    const childId = ThreadId.make("thread:compact-agent-child");
    const held = yield* heldCohort(launcherId, childId);

    yield* threads.compact({
      projectId,
      threadId: launcherId,
      commandId: CommandId.make("compact:agent"),
    });
    const compaction = (yield* threads.getThreadProjection(launcherId)).runs.find(
      (run) => run.userMessageId === MessageId.make("compact:agent"),
    )!;
    yield* endRun(launcherId, compaction.id, "completed");
    const [task] = yield* supervisedTasks(launcherId, childId);
    assert.equal(task?.runId, held.runId);
    assert.equal(task?.completionDelivery?.state, "pending");
    // No cohort was planned onto any run, so no wake message or wake run exists.
    const launcher = yield* threads.getThreadProjection(launcherId);
    assert.deepEqual(
      launcher.runs.map((run) => run.id),
      [held.runId, compaction.id],
    );
    assert.isTrue(launcher.runs.every((run) => run.delegatedCompletion?.delivery == null));
  }).pipe(Effect.provide(layerCompaction)),
);

const compactThread = (threadId: ThreadId, commandId: string) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    return yield* threads.compact({ projectId, threadId, commandId: CommandId.make(commandId) });
  });

it.effect("an agent's compaction queues behind a running turn instead of steering it", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:compact-busy");
    yield* createThread(threadId);
    const running = yield* steerableUserTurn(threadId);
    yield* compactThread(threadId, "compact:busy");

    const projection = yield* orchestrator.getThreadProjection(threadId);
    const message = projection.messages.find(
      (candidate) => candidate.id === MessageId.make("compact:busy"),
    );
    assert.include(message, { text: "/compact", createdBy: "agent", creationSource: "mcp" });
    assert.notEqual(message?.runId, running.id);
    assert.equal(projection.runs.find((run) => run.id === message?.runId)?.status, "queued");
    assert.equal(projection.runs.find((run) => run.id === running.id)?.status, "running");
  }).pipe(Effect.provide(layerCompaction)),
);

it.effect("refuses to compact a thread with no conversation and dispatches nothing", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:compact-empty");
    yield* createThread(threadId);
    const empty = yield* Effect.flip(compactThread(threadId, "compact:empty"));
    assert.include(empty, {
      _tag: "ThreadManagementCompactionUnavailableError",
      reason: "no_conversation",
    });

    yield* send({ threadId, text: "/compact" });
    const onlyCompact = yield* Effect.flip(compactThread(threadId, "compact:only-compact"));
    assert.include(onlyCompact, { reason: "no_conversation" });
    assert.deepEqual(
      (yield* orchestrator.getThreadProjection(threadId)).messages.map((message) => message.text),
      ["/compact"],
    );
  }).pipe(Effect.provide(layerCompaction)),
);

it.effect("refuses to compact when the thread's provider does not advertise compact", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:compact-unsupported");
    yield* createThread(threadId);
    yield* send({ threadId, text: "hello" });
    const refused = yield* Effect.flip(compactThread(threadId, "compact:unsupported"));
    assert.include(refused, {
      _tag: "ThreadManagementCompactionUnavailableError",
      reason: "provider_unsupported",
    });
    assert.equal((yield* orchestrator.getThreadProjection(threadId)).messages.length, 1);
  }).pipe(Effect.provide(makeLayerTest(true).pipe(Layer.provideMerge(layerProviders([]))))),
);
