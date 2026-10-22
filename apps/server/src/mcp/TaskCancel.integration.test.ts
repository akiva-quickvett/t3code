import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderTurn,
  type ProviderSessionId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { layerWithoutPods } from "../pod/testkit/layerWithoutPods.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const layerOrchestratorService = OrchestratorMcpService.layer.pipe(
  Layer.provide(layerWithoutPods),
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);

const driver = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claudeAgent");
const modelSelection = { instanceId, model: "claude-test" };

interface StartedTurn {
  readonly turn: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly providerTurn: OrchestrationV2ProviderTurn;
  readonly events: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>;
  running: boolean;
}

/**
 * A fake Claude adapter over the real orchestrator, session manager and MCP service.
 * With `interruptGate`, an interrupted turn ends only once the gate opens, as with
 * adapters whose interrupt returns before the turn has ended.
 */
const makeHarness = (
  name: string,
  options: { readonly interruptGate?: Deferred.Deferred<void> } = {},
) =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace(name);
    const turns: Array<StartedTurn> = [];
    const opened: Array<{ readonly threadId: ThreadId; readonly id: ProviderSessionId }> = [];
    const closed: Array<ProviderSessionId> = [];
    const resumed: Array<ThreadId | null> = [];
    let interruptRequests = 0;
    const endTurn = (started: StartedTurn, status: "completed" | "interrupted") =>
      Effect.gen(function* () {
        started.running = false;
        const now = yield* DateTime.now;
        yield* Queue.offer(started.events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...started.providerTurn, status, completedAt: now },
        });
        yield* Queue.offer(started.events, {
          type: "turn.terminal",
          driver,
          providerThreadId: started.providerTurn.providerThreadId,
          providerTurnId: started.providerTurn.id,
          runOrdinal: started.turn.runOrdinal,
          status,
          failure: null,
          threadDisposition: "reusable",
        });
      });
    const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
      instanceId,
      driver,
      getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: (input) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
          opened.push({ threadId: input.threadId, id: input.providerSessionId });
          // The session scope closing stands in for the CLI process exiting.
          yield* Effect.addFinalizer(() => Effect.sync(() => closed.push(input.providerSessionId)));
          return {
            instanceId,
            driver,
            providerSessionId: input.providerSessionId,
            providerSession: {
              id: input.providerSessionId,
              driver,
              providerInstanceId: instanceId,
              status: "ready",
              cwd,
              model: modelSelection.model,
              capabilities: ClaudeProviderCapabilitiesV2,
              createdAt: now,
              updatedAt: now,
              lastError: null,
            },
            events: Stream.fromQueue(events),
            ensureThread: ({ threadId }) =>
              Effect.succeed({
                id: ProviderThreadId.make(`provider-thread:${threadId}`),
                driver,
                providerInstanceId: instanceId,
                providerSessionId: input.providerSessionId,
                appThreadId: threadId,
                ownerNodeId: null,
                nativeThreadRef: { driver, nativeId: `native:${threadId}`, strength: "strong" },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt: now,
                updatedAt: now,
              }),
            resumeThread: ({ providerThread }) =>
              Effect.sync(() => {
                resumed.push(providerThread.appThreadId);
                return providerThread;
              }),
            startTurn: (turn) =>
              Effect.gen(function* () {
                const providerTurn: OrchestrationV2ProviderTurn = {
                  id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                  providerThreadId: turn.providerThread.id,
                  nodeId: turn.rootNodeId,
                  runAttemptId: turn.attemptId,
                  nativeTurnRef: null,
                  ordinal: turn.providerTurnOrdinal,
                  status: "running",
                  startedAt: now,
                  completedAt: null,
                };
                turns.push({ turn, providerTurn, events, running: true });
                yield* Queue.offer(events, {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn,
                });
              }),
            steerTurn: () => Effect.die("unused"),
            interruptTurn: ({ providerTurnId }) => {
              interruptRequests += 1;
              const started = turns.find((entry) => entry.providerTurn.id === providerTurnId);
              // Like the Claude adapter, an interrupt of a turn that already ended emits nothing.
              if (started?.running !== true) return Effect.void;
              const gate = options.interruptGate;
              return gate === undefined
                ? endTurn(started, "interrupted")
                : Deferred.await(gate).pipe(
                    Effect.andThen(endTurn(started, "interrupted")),
                    Effect.forkDetach,
                    Effect.asVoid,
                  );
            },
            respondToRuntimeRequest: () => Effect.die("unused"),
            readThreadSnapshot: () => Effect.die("unused"),
            rollbackThread: () => Effect.die("unused"),
            forkThread: () => Effect.die("unused"),
          };
        }),
    };
    const layerAdapters = ProviderAdapterRegistry.layerSingle(adapter);
    const layerOrchestrator = ProviderReplayHarness.layerWithRegistry({ name }, layerAdapters, {
      runEffectWorker: false,
      realThreadManagement: true,
    });
    const layerOrchestration = Layer.merge(
      layerOrchestrator,
      ThreadManagementService.layer.pipe(
        Layer.provide(layerOrchestrator),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
      ),
    );
    const layer = layerOrchestratorService.pipe(
      Layer.provideMerge(layerOrchestration),
      Layer.provide(
        Layer.mergeAll(
          layerAdapters,
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          ServerSettings.layerTest(),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          NodeServices.layer,
        ),
      ),
    );
    return {
      cwd,
      turns,
      opened,
      closed,
      resumed,
      interruptRequests: () => interruptRequests,
      endTurn,
      layer,
    };
  });

