import {
  createRolePresetLabelsAtomFamily,
  type RolePresetLabels,
  rolePresetLabelsKey,
  type ThreadRoleBadge,
  threadRoleBadge,
} from "@t3tools/client-runtime/state/agent-roles";
import type {
  AgentRolePresetList,
  EnvironmentId,
  ProjectId,
  ThreadRolePreset,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { useServerConfigs } from "./entities";
import { environmentServerConfigsAtom, serverEnvironment } from "./server";
import { waitForAtomValue } from "./waitForAtomValue";

const rolePresetLabelsAtom = createRolePresetLabelsAtomFamily(
  serverEnvironment.agentRolePresetsLive,
);

const NO_ROLE_LABELS_ATOM = Atom.make<RolePresetLabels | null>(null).pipe(
  Atom.withLabel("agent-role-labels:none"),
);

/** Threads without a role read a constant atom, so they open no subscription. */
export function useThreadRoleBadge(thread: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly rolePreset?: ThreadRolePreset | null | undefined;
}): ThreadRoleBadge | null {
  const labels = useAtomValue(
    thread.rolePreset == null
      ? NO_ROLE_LABELS_ATOM
      : rolePresetLabelsAtom(rolePresetLabelsKey(thread.environmentId, thread.projectId)),
  );
  return threadRoleBadge(thread.rolePreset, labels);
}

export function readEnvironmentSupportsRolePresets(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .agentRolePresets === true
  );
}

/** Stock servers lack role presets, so their clients hide every role control. */
export function useEnvironmentSupportsRolePresets(environmentId: EnvironmentId | null): boolean {
  const configs = useServerConfigs();
  return (
    environmentId !== null &&
    configs.get(environmentId)?.environment.capabilities.agentRolePresets === true
  );
}

/** One read of the server's list, for actions outside a mounted picker. */
export async function readRolePresets(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): Promise<AgentRolePresetList | null> {
  const atom = serverEnvironment.agentRolePresetsLive({ environmentId, input: { projectId } });
  const loaded = await waitForAtomValue({
    registry: appAtomRegistry,
    atom,
    predicate: AsyncResult.isSuccess,
    timeoutMs: 5_000,
  });
  return loaded ? Option.getOrNull(AsyncResult.value(appAtomRegistry.get(atom))) : null;
}
