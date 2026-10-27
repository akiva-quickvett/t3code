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
  RunId,
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
import { settleBlockedThreads } from "./settleBlocker.ts";
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

  it.effect("leaves a descendant that limit recovery parked to its own reset", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const lead = ThreadId.make("thread:limit-lead");
      const limited = ThreadId.make("thread:limit-cell");
      yield* createThread(lead);
      yield* createSubagent(limited, lead);
      const resetAt = DateTime.add(yield* DateTime.now, { hours: 5 });
      const row = (yield* orchestrator.getThreadProjection(limited)).thread;
      yield* projections.apply({
        id: EventId.make("event:limit-cell:parked"),
        type: "thread.metadata-updated",
        threadId: limited,
        providerInstanceId: instanceId,
        occurredAt: yield* DateTime.now,
        payload: {
          ...row,
          snoozedUntil: resetAt,
          snoozedAt: yield* DateTime.now,
          limitRecovery: {
            runId: RunId.make("run:limit-cell"),
            resetAt: DateTime.formatIso(resetAt),
            autoResume: true,
            snooze: true,
          },
        },
      });
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("snooze:limit-lead"),
        threadId: lead,
        snoozedUntil: yield* later(1),
        scope: "tree",
      });
      assert.equal(yield* snoozedUntil(limited), DateTime.formatIso(resetAt));
      yield* orchestrator.dispatch({
        type: "thread.unsnooze",
        commandId: CommandId.make("wake:limit-lead"),
        threadId: lead,
        reason: "user",
        scope: "tree",
      });
      assert.isNull(yield* snoozedUntil(lead));
      assert.equal(yield* snoozedUntil(limited), DateTime.formatIso(resetAt));
    }),
  );

  it.effect("applies a snooze when idle only while that request is still the pending one", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:cancelled-wait");
      yield* createThread(threadId);
      const run = yield* send(threadId, "busy for a while");
      const until = yield* later(3);
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("snooze:cancelled-wait"),
        threadId,
        snoozedUntil: until,
        whenIdle: true,
      });
      const requestedAt = (yield* snoozeWhenIdleOf(threadId))!.requestedAt;
      yield* endRun(threadId, run.id);
      // The request was cancelled and a new one made after the reactor read it.
      const stale = yield* orchestrator
        .dispatch({
          type: "thread.snooze",
          commandId: CommandId.make("apply:stale-wait"),
          threadId,
          snoozedUntil: until,
          whenIdleRequestedAt: "2000-01-01T00:00:00.000Z",
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(stale));
      assert.isNull(yield* snoozedUntil(threadId));
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("apply:current-wait"),
        threadId,
        snoozedUntil: until,
        whenIdleRequestedAt: requestedAt,
      });
      assert.equal(yield* snoozedUntil(threadId), until);
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

  it.effect("counts a pull request watch as how a thread wakes, not as work", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const lead = ThreadId.make("thread:watching-lead");
      const slice = ThreadId.make("thread:watching-slice");
      const worktreePath = "/work/pods/watching";
      yield* createThread(lead);
      yield* createThread(slice, { supervisorThreadId: lead, worktreePath });
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("watch:watching-slice"),
        threadId: slice,
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 31,
        watching: true,
        link: { url: "https://github.com/pingdotgg/t3code/pull/31", source: "agent" },
      });
      const until = yield* later(2);
      // Not refused as "still working", and no wait for the watch to end.
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("snooze:watching-lead"),
        threadId: lead,
        snoozedUntil: until,
        scope: "tree",
      });
      assert.equal(yield* snoozedUntil(slice), until);
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const parking = yield* projections.getThreadParking({ worktreePath });
      assert.isTrue(parking.every((thread) => isThreadParked(thread, nowMs)));
    }),
  );

  it.effect(
    "waits for a background subagent, not for a pull request watch, to snooze when idle",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const threadId = ThreadId.make("thread:background-agent");
        yield* createThread(threadId);
        const run = yield* send(threadId, "start a background subagent");
        yield* endRun(threadId, run.id);
        const providerThread = (yield* orchestrator.getThreadProjection(
          threadId,
        )).providerThreads.find((candidate) => candidate.id === run.providerThreadId)!;
        yield* projections.apply({
          id: EventId.make("event:background-agent:task"),
          type: "provider-thread.updated",
          threadId,
          providerInstanceId: instanceId,
          occurredAt: yield* DateTime.now,
          payload: {
            ...providerThread,
            pendingBackgroundTasks: [
              { taskId: "native-subagent-1", description: "Reviewing", kind: "subagent" },
            ],
          },
        });
        // The client offers "Snooze only this thread when idle"; the server agrees it is working.
        yield* orchestrator.dispatch({
          type: "thread.snooze",
          commandId: CommandId.make("snooze:background-agent"),
          threadId,
          snoozedUntil: yield* later(2),
          whenIdle: true,
        });
        assert.isNull(yield* snoozedUntil(threadId));
        assert.deepInclude(yield* snoozeWhenIdleOf(threadId), { scope: "thread" });
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

/**
 * Promote refuses a thread in an agent tree, so a meta below a root is set
 * directly: tree rules must still leave it out.
 */
const markMeta = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const thread = yield* projections.getThread(threadId);
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make(`event:meta:${threadId}`),
      type: "thread.metadata-updated",
      threadId,
      providerInstanceId: instanceId,
      occurredAt: now,
      payload: { ...thread, metaAt: now, autoSettleDisabledAt: now },
    });
  });