/** Thread and task steps shared by the tests, run inside a harness's layer. */
const makeSteps = (cwd: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
      orchestrator.streamDomainEvents.pipe(
        Stream.filter(predicate),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkScoped,
      );
    const turnRunning = (threadId?: ThreadId) =>
      watch(
        (event) =>
          event.type === "provider-turn.updated" &&
          event.payload.status === "running" &&
          (threadId === undefined || event.threadId === threadId),
      );
    const startThread = (threadId: ThreadId) =>
      Effect.gen(function* () {
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create:${threadId}`),
          threadId,
          projectId: ProjectId.make("project:task-cancel"),
          title: "Parent",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        const running = yield* turnRunning(threadId);
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`start:${threadId}`),
          threadId,
          messageId: MessageId.make(`message:start:${threadId}`),
          text: "Delegate a review",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        yield* Fiber.join(running);
      });
    const delegate = (parentThreadId: ThreadId) =>
      Effect.gen(function* () {
        const parent = yield* orchestrator.getThreadProjection(parentThreadId);
        const parentRun = parent.runs.findLast((run) => run.status === "running")!;
        const running = yield* turnRunning();
        yield* orchestrator.dispatch({
          type: "delegated_task.request",
          commandId: CommandId.make(`delegate:${parentThreadId}:${parent.subagents.length}`),
          parentThreadId,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId!,
          task: "Review the change",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          completionWake: "always",
          createdBy: "agent",
          creationSource: "mcp",
        });
        yield* worker.drain();
        yield* Fiber.join(running);
        const task = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.at(-1)!;
        return { taskId: task.id, childThreadId: task.childThreadId! };
      });
    const sessionOf = (threadId: ThreadId) =>
      orchestrator
        .getThreadProjection(threadId)
        .pipe(Effect.map((projection) => projection.providerSessions[0]!.id));
    const detached: Array<
      Extract<OrchestrationV2DomainEvent, { readonly type: "provider-session.detached" }>
    > = [];
    yield* orchestrator.streamDomainEvents.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          if (event.type === "provider-session.detached") detached.push(event);
        }),
      ),
      Effect.forkScoped,
    );
    const detachedEvents = (threadId: ThreadId) =>
      detached.filter((event) => event.threadId === threadId).map((event) => event.payload);
    const runEnded = (threadId: ThreadId) =>
      watch(
        (event) =>
          event.type === "run.updated" &&
          event.threadId === threadId &&
          event.payload.status !== "running" &&
          event.payload.status !== "waiting" &&
          event.payload.status !== "queued" &&
          event.payload.status !== "starting" &&
          event.payload.status !== "preparing",
      );
    // Runs effects as the worker does, each time the outbox signals work, until `fiber` ends.
    const drainUntil = <A, E>(fiber: Fiber.Fiber<A, E>) =>
      Effect.raceFirst(
        Fiber.join(fiber),
        Effect.forever(worker.drain().pipe(Effect.andThen(worker.awaitWork))),
      );
    const scopeOf = (threadId: ThreadId): McpInvocationScope => ({
      environmentId: EnvironmentId.make("environment:task-cancel"),
      requestNamespace: "provider-session:task-cancel",
      thread: {
        threadId,
        providerSessionId: "provider-session:task-cancel",
        providerInstanceId: instanceId,
      },
      client: undefined,
      capabilities: new Set(["orchestration"]),
      issuedAt: 1,
    });
    return {
      orchestrator,
      worker,
      watch,
      turnRunning,
      startThread,
      delegate,
      sessionOf,
      detachedEvents,
      runEnded,
      drainUntil,
      scopeOf,
    };
  });

// A delegated Claude child ends its turn while a background native subagent it
// started keeps running (#17154).

it.effect("task_cancel ends a delegated child's background native subagent", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness("task-cancel-native-subagent");
      yield* Effect.gen(function* () {
        const { orchestrator, worker, watch, startThread, delegate, scopeOf } = yield* makeSteps(
          harness.cwd,
        );
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const parentThreadId = ThreadId.make("thread:task-cancel-parent");
        yield* startThread(parentThreadId);
        const task = yield* delegate(parentThreadId);
        const child = harness.turns.find((entry) => entry.turn.threadId === task.childThreadId)!;
        const childTurn = (yield* orchestrator.getThreadProjection(task.childThreadId))
          .providerTurns[0]!;

        const now = yield* DateTime.now;
        const subagentId = NodeId.make("node:native-subagent");
        const native = {
          threadId: task.childThreadId,
          runId: child.turn.runId,
          origin: "provider_native",
          driver,
          providerInstanceId: instanceId,
          providerThreadId: childTurn.providerThreadId,
          childThreadId: null,
          prompt: "Check the tests",
          title: null,
          status: "running",
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        } as const;
        const waiting = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === child.turn.runId &&
            event.payload.status === "waiting",
        );
        for (const event of [
          {
            type: "node.updated",
            driver,
            node: {
              id: subagentId,
              threadId: native.threadId,
              runId: native.runId,
              parentNodeId: child.turn.rootNodeId,
              rootNodeId: child.turn.rootNodeId,
              kind: "subagent",
              status: "running",
              countsForRun: false,
              providerThreadId: childTurn.providerThreadId,
              providerTurnId: childTurn.id,
              nativeItemRef: null,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: now,
              completedAt: null,
            },
          },
          {
            type: "subagent.updated",
            driver,
            subagent: {
              ...native,
              id: subagentId,
              parentNodeId: child.turn.rootNodeId,
              createdBy: "agent",
              nativeTaskRef: null,
              model: null,
            },
          },
          {
            type: "turn_item.updated",
            driver,
            turnItem: {
              ...native,
              id: TurnItemId.make("turn-item:native-subagent"),
              nodeId: subagentId,
              providerTurnId: childTurn.id,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              type: "subagent",
              subagentId,
            },
          },
          {
            type: "provider_turn.updated",
            driver,
            providerTurn: { ...childTurn, status: "completed", completedAt: now },
          },
          {
            type: "turn.terminal",
            driver,
            providerThreadId: childTurn.providerThreadId,
            providerTurnId: childTurn.id,
            runOrdinal: child.turn.runOrdinal,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          },
        ] satisfies ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) {
          yield* Queue.offer(child.events, event);
        }
        child.running = false;
        yield* Fiber.join(waiting);
        yield* worker.drain();

        const scope = scopeOf(parentThreadId);
        const before = yield* service.taskStatus(scope, task.taskId);
        assert.equal(before.status, "running");
        assert.equal(before.workState, "waiting_for_children");

        const cancelled = yield* service.cancelTask(scope, {
          taskId: task.taskId,
          clientRequestId: "cancel-task",
        });
        assert.equal(cancelled.status, "cancel_requested");
        yield* worker.drain();

        const childAfter = yield* orchestrator.getThreadProjection(task.childThreadId);
        assert.equal(
          childAfter.subagents.find((entry) => entry.id === subagentId)?.status,
          "interrupted",
        );
        assert.equal(
          childAfter.nodes.find((entry) => entry.id === subagentId)?.status,
          "interrupted",
        );
        assert.equal(
          childAfter.turnItems.find((item) => item.type === "subagent")?.status,
          "interrupted",
        );

        const after = yield* service.taskStatus(scope, task.taskId);
        assert.equal(after.status, "completed");
        assert.notEqual(after.workState, "waiting_for_children");
      }).pipe(Effect.provide(harness.layer));
    }),
  ),
);

it.effect(
  "task_cancel detaches the cancelled child's provider session, which a follow-up resumes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("task-cancel-detach");
        yield* Effect.gen(function* () {
          const steps = yield* makeSteps(harness.cwd);
          const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const parentThreadId = ThreadId.make("thread:task-cancel-detach-parent");
          yield* steps.startThread(parentThreadId);
          const task = yield* steps.delegate(parentThreadId);
          const parentSession = yield* steps.sessionOf(parentThreadId);
          const childSession = yield* steps.sessionOf(task.childThreadId);
          assert.isTrue(Option.isSome(yield* sessions.get(childSession)));

          const scope = steps.scopeOf(parentThreadId);
          const childEnded = yield* steps.runEnded(task.childThreadId);
          const cancelled = yield* service.cancelTask(scope, {
            taskId: task.taskId,
            clientRequestId: "cancel-task",
          });
          assert.equal(cancelled.status, "cancel_requested");
          yield* steps.worker.drain();
          yield* Fiber.join(childEnded);

          assert.deepEqual(
            steps
              .detachedEvents(task.childThreadId)
              .map((payload) => [payload.providerSessionId, payload.reason]),
            [[childSession, "Delegated task cancelled."]],
          );
          assert.deepEqual(harness.closed, [childSession]);
          assert.isTrue(Option.isNone(yield* sessions.get(childSession)));
          assert.isTrue(Option.isSome(yield* sessions.get(parentSession)));
          const childAfter = yield* steps.orchestrator.getThreadProjection(task.childThreadId);
          assert.equal(childAfter.runs[0]?.status, "interrupted");
          assert.deepEqual(childAfter.providerSessions, []);

          // A retried cancel and a fresh one both succeed and find nothing left to detach.
          yield* service.cancelTask(scope, { taskId: task.taskId, clientRequestId: "cancel-task" });
          yield* service.cancelTask(scope, {
            taskId: task.taskId,
            clientRequestId: "cancel-again",
          });
          yield* steps.worker.drain();
          assert.lengthOf(steps.detachedEvents(task.childThreadId), 1);

          const resumedTurn = yield* steps.turnRunning(task.childThreadId);
          yield* steps.orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("follow-up"),
            threadId: task.childThreadId,
            messageId: MessageId.make("message:follow-up"),
            text: "One more thing",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* steps.worker.drain();
          yield* Fiber.join(resumedTurn);
          assert.deepEqual(
            harness.opened.filter((entry) => entry.threadId === task.childThreadId).length,
            2,
          );
          assert.deepEqual(harness.resumed, [task.childThreadId]);
          assert.isTrue(
            Option.isSome(yield* sessions.get(yield* steps.sessionOf(task.childThreadId))),
          );
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
);

// Some adapters' interrupts return before the turn ends. The Stop's interrupt effect
// then settles the run as interrupted, so the detach behind it fails nothing.
it.effect("task_cancel releases a session whose interrupted turn has not ended yet", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const interruptGate = yield* Deferred.make<void>();
      const harness = yield* makeHarness("task-cancel-slow-interrupt", { interruptGate });
      yield* Effect.gen(function* () {
        const steps = yield* makeSteps(harness.cwd);
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const parentThreadId = ThreadId.make("thread:task-cancel-slow-interrupt-parent");
        yield* steps.startThread(parentThreadId);
        const task = yield* steps.delegate(parentThreadId);
        const childSession = yield* steps.sessionOf(task.childThreadId);

        yield* service.cancelTask(steps.scopeOf(parentThreadId), {
          taskId: task.taskId,
          clientRequestId: "cancel-slow-interrupt",
        });
        yield* steps.worker.drain();
        assert.equal(harness.interruptRequests(), 1);
        assert.deepEqual(harness.closed, [childSession]);

        // The provider's terminal arrives after its session is gone.
        yield* Deferred.succeed(interruptGate, undefined);
        yield* steps.worker.drain();
        const child = yield* steps.orchestrator.getThreadProjection(task.childThreadId);
        assert.equal(child.runs[0]?.status, "interrupted");
        assert.isFalse(child.turnItems.some((item) => item.type === "error"));
        assert.lengthOf(steps.detachedEvents(task.childThreadId), 1);
      }).pipe(Effect.provide(harness.layer));
    }),
  ),
);

it.effect("task_cancel detaches every delegated thread it stops", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness("task-cancel-detach-tree");
      yield* Effect.gen(function* () {
        const steps = yield* makeSteps(harness.cwd);
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const parentThreadId = ThreadId.make("thread:task-cancel-tree-parent");
        yield* steps.startThread(parentThreadId);
        const task = yield* steps.delegate(parentThreadId);
        const grandchild = yield* steps.delegate(task.childThreadId);
        const childSession = yield* steps.sessionOf(task.childThreadId);
        const grandchildSession = yield* steps.sessionOf(grandchild.childThreadId);

        yield* service.cancelTask(steps.scopeOf(parentThreadId), {
          taskId: task.taskId,
          clientRequestId: "cancel-tree",
        });
        yield* steps.worker.drain();

        assert.lengthOf(steps.detachedEvents(task.childThreadId), 1);
        assert.lengthOf(steps.detachedEvents(grandchild.childThreadId), 1);
        assert.lengthOf(steps.detachedEvents(parentThreadId), 0);
        assert.sameMembers(harness.closed, [childSession, grandchildSession]);
      }).pipe(Effect.provide(harness.layer));
    }),
  ),
);

it.effect("a user Stop keeps the stopped threads' provider sessions", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness("task-cancel-user-stop");
      yield* Effect.gen(function* () {
        const steps = yield* makeSteps(harness.cwd);
        const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const parentThreadId = ThreadId.make("thread:task-cancel-user-stop-parent");
        yield* steps.startThread(parentThreadId);
        const task = yield* steps.delegate(parentThreadId);
        const parentRun = (yield* steps.orchestrator.getThreadProjection(parentThreadId)).runs[0]!;

        // The client's Stop: its delegated-tasks.stop effect stops the child too.
        const childEnded = yield* steps.runEnded(task.childThreadId);
        yield* steps.orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("user-stop"),
          threadId: parentThreadId,
          runId: parentRun.id,
          holdQueue: true,
        });
        yield* steps.drainUntil(childEnded);
        yield* steps.worker.drain();

        const child = yield* steps.orchestrator.getThreadProjection(task.childThreadId);
        assert.equal(child.runs[0]?.status, "interrupted");
        assert.lengthOf(steps.detachedEvents(task.childThreadId), 0);
        assert.lengthOf(steps.detachedEvents(parentThreadId), 0);
        assert.deepEqual(harness.closed, []);
        assert.isTrue(
          Option.isSome(yield* sessions.get(yield* steps.sessionOf(task.childThreadId))),
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  ),
);

it.effect("task_cancel leaves a session idle release already closed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness("task-cancel-after-idle-release");
      yield* Effect.gen(function* () {
        const steps = yield* makeSteps(harness.cwd);
        const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const parentThreadId = ThreadId.make("thread:task-cancel-idle-parent");
        yield* steps.startThread(parentThreadId);
        const task = yield* steps.delegate(parentThreadId);
        const childSession = yield* steps.sessionOf(task.childThreadId);
        const childTurn = harness.turns.find(
          (entry) => entry.turn.threadId === task.childThreadId,
        )!;
        const completed = yield* steps.watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === childTurn.turn.runId &&
            event.payload.status === "completed",
        );
        yield* harness.endTurn(childTurn, "completed");
        yield* steps.drainUntil(completed);
        yield* sessions.release({ providerSessionId: childSession, reason: "idle_timeout" });
        const released = yield* steps.orchestrator.getThreadProjection(task.childThreadId);
        assert.equal(released.providerSessions[0]?.status, "stopped");

        yield* service.cancelTask(steps.scopeOf(parentThreadId), {
          taskId: task.taskId,
          clientRequestId: "cancel-after-idle-release",
        });
        yield* steps.worker.drain();

        assert.lengthOf(steps.detachedEvents(task.childThreadId), 0);
        assert.deepEqual(harness.closed, [childSession]);
      }).pipe(Effect.provide(harness.layer));
    }),
  ),
);
