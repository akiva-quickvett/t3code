import { OrchestratorMcpFailure, PodRuntimeSnapshot, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PodRuntimeService from "../../../pod/PodRuntimeService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  PodRuntimeService.PodRuntimeService,
];

const PodToolParameters = Schema.Struct({
  threadId: Schema.optional(ThreadId).annotate({
    description: "The thread whose worktree's pod to use. Omit for this thread.",
  }),
});

const PodToolResult = Schema.Struct({ pod: Schema.NullOr(PodRuntimeSnapshot) });

const PodStatusTool = Tool.make("t3_pod_status", {
  description:
    "Report the pod of a thread's worktree: its state (creating, running, stopping, stopped, starting, frozen, stop_failed, start_failed, removing, removed), services and last error. A pod runs the project's compose stack in a private Docker daemon, and every terminal and script on that worktree runs inside it. pod is null when the worktree runs on the host.",
  parameters: PodToolParameters,
  success: PodToolResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get pod status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const PodStartTool = Tool.make("t3_pod_start", {
  description:
    "Start the pod of a thread's worktree when it is stopped, frozen or failed; a failed creation is retried as a creation. Returns once the start is recorded; call t3_pod_status to see it reach running or start_failed.",
  parameters: PodToolParameters,
  success: PodToolResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Start pod")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const PodStopTool = Tool.make("t3_pod_stop", {
  description:
    "Stop the pod of a thread's worktree: the stack stops, nothing is deleted, and t3_pod_start brings it back as it was. Every thread on that worktree loses its terminals and scripts until then.",
  parameters: PodToolParameters,
  success: PodToolResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Stop pod")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const PodToolkit = Toolkit.make(PodStatusTool, PodStartTool, PodStopTool);
