import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2AppThread,
  PodRuntimeId,
  type PodRuntimeSnapshot,
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
import * as TestClock from "effect/testing/TestClock";

import * as PodRuntimeService from "../pod/PodRuntimeService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as PodParkingReactor from "./PodParkingReactor.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as SnoozeWhenIdleReactor from "./SnoozeWhenIdleReactor.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const projectId = ProjectId.make("project:settle-tree");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const worktrees = {
  meta: "/work/pods/meta",
  slice: "/work/pods/slice",
  cell: "/work/pods/cell",
  lone: "/work/pods/lone",
};

/** One pod per worktree, recording each park and start the reactor asks for. */
const calls: Array<string> = [];
const pods = new Map<string, PodRuntimeSnapshot>(
  Object.values(worktrees).map((worktreePath, index) => [
    worktreePath,
    {
      id: PodRuntimeId.make(`pod-settletree${index}`),
      projectId,
      worktreePath,
      state: "running",
      services: [],
      image: "docker:27-cli",
      startedAt: null,
      lastError: null,
      containerIds: [],
      volumeIds: [],
      updatedAt: "2026-10-21T00:00:00.000Z",
    },
  ]),
);
const podById = (id: PodRuntimeId) => [...pods.values()].find((pod) => pod.id === id)!;
const layerPods = Layer.mock(PodRuntimeService.PodRuntimeService)({
  live: Effect.sync(() => [...pods.values()]),
  forPath: (path) => Effect.sync(() => pods.get(path)),
  park: (id, options) =>
    Effect.gen(function* () {
      const pod = podById(id);
      if ((yield* options.parkedSince) === null) return false;
      yield* options.beforeStop;
      calls.push(`park ${pod.worktreePath}`);
      pods.set(pod.worktreePath, { ...pod, state: "stopped", parked: true });
      return true;
    }),
  start: (id) =>
    Effect.sync(() => {
      const { parked: _parked, ...pod } = podById(id);
      calls.push(`start ${pod.worktreePath}`);
      const started = { ...pod, state: "running" as const };
      pods.set(pod.worktreePath, started);
      return started;
    }),
});

const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.merge(
  PodParkingReactor.layer.pipe(
    Layer.provide(
      Layer.merge(
        layerPods,
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          releasePod: () => Effect.void,
        }),
      ),
    ),
  ),
  SnoozeWhenIdleReactor.layer,
).pipe(
  Layer.provideMerge(ThreadManagementService.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      EventStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "settle-tree" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  Layer.provideMerge(NodeCrypto.layer),
);

const sweep = Effect.flatMap(PodParkingReactor.PodParkingReactor, (reactor) => reactor.sweep);
const sweepWaits = Effect.flatMap(
  SnoozeWhenIdleReactor.SnoozeWhenIdleReactor,
  (reactor) => reactor.sweep,
);

const createThread = (threadId: ThreadId, worktreePath: string, supervisorThreadId?: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId,
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath,
      ...(supervisorThreadId === undefined ? {} : { supervisorThreadId }),
      createdBy: "user",
      creationSource: "web",
    }),
  );

