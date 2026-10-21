import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as SnoozeWhenIdleReactor from "./SnoozeWhenIdleReactor.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { isThreadParked } from "./threadParking.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const projectId = ProjectId.make("project:snooze-tree");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = SnoozeWhenIdleReactor.layer.pipe(
  Layer.provideMerge(ThreadManagementService.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      EventStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "snooze-tree" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  Layer.provideMerge(NodeCrypto.layer),
);

const later = (hours: number) =>
  DateTime.now.pipe(Effect.map((now) => DateTime.formatIso(DateTime.add(now, { hours }))));

const createThread = (
  threadId: ThreadId,
  options: { readonly supervisorThreadId?: ThreadId; readonly worktreePath?: string } = {},
) =>
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
      worktreePath: options.worktreePath ?? null,
      ...(options.supervisorThreadId === undefined
        ? {}
        : { supervisorThreadId: options.supervisorThreadId }),
      createdBy: "user",
      creationSource: "web",
    });
  });

/** A delegated child, as delegate_task records it, without a provider run behind it. */
const createSubagent = (threadId: ThreadId, parent: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const parentThread = (yield* orchestrator.getThreadProjection(parent)).thread;
    const payload: OrchestrationV2AppThread = {
      ...parentThread,
      id: threadId,
      title: threadId,
      lineage: {
        parentThreadId: parent,
        relationshipToParent: "subagent",
        rootThreadId: parentThread.lineage.rootThreadId,
      },
      createdBy: "agent",
      creationSource: "mcp",
    };
    yield* projections.apply({
      id: EventId.make(`event:created:${threadId}`),
      type: "thread.created",
      threadId,
      providerInstanceId: instanceId,
      occurredAt: yield* DateTime.now,
      payload,
    });
  });

const send = (
  threadId: ThreadId,
  text: string,
  mode: "start_immediately" | "queue_after_active" = "start_immediately",
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const messageId = MessageId.make(`message:${threadId}:${text}`);
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      threadId,
      messageId,
      text,
      attachments: [],
      dispatchMode: { type: mode },
      createdBy: "user",
      creationSource: "web",
    });
    const projection = yield* orchestrator.getThreadProjection(threadId);
    return projection.runs.find((run) => run.userMessageId === messageId)!;
  });

const endRun = (threadId: ThreadId, runId: RunId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
      (candidate) => candidate.id === runId,
    )!;
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make(`event:${runId}:completed`),
      type: "run.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: { ...run, status: "completed", startedAt: now, completedAt: now },
    });
  });

const snoozedUntil = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const thread = (yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(threadId))
      .thread;
    return thread.snoozedUntil == null ? null : DateTime.formatIso(thread.snoozedUntil);
  });

const snoozeWhenIdleOf = (threadId: ThreadId) =>
  Effect.map(
    Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
      orchestrator.getThreadProjection(threadId),
    ),
    (projection) => projection.thread.snoozeWhenIdle ?? null,
  );

const ids = {
  meta: ThreadId.make("thread:meta"),
  slice: ThreadId.make("thread:slice"),
  otherSlice: ThreadId.make("thread:other-slice"),
  broker: ThreadId.make("thread:broker"),
  cell: ThreadId.make("thread:cell"),
  archived: ThreadId.make("thread:archived-cell"),
  settled: ThreadId.make("thread:settled-cell"),
  stranger: ThreadId.make("thread:stranger"),
};

/** meta supervises two slices; one slice delegated a broker, which delegated a cell. */
const buildTree = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* createThread(ids.meta);
  yield* createThread(ids.slice, { supervisorThreadId: ids.meta });
  yield* createThread(ids.otherSlice, { supervisorThreadId: ids.meta });
  yield* createSubagent(ids.broker, ids.slice);
  yield* createSubagent(ids.cell, ids.broker);
  yield* createSubagent(ids.archived, ids.broker);
  yield* createSubagent(ids.settled, ids.broker);
  yield* createThread(ids.stranger);
  yield* orchestrator.dispatch({
    type: "thread.archive",
    commandId: CommandId.make("archive:cell"),
    threadId: ids.archived,
  });
  yield* orchestrator.dispatch({
    type: "thread.settle",
    commandId: CommandId.make("settle:cell"),
    threadId: ids.settled,
  });
});