const promote = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.meta.set",
      commandId: CommandId.make(`promote:${threadId}`),
      threadId,
      enabled: true,
    }),
  );

const settledOf = (threadId: ThreadId) =>
  Effect.map(
    Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
      orchestrator.getThreadProjection(threadId),
    ),
    ({ thread }) => ({
      settled: thread.settledOverride === "settled",
      settledByTree: thread.settledByTree ?? null,
    }),
  );

it.layer(layerTest)("metas in trees", (it) => {
  it.effect("a tree snooze on a meta snoozes the meta alone, at once", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const meta = ThreadId.make("thread:tree-meta");
      const slice = ThreadId.make("thread:tree-meta-slice");
      yield* createThread(meta);
      yield* createThread(slice, { supervisorThreadId: meta });
      yield* promote(meta);
      yield* send(slice, "keep building");
      const until = yield* later(2);
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("snooze:tree-meta"),
        threadId: meta,
        snoozedUntil: until,
        scope: "tree",
      });
      assert.equal(yield* snoozedUntil(meta), until);
      assert.isNull(yield* snoozedUntil(slice));
      assert.isNull(yield* snoozeWhenIdleOf(slice));
    }),
  );

  it.effect("a tree wake on a meta wakes the meta alone", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const meta = ThreadId.make("thread:wake-meta");
      const slice = ThreadId.make("thread:wake-meta-slice");
      yield* createThread(meta);
      yield* createThread(slice, { supervisorThreadId: meta });
      yield* promote(meta);
      const sliceUntil = yield* later(5);
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("snooze:wake-meta-slice"),
        threadId: slice,
        snoozedUntil: sliceUntil,
        scope: "thread",
      });
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("snooze:wake-meta"),
        threadId: meta,
        snoozedUntil: yield* later(2),
        scope: "tree",
      });
      yield* orchestrator.dispatch({
        type: "thread.unsnooze",
        commandId: CommandId.make("unsnooze:wake-meta"),
        threadId: meta,
        reason: "user",
        scope: "tree",
      });
      assert.isNull(yield* snoozedUntil(meta));
      assert.equal(yield* snoozedUntil(slice), sliceUntil);
    }),
  );

  it.effect("a busy meta's snooze when idle waits for its own work, scoped to itself", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const meta = ThreadId.make("thread:busy-meta");
      yield* createThread(meta);
      yield* promote(meta);
      yield* send(meta, "relay the results");
      const until = yield* later(2);
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("snooze:busy-meta"),
        threadId: meta,
        snoozedUntil: until,
        scope: "tree",
        whenIdle: true,
      });
      assert.isNull(yield* snoozedUntil(meta));
      assert.deepInclude(yield* snoozeWhenIdleOf(meta), { snoozedUntil: until, scope: "thread" });
    }),
  );

  it.effect("a tree snooze above a meta snoozes the rest of the tree and skips the meta", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const root = ThreadId.make("thread:snooze-root");
      const meta = ThreadId.make("thread:snooze-root-meta");
      const sibling = ThreadId.make("thread:snooze-root-sibling");
      yield* createThread(root);
      yield* createSubagent(meta, root);
      yield* createSubagent(sibling, root);
      yield* markMeta(meta);
      const until = yield* later(3);
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("snooze:root-over-meta"),
        threadId: root,
        snoozedUntil: until,
        scope: "tree",
      });
      assert.equal(yield* snoozedUntil(root), until);
      assert.equal(yield* snoozedUntil(sibling), until);
      assert.isNull(yield* snoozedUntil(meta));
    }),
  );

  it.effect("a tree settle above a running meta neither waits for it nor settles it", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const root = ThreadId.make("thread:settle-root");
      const meta = ThreadId.make("thread:settle-root-meta");
      const sibling = ThreadId.make("thread:settle-root-sibling");
      yield* createThread(root);
      yield* createSubagent(meta, root);
      yield* createSubagent(sibling, root);
      yield* markMeta(meta);
      yield* send(meta, "keep relaying");
      const tree = yield* projections.getThreadParking({ treeOf: root });
      assert.isTrue(tree.find((thread) => thread.id === meta)?.busy);
      assert.deepEqual(yield* settleBlockedThreads(projections, tree), []);

      const result = yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("settle:root-over-meta"),
        threadId: root,
        scope: "tree",
      });
      assert.notProperty(result, "waitsForIdle");
      assert.deepEqual(yield* settledOf(root), { settled: true, settledByTree: null });
      assert.deepEqual(yield* settledOf(sibling), { settled: true, settledByTree: root });
      assert.deepEqual(yield* settledOf(meta), { settled: false, settledByTree: null });
    }),
  );
});
