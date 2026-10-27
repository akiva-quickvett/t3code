import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  NodeId,
  type OrchestrationV2ThreadShell,
  type ScheduledTask,
  ScheduledTaskId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { projectAgentUsageLimits } from "@t3tools/shared/usageLimits";

import {
  DispatchModeLimit,
  type DispatchModeRefusal,
} from "../orchestration-v2/DispatchModeLimit.ts";
import {
  OrchestratorProjectionError,
  OrchestratorThreadAboveModeLimitError,
} from "../orchestration-v2/Orchestrator.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { DEFAULT_AGENT_ROLE_PRESETS } from "../agentRoles/defaultAgentRolePresets.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { buildUnavailableProviderSnapshot } from "../provider/unavailableProviderSnapshot.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import { layerWithoutPods } from "../pod/testkit/layerWithoutPods.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as OrganService from "../organs/OrganService.ts";
import { DEFAULT_ORGAN_PRESETS } from "../organs/defaultOrganPresets.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const layerOrchestratorService = OrchestratorMcpService.layer.pipe(
  Layer.provide(OrganService.layer),
  Layer.provide(layerWithoutPods),
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);

describe("OrchestratorMcpService", () => {
  it.effect("retries terminal acknowledgement with a fresh command id", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-ack-parent");
      const childThreadId = ThreadId.make("thread:mcp-ack-child");
      const childRunId = RunId.make("run:mcp-ack-child");
      const taskId = NodeId.make("node:mcp-ack-task");
      const acknowledgementCommandIds = yield* Ref.make<ReadonlyArray<string>>([]);
      const acknowledgementAttempts = yield* Ref.make(0);
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: "terminal result",
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId },
        runs: [
          {
            id: childRunId,
            ordinal: 1,
            status: "completed",
            startedAt: DateTime.makeUnsafe("2026-10-03T10:00:00Z"),
            completedAt: DateTime.makeUnsafe("2026-10-03T10:10:00Z"),
          },
          {
            id: RunId.make("run:mcp-ack-continuation"),
            ordinal: 2,
            status: "failed",
            startedAt: DateTime.makeUnsafe("2026-10-03T10:02:00Z"),
            completedAt: DateTime.makeUnsafe("2026-10-03T10:05:00Z"),
          },
        ],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      let hasNestedWork = true;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? hasNestedWork
                  ? {
                      ...parentProjection,
                      subagents: parentProjection.subagents.map((task) => ({
                        ...task,
                        result: null,
                        status: "running" as const,
                      })),
                    }
                  : parentProjection
                : hasNestedWork
                  ? {
                      ...childProjection,
                      subagents: [
                        { ...parentProjection.subagents[0]!, status: "running" as const },
                      ],
                    }
                  : childProjection,
            ),
          dispatch: (command) =>
            Ref.update(acknowledgementCommandIds, (commandIds) => [
              ...commandIds,
              String(command.commandId),
            ]).pipe(
              Effect.andThen(Ref.updateAndGet(acknowledgementAttempts, (count) => count + 1)),
              Effect.flatMap((attempt) =>
                attempt === 1
                  ? Effect.fail(new Error("simulated acknowledgement failure") as never)
                  : Effect.succeed({} as never),
              ),
            ),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-ack"),
        requestNamespace: "provider-session:mcp-ack",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-ack",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const pending = yield* service.taskStatus(scope, taskId);
        assert.equal(pending.status, "running");
        assert.equal(pending.workState, "waiting_for_children");
        assert.isNull(pending.summary);
        assert.equal(yield* Ref.get(acknowledgementAttempts), 0);
        hasNestedWork = false;
        const error = yield* service.taskStatus(scope, taskId).pipe(Effect.flip);
        assert.equal(error.code, "orchestration_error");

        const result = yield* service.taskStatus(scope, taskId);
        assert.equal(result.status, "completed");
        assert.equal(result.summary, "terminal result");
        assert.equal(result.latestTerminalRunId, childRunId);
        assert.equal(result.latestTerminalStatus, "completed");
        const commandIds = yield* Ref.get(acknowledgementCommandIds);
        assert.equal(commandIds.length, 2);
        assert.notEqual(commandIds[0], commandIds[1]);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("reports a restart-cut child as working until its continuation settles", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-restart-parent");
      const childThreadId = ThreadId.make("thread:mcp-restart-child");
      const taskId = NodeId.make("node:mcp-restart-task");
      const dispatched = yield* Ref.make(0);
      let awaitsRestart = true;
      let readFails = true;
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            status: "running",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId },
        runs: [
          {
            id: RunId.make("run:mcp-restart-child"),
            ordinal: 1,
            status: "cancelled",
            delegatedTaskId: taskId,
          },
          { id: RunId.make("run:mcp-restart-later"), ordinal: 2, status: "running" },
        ],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
        turnItems: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          delegatedTaskResultPending: () =>
            readFails
              ? Effect.fail(new OrchestratorProjectionError({ threadId: childThreadId }))
              : Effect.succeed(awaitsRestart),
          dispatch: () => Ref.update(dispatched, (count) => count + 1).pipe(Effect.as({} as never)),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-restart"),
        requestNamespace: "provider-session:mcp-restart",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-restart",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const failed = yield* service.taskStatus(scope, taskId).pipe(Effect.flip);
        assert.equal(failed.code, "orchestration_error");
        assert.equal(yield* Ref.get(dispatched), 0);
        readFails = false;
        const held = yield* service.taskStatus(scope, taskId);
        assert.equal(held.status, "running");
        assert.equal(held.workState, "working");
        assert.isNull(held.summary);
        assert.equal(yield* Ref.get(dispatched), 0);
        awaitsRestart = false;
        const settled = yield* service.taskStatus(scope, taskId);
        assert.equal(settled.status, "cancelled");
        assert.equal(yield* Ref.get(dispatched), 1);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("does not dispose delivery when a nonterminal task has no active child run", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-child");
      const taskId = NodeId.make("node:mcp-cancel-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId },
        runs: [],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.as({} as never),
            ),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel"),
        requestNamespace: "provider-session:mcp-cancel",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .cancelTask(scope, { taskId, clientRequestId: "cancel-unstarted-task" })
          .pipe(Effect.flip);
        assert.equal(error.code, "task_not_cancellable");
        assert.deepEqual(yield* Ref.get(dispatched), []);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("does not dispose delivery when the child stop fails", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-failed-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-failed-child");
      const childRunId = RunId.make("run:mcp-cancel-failed-child");
      const taskId = NodeId.make("node:mcp-cancel-failed-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId },
        runs: [{ id: childRunId, status: "running" }],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(Effect.fail(new Error("simulated stop failure") as never)),
            ),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel-failed"),
        requestNamespace: "provider-session:mcp-cancel-failed",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel-failed",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .cancelTask(scope, { taskId, clientRequestId: "cancel-failed-task" })
          .pipe(Effect.flip);
        assert.equal(error.code, "task_not_cancellable");
        assert.deepEqual(
          (yield* Ref.get(dispatched)).map((command) => (command as { type: string }).type),
          ["thread.stop"],
        );
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("returns cancel requested when post-stop disposal fails", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-dispose-failed-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-dispose-failed-child");
      const childRunId = RunId.make("run:mcp-cancel-dispose-failed-child");
      const taskId = NodeId.make("node:mcp-cancel-dispose-failed-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId },
        runs: [{ id: childRunId, status: "running" }],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(
                command.type === "delegated_task.completion-delivery.dispose"
                  ? Effect.fail(new Error("simulated disposal failure") as never)
                  : Effect.succeed({} as never),
              ),
            ),
          stopDelegatedTasks: () => Effect.void,
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel-dispose-failed"),
        requestNamespace: "provider-session:mcp-cancel-dispose-failed",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel-dispose-failed",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.cancelTask(scope, {
          taskId,
          clientRequestId: "cancel-dispose-failed-task",
        });
        assert.equal(result.status, "cancel_requested");
        assert.deepEqual(
          (yield* Ref.get(dispatched)).map((command) => (command as { type: string }).type),
          ["thread.stop", "delegated_task.completion-delivery.dispose"],
        );
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("cancelling a supervised task unqueues its run and leaves the thread's turns", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-supervised-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-supervised-child");
      const trackedRunId = RunId.make("run:mcp-cancel-supervised-tracked");
      const runningRunId = RunId.make("run:mcp-cancel-supervised-running");
      const taskId = NodeId.make("node:mcp-cancel-supervised-task");
      const dispatched = yield* Ref.make<ReadonlyArray<{ type: string; runId?: RunId }>>([]);
      const stoppedTrees = yield* Ref.make(0);
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            supervised: true,
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId },
        runs: [
          // The slice's own turn, which may have delegated work of its own.
          { id: runningRunId, ordinal: 1, status: "running" },
          { id: trackedRunId, ordinal: 2, status: "queued", delegatedTaskId: taskId },
        ],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [
              ...commands,
              { type: command.type, ...("runId" in command ? { runId: command.runId } : {}) },
            ]).pipe(Effect.as({} as never)),
          stopDelegatedTasks: () => Ref.update(stoppedTrees, (count) => count + 1),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel-supervised"),
        requestNamespace: "provider-session:mcp-cancel-supervised",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel-supervised",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.cancelTask(scope, {
          taskId,
          clientRequestId: "cancel-supervised-task",
        });
        assert.equal(result.status, "cancel_requested");
        assert.deepEqual(yield* Ref.get(dispatched), [
          { type: "queued-run.cancel", runId: trackedRunId },
          { type: "delegated_task.completion-delivery.dispose" },
        ]);
        assert.equal(yield* Ref.get(stoppedTrees), 0);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("refuses to cancel a task whose child now runs above the parent's modes", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-dispose-failed-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-dispose-failed-child");
      const childRunId = RunId.make("run:mcp-cancel-dispose-failed-child");
      const taskId = NodeId.make("node:mcp-cancel-dispose-failed-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const parentProjection = {
        thread: { id: parentThreadId, runtimeMode: "approval-required", interactionMode: "plan" },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId },
        runs: [{ id: childRunId, status: "running" }],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(
                command.type === "delegated_task.completion-delivery.dispose"
                  ? Effect.fail(new Error("simulated disposal failure") as never)
                  : Effect.succeed({} as never),
              ),
            ),
          stopDelegatedTasks: () => Effect.void,
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel-dispose-failed"),
        requestNamespace: "provider-session:mcp-cancel-dispose-failed",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel-dispose-failed",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .cancelTask(scope, { taskId, clientRequestId: "cancel-above-modes" })
          .pipe(Effect.flip);
        assert.equal(error.code, "runtime_mode_escalation_denied");
        assert.deepEqual(yield* Ref.get(dispatched), []);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  const cancelOverRaisedGrandchild = (child: {
    readonly deleted: boolean;
    readonly raisedDuringStop?: boolean;
  }) =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-grandchild-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-grandchild-child");
      const grandchildThreadId = ThreadId.make("thread:mcp-cancel-grandchild-grandchild");
      const taskId = NodeId.make("node:mcp-cancel-grandchild-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const stoppedBelow = yield* Ref.make(false);
      const appOwnedTask = (id: string, threadId: ThreadId, childId: ThreadId) => ({
        id: NodeId.make(id),
        threadId,
        origin: "app_owned",
        childThreadId: childId,
        driver: "codex",
        model: "gpt-5.6-terra",
        result: null,
        completionDelivery: { state: "pending" },
      });
      const projections = new Map([
        [
          parentThreadId,
          {
            thread: {
              id: parentThreadId,
              runtimeMode: "approval-required",
              interactionMode: "default",
            },
            runs: [],
            contextTransfers: [],
            subagents: [appOwnedTask(taskId, parentThreadId, childThreadId)],
          },
        ],
        [
          childThreadId,
          {
            thread: { id: childThreadId },
            runs: [{ id: RunId.make("run:mcp-cancel-grandchild-child"), status: "running" }],
            contextTransfers: [],
            messages: [],
            subagents: [
              appOwnedTask("node:mcp-cancel-grandchild-below", childThreadId, grandchildThreadId),
            ],
            providerThreads: [],
            runtimeRequests: [],
          },
        ],
        [
          grandchildThreadId,
          {
            thread: { id: grandchildThreadId },
            runs: [],
            contextTransfers: [],
            messages: [],
            subagents: [],
            providerThreads: [],
            runtimeRequests: [],
          },
        ],
      ]) as unknown as ReadonlyMap<ThreadId, OrchestrationV2ThreadProjection>;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) => Effect.succeed(projections.get(threadId)!),
          getThreadShell: (threadId) =>
            Effect.succeed(
              threadId === grandchildThreadId && child.raisedDuringStop !== true
                ? liveThreadShell(threadId)
                : threadId === childThreadId && child.deleted
                  ? null
                  : liveThreadShell(threadId, { runtimeMode: "approval-required" }),
            ),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.as({} as never),
            ),
          stopDelegatedTasks: () =>
            Effect.gen(function* () {
              const limit = yield* DispatchModeLimit;
              if (child.raisedDuringStop === true && limit?.refused !== undefined) {
                const refusal: DispatchModeRefusal = {
                  threadId: grandchildThreadId,
                  mode: "runtime",
                  runtimeMode: "full-access",
                  interactionMode: "default",
                };
                yield* Ref.set(limit.refused, refusal);
                return yield* new OrchestratorThreadAboveModeLimitError({
                  commandId: CommandId.make("stop-grandchild"),
                  threadId: grandchildThreadId,
                  mode: "runtime",
                  runtimeMode: "full-access",
                  interactionMode: "default",
                });
              }
              yield* Ref.set(stoppedBelow, true);
            }),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel-grandchild"),
        requestNamespace: "provider-session:mcp-cancel-grandchild",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel-grandchild",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      return yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .cancelTask(scope, { taskId, clientRequestId: "cancel-grandchild-above-modes" })
          .pipe(Effect.flip);
        return {
          code: error.code,
          dispatched: yield* Ref.get(dispatched),
          stoppedBelow: yield* Ref.get(stoppedBelow),
        };
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    });

  it.effect("refuses to cancel a task when a task under it now runs above the parent's modes", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* cancelOverRaisedGrandchild({ deleted: false }), {
        code: "runtime_mode_escalation_denied",
        dispatched: [],
        stoppedBelow: false,
      });
    }),
  );

  it.effect("reports a task under the child that its user raises while it is being stopped", () =>
    Effect.gen(function* () {
      const outcome = yield* cancelOverRaisedGrandchild({ deleted: false, raisedDuringStop: true });
      assert.equal(outcome.code, "runtime_mode_escalation_denied");
      assert.isFalse(outcome.stoppedBelow);
    }),
  );

  it.effect("checks the tasks under a deleted child before cancelling it", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* cancelOverRaisedGrandchild({ deleted: true }), {
        code: "runtime_mode_escalation_denied",
        dispatched: [],
        stoppedBelow: false,
      });
    }),
  );
});