it.layer(layerTest)("snooze trees", (it) => {
  it.effect(
    "snoozes a thread's whole agent tree over subagent and supervisor edges, once per command",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* buildTree;
        const until = yield* later(3);
        const command = {
          type: "thread.snooze",
          commandId: CommandId.make("snooze:tree"),
          threadId: ids.meta,
          snoozedUntil: until,
          scope: "tree",
        } as const;
        yield* orchestrator.dispatch(command);
        for (const threadId of [ids.meta, ids.slice, ids.otherSlice, ids.broker, ids.cell])
          assert.equal(yield* snoozedUntil(threadId), until, threadId);
        for (const threadId of [ids.archived, ids.settled, ids.stranger])
          assert.isNull(yield* snoozedUntil(threadId), threadId);

        // A retried command replays the root's receipt and records nothing new.
        const sequence = yield* orchestrator.getThreadEventSequence(ids.cell);
        yield* orchestrator.dispatch(command);
        assert.equal(yield* orchestrator.getThreadEventSequence(ids.cell), sequence);
      }),
  );

  it.effect("wakes a tree the same way, and a descendant's wake reaches only its branch", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const until = yield* later(3);
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("snooze:tree-again"),
        threadId: ids.meta,
        snoozedUntil: until,
        scope: "tree",
      });
      yield* orchestrator.dispatch({
        type: "thread.unsnooze",
        commandId: CommandId.make("wake:slice-branch"),
        threadId: ids.slice,
        reason: "user",
        scope: "tree",
      });
      for (const threadId of [ids.slice, ids.broker, ids.cell])
        assert.isNull(yield* snoozedUntil(threadId), threadId);
      for (const threadId of [ids.meta, ids.otherSlice])
        assert.equal(yield* snoozedUntil(threadId), until, threadId);

      yield* orchestrator.dispatch({
        type: "thread.unsnooze",
        commandId: CommandId.make("wake:tree"),
        threadId: ids.meta,
        reason: "user",
        scope: "tree",
      });
      for (const threadId of [ids.meta, ids.otherSlice])
        assert.isNull(yield* snoozedUntil(threadId), threadId);
    }),
  );

  it.effect("snoozes only the thread when its scope says so, as stock clients send it", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const until = yield* later(2);
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("snooze:only-meta"),
        threadId: ids.meta,
        snoozedUntil: until,
      });
      assert.equal(yield* snoozedUntil(ids.meta), until);
      assert.isNull(yield* snoozedUntil(ids.slice));
      yield* orchestrator.dispatch({
        type: "thread.unsnooze",
        commandId: CommandId.make("wake:only-meta"),
        threadId: ids.meta,
        reason: "user",
      });
    }),
  );

  it.effect("refuses a working tree unless told to wait, then snoozes it once it is idle", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const reactor = yield* SnoozeWhenIdleReactor.SnoozeWhenIdleReactor;
      const run = yield* send(ids.otherSlice, "keep building");
      const until = yield* later(4);
      const refused = yield* orchestrator
        .dispatch({
          type: "thread.snooze",
          commandId: CommandId.make("snooze:busy-tree"),
          threadId: ids.meta,
          snoozedUntil: until,
          scope: "tree",
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(refused));
      assert.include(String(refused), "Snooze when idle");
      assert.isNull(yield* snoozedUntil(ids.meta));

      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("snooze:busy-tree-when-idle"),
        threadId: ids.meta,
        snoozedUntil: until,
        scope: "tree",
        whenIdle: true,
      });
      const waiting = yield* snoozeWhenIdleOf(ids.meta);
      assert.deepInclude(waiting, { snoozedUntil: until, scope: "tree" });
      assert.isNull(yield* snoozedUntil(ids.meta));

      // Still working: the reactor leaves it waiting.
      yield* reactor.sweep;
      assert.isNull(yield* snoozedUntil(ids.meta));

      yield* endRun(ids.otherSlice, run.id);
      yield* reactor.sweep;
      for (const threadId of [ids.meta, ids.slice, ids.otherSlice, ids.broker, ids.cell])
        assert.equal(yield* snoozedUntil(threadId), until, threadId);
      assert.isNull(yield* snoozeWhenIdleOf(ids.meta));
    }),
  );

  it.effect("lets a thread snooze its tree mid-turn, by its own rule or once the turn ends", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const reactor = yield* SnoozeWhenIdleReactor.SnoozeWhenIdleReactor;
      const agent = ThreadId.make("thread:busy-agent");
      yield* createThread(agent);
      const run = yield* send(agent, "working on it");
      const until = yield* later(2);
      // As before snooze trees: a running thread may be snoozed; only work under it waits.
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("snooze:busy-agent-now"),
        threadId: agent,
        snoozedUntil: until,
        scope: "tree",
      });
      assert.equal(yield* snoozedUntil(agent), until);
      yield* orchestrator.dispatch({
        type: "thread.unsnooze",
        commandId: CommandId.make("wake:busy-agent"),
        threadId: agent,
        reason: "user",
        scope: "tree",
      });

      // What an agent's own snooze sends: it waits for the turn to end.
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("snooze:busy-agent-when-idle"),
        threadId: agent,
        snoozedUntil: until,
        scope: "tree",
        whenIdle: true,
      });
      assert.isNull(yield* snoozedUntil(agent));
      yield* endRun(agent, run.id);
      yield* reactor.sweep;
      assert.equal(yield* snoozedUntil(agent), until);
    }),
  );

  it.effect("changes nothing in the tree when its root refuses the snooze", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const root = ThreadId.make("thread:archived-root");
      const child = ThreadId.make("thread:archived-root-child");
      yield* createThread(root);
      yield* createSubagent(child, root);
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive:root"),
        threadId: root,
      });
      const refused = yield* orchestrator
        .dispatch({
          type: "thread.snooze",
          commandId: CommandId.make("snooze:archived-root"),
          threadId: root,
          snoozedUntil: yield* later(1),
          scope: "tree",
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(refused));
      assert.isNull(yield* snoozedUntil(child));
    }),
  );

  it.effect(
    "a Stop ends a run that has not reached its provider, as while it waits for a pod",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make("thread:stopped-before-provider");
        yield* createThread(threadId);
        const run = yield* send(threadId, "start something");
        assert.notInclude(["completed", "failed", "interrupted", "cancelled"], run.status);
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("stop:before-provider"),
          threadId,
          runId: run.id,
        });
        const after = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (candidate) => candidate.id === run.id,
        );
        assert.include(["interrupted", "cancelled"], after?.status);
      }),
  );

  it.effect("a thread snoozes when idle at once if idle; new work or a wake calls it off", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const until = yield* later(5);
      const snoozeWhenIdle = (id: string) =>
        orchestrator.dispatch({
          type: "thread.snooze",
          commandId: CommandId.make(id),
          threadId: ids.stranger,
          snoozedUntil: until,
          whenIdle: true,
        });

      yield* snoozeWhenIdle("snooze:idle-stranger");
      assert.equal(yield* snoozedUntil(ids.stranger), until);
      yield* orchestrator.dispatch({
        type: "thread.unsnooze",
        commandId: CommandId.make("wake:idle-stranger"),
        threadId: ids.stranger,
        reason: "user",
      });

      const run = yield* send(ids.stranger, "first task");
      yield* snoozeWhenIdle("snooze:busy-stranger");
      assert.isNull(yield* snoozedUntil(ids.stranger));
      assert.deepInclude(yield* snoozeWhenIdleOf(ids.stranger), { scope: "thread" });
      yield* orchestrator.dispatch({
        type: "thread.unsnooze",
        commandId: CommandId.make("cancel:busy-stranger"),
        threadId: ids.stranger,
        reason: "user",
      });
      assert.isNull(yield* snoozeWhenIdleOf(ids.stranger));

      yield* snoozeWhenIdle("snooze:busy-stranger-again");
      assert.isNotNull(yield* snoozeWhenIdleOf(ids.stranger));
      yield* send(ids.stranger, "one more thing", "queue_after_active");
      assert.isNull(yield* snoozeWhenIdleOf(ids.stranger));
      yield* endRun(ids.stranger, run.id);
    }),
  );

  it.effect("a pull request watch wake unsnoozes its thread", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:watched-slice");
      yield* createThread(threadId);
      const key = { host: "github.com", repository: "pingdotgg/t3code", number: 21 };
      const url = "https://github.com/pingdotgg/t3code/pull/21";
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("watch:slice"),
        threadId,
        ...key,
        watching: true,
        link: { url, source: "agent" },
      });
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("snooze:watched"),
        threadId,
        snoozedUntil: yield* later(6),
        scope: "tree",
      });
      const watch = (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch;
      assert.isDefined(watch);
      if (watch === undefined) return;
      yield* orchestrator.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make("watch:wake"),
        threadId,
        ...key,
        startedAt: watch.startedAt,
        watch: { ...watch, failedChecks: ["lint"], wakes: 1 },
        wake: {
          text: "Checks failed on #21.",
          notification: {
            source: { kind: "monitor" },
            outcome: "failed",
            summary: "#21: lint failed",
          },
          messageId: MessageId.make("message:watch-wake"),
        },
      });
      assert.isNull(yield* snoozedUntil(threadId));
    }),
  );

  it.effect("reads the threads on a worktree and whether each is parked", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const worktreePath = "/work/pods/parked";
      const broker = ThreadId.make("thread:pod-broker");
      const cell = ThreadId.make("thread:pod-cell");
      yield* createThread(broker, { worktreePath });
      yield* createThread(cell, { worktreePath });
      yield* createThread(ThreadId.make("thread:elsewhere"), { worktreePath: "/work/pods/other" });
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("snooze:pod-broker"),
        threadId: broker,
        snoozedUntil: yield* later(1),
        scope: "tree",
      });
      const run = yield* send(cell, "work in the pod");
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const parking = yield* projections.getThreadParking({ worktreePath });
      assert.sameMembers(
        parking.map((thread) => thread.id),
        [broker, cell],
      );
      const parked = new Map(parking.map((thread) => [thread.id, isThreadParked(thread, nowMs)]));
      assert.isTrue(parked.get(broker));
      assert.isFalse(parked.get(cell));

      yield* endRun(cell, run.id);
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("settle:pod-cell"),
        threadId: cell,
      });
      const after = yield* projections.getThreadParking({ worktreePath });
      assert.isTrue(after.every((thread) => isThreadParked(thread, nowMs)));
    }),
  );
});
