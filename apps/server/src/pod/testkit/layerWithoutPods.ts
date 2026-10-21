import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as PodRuntimeService from "../PodRuntimeService.ts";
import * as WorkspaceExecutionTarget from "../WorkspaceExecutionTarget.ts";

/** For tests of host behavior: every path runs on the host and no worktree has a pod. */
export const layerWithoutPods = Layer.mergeAll(
  Layer.mock(PodRuntimeService.PodRuntimeService)({
    forPath: () => Effect.succeed(undefined),
  }),
  Layer.mock(WorkspaceExecutionTarget.WorkspaceExecutionTarget)({
    resolve: () => Effect.succeed({ type: "host" }),
    launch: () => {
      throw new Error("no worktree has a pod in this test");
    },
  }),
);
