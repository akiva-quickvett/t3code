import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  OrchestratorMcpCapabilitiesResult,
  OrchestratorMcpCreateThreadsInput,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpThreadDetail,
  OrchestratorMcpThreadInterruptInput,
  OrchestratorMcpThreadListInput,
  OrchestratorMcpThreadListItem,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadSendInput,
  OrchestratorMcpThreadWaitInput,
} from "./orchestratorMcp.ts";

const decodeCapabilitiesResult = Schema.decodeUnknownSync(OrchestratorMcpCapabilitiesResult);
const decodeCreateThreadsInput = Schema.decodeUnknownSync(OrchestratorMcpCreateThreadsInput);
const decodeDelegateTaskInput = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskInput);
const decodeDelegateTaskResult = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskResult);
const decodeThreadInterruptInput = Schema.decodeUnknownSync(OrchestratorMcpThreadInterruptInput);
const decodeThreadListInput = Schema.decodeUnknownSync(OrchestratorMcpThreadListInput);
const decodeThreadReadInput = Schema.decodeUnknownSync(OrchestratorMcpThreadReadInput);
const decodeThreadSendInput = Schema.decodeUnknownSync(OrchestratorMcpThreadSendInput);
const decodeThreadWaitInput = Schema.decodeUnknownSync(OrchestratorMcpThreadWaitInput);
const decodeListItemLineage = {
  supervisorThreadId: Schema.decodeUnknownSync(
    OrchestratorMcpThreadListItem.fields.supervisorThreadId,
  ),
  relationshipToParent: Schema.decodeUnknownSync(
    OrchestratorMcpThreadListItem.fields.relationshipToParent,
  ),
};
const decodeThreadDetailLineage = {
  supervisorThreadId: Schema.decodeUnknownSync(
    OrchestratorMcpThreadDetail.fields.supervisorThreadId,
  ),
  relationshipToParent: Schema.decodeUnknownSync(
    OrchestratorMcpThreadDetail.fields.relationshipToParent,
  ),
};

