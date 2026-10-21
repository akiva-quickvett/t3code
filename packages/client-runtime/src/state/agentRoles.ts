import type {
  AgentRolePresetList,
  EffectiveAgentRolePreset,
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadRolePreset,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

/** Preset id to its current label, for the presets in effect in one project. */
export type RolePresetLabels = ReadonlyMap<string, string>;

export interface ThreadRoleBadge {
  readonly label: string;
  /** The preset was removed after the thread took it; the label is the thread's snapshot. */
  readonly missing: boolean;
}

/**
 * A known preset shows its current label. Until the presets load, or on a
 * server without them, the thread's own snapshot stands in, never as missing.
 */
export function threadRoleBadge(
  rolePreset: ThreadRolePreset | null | undefined,
  labels: RolePresetLabels | null,
): ThreadRoleBadge | null {
  if (rolePreset == null) return null;
  if (labels === null) return { label: rolePreset.label, missing: false };
  const label = labels.get(rolePreset.id);
  return label === undefined
    ? { label: rolePreset.label, missing: true }
    : { label, missing: false };
}

export function threadRolePresetOf(preset: EffectiveAgentRolePreset): ThreadRolePreset {
  return { id: preset.id, label: preset.label };
}

export interface RolePresetDraftChoice {
  readonly rolePreset: ThreadRolePreset;
  /** Absent when no provider can run the preset; the draft keeps its model. */
  readonly modelSelection?: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
}

/** What picking a preset applies to a new thread, as the server resolved it. */
export function rolePresetDraftChoice(preset: EffectiveAgentRolePreset): RolePresetDraftChoice {
  return {
    rolePreset: threadRolePresetOf(preset),
    ...(preset.resolvedModelSelection === null
      ? {}
      : { modelSelection: preset.resolvedModelSelection }),
    ...(preset.runtimeMode === undefined ? {} : { runtimeMode: preset.runtimeMode }),
    ...(preset.interactionMode === undefined ? {} : { interactionMode: preset.interactionMode }),
  };
}

function labelsOf(list: AgentRolePresetList): RolePresetLabels {
  return new Map(list.presets.map((preset) => [preset.id, preset.label]));
}

function labelsEqual(left: RolePresetLabels | null, right: RolePresetLabels | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.size !== right.size) return false;
  for (const [id, label] of left) if (right.get(id) !== label) return false;
  return true;
}

type LivePresets = (key: {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly projectId?: ProjectId };
}) => Atom.Atom<AsyncResult.AsyncResult<AgentRolePresetList, unknown>>;

/**
 * Labels change only when presets are added, removed or renamed, so a badge
 * reading them does not re-render when provider availability moves.
 */
export function createRolePresetLabelsAtomFamily(livePresets: LivePresets) {
  return Atom.family((key: `${EnvironmentId}\u0000${ProjectId}`) => {
    const [environmentId, projectId] = key.split("\u0000") as [EnvironmentId, ProjectId];
    let previous: RolePresetLabels | null = null;
    return Atom.make((get) => {
      const list = Option.getOrNull(
        AsyncResult.value(get(livePresets({ environmentId, input: { projectId } }))),
      );
      const next = list === null ? null : labelsOf(list);
      if (labelsEqual(previous, next)) return previous;
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`agent-role-labels:${key}`));
  });
}

export function rolePresetLabelsKey(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): `${EnvironmentId}\u0000${ProjectId}` {
  return `${environmentId}\u0000${projectId}`;
}
