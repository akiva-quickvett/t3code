import {
  EMPTY_POD_RUNTIME_STATE,
  type PodRuntimeLiveState,
  podForWorktree,
} from "@t3tools/client-runtime/state/pod-runtime";
import type { EnvironmentId, PodRuntimeSnapshot, ProjectId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { useServerConfigs } from "./entities";
import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";

/** Stock servers have no pod runtime, so their clients hide every pod control. */
export function useEnvironmentSupportsPodRuntime(environmentId: EnvironmentId | null): boolean {
  const configs = useServerConfigs();
  return (
    environmentId !== null &&
    configs.get(environmentId)?.environment.capabilities.podRuntime === true
  );
}

const liveState = (environmentId: EnvironmentId) =>
  serverEnvironment.podRuntimeLive({ environmentId, input: {} });

const NO_PODS_ATOM = Atom.make<PodRuntimeLiveState>(EMPTY_POD_RUNTIME_STATE).pipe(
  Atom.withLabel("pod-runtime:none"),
);
const NO_POD_ATOM = Atom.make<PodRuntimeSnapshot | undefined>(undefined).pipe(
  Atom.withLabel("pod-runtime:no-pod"),
);

const podsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    Option.getOrElse(
      AsyncResult.value(get(liveState(environmentId))),
      () => EMPTY_POD_RUNTIME_STATE,
    ),
  ).pipe(Atom.withLabel(`pod-runtime:pods:${environmentId}`)),
);

// One atom per worktree, so a pod changing re-renders only the rows showing it.
const worktreePodAtom = Atom.family((key: string) => {
  const separator = key.indexOf("\u0000");
  const environmentId = key.slice(0, separator) as EnvironmentId;
  const worktreePath = key.slice(separator + 1);
  return Atom.make((get) => podForWorktree(get(podsAtom(environmentId)).pods, worktreePath)).pipe(
    Atom.withLabel(`pod-runtime:worktree:${key}`),
  );
});

/** Every pod of the environment, live; empty on a server without pods. */
export function usePodRuntimeState(environmentId: EnvironmentId | null): PodRuntimeLiveState {
  const supported = useEnvironmentSupportsPodRuntime(environmentId);
  return useAtomValue(supported && environmentId !== null ? podsAtom(environmentId) : NO_PODS_ATOM);
}

/** The pod a worktree runs in, live. Rows without a worktree open no subscription. */
export function useWorktreePod(
  environmentId: EnvironmentId | null,
  worktreePath: string | null | undefined,
): PodRuntimeSnapshot | undefined {
  const supported = useEnvironmentSupportsPodRuntime(environmentId);
  return useAtomValue(
    supported && environmentId !== null && worktreePath != null
      ? worktreePodAtom(`${environmentId}\u0000${worktreePath}`)
      : NO_POD_ATOM,
  );
}

/** Whether the composer may offer a container: the runtime is on and t3.json has a pod block. */
export function useProjectOffersPods(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
): boolean {
  const supported = useEnvironmentSupportsPodRuntime(environmentId);
  const status = useEnvironmentQuery(
    supported && environmentId !== null && projectId !== null
      ? serverEnvironment.podRuntimeProjectStatus({ environmentId, input: { projectId } })
      : null,
  );
  return status.data?.enabled === true && status.data.projectConfigured === true;
}