describe("OrchestratorMcpService provider resolution", () => {
  const parentThreadId = ThreadId.make("thread:mcp-providers-parent");
  const childThreadId = ThreadId.make("thread:mcp-providers-child");
  const parentRunId = RunId.make("run:mcp-providers-parent");
  const parentNodeId = NodeId.make("node:mcp-providers-root");
  const taskId = NodeId.make("node:mcp-providers-task");
  const projectId = ProjectId.make("project:mcp-providers");
  const codexInstanceId = ProviderInstanceId.make("codex");
  const antigravityInstanceId = ProviderInstanceId.make("antigravity");

  const scope: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:mcp-providers"),
    requestNamespace: "provider-session:mcp-providers",
    thread: {
      threadId: parentThreadId,
      providerSessionId: "provider-session:mcp-providers",
      providerInstanceId: codexInstanceId,
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };

  const providerSnapshot = (input: {
    readonly instanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
    readonly model?: string;
    readonly enabled?: boolean;
  }): ServerProvider => ({
    instanceId: input.instanceId,
    driver: input.driver,
    enabled: input.enabled ?? true,
    installed: input.enabled !== false,
    version: input.enabled === false ? null : "test",
    status: input.enabled === false ? "disabled" : "ready",
    auth: { status: input.enabled === false ? "unknown" : "authenticated" },
    ...(input.enabled === false ? { message: "Provider is disabled in T3 Code settings." } : {}),
    checkedAt: "2026-09-13T00:00:00.000Z",
    models:
      input.model === undefined
        ? []
        : [{ slug: input.model, name: input.model, isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  });

  const providerRegistryLayer = (providers: ReadonlyArray<ServerProvider>) =>
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed(providers),
      refreshInstance: () => Effect.succeed(providers),
    });

  const adapterRegistryLayer = (instanceIds: ReadonlyArray<ProviderInstanceId>) =>
    Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
        list: () => Effect.succeed(instanceIds),
        get: (instanceId) =>
          instanceIds.includes(instanceId)
            ? Effect.succeed({
                instanceId,
              } as unknown as ProviderAdapter.ProviderAdapterV2["Service"])
            : Effect.fail(
                new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
              ),
      }),
    );

  const parentProjection = (
    subagents: ReadonlyArray<unknown>,
    modelSelection: {
      readonly instanceId: ProviderInstanceId;
      readonly model: string;
      readonly options?: ReadonlyArray<{ readonly id: string; readonly value: unknown }>;
    } = { instanceId: codexInstanceId, model: "gpt-5.4" },
  ): OrchestrationV2ThreadProjection =>
    ({
      thread: {
        id: parentThreadId,
        projectId,
        title: "MCP parent",
        createdBy: "user",
        creationSource: "web",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
      },
      runs: [
        {
          id: parentRunId,
          ordinal: 1,
          status: "running",
          rootNodeId: parentNodeId,
          providerInstanceId: codexInstanceId,
          modelSelection,
        },
      ],
      contextTransfers: [],
      subagents,
    }) as unknown as OrchestrationV2ThreadProjection;

  const childProjection = {
    thread: { id: childThreadId },
    runs: [],
    contextTransfers: [],
    messages: [],
    subagents: [],
    providerThreads: [],
    runtimeRequests: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;

  it.effect(
    "advertises orchestration capability from registered adapters rather than a driver allowlist",
    () =>
      Effect.gen(function* () {
        const disabledAntigravityInstanceId = ProviderInstanceId.make("antigravity-alt");
        const disabledWithoutAdapterInstanceId = ProviderInstanceId.make("codex-without-adapter");
        const forkOnlyInstanceId = ProviderInstanceId.make("forkOnly");
        const forkShadow = yield* buildUnavailableProviderSnapshot({
          driverKind: "forkOnly",
          instanceId: forkOnlyInstanceId,
          reason: "Driver 'forkOnly' is not registered in this build.",
          checkedAt: "2026-09-13T00:00:00.000Z",
        });
        let providers: ReadonlyArray<ServerProvider> = [
          providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
          providerSnapshot({
            instanceId: ProviderInstanceId.make("claudeAgent"),
            driver: ProviderDriverKind.make("claudeAgent"),
            model: "claude-sonnet-4-6",
          }),
          providerSnapshot({
            instanceId: ProviderInstanceId.make("pi"),
            driver: ProviderDriverKind.make("pi"),
            model: "pi-model",
          }),
          providerSnapshot({
            instanceId: ProviderInstanceId.make("acpRegistry"),
            driver: ProviderDriverKind.make("acpRegistry"),
            model: "acp-model",
          }),
          providerSnapshot({
            instanceId: antigravityInstanceId,
            driver: ProviderDriverKind.make("antigravity"),
            model: "ant-model",
          }),
          providerSnapshot({
            instanceId: disabledAntigravityInstanceId,
            driver: ProviderDriverKind.make("antigravity"),
            model: "ant-model",
            enabled: false,
          }),
          providerSnapshot({
            instanceId: disabledWithoutAdapterInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
            enabled: false,
          }),
          forkShadow,
        ];
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed(parentProjection([])),
          }),
          ServerSettings.layerTest(),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.sync(() => providers),
          }),
          adapterRegistryLayer([
            codexInstanceId,
            ProviderInstanceId.make("claudeAgent"),
            ProviderInstanceId.make("pi"),
            ProviderInstanceId.make("acpRegistry"),
            antigravityInstanceId,
            disabledAntigravityInstanceId,
          ]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const capabilities = yield* service.capabilities(scope);
          const byId = new Map(
            capabilities.providers.map((provider) => [provider.providerInstanceId, provider]),
          );
          for (const provider of providers) {
            assert.deepEqual(
              byId.get(provider.instanceId)?.models.map((model) => model.id),
              provider.models.map((model) => model.slug),
            );
          }

          providers = providers.map((provider) => ({
            ...provider,
            models: [
              ...provider.models,
              {
                slug: `${provider.driver}/custom-model-after-refresh`,
                name: "Custom model",
                isCustom: true,
                capabilities: null,
              },
            ],
          }));
          const refreshed = yield* service.capabilities(scope);
          for (const provider of providers) {
            assert.deepEqual(
              refreshed.providers
                .find((entry) => entry.providerInstanceId === provider.instanceId)
                ?.models.map((model) => model.id),
              provider.models.map((model) => model.slug),
            );
          }

          for (const instanceId of [
            codexInstanceId,
            ProviderInstanceId.make("claudeAgent"),
            ProviderInstanceId.make("pi"),
            ProviderInstanceId.make("acpRegistry"),
            antigravityInstanceId,
          ]) {
            const entry = byId.get(instanceId);
            assert.isDefined(entry);
            assert.isTrue(
              entry!.canRunChildTask,
              `expected ${instanceId} to advertise canRunChildTask`,
            );
            assert.isTrue(entry!.canRunCrossProviderChildTask);
            assert.deepEqual(entry!.constraints, []);
          }

          const disabled = byId.get(disabledAntigravityInstanceId);
          assert.isDefined(disabled);
          assert.isFalse(disabled!.canRunChildTask);
          assert.isFalse(disabled!.canRunCrossProviderChildTask);
          assert.deepEqual(disabled!.constraints, ["Provider instance is disabled."]);

          const disabledWithoutAdapter = byId.get(disabledWithoutAdapterInstanceId);
          assert.isDefined(disabledWithoutAdapter);
          assert.isFalse(disabledWithoutAdapter!.canRunChildTask);
          assert.isFalse(disabledWithoutAdapter!.canRunCrossProviderChildTask);
          assert.deepEqual(disabledWithoutAdapter!.constraints, [
            "No V2 provider adapter is registered.",
            "Provider instance is disabled.",
          ]);

          const fork = byId.get(forkOnlyInstanceId);
          assert.isDefined(fork);
          assert.isFalse(fork!.canRunChildTask);
          assert.isFalse(fork!.canRunCrossProviderChildTask);
          assert.deepEqual(fork!.constraints, [
            "No V2 provider adapter is registered.",
            "Driver 'forkOnly' is not registered in this build.",
            "Provider instance is disabled.",
          ]);
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
      }),
  );

  it.effect("reports the same headroom as t3_usage_limits and no account emails", () =>
    Effect.gen(function* () {
      const thresholds = { sessionLowPercent: 70, weeklyLowPercent: 95 };
      const sessionAt = (usedPercent: number) => ({
        checkedAt: "2026-09-13T00:00:00.000Z",
        windows: [
          {
            id: "five_hour",
            kind: "session" as const,
            label: "Session",
            usedPercent,
            resetsAt: "2026-09-14T00:00:00.000Z",
          },
        ],
      });
      const unavailable = (reason: "unsupported" | "probeFailed") => ({
        checkedAt: "2026-09-13T00:00:00.000Z",
        windows: [],
        unavailable: { reason },
      });
      const instance = (
        id: string,
        usageLimits?: ServerProvider["usageLimits"],
        displayName?: string,
      ): ServerProvider => ({
        ...providerSnapshot({
          instanceId: ProviderInstanceId.make(id),
          driver: ProviderDriverKind.make("codex"),
          model: "gpt-5.4",
        }),
        ...(usageLimits === undefined ? {} : { usageLimits }),
        ...(displayName === undefined ? {} : { displayName }),
      });
      const providers = [
        instance("codex", sessionAt(10), "Codex work"),
        instance("codex_low", sessionAt(70), "me@example.com"),
        instance("codex_full", sessionAt(100)),
        instance("codex_api_key", unavailable("unsupported")),
        instance("codex_flaky", unavailable("probeFailed")),
        instance("codex_unprobed"),
      ];
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed(parentProjection([])),
        }),
        ServerSettings.layerTest({ usageHeadroom: thresholds }),
        providerRegistryLayer(providers),
        adapterRegistryLayer(providers.map((provider) => provider.instanceId)),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const capabilities = yield* service.capabilities(scope);
        const now = yield* Clock.currentTimeMillis;
        const toolHeadroom = providers.map((provider) => [
          String(provider.instanceId),
          projectAgentUsageLimits(provider, thresholds, now).headroom,
        ]);
        assert.deepEqual(toolHeadroom, [
          ["codex", "ok"],
          ["codex_low", "low"],
          ["codex_full", "exhausted"],
          ["codex_api_key", "ok"],
          ["codex_flaky", "unknown"],
          ["codex_unprobed", "ok"],
        ]);
        assert.deepEqual(
          capabilities.providers.map((provider) => [
            String(provider.providerInstanceId),
            provider.headroom,
          ]),
          toolHeadroom,
        );
        assert.deepEqual(
          capabilities.providers.slice(0, 2).map((provider) => provider.displayName),
          ["Codex work", null],
        );
        assert.notInclude(JSON.stringify(capabilities), "example.com");
        assert.isTrue(capabilities.features.usageLimits);
        assert.isTrue(capabilities.features.usageThreadTree);
        assert.isTrue(capabilities.features.snoozeTree);
        assert.isTrue(capabilities.features.settleTree);
        assert.isTrue(capabilities.features.metas);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("lists why a provider's sessions are refused on a pod's worktree", () =>
    Effect.gen(function* () {
      const providers = [
        providerSnapshot({
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
        }),
        providerSnapshot({
          instanceId: ProviderInstanceId.make("cursor"),
          driver: ProviderDriverKind.make("cursor"),
        }),
      ];
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed(parentProjection([])),
        }),
        ServerSettings.layerTest(),
        providerRegistryLayer(providers),
        adapterRegistryLayer(providers.map((provider) => provider.instanceId)),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const capabilities = yield* service.capabilities(scope);
        const [codex, cursor] = capabilities.providers;
        assert.isUndefined(codex?.podRefusal);
        assert.include(cursor?.podRefusal, "inside the T3 server process");
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("leaves models the user hid out of the capability catalog", () =>
    Effect.gen(function* () {
      const codex = providerSnapshot({
        instanceId: codexInstanceId,
        driver: ProviderDriverKind.make("codex"),
        model: "gpt-5.4",
      });
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed(parentProjection([])),
        }),
        ServerSettings.layerTest({
          providerModelPreferences: {
            [codexInstanceId]: { hiddenModels: ["gpt-5.4-mini", "my-model"], modelOrder: [] },
          },
        }),
        providerRegistryLayer([
          {
            ...codex,
            models: [
              ...codex.models,
              { slug: "gpt-5.4-mini", name: "Mini", isCustom: false, capabilities: null },
              { slug: "my-model", name: "Mine", isCustom: true, capabilities: null },
            ],
          },
        ]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const capabilities = yield* service.capabilities(scope);
        assert.deepEqual(
          capabilities.providers[0]?.models.map((model) => model.id),
          ["gpt-5.4", "my-model"],
        );
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect.each([
    {
      name: "installation",
      snapshot: { installed: false, version: null, status: "warning", auth: { status: "unknown" } },
      constraints: ["Provider executable is not installed."],
    },
    {
      name: "health",
      snapshot: { status: "error", message: "Provider health check failed." },
      constraints: ["Provider health check failed."],
    },
    {
      name: "authentication",
      snapshot: { auth: { status: "unauthenticated" } },
      constraints: ["Provider is not authenticated."],
    },
    {
      name: "combined installation and health",
      snapshot: {
        installed: false,
        version: null,
        status: "error",
        message: "Provider executable could not be found.",
        auth: { status: "unknown" },
      },
      constraints: [
        "Provider executable is not installed.",
        "Provider executable could not be found.",
      ],
    },
    {
      name: "disabled with stale probe failures",
      snapshot: {
        enabled: false,
        installed: false,
        version: null,
        status: "error",
        message: "Stale provider health failure.",
        auth: { status: "unauthenticated" },
      },
      constraints: ["Provider instance is disabled."],
    },
  ] as const)("reports $name provider constraints", (testCase) =>
    Effect.gen(function* () {
      const provider: ServerProvider = {
        ...providerSnapshot({
          instanceId: codexInstanceId,
          driver: ProviderDriverKind.make("codex"),
          model: "gpt-5.4",
        }),
        ...testCase.snapshot,
      };
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed(parentProjection([])),
        }),
        ServerSettings.layerTest(),
        providerRegistryLayer([provider]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const capabilities = yield* service.capabilities(scope);
        const entry = capabilities.providers.find(
          (candidate) => candidate.providerInstanceId === codexInstanceId,
        );
        assert.isDefined(entry);
        assert.isFalse(entry!.canRunChildTask);
        assert.isFalse(entry!.canRunCrossProviderChildTask);
        assert.deepEqual(entry!.constraints, testCase.constraints);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect(
    "delegates to an Antigravity instance whose adapter resolves through the registry",
    () =>
      Effect.gen(function* () {
        let delegated = false;
        const task = {
          id: taskId,
          threadId: parentThreadId,
          runId: parentRunId,
          parentNodeId,
          origin: "app_owned",
          createdBy: "agent",
          driver: ProviderDriverKind.make("antigravity"),
          providerInstanceId: antigravityInstanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef: null,
          prompt: "Summarize the diff.",
          title: null,
          model: "ant-model",
          status: "running",
          result: null,
          startedAt: null,
          completedAt: null,
        };
        const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            hasReceipt: () => Effect.succeed(false),
            assertProviderInstanceEnabled: () => Effect.void,
            getThreadRecords: (threadId) =>
              Effect.succeed(
                threadId === parentThreadId
                  ? parentProjection(delegated ? [task] : [])
                  : childProjection,
              ),
            dispatch: (command) =>
              Ref.update(dispatched, (commands) => [...commands, command]).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    delegated = true;
                  }),
                ),
                Effect.as({
                  sequence: 1,
                  storedEvents: [
                    {
                      sequence: 1,
                      commandId: null,
                      event: { type: "subagent.updated", payload: task },
                    },
                  ],
                } as never),
              ),
          }),
          ServerSettings.layerTest(),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([
              providerSnapshot({
                instanceId: codexInstanceId,
                driver: ProviderDriverKind.make("codex"),
                model: "gpt-5.4",
              }),
              providerSnapshot({
                instanceId: antigravityInstanceId,
                driver: ProviderDriverKind.make("antigravity"),
                model: "ant-model",
              }),
            ]),
          }),
          adapterRegistryLayer([codexInstanceId, antigravityInstanceId]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const result = yield* service.delegateTask(scope, {
            task: "Summarize the diff.",
            target: { providerInstanceId: antigravityInstanceId, model: "ant-model" },
            mode: "async",
            clientRequestId: "delegate-antigravity-1",
          });
          assert.equal(result.status, "running");
          assert.equal(result.providerInstanceId, antigravityInstanceId);
          const commands = yield* Ref.get(dispatched);
          assert.equal(commands.length, 1);
          const request = commands[0] as {
            type: string;
            modelSelection: { instanceId: string; model: string };
          };
          assert.equal(request.type, "delegated_task.request");
          assert.equal(request.modelSelection.instanceId, antigravityInstanceId);
          assert.equal(request.modelSelection.model, "ant-model");
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
      }),
  );

  it.effect("resolves a driverKind target to a capable Antigravity instance", () =>
    Effect.gen(function* () {
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const task = {
        id: taskId,
        threadId: parentThreadId,
        runId: parentRunId,
        parentNodeId,
        origin: "app_owned",
        createdBy: "agent",
        driver: ProviderDriverKind.make("antigravity"),
        providerInstanceId: antigravityInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Summarize the diff.",
        title: null,
        model: "ant-model",
        status: "running",
        result: null,
        startedAt: null,
        completedAt: null,
      };
      let delegated = false;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          assertProviderInstanceEnabled: () => Effect.void,
          isProviderInstanceEnabledForProject: () => Effect.succeed(true),
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? parentProjection(delegated ? [task] : [])
                : childProjection,
            ),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  delegated = true;
                }),
              ),
              Effect.as({
                sequence: 1,
                storedEvents: [
                  {
                    sequence: 1,
                    commandId: null,
                    event: { type: "subagent.updated", payload: task },
                  },
                ],
              } as never),
            ),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([
            providerSnapshot({
              instanceId: codexInstanceId,
              driver: ProviderDriverKind.make("codex"),
              model: "gpt-5.4",
            }),
            providerSnapshot({
              instanceId: antigravityInstanceId,
              driver: ProviderDriverKind.make("antigravity"),
              model: "ant-model",
            }),
          ]),
        }),
        adapterRegistryLayer([codexInstanceId, antigravityInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.delegateTask(scope, {
          task: "Summarize the diff.",
          target: { driverKind: ProviderDriverKind.make("antigravity") },
          mode: "async",
          clientRequestId: "delegate-antigravity-driver-1",
        });
        assert.equal(result.status, "running");
        const commands = yield* Ref.get(dispatched);
        assert.equal(commands.length, 1);
        const request = commands[0] as {
          modelSelection: { instanceId: string; model: string };
        };
        assert.equal(request.modelSelection.instanceId, antigravityInstanceId);
        assert.equal(request.modelSelection.model, "ant-model");
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("rejects delegation to a provider without a registered adapter", () =>
    Effect.gen(function* () {
      const forkOnlyInstanceId = ProviderInstanceId.make("forkOnly");
      const forkShadow = yield* buildUnavailableProviderSnapshot({
        driverKind: "forkOnly",
        instanceId: forkOnlyInstanceId,
        reason: "Driver 'forkOnly' is not registered in this build.",
        checkedAt: "2026-09-13T00:00:00.000Z",
      });
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          getThreadRecords: () => Effect.succeed(parentProjection([])),
        }),
        ServerSettings.layerTest(),
        providerRegistryLayer([
          providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
          forkShadow,
        ]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const byInstance = yield* service
          .delegateTask(scope, {
            task: "Summarize the diff.",
            target: { providerInstanceId: forkOnlyInstanceId },
            mode: "async",
            clientRequestId: "delegate-fork-1",
          })
          .pipe(Effect.flip);
        assert.equal(byInstance.code, "provider_unavailable");
        assert.isTrue(byInstance.message.includes("No V2 provider adapter is registered."));

        const byDriver = yield* service
          .delegateTask(scope, {
            task: "Summarize the diff.",
            target: { driverKind: ProviderDriverKind.make("forkOnly") },
            mode: "async",
            clientRequestId: "delegate-fork-2",
          })
          .pipe(Effect.flip);
        assert.equal(byDriver.code, "provider_unavailable");
        assert.isTrue(
          byDriver.message.includes("No V2 provider adapter is registered for driver forkOnly."),
        );
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("refuses delegation to a provider the project turned off", () =>
    Effect.gen(function* () {
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          getThreadRecords: () => Effect.succeed(parentProjection([])),
          dispatch: () =>
            Effect.fail(
              new ThreadManagementService.ThreadManagementProviderInstanceDisabledError({
                projectId,
                instanceId: codexInstanceId,
              }),
            ),
        }),
        providerRegistryLayer([
          providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
        ]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        ServerSettings.layerTest(),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .delegateTask(scope, {
            task: "Summarize the diff.",
            target: { providerInstanceId: codexInstanceId },
            mode: "async",
            clientRequestId: "delegate-disabled-1",
          })
          .pipe(Effect.flip);
        assert.equal(error.code, "invalid_request");
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("driver-only delegation skips an instance the project turned off", () =>
    Effect.gen(function* () {
      const altInstanceId = ProviderInstanceId.make("codex-alt");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const task = {
        id: taskId,
        threadId: parentThreadId,
        runId: parentRunId,
        parentNodeId,
        origin: "app_owned",
        createdBy: "agent",
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: altInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Summarize the diff.",
        title: null,
        model: "gpt-5.4",
        status: "running",
        result: null,
        startedAt: null,
        completedAt: null,
      };
      let delegated = false;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? parentProjection(delegated ? [task] : [])
                : childProjection,
            ),
          isProviderInstanceEnabledForProject: ({ instanceId }) =>
            Effect.succeed(instanceId !== codexInstanceId),
          assertProviderInstanceEnabled: ({ projectId, instanceId }) =>
            instanceId === codexInstanceId
              ? Effect.fail(
                  new ThreadManagementService.ThreadManagementProviderInstanceDisabledError({
                    projectId,
                    instanceId,
                  }),
                )
              : Effect.void,
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  delegated = true;
                }),
              ),
              Effect.as({
                sequence: 1,
                storedEvents: [
                  {
                    sequence: 1,
                    commandId: null,
                    event: { type: "subagent.updated", payload: task },
                  },
                ],
              } as never),
            ),
        }),
        providerRegistryLayer([
          providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
          providerSnapshot({
            instanceId: altInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
        ]),
        adapterRegistryLayer([codexInstanceId, altInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        ServerSettings.layerTest(),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.delegateTask(scope, {
          task: "Summarize the diff.",
          target: { driverKind: ProviderDriverKind.make("codex") },
          mode: "async",
          clientRequestId: "delegate-driver-skip-disabled-1",
        });
        assert.equal(result.status, "running");
        const commands = yield* Ref.get(dispatched);
        assert.equal(commands.length, 1);
        const request = commands[0] as {
          modelSelection: { instanceId: string; model: string };
        };
        assert.equal(request.modelSelection.instanceId, altInstanceId);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect(
    "retrying an accepted driver-only delegation replays even after the project disables every candidate",
    () =>
      Effect.gen(function* () {
        const altInstanceId = ProviderInstanceId.make("codex-alt");
        const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
        const accepted = yield* Ref.make(false);
        const everyCandidateDisabled = yield* Ref.make(false);
        const task = {
          id: taskId,
          threadId: parentThreadId,
          runId: parentRunId,
          parentNodeId,
          origin: "app_owned",
          createdBy: "agent",
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef: null,
          prompt: "Summarize the diff.",
          title: null,
          model: "gpt-5.4",
          status: "running",
          result: null,
          startedAt: null,
          completedAt: null,
        };
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: (threadId) =>
              Ref.get(accepted).pipe(
                Effect.map((isAccepted) =>
                  threadId === parentThreadId
                    ? parentProjection(isAccepted ? [task] : [])
                    : childProjection,
                ),
              ),
            hasReceipt: () => Ref.get(accepted),
            isProviderInstanceEnabledForProject: () =>
              Ref.get(everyCandidateDisabled).pipe(Effect.map((disabled) => !disabled)),
            assertProviderInstanceEnabled: ({ projectId, instanceId }) =>
              Effect.all([Ref.get(accepted), Ref.get(everyCandidateDisabled)]).pipe(
                Effect.flatMap(([isAccepted, disabled]) =>
                  isAccepted || !disabled
                    ? Effect.void
                    : Effect.fail(
                        new ThreadManagementService.ThreadManagementProviderInstanceDisabledError({
                          projectId,
                          instanceId,
                        }),
                      ),
                ),
              ),
            dispatch: (command) =>
              Ref.update(dispatched, (commands) => [...commands, command]).pipe(
                Effect.andThen(Ref.set(accepted, true)),
                Effect.as({
                  sequence: 1,
                  storedEvents: [
                    {
                      sequence: 1,
                      commandId: null,
                      event: { type: "subagent.updated", payload: task },
                    },
                  ],
                } as never),
              ),
          }),
          providerRegistryLayer([
            providerSnapshot({
              instanceId: codexInstanceId,
              driver: ProviderDriverKind.make("codex"),
              model: "gpt-5.4",
            }),
            providerSnapshot({
              instanceId: altInstanceId,
              driver: ProviderDriverKind.make("codex"),
              model: "gpt-5.4",
            }),
          ]),
          adapterRegistryLayer([codexInstanceId, altInstanceId]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          ServerSettings.layerTest(),
        );

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const first = yield* service.delegateTask(scope, {
            task: "Summarize the diff.",
            target: { driverKind: ProviderDriverKind.make("codex") },
            mode: "async",
            clientRequestId: "delegate-driver-retry-after-disable-1",
          });
          assert.equal(first.status, "running");

          yield* Ref.set(everyCandidateDisabled, true);

          const retry = yield* service.delegateTask(scope, {
            task: "Summarize the diff.",
            target: { driverKind: ProviderDriverKind.make("codex") },
            mode: "async",
            clientRequestId: "delegate-driver-retry-after-disable-1",
          });
          assert.equal(retry.status, "running");

          const commands = yield* Ref.get(dispatched);
          assert.equal(commands.length, 2);
          const retryCommand = commands[1] as {
            modelSelection: { instanceId: string; model: string };
          };
          assert.equal(retryCommand.modelSelection.instanceId, codexInstanceId);
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
      }),
  );

  it.effect("re-probes an unavailable target once before refusing it", () =>
    Effect.gen(function* () {
      const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
      const claudeDriver = ProviderDriverKind.make("claudeAgent");
      const task = {
        id: taskId,
        threadId: parentThreadId,
        runId: parentRunId,
        parentNodeId,
        origin: "app_owned",
        createdBy: "agent",
        driver: claudeDriver,
        providerInstanceId: claudeInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Review the diff.",
        title: null,
        model: "claude-opus-5-5",
        status: "running",
        result: null,
        startedAt: null,
        completedAt: null,
      };
      const healthy = providerSnapshot({
        instanceId: claudeInstanceId,
        driver: claudeDriver,
        model: "claude-opus-5-5",
      });
      const missingCli: ServerProvider = {
        ...healthy,
        installed: false,
        status: "error",
        message: "Claude Agent CLI (`claude`) was not found on PATH.",
      };
      const codex = providerSnapshot({
        instanceId: codexInstanceId,
        driver: ProviderDriverKind.make("codex"),
        model: "gpt-5.4",
      });
      let cliInstalled = false;
      const probes = yield* Ref.make(0);
      const dispatched = yield* Ref.make(0);
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          assertProviderInstanceEnabled: () => Effect.void,
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId ? parentProjection([task]) : childProjection,
            ),
          dispatch: () =>
            Ref.update(dispatched, (count) => count + 1).pipe(
              Effect.as({
                sequence: 1,
                storedEvents: [
                  {
                    sequence: 1,
                    commandId: null,
                    event: { type: "subagent.updated", payload: task },
                  },
                ],
              } as never),
            ),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([codex, missingCli]),
          refreshInstance: () =>
            Ref.update(probes, (count) => count + 1).pipe(
              Effect.as([codex, cliInstalled ? healthy : missingCli]),
            ),
        }),
        adapterRegistryLayer([codexInstanceId, claudeInstanceId]),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const delegate = (clientRequestId: string) =>
          service.delegateTask(scope, {
            task: "Review the diff.",
            target: { providerInstanceId: claudeInstanceId, model: "claude-opus-5-5" },
            mode: "async",
            clientRequestId,
          });

        const error = yield* delegate("delegate-recheck-1").pipe(Effect.flip);
        assert.equal(error.code, "provider_unavailable");
        assert.equal(yield* Ref.get(probes), 1);
        assert.equal(yield* Ref.get(dispatched), 0);

        cliInstalled = true;
        const result = yield* delegate("delegate-recheck-2");
        assert.equal(result.providerInstanceId, claudeInstanceId);
        assert.equal(yield* Ref.get(probes), 2);
        assert.equal(yield* Ref.get(dispatched), 1);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect(
    "inherits an available parent instance for driver-only targets and otherwise selects a healthy peer",
    () =>
      Effect.gen(function* () {
        const codexAltInstanceId = ProviderInstanceId.make("codex-alt");
        const driver = ProviderDriverKind.make("codex");
        const claudeDriver = ProviderDriverKind.make("claudeAgent");
        const parentModelSelection = {
          instanceId: codexInstanceId,
          model: "gpt-5.4",
          options: [{ id: "reasoningEffort", value: "high" }],
        } as const;
        const task = {
          id: taskId,
          threadId: parentThreadId,
          runId: parentRunId,
          parentNodeId,
          origin: "app_owned",
          createdBy: "agent",
          driver,
          providerInstanceId: codexInstanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef: null,
          prompt: "Summarize the diff.",
          title: null,
          model: "gpt-5.4",
          status: "running",
          result: null,
          startedAt: null,
          completedAt: null,
        };
        const cases = [
          {
            name: "healthy-inherited",
            inheritedEnabled: true,
            peerEnabled: true,
            explicit: false,
            selectedInstanceId: codexInstanceId,
            candidateDriver: driver,
          },
          {
            name: "unavailable-inherited-falls-back-to-healthy-peer",
            inheritedEnabled: false,
            peerEnabled: true,
            explicit: false,
            selectedInstanceId: codexAltInstanceId,
            candidateDriver: driver,
          },
          {
            name: "no-available-peer",
            inheritedEnabled: false,
            peerEnabled: false,
            explicit: false,
            selectedInstanceId: null,
            candidateDriver: driver,
          },
          {
            name: "cross-driver-no-available-candidate",
            inheritedEnabled: false,
            peerEnabled: false,
            explicit: false,
            selectedInstanceId: null,
            candidateDriver: claudeDriver,
          },
          {
            name: "explicit-unavailable",
            inheritedEnabled: false,
            peerEnabled: true,
            explicit: true,
            selectedInstanceId: null,
            candidateDriver: driver,
          },
          {
            name: "inherited-unavailable",
            inheritedEnabled: false,
            peerEnabled: true,
            explicit: false,
            selectedInstanceId: null,
            candidateDriver: driver,
          },
          {
            name: "explicit-disabled-without-adapter",
            inheritedEnabled: false,
            peerEnabled: true,
            explicit: true,
            selectedInstanceId: null,
            candidateDriver: driver,
          },
          {
            name: "explicit-healthy",
            inheritedEnabled: true,
            peerEnabled: true,
            explicit: true,
            selectedInstanceId: codexAltInstanceId,
            candidateDriver: driver,
          },
        ] as const;

        for (const testCase of cases) {
          const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
          let delegated = false;
          const layerDependencies = Layer.mergeAll(
            NodeServices.layer,
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              hasReceipt: () => Effect.succeed(false),
              assertProviderInstanceEnabled: () => Effect.void,
              isProviderInstanceEnabledForProject: () => Effect.succeed(true),
              getThreadRecords: (threadId) =>
                Effect.succeed(
                  threadId === parentThreadId
                    ? parentProjection(delegated ? [task] : [], parentModelSelection)
                    : childProjection,
                ),
              dispatch: (command) =>
                Ref.update(dispatched, (commands) => [...commands, command]).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      delegated = true;
                    }),
                  ),
                  Effect.as({
                    sequence: 1,
                    storedEvents: [
                      {
                        sequence: 1,
                        commandId: null,
                        event: { type: "subagent.updated", payload: task },
                      },
                    ],
                  } as never),
                ),
            }),
            ServerSettings.layerTest(),
            providerRegistryLayer([
              providerSnapshot({
                instanceId: codexInstanceId,
                driver,
                model: "gpt-5.4",
                enabled: testCase.inheritedEnabled,
              }),
              providerSnapshot({
                instanceId: codexAltInstanceId,
                driver: testCase.candidateDriver,
                model: "codex-alt-model",
                enabled: testCase.peerEnabled,
              }),
            ]),
            adapterRegistryLayer(
              testCase.name === "explicit-disabled-without-adapter"
                ? [codexAltInstanceId]
                : [codexInstanceId, codexAltInstanceId],
            ),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          );

          yield* Effect.gen(function* () {
            const service = yield* OrchestratorMcpService.OrchestratorMcpService;
            const target =
              testCase.name === "inherited-unavailable"
                ? undefined
                : testCase.explicit
                  ? ({
                      providerInstanceId:
                        testCase.selectedInstanceId === null
                          ? codexInstanceId
                          : testCase.selectedInstanceId,
                    } as const)
                  : ({ driverKind: testCase.candidateDriver } as const);
            if (testCase.selectedInstanceId === null) {
              const error = yield* service
                .delegateTask(scope, {
                  task: "Summarize the diff.",
                  target,
                  mode: "async",
                  clientRequestId: `delegate-select-${testCase.name}`,
                })
                .pipe(Effect.flip);
              assert.equal(error.code, "provider_unavailable", testCase.name);
              if (
                testCase.name === "explicit-unavailable" ||
                testCase.name === "inherited-unavailable" ||
                testCase.name === "explicit-disabled-without-adapter"
              ) {
                const expectedMessage =
                  `Provider ${codexInstanceId} cannot run a child task: ` +
                  (testCase.name === "explicit-disabled-without-adapter"
                    ? "No V2 provider adapter is registered. "
                    : "") +
                  "Provider instance is disabled.";
                assert.equal(error.message, expectedMessage);
                const threadError = yield* service
                  .createThreads(scope, {
                    threads: [{ prompt: "Summarize the diff.", target }],
                    clientRequestId: `disabled-threads-${testCase.name}`,
                  })
                  .pipe(Effect.flip);
                assert.equal(threadError.code, "provider_unavailable");
                assert.equal(threadError.message, expectedMessage);
              }
              if (testCase.name === "cross-driver-no-available-candidate") {
                assert.isTrue(error.message.includes("driver claudeAgent"), testCase.name);
                const threadError = yield* service
                  .createThreads(scope, {
                    threads: [{ prompt: "Summarize the diff.", target }],
                    clientRequestId: `delegate-threads-${testCase.name}`,
                  })
                  .pipe(Effect.flip);
                assert.equal(
                  threadError.code,
                  "provider_unavailable",
                  `${testCase.name}-createThreads`,
                );
                assert.isTrue(
                  threadError.message.includes("driver claudeAgent"),
                  `${testCase.name}-createThreads`,
                );
              }
              assert.deepEqual(yield* Ref.get(dispatched), [], testCase.name);
              return;
            }
            const result = yield* service.delegateTask(scope, {
              task: "Summarize the diff.",
              target,
              mode: "async",
              clientRequestId: `delegate-select-${testCase.name}`,
            });
            assert.equal(result.status, "running", testCase.name);
            const commands = yield* Ref.get(dispatched);
            assert.equal(commands.length, 1, testCase.name);
            const request = commands[0] as {
              type: string;
              modelSelection: {
                instanceId: string;
                model: string;
                options?: ReadonlyArray<{ id: string; value: unknown }>;
              };
            };
            assert.equal(request.type, "delegated_task.request", testCase.name);
            assert.equal(
              request.modelSelection.instanceId,
              testCase.selectedInstanceId,
              testCase.name,
            );
            if (testCase.name === "healthy-inherited") {
              assert.deepEqual(request.modelSelection, parentModelSelection, testCase.name);
            } else {
              assert.equal(request.modelSelection.model, "codex-alt-model", testCase.name);
            }
          }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
        }
      }),
  );

  describe("scheduled tasks at modes above the caller's", () => {
    const projectId = ProjectId.make("project:scheduled");
    const boundThreadId = ThreadId.make("thread:scheduled-bound");
    const task = (overrides: Partial<ScheduledTask>): ScheduledTask => ({
      id: ScheduledTaskId.make("scheduled-task:webhook"),
      title: "On push",
      prompt: "Do {{body.instruction}}",
      enabled: true,
      schedule: { type: "webhook", signature: null },
      projectId,
      threadId: null,
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
      createdAt: "2026-10-05T00:00:00.000Z",
      updatedAt: "2026-10-05T00:00:00.000Z",
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: "never",
      lastRunError: null,
      runCount: 0,
      webhook: {
        path: "/hooks/scheduled-task/secret",
        url: "https://t3.example/hooks/secret",
        hasSecret: false,
      },
      ...overrides,
    });
    const supervisedClient: McpInvocationScope = {
      environmentId: EnvironmentId.make("environment:scheduled"),
      requestNamespace: "client:scheduled",
      thread: undefined,
      client: {
        sessionId: "scheduled",
        label: "Claude Code",
        access: "approval-required",
      },
      capabilities: new Set(["orchestration"]),
      issuedAt: 1,
    };
    const service = (
      tasks: ReadonlyArray<ScheduledTask>,
      boundThread: OrchestrationV2ThreadShell | null,
      upserted: Ref.Ref<number>,
    ) =>
      layerOrchestratorService.pipe(
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadShell: (threadId) =>
                Effect.succeed(threadId === boundThreadId ? boundThread : null),
            }),
            ServerSettings.layerTest(),
            Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
            Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
              list: () => Effect.succeed([]),
            }),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({
              list: () => Effect.succeed({ tasks }),
              upsert: () =>
                Ref.update(upserted, (count) => count + 1).pipe(Effect.as({ task: tasks[0]! })),
            }),
          ),
        ),
      );

    it.effect("hides a webhook URL from a caller below the task's modes", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        const listed = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.flatMap((mcp) => mcp.listScheduledTasks(supervisedClient, { projectId })),
          Effect.provide(
            service(
              [
                task({ runtimeMode: "full-access" }),
                task({ id: ScheduledTaskId.make("scheduled-task:supervised") }),
              ],
              null,
              upserted,
            ),
          ),
        );
        assert.deepEqual(
          listed.tasks.map((summary) => summary.webhookUrl),
          [undefined, "https://t3.example/hooks/secret"],
        );
      }),
    );

    it.effect("hides a webhook URL from a thread whose turn has ended", () =>
      Effect.gen(function* () {
        const callerId = ThreadId.make("thread:scheduled-ended");
        const shell = liveThreadShell(callerId, { activeRunId: null });
        const listed = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.flatMap((mcp) =>
            mcp.listScheduledTasks(
              {
                ...supervisedClient,
                requestNamespace: "provider:scheduled-ended",
                thread: {
                  threadId: callerId,
                  providerSessionId: "provider:scheduled-ended",
                  providerInstanceId: shell.providerInstanceId,
                },
                client: undefined,
              },
              { projectId },
            ),
          ),
          Effect.provide(
            layerOrchestratorService.pipe(
              Layer.provide(
                Layer.mergeAll(
                  NodeServices.layer,
                  Layer.mock(ThreadManagementService.ThreadManagementService)({
                    getThreadShell: () => Effect.succeed(null),
                    getThreadRecords: () => Effect.succeed(idleThreadProjection(shell)),
                  }),
                  ServerSettings.layerTest(),
                  Layer.mock(ProviderRegistry.ProviderRegistry)({
                    getProviders: Effect.succeed([]),
                  }),
                  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
                    list: () => Effect.succeed([]),
                  }),
                  Layer.mock(ProjectService.ProjectService)({}),
                  Layer.mock(SecretRequests.SecretRequests)({}),
                  Layer.mock(ScheduledTaskService.ScheduledTaskService)({
                    list: () => Effect.succeed({ tasks: [task({})] }),
                  }),
                ),
              ),
            ),
          ),
        );
        assert.equal(listed.tasks[0]?.webhookUrl, undefined);
      }),
    );

    it.effect("never shows a read-only client a webhook URL", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        const listed = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.flatMap((mcp) =>
            mcp.listScheduledTasks(
              {
                ...supervisedClient,
                client: { sessionId: "scheduled", label: "Claude Code", access: "read-only" },
              },
              { projectId },
            ),
          ),
          Effect.provide(service([task({})], null, upserted)),
        );
        assert.equal(listed.tasks[0]?.webhookUrl, undefined);
      }),
    );

    it.effect("checks a bound task against its thread's current modes", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        const bound = task({ threadId: boundThreadId });
        const layer = service(
          [bound],
          liveThreadShell(boundThreadId, { runtimeMode: "full-access" }),
          upserted,
        );
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(layer),
        );
        const listed = yield* mcp.listScheduledTasks(supervisedClient, { projectId });
        assert.equal(listed.tasks[0]?.webhookUrl, undefined);
        const error = yield* mcp
          .updateScheduledTask(supervisedClient, {
            scheduledTaskId: bound.id,
            prompt: "Something else",
          })
          .pipe(Effect.flip);
        assert.equal(error.code, "runtime_mode_escalation_denied");
        assert.equal(yield* Ref.get(upserted), 0);
      }),
    );

    it.effect("reports a saved task even when its bound thread cannot be read", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        const bound = task({ threadId: boundThreadId });
        const lookups = yield* Ref.make(0);
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(
            layerOrchestratorService.pipe(
              Layer.provide(
                Layer.mergeAll(
                  NodeServices.layer,
                  Layer.mock(ThreadManagementService.ThreadManagementService)({
                    getThreadShell: (threadId) =>
                      Ref.getAndUpdate(lookups, (count) => count + 1).pipe(
                        Effect.flatMap((count) =>
                          count === 0
                            ? Effect.succeed(
                                liveThreadShell(threadId, { runtimeMode: "approval-required" }),
                              )
                            : Effect.fail(new OrchestratorProjectionError({ threadId })),
                        ),
                      ),
                  }),
                  ServerSettings.layerTest(),
                  Layer.mock(ProviderRegistry.ProviderRegistry)({
                    getProviders: Effect.succeed([]),
                  }),
                  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
                    list: () => Effect.succeed([]),
                  }),
                  Layer.mock(ProjectService.ProjectService)({}),
                  Layer.mock(SecretRequests.SecretRequests)({}),
                  Layer.mock(ScheduledTaskService.ScheduledTaskService)({
                    list: () => Effect.succeed({ tasks: [bound] }),
                    upsert: () =>
                      Ref.update(upserted, (count) => count + 1).pipe(Effect.as({ task: bound })),
                  }),
                ),
              ),
            ),
          ),
        );
        const updated = yield* mcp.updateScheduledTask(supervisedClient, {
          scheduledTaskId: bound.id,
          prompt: "Something else",
        });
        assert.equal(yield* Ref.get(upserted), 1);
        assert.equal(updated.scheduledTaskId, bound.id);
        assert.equal(updated.webhookUrl, undefined);
      }),
    );
  });

  describe("resolveRuntimeMode", () => {
    const muse = {
      modelSelection: { instanceId: ProviderInstanceId.make("muse"), model: "muse-model" },
      supportedRuntimeModes: ["approval-required", "full-access"] as const,
    };

    it.effect("refuses an explicit mode the target provider does not offer", () =>
      Effect.gen(function* () {
        const error = yield* OrchestratorMcpService.resolveRuntimeMode(
          "full-access",
          "auto-accept-edits",
          muse,
        ).pipe(Effect.flip);
        assert.equal(error.code, "invalid_request");
        assert.include(error.message, "approval-required, full-access");
      }),
    );

    it.effect("steps an inherited mode down to the broadest one the provider offers", () =>
      Effect.gen(function* () {
        assert.equal(
          yield* OrchestratorMcpService.resolveRuntimeMode("full-access", "inherit", muse),
          "full-access",
        );
        assert.equal(
          yield* OrchestratorMcpService.resolveRuntimeMode("auto", undefined, muse),
          "approval-required",
        );
      }),
    );
  });

  describe("role presets", () => {
    const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
    const claude: ServerProvider = {
      ...providerSnapshot({
        instanceId: claudeInstanceId,
        driver: ProviderDriverKind.make("claudeAgent"),
      }),
      models: ["claude-sonnet-5-5", "claude-opus-5-5"].map((slug) => ({
        slug,
        name: slug,
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Reasoning",
              type: "select" as const,
              options: [
                { id: "high", label: "High" },
                { id: "xhigh", label: "Extra High" },
              ],
            },
          ],
        },
      })),
    };
    const codex = providerSnapshot({
      instanceId: codexInstanceId,
      driver: ProviderDriverKind.make("codex"),
      model: "gpt-5.4",
    });
    const presetTask = {
      id: taskId,
      threadId: parentThreadId,
      runId: parentRunId,
      parentNodeId,
      origin: "app_owned",
      createdBy: "agent",
      driver: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: claudeInstanceId,
      providerThreadId: null,
      childThreadId,
      nativeTaskRef: null,
      prompt: "Review the diff.",
      title: null,
      model: "claude-sonnet-5-5",
      status: "running",
      result: null,
      startedAt: null,
      completedAt: null,
    };

    const presetHarness = (input: {
      readonly providers: ReadonlyArray<ServerProvider>;
      readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
      readonly parent?: OrchestrationV2ThreadProjection;
    }) =>
      Effect.gen(function* () {
        const dispatched = yield* Ref.make<ReadonlyArray<Record<string, unknown>>>([]);
        let delegated = false;
        const parent = () => input.parent ?? parentProjection(delegated ? [presetTask] : []);
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            hasReceipt: () => Effect.succeed(false),
            assertProviderInstanceEnabled: () => Effect.void,
            isProviderInstanceEnabledForProject: () => Effect.succeed(true),
            getThreadRecords: (threadId) =>
              Effect.succeed(
                threadId === parentThreadId
                  ? parent()
                  : threadId === childThreadId
                    ? childProjection
                    : ({
                        thread: {
                          id: threadId,
                          title: "Created",
                          createdBy: "agent",
                          creationSource: "mcp",
                        },
                        runs: [],
                      } as unknown as OrchestrationV2ThreadProjection),
              ),
            dispatch: (command) =>
              Ref.update(dispatched, (commands) => [
                ...commands,
                command as unknown as Record<string, unknown>,
              ]).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    if (command.type === "delegated_task.request") delegated = true;
                  }),
                ),
                Effect.as({
                  sequence: 1,
                  storedEvents:
                    command.type === "delegated_task.request"
                      ? [
                          {
                            sequence: 1,
                            commandId: null,
                            event: { type: "subagent.updated", payload: presetTask },
                          },
                        ]
                      : [],
                } as never),
              ),
          }),
          ServerSettings.layerTest(input.settings),
          providerRegistryLayer(input.providers),
          adapterRegistryLayer(input.providers.map((provider) => provider.instanceId)),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        const service = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))),
        );
        return { service, dispatched };
      });

    it.effect("delegates with a preset's model and role, keeping its text out of the task", () =>
      Effect.gen(function* () {
        const { service, dispatched } = yield* presetHarness({ providers: [codex, claude] });
        yield* service.delegateTask(scope, {
          task: "Review the diff.",
          preset: " Review-T1 ",
          mode: "async",
          clientRequestId: "preset-review",
        });
        const [request] = yield* Ref.get(dispatched);
        assert.deepEqual(request?.modelSelection, {
          instanceId: claudeInstanceId,
          model: "claude-sonnet-5-5",
          options: [{ id: "effort", value: "high" }],
        });
        assert.deepEqual(request?.rolePreset, { id: "review-t1", label: "Reviewer (tier 1)" });
        assert.equal(request?.task, "Review the diff.");
        assert.isUndefined(request?.workspaceStrategy);
      }),
    );

    it.effect("lets a request's own model win and drops the preset's options with it", () =>
      Effect.gen(function* () {
        const { service, dispatched } = yield* presetHarness({ providers: [codex, claude] });
        yield* service.delegateTask(scope, {
          task: "Review the diff.",
          preset: "review-t1",
          target: { model: "claude-opus-5-5" },
          mode: "async",
          clientRequestId: "preset-review-opus",
        });
        const [request] = yield* Ref.get(dispatched);
        assert.deepEqual(request?.modelSelection, {
          instanceId: claudeInstanceId,
          model: "claude-opus-5-5",
        });
      }),
    );

    it.effect("keeps a preset's broader modes under the caller's and refuses explicit ones", () =>
      Effect.gen(function* () {
        const base = parentProjection([]);
        const narrowParent = {
          ...base,
          thread: { ...base.thread, runtimeMode: "approval-required", interactionMode: "plan" },
        } as OrchestrationV2ThreadProjection;
        const { service, dispatched } = yield* presetHarness({
          providers: [codex],
          parent: narrowParent,
          settings: {
            agentRolePresets: {
              environment: {
                overrides: {
                  wide: {
                    id: "wide",
                    label: "Wide",
                    target: { driverKind: ProviderDriverKind.make("codex"), model: "gpt-5.4" },
                    runtimeMode: "full-access",
                    interactionMode: "default",
                    instructions: "",
                  },
                },
              },
            },
          },
        });
        yield* service.createThreads(scope, {
          threads: [{ preset: "wide" }],
          clientRequestId: "preset-wide",
        });
        const [created] = yield* Ref.get(dispatched);
        assert.equal(created?.runtimeMode, "approval-required");
        assert.equal(created?.interactionMode, "plan");
        assert.deepEqual(created?.rolePreset, { id: "wide", label: "Wide" });
        const escalation = yield* service
          .createThreads(scope, {
            threads: [{ preset: "wide", runtimeMode: "full-access" }],
            clientRequestId: "preset-wide-explicit",
          })
          .pipe(Effect.flip);
        assert.equal(escalation.code, "runtime_mode_escalation_denied");
      }),
    );

    it.effect("refuses an unknown preset by naming the known ones", () =>
      Effect.gen(function* () {
        const { service, dispatched } = yield* presetHarness({ providers: [codex, claude] });
        const error = yield* service
          .delegateTask(scope, { task: "Review.", preset: "reviewr", mode: "async" })
          .pipe(Effect.flip);
        assert.equal(error.code, "invalid_request");
        assert.include(error.message, "review-t1");
        assert.deepEqual(yield* Ref.get(dispatched), []);
      }),
    );

    it.effect("reports a preset whose provider is missing as unavailable", () =>
      Effect.gen(function* () {
        const { service } = yield* presetHarness({ providers: [codex] });
        const error = yield* service
          .delegateTask(scope, { task: "Review.", preset: "review-t1", mode: "async" })
          .pipe(Effect.flip);
        assert.equal(error.code, "provider_unavailable");
      }),
    );

    it.effect("lists presets in capabilities without their instructions", () =>
      Effect.gen(function* () {
        const { service } = yield* presetHarness({ providers: [codex, claude] });
        const capabilities = yield* service.capabilities(scope);
        const grok = capabilities.rolePresets?.find((preset) => preset.id === "review-t3-grok");
        assert.deepEqual(grok, {
          id: "review-t3-grok",
          label: "Reviewer (tier 3, second)",
          target: { driverKind: ProviderDriverKind.make("claudeAgent"), model: "claude-opus-5-5" },
          runsIn: "host",
        });
        assert.isFalse(
          capabilities.rolePresets?.some((preset) => "instructions" in preset) ?? true,
        );
      }),
    );

    it.effect("lists the organ presets in effect for the caller's project", () =>
      Effect.gen(function* () {
        const wideScouts = {
          id: "scouts",
          label: "Wide scouts",
          goalTemplate: "Scout widely: {goal}",
          cells: [
            {
              role: "scout",
              count: 4,
              target: {
                driverKind: ProviderDriverKind.make("claudeAgent"),
                model: "claude-opus-5-5",
                options: [{ id: "effort", value: "high" }],
              },
            },
          ],
        };
        const { service } = yield* presetHarness({
          providers: [codex, claude],
          settings: {
            organPresets: {
              projects: {
                [projectId]: { overrides: { scouts: wideScouts }, removed: ["research"] },
                [ProjectId.make("project:elsewhere")]: { removed: ["scouts"] },
              },
            },
          },
        });
        const capabilities = yield* service.capabilities(scope);
        assert.deepEqual(
          capabilities.organPresets,
          DEFAULT_ORGAN_PRESETS.filter((preset) => preset.id !== "research").map((preset) =>
            preset.id === "scouts"
              ? {
                  ...wideScouts,
                  cells: [
                    {
                      role: "scout",
                      count: 4,
                      target: {
                        driverKind: ProviderDriverKind.make("claudeAgent"),
                        model: "claude-opus-5-5",
                      },
                    },
                  ],
                }
              : preset,
          ),
        );
      }),
    );
  });
});

