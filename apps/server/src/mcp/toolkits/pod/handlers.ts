import { OrchestratorMcpFailure, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as PodRuntimeService from "../../../pod/PodRuntimeService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readThread } from "../../threadAccess.ts";
import { PodToolkit } from "./tools.ts";

const threadPod = (threadId: ThreadId | undefined) =>
  Effect.gen(function* () {
    const context = yield* McpInvocationContext.McpInvocationContext;
    if (!context.capabilities.has("worktree"))
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "This credential cannot use worktrees or their pods.",
      });
    const {
      projection: { thread },
    } = yield* readThread(threadId);
    const pods = yield* PodRuntimeService.PodRuntimeService;
    return thread.worktreePath === null ? undefined : yield* pods.forPath(thread.worktreePath);
  });

const requirePod = (threadId: ThreadId | undefined) =>
  threadPod(threadId).pipe(
    Effect.flatMap((pod) =>
      pod === undefined
        ? Effect.fail(
            new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "This thread's worktree has no pod; it runs on the host.",
            }),
          )
        : Effect.succeed(pod),
    ),
  );

const podFailure = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

const handlers = {
  t3_pod_status: McpToolAccess.reads((input) =>
    threadPod(input.threadId).pipe(Effect.map((pod) => ({ pod: pod ?? null }))),
  ),
  t3_pod_start: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const pod = yield* requirePod(input.threadId);
      const pods = yield* PodRuntimeService.PodRuntimeService;
      return { pod: yield* pods.start(pod.id).pipe(Effect.mapError(podFailure)) };
    }),
  ),
  t3_pod_stop: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const pod = yield* requirePod(input.threadId);
      const pods = yield* PodRuntimeService.PodRuntimeService;
      return { pod: yield* pods.stop(pod.id).pipe(Effect.mapError(podFailure)) };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof PodToolkit.tools>;

export const layer = McpToolAccess.toLayer(PodToolkit, handlers);
