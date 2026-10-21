import type { PodRuntimeId, PodRuntimeState } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ContainerDriver from "./ContainerDriver.ts";
import { podContainerNames, podSafeEnv } from "./PodContainerPlan.ts";
import * as PodRuntimeStore from "./PodRuntimeStore.ts";

export interface PodExecutionTarget {
  readonly type: "pod";
  readonly podId: PodRuntimeId;
  readonly state: PodRuntimeState;
  readonly worktreePath: string;
  readonly dockerHost: string;
}

export type ExecutionTarget = { readonly type: "host" } | PodExecutionTarget;

const HOST: ExecutionTarget = { type: "host" };

/**
 * Where a command for a path runs. The runtime belongs to the worktree, not
 * to the thread that made it, so every terminal and script on a pod's
 * worktree runs in that pod's agent container.
 */
export class WorkspaceExecutionTarget extends Context.Service<
  WorkspaceExecutionTarget,
  {
    readonly resolve: (path: string) => Effect.Effect<ExecutionTarget>;
    /** A host command that runs `spec` in the pod; credentials the host holds are not passed on. */
    readonly launch: (
      target: PodExecutionTarget,
      spec: ContainerDriver.PodExecSpec & { readonly tty: boolean },
    ) => ContainerDriver.PodExecLaunch;
    readonly exec: (
      target: PodExecutionTarget,
      spec: ContainerDriver.PodExecSpec & { readonly timeoutMs: number },
    ) => Effect.Effect<ContainerDriver.PodExecResult, ContainerDriver.ContainerDriverError>;
  }
>()("t3/pod/WorkspaceExecutionTarget") {}

const make = Effect.gen(function* () {
  const store = yield* PodRuntimeStore.PodRuntimeStore;
  const driver = yield* ContainerDriver.ContainerDriver;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironmentIdentity)
    .getEnvironmentId;
  const agentName = (target: PodExecutionTarget) =>
    podContainerNames(target.podId, environmentId).agent;
  const safe = <Spec extends ContainerDriver.PodExecSpec>(spec: Spec): Spec =>
    spec.env === undefined ? spec : { ...spec, env: podSafeEnv(spec.env) };
  return WorkspaceExecutionTarget.of({
    resolve: (path) =>
      store.findByPath(path).pipe(
        Effect.map((record): ExecutionTarget =>
          record === undefined
            ? HOST
            : {
                type: "pod",
                podId: record.snapshot.id,
                state: record.snapshot.state,
                worktreePath: record.snapshot.worktreePath,
                dockerHost: record.dockerHost,
              },
        ),
      ),
    launch: (target, spec) =>
      driver.forHost(target.dockerHost).execLaunch(agentName(target), safe(spec)),
    exec: (target, spec) => driver.forHost(target.dockerHost).exec(agentName(target), safe(spec)),
  });
});

export const layer = Layer.effect(WorkspaceExecutionTarget, make);