interface ChildReadGate {
  readonly armed: boolean;
  readonly first: ThreadId | null;
}

class ChildReadGateRef extends Context.Service<ChildReadGateRef, Ref.Ref<ChildReadGate>>()(
  "t3/mcp/OrchestratorMcpService.test/ChildReadGateRef",
) {}

describe("OrchestratorMcpService organs", () => {
  const codexInstanceId = ProviderInstanceId.make("codex");
  const altInstanceId = ProviderInstanceId.make("codex-alt");
  const driver = ProviderDriverKind.make("codex");
  const model = "gpt-5.4";
  const modelSelection = { instanceId: codexInstanceId, model };
  const target = { providerInstanceId: codexInstanceId, model };
  const projectId = ProjectId.make("project:mcp-organs");
  const parentThreadId = ThreadId.make("thread:mcp-organs-parent");

  const provider = (instanceId: ProviderInstanceId): ServerProvider => ({
    instanceId,
    driver,
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-23T00:00:00.000Z",
    models: [{ slug: model, name: model, isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  });

  const adapter = (instanceId: ProviderInstanceId) =>
    ({
      instanceId,
      driver,
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
      openSession: () => Effect.die("The effect worker does not run in these tests."),
    }) as ProviderAdapter.ProviderAdapterV2["Service"];

  const scopeIn = (requestNamespace: string): McpInvocationScope => ({
    environmentId: EnvironmentId.make("environment:mcp-organs"),
    requestNamespace,
    thread: {
      threadId: parentThreadId,
      providerSessionId: requestNamespace,
      providerInstanceId: codexInstanceId,
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  });
  const scope = scopeIn("provider-session:mcp-organs");

  // A real orchestrator and thread management with the effect worker off: delegations
  // create their child threads and runs, and no provider session ever opens.
  const layerOrgans = (
    options: {
      readonly providers?: Ref.Ref<ReadonlyArray<ServerProvider>>;
      readonly allowedChildRoles?: { readonly [role: string]: ReadonlyArray<string> };
      /** While armed, reads of any child thread but the first one read fail. */
      readonly childReadGate?: Ref.Ref<ChildReadGate>;
    } = {},
  ) => {
    const providers = options.providers;
    const layerSettings = ServerSettings.layerTest({
      providerInstances: { [altInstanceId]: { driver, config: {} } },
      agentRolePresets: {
        environment: {
          overrides: Object.fromEntries(
            Object.entries(options.allowedChildRoles ?? {}).map(([id, allowedChildRoles]) => [
              id,
              {
                ...DEFAULT_AGENT_ROLE_PRESETS.find((preset) => preset.id === id)!,
                allowedChildRoles,
              },
            ]),
          ),
        },
      },
    });
    const layerAdapters = ProviderAdapterRegistry.layerFromAdapters([
      adapter(codexInstanceId),
      adapter(altInstanceId),
    ]);
    const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
      { name: "mcp-organs" },
      layerAdapters,
      { runEffectWorker: false },
    );
    const layerThreadManagement = ThreadManagementService.layer.pipe(
      Layer.provide(layerOrchestrator),
      Layer.provide(layerSettings),
      Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    );
    const gate = options.childReadGate;
    const layerOrchestration = Layer.merge(
      layerOrchestrator,
      gate === undefined
        ? layerThreadManagement
        : Layer.effect(
            ThreadManagementService.ThreadManagementService,
            Effect.gen(function* () {
              const real = yield* ThreadManagementService.ThreadManagementService;
              const getThreadRecords: typeof real.getThreadRecords = (threadId, fields, filter) =>
                Ref.modify(gate, (state): readonly [boolean, ChildReadGate] => {
                  if (!state.armed || threadId === parentThreadId) return [false, state];
                  if (state.first === null) return [false, { ...state, first: threadId }];
                  return [threadId !== state.first, state];
                }).pipe(
                  Effect.flatMap((fail) =>
                    fail
                      ? Effect.fail(
                          new OrchestratorProjectionError({
                            threadId,
                            cause: "injected read failure",
                          }),
                        )
                      : real.getThreadRecords(threadId, fields, filter),
                  ),
                ) as ReturnType<typeof real.getThreadRecords>;
              return ThreadManagementService.ThreadManagementService.of({
                ...real,
                getThreadRecords,
              });
            }),
          ).pipe(Layer.provide(layerThreadManagement)),
    );
    const readProviders =
      providers === undefined ? Effect.succeed([provider(codexInstanceId)]) : Ref.get(providers);
    // Settings are exposed too, so a test can change them between calls.
    return layerOrchestratorService.pipe(
      Layer.provideMerge(layerOrchestration),
      Layer.provideMerge(
        Layer.mergeAll(
          layerAdapters,
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: readProviders,
            refreshInstance: () => readProviders,
          }),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          layerSettings,
          NodeServices.layer,
        ),
      ),
    );
  };

  const createParent = (options: { readonly start?: boolean; readonly role?: string } = {}) =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      yield* threads.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-organ-parent"),
        threadId: parentThreadId,
        projectId,
        title: "Organ parent",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        ...(options.role === undefined
          ? {}
          : { rolePreset: { id: options.role, label: options.role } }),
        createdBy: "user",
        creationSource: "web",
      });
      if (options.start === false) return;
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("start-organ-parent"),
        threadId: parentThreadId,
        messageId: MessageId.make("message:organ-parent"),
        text: "Start an organ",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
    });

  const parentSubagents = Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    return (yield* threads.getThreadRecords(parentThreadId, ["subagents"])).subagents;
  });

  const childLineage = (childThreadId: ThreadId) =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      return (yield* threads.getThreadProjection(childThreadId)).thread.lineage;
    });

  it.effect("starts one labelled child per cell, each waking the parent", () =>
    Effect.gen(function* () {
      yield* createParent();
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const goal = "g".repeat(600);
      const started = yield* service.startOrgan(scope, {
        presetId: "scouts",
        goal,
        cells: [{ role: "scout", count: 2, target }],
        clientRequestId: "scouts-1",
      });
      assert.lengthOf(started.tasks, 2);
      assert.isUndefined(started.failed);
      assert.equal(started.round, 1);
      const organ = {
        id: started.organId,
        presetId: "scouts",
        goal: `${goal.slice(0, 499)}…`,
        round: 1,
      };
      const subagents = yield* parentSubagents;
      assert.deepEqual(
        subagents.map((task) => [task.organ, task.completionWake, task.prompt]),
        [
          [organ, "always", `Scout: ${goal}`],
          [organ, "always", `Scout: ${goal}`],
        ],
      );
      for (const task of started.tasks) {
        assert.deepEqual((yield* childLineage(task.childThreadId)).organ, organ);
      }
    }).pipe(Effect.provide(layerOrgans())),
  );

  it.effect(
    "returns the started cells and the failed one, and a keyed retry adds no children",
    () =>
      Effect.gen(function* () {
        yield* createParent();
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const providers = yield* ProviderRegistry.ProviderRegistry;
        const input = {
          presetId: "scouts",
          goal: "Look around.",
          cells: [
            { role: "scout", count: 2, target },
            { role: "research", target: { providerInstanceId: altInstanceId, model } },
            { role: "scout", target },
          ],
          clientRequestId: "partial-1",
        };
        const first = yield* service.startOrgan(scope, input);
        assert.lengthOf(first.tasks, 2);
        assert.equal(first.failed?.[0]?.index, 2);
        assert.include(first.failed?.[0]?.reason ?? "", "codex-alt");

        const retry = yield* service.startOrgan(scope, input);
        assert.equal(retry.organId, first.organId);
        assert.deepEqual(
          retry.tasks.map((task) => task.taskId),
          first.tasks.map((task) => task.taskId),
        );
        assert.lengthOf(yield* parentSubagents, 2);

        // Once the provider is back, the retry starts only the cells that never started.
        yield* providers.refreshInstance(altInstanceId);
        const completed = yield* service.startOrgan(scope, input);
        assert.equal(completed.organId, first.organId);
        assert.isUndefined(completed.failed);
        assert.deepEqual(
          completed.tasks.slice(0, 2).map((task) => task.taskId),
          first.tasks.map((task) => task.taskId),
        );
        const subagents = yield* parentSubagents;
        assert.lengthOf(subagents, 4);
        assert.isTrue(subagents.every((task) => task.organ?.id === first.organId));
      }).pipe(
        Effect.provide(
          Effect.gen(function* () {
            const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>([
              provider(codexInstanceId),
            ]);
            return Layer.merge(
              layerOrgans({ providers }),
              Layer.mock(ProviderRegistry.ProviderRegistry)({
                refreshInstance: () =>
                  Ref.updateAndGet(providers, (current) => [...current, provider(altInstanceId)]),
              }),
            );
          }).pipe(Layer.unwrap),
        ),
      ),
  );

  it.effect("mints a new organ per key-less call and per session, apart from delegate_task", () =>
    Effect.gen(function* () {
      yield* createParent();
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const input = { presetId: "scouts", goal: "Look.", cells: [{ role: "scout", target }] };
      const first = yield* service.startOrgan(scope, input);
      const second = yield* service.startOrgan(scope, input);
      assert.notEqual(first.organId, second.organId);
      assert.notEqual(first.tasks[0]?.taskId, second.tasks[0]?.taskId);

      const keyed = { ...input, clientRequestId: "x" };
      const sessionA = yield* service.startOrgan(scope, keyed);
      const sessionB = yield* service.startOrgan(scopeIn("provider-session:other"), keyed);
      assert.notEqual(sessionA.organId, sessionB.organId);

      // The first cell of the organ keyed "x" must not replay a delegation keyed "x:0".
      const plain = yield* service.delegateTask(scope, {
        task: "Unrelated.",
        target,
        clientRequestId: "x:0",
      });
      assert.notEqual(plain.taskId, sessionA.tasks[0]?.taskId);
      assert.lengthOf(yield* parentSubagents, 5);
    }).pipe(Effect.provide(layerOrgans())),
  );

  it.effect("refuses without a live parent run and creates nothing", () =>
    Effect.gen(function* () {
      yield* createParent({ start: false });
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const error = yield* service
        .startOrgan(scope, { presetId: "scouts", goal: "Look." })
        .pipe(Effect.flip);
      assert.equal(error.code, "parent_not_active");
      assert.isEmpty(yield* parentSubagents);
    }).pipe(Effect.provide(layerOrgans())),
  );

  it.effect("enforces allowed child roles for organs only", () =>
    Effect.gen(function* () {
      yield* createParent({ role: "slice" });
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const error = yield* service
        .startOrgan(scope, {
          presetId: "research",
          goal: "Compare.",
          cells: [{ role: "research", target }],
        })
        .pipe(Effect.flip);
      assert.equal(error.code, "invalid_request");
      assert.equal(
        error.message,
        "Role `slice` (defined in the environment layer) can't start `research`; add it to its allowed child roles.",
      );
      assert.isEmpty(yield* parentSubagents);

      const plain = yield* service.delegateTask(scope, {
        task: "Research anyway.",
        preset: "research",
        target,
      });
      assert.equal(plain.status, "running");
      assert.isUndefined((yield* parentSubagents)[0]?.organ);
    }).pipe(Effect.provide(layerOrgans({ allowedChildRoles: { slice: ["scout"] } }))),
  );

  it.effect("refuses a key reused for a different organ", () =>
    Effect.gen(function* () {
      yield* createParent();
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const cells = [{ role: "scout", target }];
      const first = yield* service.startOrgan(scope, {
        presetId: "scouts",
        goal: "Look.",
        cells,
        clientRequestId: "reused",
      });
      const error = yield* service
        .startOrgan(scope, {
          presetId: "research",
          goal: "Look.",
          cells,
          clientRequestId: "reused",
        })
        .pipe(Effect.flip);
      assert.equal(error.code, "invalid_request");
      assert.equal(
        error.message,
        `clientRequestId \`reused\` already started organ \`${first.organId}\` for a different preset or goal (preset \`scouts\`); use a new clientRequestId.`,
      );
      assert.lengthOf(yield* parentSubagents, 1);
    }).pipe(Effect.provide(layerOrgans())),
  );

  it.effect("replays accepted organ calls after the starter's allowed roles narrow", () =>
    Effect.gen(function* () {
      yield* createParent({ role: "broker" });
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const settings = yield* ServerSettings.ServerSettingsService;
      const startInput = {
        presetId: "scouts",
        goal: "Look.",
        cells: [{ role: "scout", target }],
        clientRequestId: "narrowed",
      };
      const started = yield* service.startOrgan(scope, startInput);
      const roundInput = {
        task: "Look again.",
        preset: "scout",
        target,
        organ: { id: started.organId },
        clientRequestId: "narrowed-round",
      };
      const round = yield* service.delegateTask(scope, roundInput);

      yield* settings.updateAgentRolePresets((current) => ({
        ...current,
        environment: {
          ...current.environment,
          overrides: {
            ...current.environment.overrides,
            broker: {
              ...current.environment.overrides.broker!,
              allowedChildRoles: ["implementor"],
            },
          },
        },
      }));
      const startRetry = yield* service.startOrgan(scope, startInput);
      assert.isUndefined(startRetry.failed);
      assert.equal(startRetry.tasks[0]?.taskId, started.tasks[0]?.taskId);
      assert.equal((yield* service.delegateTask(scope, roundInput)).taskId, round.taskId);

      // New work under the narrowed list is refused, for a new cell and a new round alike.
      const grown = yield* service.startOrgan(scope, {
        ...startInput,
        cells: [{ role: "scout", count: 2, target }],
      });
      assert.equal(grown.tasks[0]?.taskId, started.tasks[0]?.taskId);
      assert.deepEqual(
        grown.failed?.map((entry) => entry.index),
        [1],
      );
      assert.include(grown.failed?.[0]?.reason ?? "", "can't start `scout`");
      const newRound = yield* service
        .delegateTask(scope, { ...roundInput, clientRequestId: "narrowed-round-2" })
        .pipe(Effect.flip);
      assert.include(newRound.message, "can't start `scout`");
      assert.lengthOf(yield* parentSubagents, 2);
    }).pipe(
      Effect.provide(layerOrgans({ allowedChildRoles: { broker: ["implementor", "scout"] } })),
    ),
  );

  it.effect("resumes an organ whose cell role was removed after it started", () =>
    Effect.gen(function* () {
      yield* createParent();
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const settings = yield* ServerSettings.ServerSettingsService;
      const input = {
        presetId: "scouts",
        goal: "Look.",
        cells: [{ role: "scout", count: 2, target }],
        clientRequestId: "removed-role",
      };
      const started = yield* service.startOrgan(scope, input);
      yield* settings.updateAgentRolePresets((current) => ({
        ...current,
        environment: { ...current.environment, removed: ["scout"] },
      }));
      const retry = yield* service.startOrgan(scope, input);
      assert.isUndefined(retry.failed);
      assert.equal(retry.organId, started.organId);
      assert.deepEqual(
        retry.tasks.map((task) => task.taskId),
        started.tasks.map((task) => task.taskId),
      );
      assert.lengthOf(yield* parentSubagents, 2);
    }).pipe(Effect.provide(layerOrgans())),
  );

  it.effect("stops a reused key whose cells or full goal differ from the started organ", () =>
    Effect.gen(function* () {
      yield* createParent();
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const goal = "a".repeat(600);
      const input = {
        presetId: "scouts",
        goal,
        cells: [{ role: "scout", target }],
        clientRequestId: "same-key",
      };
      const started = yield* service.startOrgan(scope, input);
      const otherCells = yield* service.startOrgan(scope, {
        ...input,
        cells: [{ role: "research", target }],
      });
      assert.equal(otherCells.organId, started.organId);
      assert.isEmpty(otherCells.tasks);
      assert.equal(
        otherCells.failed?.[0]?.reason,
        `clientRequestId \`same-key\` already started organ \`${started.organId}\` with different cells; use a new clientRequestId.`,
      );
      // Same 500-character label, different full goal.
      const otherGoal = yield* service.startOrgan(scope, { ...input, goal: `${"a".repeat(599)}b` });
      assert.include(otherGoal.failed?.[0]?.reason ?? "", "for a different preset or goal");
      assert.lengthOf(yield* parentSubagents, 1);
    }).pipe(Effect.provide(layerOrgans())),
  );

  it.effect("reports a started cell that a retry with fewer cells leaves out", () =>
    Effect.gen(function* () {
      yield* createParent();
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const input = {
        presetId: "scouts",
        goal: "Look.",
        cells: [{ role: "scout", count: 2, target }],
        clientRequestId: "fewer",
      };
      const started = yield* service.startOrgan(scope, input);
      const fewer = yield* service.startOrgan(scope, {
        ...input,
        cells: [{ role: "scout", target }],
      });
      assert.equal(fewer.organId, started.organId);
      assert.deepEqual(
        fewer.tasks.map((task) => task.taskId),
        [started.tasks[0]?.taskId],
      );
      assert.deepEqual(fewer.failed, [
        {
          index: 1,
          reason: `clientRequestId \`fewer\` already started organ \`${started.organId}\` with different cells; use a new clientRequestId.`,
        },
      ]);
      assert.lengthOf(yield* parentSubagents, 2);
    }).pipe(Effect.provide(layerOrgans())),
  );

  it.effect("reports a resumed organ's refused first cell instead of failing the call", () =>
    Effect.gen(function* () {
      yield* createParent({ role: "broker" });
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const organId = OrganService.mintOrganId(scope.requestNamespace, "forged");
      const parentRun = (yield* threads.getThreadRecords(parentThreadId, ["runs"])).runs[0]!;
      // A user's raw delegation can label a child with any organ, so the organ has
      // records although none of this key's cells has a receipt.
      yield* threads.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make("forged-organ-cell"),
        parentThreadId,
        parentRunId: parentRun.id,
        parentNodeId: parentRun.rootNodeId!,
        task: "Scout: Look.",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        organ: { id: organId, presetId: "scouts", goal: "Look.", round: 1 },
        createdBy: "user",
        creationSource: "web",
      });
      const result = yield* service.startOrgan(scope, {
        presetId: "scouts",
        goal: "Look.",
        cells: [{ role: "scout", target }],
        clientRequestId: "forged",
      });
      assert.equal(result.organId, organId);
      assert.isEmpty(result.tasks);
      assert.equal(result.failed?.[0]?.index, 0);
      assert.include(result.failed?.[0]?.reason ?? "", "can't start `scout`");
    }).pipe(Effect.provide(layerOrgans({ allowedChildRoles: { broker: ["implementor"] } }))),
  );

  it.effect("reports a cell that started but could not be read, and replays it on retry", () =>
    Effect.gen(function* () {
      yield* createParent();
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const gate = yield* ChildReadGateRef;
      const input = {
        presetId: "scouts",
        goal: "Look.",
        cells: [{ role: "scout", count: 2, target }],
        clientRequestId: "setup-failed",
      };
      yield* Ref.set(gate, { armed: true, first: null });
      const first = yield* service.startOrgan(scope, input);
      assert.lengthOf(first.tasks, 1);
      assert.equal(first.failed?.[0]?.index, 1);
      assert.include(first.failed?.[0]?.reason ?? "", "Cell started but setup failed:");
      assert.lengthOf(yield* parentSubagents, 2);

      yield* Ref.set(gate, { armed: false, first: null });
      const retry = yield* service.startOrgan(scope, input);
      assert.equal(retry.organId, first.organId);
      assert.isUndefined(retry.failed);
      assert.equal(retry.tasks[0]?.taskId, first.tasks[0]?.taskId);
      assert.deepEqual(
        retry.tasks.map((task) => task.taskId),
        (yield* parentSubagents).map((task) => task.id),
      );
    }).pipe(
      Effect.provide(
        Effect.gen(function* () {
          const gate = yield* Ref.make<ChildReadGate>({ armed: false, first: null });
          return Layer.merge(
            layerOrgans({ childReadGate: gate }),
            Layer.succeed(ChildReadGateRef, gate),
          );
        }).pipe(Layer.unwrap),
      ),
    ),
  );

  it.effect("adds a round to an organ on the parent's records and refuses others", () =>
    Effect.gen(function* () {
      yield* createParent();
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const started = yield* service.startOrgan(scope, {
        presetId: "implementation",
        goal: "Ship it.",
        cells: [{ role: "implementor", target }],
      });
      const round = yield* service.delegateTask(scope, {
        task: "Fix the findings.",
        preset: "implementor",
        target,
        organ: { id: started.organId },
      });
      const label = (yield* parentSubagents).find((task) => task.id === round.taskId)?.organ;
      assert.deepEqual(label, {
        id: started.organId,
        presetId: "implementation",
        goal: "Ship it.",
        round: 2,
      });
      assert.deepEqual((yield* childLineage(round.childThreadId)).organ, label);

      const unknown = yield* service
        .delegateTask(scope, {
          task: "Fix the findings.",
          preset: "implementor",
          target,
          organ: { id: "organ_notOnThisThread0" },
        })
        .pipe(Effect.flip);
      assert.equal(unknown.code, "invalid_request");
      assert.lengthOf(yield* parentSubagents, 2);
    }).pipe(Effect.provide(layerOrgans())),
  );
});