/** A delegated child on its own worktree, as delegate_task records it, without a provider run. */
const createSubagent = (threadId: ThreadId, parent: ThreadId, worktreePath: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const parentThread = (yield* orchestrator.getThreadProjection(parent)).thread;
    const payload: OrchestrationV2AppThread = {
      ...parentThread,
      id: threadId,
      title: threadId,
      worktreePath,
      settledOverride: null,
      settledAt: null,
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

const send = (threadId: ThreadId, text: string) =>
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
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const projection = yield* orchestrator.getThreadProjection(threadId);
    return projection.runs.find((run) => run.userMessageId === messageId)!.id;
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

const threadOf = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.getThreadProjection(threadId),
  ).pipe(Effect.map((projection) => projection.thread));
const settledOverrideOf = (threadId: ThreadId) =>
  Effect.map(threadOf(threadId), (thread) => thread.settledOverride);

const ids = {
  meta: ThreadId.make("thread:meta"),
  slice: ThreadId.make("thread:slice"),
  cell: ThreadId.make("thread:cell"),
  doneCell: ThreadId.make("thread:done-cell"),
  freshCell: ThreadId.make("thread:fresh-cell"),
  lone: ThreadId.make("thread:lone"),
};

it.layer(layerTest)("settle trees", (it) => {
  it.effect(
    "settles a tree and stops each of its pods, and a tree unsettle starts them again",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        // meta supervises a slice; the slice delegated two cells, one already settled.
        yield* createThread(ids.meta, worktrees.meta);
        yield* createThread(ids.slice, worktrees.slice, ids.meta);
        yield* createSubagent(ids.cell, ids.slice, worktrees.cell);
        yield* createSubagent(ids.doneCell, ids.slice, worktrees.cell);
        yield* orchestrator.dispatch({
          type: "thread.settle",
          commandId: CommandId.make("settle:done-cell"),
          threadId: ids.doneCell,
        });
        const doneCellSequence = yield* orchestrator.getThreadEventSequence(ids.doneCell);
        yield* TestClock.adjust("1 minute");

        // A worktree with a thread still active keeps its pod.
        yield* sweep;
        assert.deepEqual(calls, []);

        yield* orchestrator.dispatch({
          type: "thread.settle",
          commandId: CommandId.make("settle:tree"),
          threadId: ids.meta,
          scope: "tree",
        });
        for (const threadId of [ids.meta, ids.slice, ids.cell, ids.doneCell])
          assert.equal(yield* settledOverrideOf(threadId), "settled", threadId);
        // Already settled: the cascade leaves it alone.
        assert.equal(yield* orchestrator.getThreadEventSequence(ids.doneCell), doneCellSequence);

        yield* sweep;
        assert.sameMembers(calls, [
          `park ${worktrees.meta}`,
          `park ${worktrees.slice}`,
          `park ${worktrees.cell}`,
        ]);
        calls.length = 0;

        // Delegated after the settle, so still active when the tree is unsettled.
        yield* createSubagent(ids.freshCell, ids.slice, worktrees.cell);
        yield* orchestrator.dispatch({
          type: "thread.unsettle",
          commandId: CommandId.make("unsettle:tree"),
          threadId: ids.meta,
          reason: "user",
          scope: "tree",
        });
        // It reopens what the tree settle retired, each pinned active as
        // unsettling it alone would; a cell settled on its own stays settled,
        // and one still active is left to auto-settle.
        for (const threadId of [ids.meta, ids.slice, ids.cell])
          assert.equal(yield* settledOverrideOf(threadId), "active", threadId);
        assert.equal(yield* settledOverrideOf(ids.doneCell), "settled");
        assert.isNull(yield* settledOverrideOf(ids.freshCell));

        yield* sweep;
        assert.sameMembers(calls, [
          `start ${worktrees.meta}`,
          `start ${worktrees.slice}`,
          `start ${worktrees.cell}`,
        ]);
        calls.length = 0;
      }),
  );

  it.effect(
    "a tree settle waits for the work in the tree, then settles it and parks its pods",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const tree = [ids.meta, ids.slice, ids.cell, ids.doneCell, ids.freshCell];
        const run = yield* send(ids.cell, "keep building");
        yield* orchestrator.dispatch({
          type: "thread.settle",
          commandId: CommandId.make("settle:busy-tree"),
          threadId: ids.meta,
          scope: "tree",
        });
        assert.deepInclude((yield* threadOf(ids.meta)).settleWhenIdle, { scope: "tree" });
        for (const threadId of tree.filter((threadId) => threadId !== ids.doneCell))
          assert.notEqual(yield* settledOverrideOf(threadId), "settled", threadId);

        // Still working: the wait stands and nothing parks.
        yield* sweepWaits;
        yield* sweep;
        assert.notEqual(yield* settledOverrideOf(ids.meta), "settled");
        assert.deepEqual(calls, []);

        yield* endRun(ids.cell, run);
        yield* sweepWaits;
        for (const threadId of tree)
          assert.equal(yield* settledOverrideOf(threadId), "settled", threadId);
        assert.isNull((yield* threadOf(ids.meta)).settleWhenIdle ?? null);
        yield* sweep;
        assert.sameMembers(calls, [
          `park ${worktrees.meta}`,
          `park ${worktrees.slice}`,
          `park ${worktrees.cell}`,
        ]);
        calls.length = 0;
      }),
  );

  it.effect("an unsettle of the root or a new message to it calls the wait off", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make("unsettle:tree-again"),
        threadId: ids.meta,
        reason: "user",
        scope: "tree",
      });
      yield* sweep;
      calls.length = 0;

      const cellRun = yield* send(ids.cell, "one more pass");
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("settle:tree-then-unsettle"),
        threadId: ids.meta,
        scope: "tree",
      });
      yield* orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make("unsettle:meta-cancels"),
        threadId: ids.meta,
        reason: "user",
      });
      assert.isNull((yield* threadOf(ids.meta)).settleWhenIdle ?? null);

      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("settle:tree-then-message"),
        threadId: ids.meta,
        scope: "tree",
      });
      assert.isNotNull((yield* threadOf(ids.meta)).settleWhenIdle ?? null);
      const metaRun = yield* send(ids.meta, "actually, one more thing");
      assert.isNull((yield* threadOf(ids.meta)).settleWhenIdle ?? null);

      yield* endRun(ids.cell, cellRun);
      yield* endRun(ids.meta, metaRun);
      yield* sweepWaits;
      for (const threadId of [ids.meta, ids.slice, ids.cell])
        assert.notEqual(yield* settledOverrideOf(threadId), "settled", threadId);
      yield* sweep;
      assert.deepEqual(calls, []);
    }),
  );

  it.effect("a descendant that refuses leaves the rest of the tree settled, and names it", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      // A refusal recorded under the id the cascade derives for the slice.
      yield* orchestrator
        .dispatch({
          type: "thread.unarchive",
          commandId: CommandId.make(`settle:partial:tree:${ids.slice}`),
          threadId: ids.slice,
        })
        .pipe(Effect.exit);
      const partial = yield* orchestrator
        .dispatch({
          type: "thread.settle",
          commandId: CommandId.make("settle:partial"),
          threadId: ids.meta,
          scope: "tree",
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(partial));
      assert.include(String(partial), ids.slice);
      for (const threadId of [ids.meta, ids.cell, ids.freshCell])
        assert.equal(yield* settledOverrideOf(threadId), "settled", threadId);
      assert.notEqual(yield* settledOverrideOf(ids.slice), "settled");

      yield* orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make("unsettle:after-partial"),
        threadId: ids.meta,
        reason: "user",
        scope: "tree",
      });
      yield* sweep;
      calls.length = 0;
    }),
  );

  it.effect("an agent settling its own tree mid-turn settles it once all the work in it ends", () =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const run = yield* send(ids.meta, "settle the tree when done");
      const cellRun = yield* send(ids.cell, "still building");
      assert.isNotNull((yield* threads.getThreadShell(ids.meta))?.activeRunId ?? null);
      const result = yield* threads.settleThread({
        threadId: ids.meta,
        commandId: CommandId.make("settle:own-tree"),
        byOwnAgent: true,
        scope: "tree",
      });
      assert.deepEqual(result, { settlesWhenTurnEnds: true });
      assert.deepInclude((yield* threadOf(ids.meta)).settleWhenIdle, { scope: "tree" });
      assert.notEqual(yield* settledOverrideOf(ids.meta), "settled");

      yield* endRun(ids.meta, run);
      yield* sweepWaits;
      assert.notEqual(yield* settledOverrideOf(ids.meta), "settled");
      yield* endRun(ids.cell, cellRun);
      yield* sweepWaits;
      for (const threadId of [ids.meta, ids.slice, ids.cell])
        assert.equal(yield* settledOverrideOf(threadId), "settled", threadId);
      yield* sweep;
      calls.length = 0;
    }),
  );

  it.effect("a send to a settled pod thread unsettles it, which starts its pod", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* createThread(ids.lone, worktrees.lone);
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("settle:lone"),
        threadId: ids.lone,
      });
      yield* sweep;
      assert.deepEqual(calls, [`park ${worktrees.lone}`]);

      yield* send(ids.lone, "one more thing");
      assert.isNull(yield* settledOverrideOf(ids.lone));
      yield* sweep;
      assert.deepEqual(calls, [`park ${worktrees.lone}`, `start ${worktrees.lone}`]);
    }),
  );
});
