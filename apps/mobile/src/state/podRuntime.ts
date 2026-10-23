import { useAtomValue } from "@effect/atom-react";
import { EMPTY_POD_RUNTIME_STATE, podForWorktree } from "@t3tools/client-runtime/state/pod-runtime";
import type { EnvironmentId, PodRuntimeSnapshot } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { useServerConfigs } from "./entities";
import { serverEnvironment } from "./server";

const NO_POD_ATOM = Atom.make<PodRuntimeSnapshot | undefined>(undefined).pipe(
  Atom.withLabel("pod-runtime:no-pod"),
);

const podsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    Option.getOrElse(
      AsyncResult.value(get(serverEnvironment.podRuntimeLive({ environmentId, input: {} }))),
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

/** The pod a worktree runs in, live. Rows without a worktree, or on stock servers, open no subscription. */
export function useWorktreePod(
  environmentId: EnvironmentId,
  worktreePath: string | null | undefined,
): PodRuntimeSnapshot | undefined {
  const supported =
    useServerConfigs().get(environmentId)?.environment.capabilities.podRuntime === true;
  return useAtomValue(
    supported && worktreePath != null
      ? worktreePodAtom(`${environmentId}\u0000${worktreePath}`)
      : NO_POD_ATOM,
  );
}