describe("orchestrator MCP contracts", () => {
  it("reports supervised wakes only where the server knows them", () => {
    const decode = Schema.decodeUnknownSync(OrchestratorMcpCapabilitiesResult);
    const older = {
      parentThreadId: null,
      inheritedProviderInstanceId: null,
      inheritedModel: null,
      runtimeMode: "full-access",
      interactionMode: "default",
      providers: [],
      features: {
        appOwnedSubagents: true,
        asyncPolling: true,
        cancellation: true,
        batchThreadCreation: true,
        threadManagement: true,
        incrementalThreadRead: true,
        scheduledTasks: true,
        maxBatchThreads: 20,
      },
    };
    expect(decode(older).features.supervisedWakes).toBeUndefined();
    expect(
      decode({ ...older, features: { ...older.features, supervisedWakes: false } }).features
        .supervisedWakes,
    ).toBe(false);
  });

  it("lists and reads a supervisor without a new relationship", () => {
    for (const decode of [decodeListItemLineage, decodeThreadDetailLineage]) {
      expect(decode.supervisorThreadId("thread-meta")).toBe("thread-meta");
      expect(() => decode.relationshipToParent("supervised")).toThrow();
    }
  });

  it("accepts explicit worktree isolation and keeps shared delegation as the default", () => {
    expect(decodeDelegateTaskInput({ task: "Review changes" }).isolation).toBeUndefined();
    expect(
      decodeDelegateTaskInput({ task: "Review changes", isolation: "worktree" }).isolation,
    ).toBe("worktree");
    expect(() => decodeDelegateTaskInput({ task: "Review changes", isolation: "copy" })).toThrow();
  });
  it("decodes an optional worktree branch and base ref", () => {
    const request = decodeDelegateTaskInput({
      task: "Build the feature",
      isolation: "worktree",
      branch: " pod/goal-feature ",
      baseRef: "origin/slice",
    });
    expect(request.branch).toBe("pod/goal-feature");
    expect(request.baseRef).toBe("origin/slice");
    expect(() => decodeDelegateTaskInput({ task: "Build", branch: "  " })).toThrow();
  });
  it("decodes cross-provider delegated task requests and durable results", () => {
    const request = decodeDelegateTaskInput({
      task: "Inspect the workspace and report the result.",
      target: {
        providerInstanceId: "claudeAgent",
        model: "claude-sonnet-4-6",
      },
      mode: "wait",
      timeoutMs: 5_000,
      clientRequestId: "delegate-1",
      runtimeMode: "inherit",
      interactionMode: "inherit",
    });
    const result = decodeDelegateTaskResult({
      taskId: "node-task-1",
      childThreadId: "thread-child-1",
      childRunId: "run-child-1",
      childNodeId: "node-task-1",
      status: "completed",
      workState: "result_available",
      hasPendingChildRuns: false,
      providerInstanceId: "claudeAgent",
      model: "claude-sonnet-4-6",
      summary: "Workspace inspected.",
      resultContextTransferId: "context-transfer-result-1",
      latestTerminalRunId: "run-child-1",
      latestTerminalStatus: "completed",
      latestTerminalSummary: "Workspace inspected.",
      latestTerminalResultContextTransferId: "context-transfer-result-1",
      hasPendingQuestion: false,
      waitTimedOut: false,
    });

    expect(request.target?.providerInstanceId).toBe("claudeAgent");
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("Workspace inspected.");
  });

  it("decodes target model options in canonical and shorthand shapes", () => {
    const canonical = decodeDelegateTaskInput({
      task: "Say hello.",
      target: {
        providerInstanceId: "codex",
        model: "gpt-5.6-luna",
        options: [{ id: "reasoning", value: "low" }],
      },
    });
    const shorthand = decodeDelegateTaskInput({
      task: "Say hello.",
      target: {
        providerInstanceId: "codex",
        model: "gpt-5.6-luna",
        options: { reasoning: "low", fastMode: true },
      },
    });

    expect(canonical.target?.options).toEqual([{ id: "reasoning", value: "low" }]);
    expect(shorthand.target?.options).toEqual([
      { id: "reasoning", value: "low" },
      { id: "fastMode", value: true },
    ]);
  });

  it("rejects target model options that are not strings or booleans", () => {
    expect(() =>
      decodeDelegateTaskInput({
        task: "Say hello.",
        target: {
          providerInstanceId: "codex",
          model: "gpt-5.6-luna",
          options: { reasoning: 3 },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeDelegateTaskInput({
        task: "Say hello.",
        target: {
          providerInstanceId: "codex",
          model: "gpt-5.6-luna",
          options: [{ id: "reasoning", value: null }],
        },
      }),
    ).toThrow();
  });

  it("decodes mixed prompted and empty thread batches", () => {
    const request = decodeCreateThreadsInput({
      clientRequestId: "threads-1",
      threads: [
        { title: "Inherited empty thread" },
        {
          prompt: "Review the API.",
          target: { driverKind: "claudeAgent" },
          runtimeMode: "approval-required",
        },
      ],
    });

    expect(request.threads).toHaveLength(2);
    expect(request.threads[0]?.prompt).toBeUndefined();
    expect(request.threads[1]?.target?.driverKind).toBe("claudeAgent");
  });

  it("decodes project-scoped thread orchestration requests", () => {
    expect(
      decodeThreadListInput({
        statuses: ["running", "completed"],
        includeSubagents: false,
        limit: 25,
      }).statuses,
    ).toEqual(["running", "completed"]);
    expect(
      decodeThreadReadInput({
        threadId: "thread-loop-1",
        view: "activity",
        afterPosition: 10,
      }).afterPosition,
    ).toBe(10);
    expect(
      decodeThreadSendInput({
        threadId: "thread-loop-1",
        message: "Continue with the next iteration.",
        mode: "steer",
        clientRequestId: "send-loop-2",
      }).mode,
    ).toBe("steer");
    expect(
      decodeThreadWaitInput({
        threadId: "thread-loop-1",
        runId: "run-loop-2",
        timeoutMs: 5_000,
      }).runId,
    ).toBe("run-loop-2");
    expect(
      decodeThreadInterruptInput({
        threadId: "thread-loop-1",
        reason: "Loop converged.",
      }).reason,
    ).toBe("Loop converged.");
  });
});

describe("orchestrator capabilities headroom", () => {
  const provider = {
    providerInstanceId: "codex",
    driverKind: "codex",
    displayName: null,
    models: [],
    canRunChildTask: true,
    canRunCrossProviderChildTask: true,
    constraints: [],
  };
  const result = (providers: ReadonlyArray<unknown>, features: Record<string, unknown> = {}) => ({
    parentThreadId: null,
    inheritedProviderInstanceId: null,
    inheritedModel: null,
    runtimeMode: "full-access",
    interactionMode: "default",
    providers,
    rolePresets: [],
    features: {
      appOwnedSubagents: true,
      asyncPolling: true,
      cancellation: true,
      batchThreadCreation: true,
      threadManagement: true,
      incrementalThreadRead: true,
      scheduledTasks: true,
      maxBatchThreads: 20,
      ...features,
    },
  });

  it("decodes a result from a server that predates headroom", () => {
    const decoded = decodeCapabilitiesResult(result([provider]));
    expect(decoded.providers[0]?.headroom).toBeUndefined();
    expect(decoded.features.usageLimits).toBeUndefined();
  });

  it("carries per-instance headroom and rejects unknown verdicts", () => {
    const decoded = decodeCapabilitiesResult(
      result(
        [
          { ...provider, headroom: "low" },
          { ...provider, headroom: "unknown" },
        ],
        {
          usageLimits: true,
        },
      ),
    );
    expect(decoded.providers.map((entry) => entry.headroom)).toEqual(["low", "unknown"]);
    expect(decoded.features.usageLimits).toBe(true);
    expect(() => decodeCapabilitiesResult(result([{ ...provider, headroom: "full" }]))).toThrow();
  });
});
