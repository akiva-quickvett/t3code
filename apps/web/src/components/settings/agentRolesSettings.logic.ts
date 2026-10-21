import {
  AgentRolePreset,
  AgentRolePresetId,
  type AgentRolePresetContextWindow,
  type AgentRolePresetIsolation,
  type AgentRolePresetRunsIn,
  type EffectiveAgentRolePreset,
  type ProviderInteractionMode,
  type ProviderOptionSelection,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

export type RoleLayer = "environment" | "project";

export interface RoleDraft {
  readonly isNew: boolean;
  readonly id: string;
  readonly label: string;
  readonly instanceId: string;
  readonly driverKind: string;
  readonly model: string;
  /** Pinned presets run on one instance; unpinned ones on any instance of the driver. */
  readonly pinInstance: boolean;
  readonly options: ReadonlyArray<ProviderOptionSelection>;
  readonly runtimeMode: RuntimeMode | "";
  readonly interactionMode: ProviderInteractionMode | "";
  readonly isolation: AgentRolePresetIsolation | "";
  readonly runsIn: AgentRolePresetRunsIn | "";
  readonly contextWindow: AgentRolePresetContextWindow | "";
  readonly instructions: string;
  readonly skills: string;
  readonly allowedChildRoles: string;
}

export const EMPTY_ROLE_DRAFT: RoleDraft = {
  isNew: true,
  id: "",
  label: "",
  instanceId: "",
  driverKind: "",
  model: "",
  pinInstance: false,
  options: [],
  runtimeMode: "",
  interactionMode: "",
  isolation: "",
  runsIn: "",
  contextWindow: "",
  instructions: "",
  skills: "",
  allowedChildRoles: "",
};

export function presetToDraft(preset: EffectiveAgentRolePreset): RoleDraft {
  return {
    isNew: false,
    id: preset.id,
    label: preset.label,
    instanceId: preset.target.providerInstanceId ?? preset.resolvedModelSelection?.instanceId ?? "",
    driverKind: preset.target.driverKind ?? "",
    model: preset.target.model,
    pinInstance: preset.target.providerInstanceId !== undefined,
    options: preset.target.options,
    runtimeMode: preset.runtimeMode ?? "",
    interactionMode: preset.interactionMode ?? "",
    isolation: preset.isolation ?? "",
    runsIn: preset.runsIn ?? "",
    contextWindow: preset.contextWindow ?? "",
    instructions: preset.instructions,
    skills: (preset.skills ?? []).join(", "),
    allowedChildRoles: (preset.allowedChildRoles ?? []).join(", "),
  };
}

const splitList = (value: string) =>
  value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const decodePreset = Schema.decodeUnknownExit(AgentRolePreset);
const isPresetId = Schema.is(AgentRolePresetId);

/** The server decodes again; this only lets the dialog say what is wrong before saving. */
export function draftToPreset(
  draft: RoleDraft,
): { readonly preset: AgentRolePreset } | { readonly error: string } {
  const skills = splitList(draft.skills);
  const allowedChildRoles = splitList(draft.allowedChildRoles);
  const exit = decodePreset({
    id: draft.id.trim(),
    label: draft.label,
    target: {
      ...(draft.pinInstance
        ? { providerInstanceId: draft.instanceId }
        : { driverKind: draft.driverKind }),
      model: draft.model,
      options: draft.options,
    },
    ...(draft.runtimeMode === "" ? {} : { runtimeMode: draft.runtimeMode }),
    ...(draft.interactionMode === "" ? {} : { interactionMode: draft.interactionMode }),
    ...(draft.isolation === "" ? {} : { isolation: draft.isolation }),
    ...(draft.runsIn === "" ? {} : { runsIn: draft.runsIn }),
    ...(draft.contextWindow === "" ? {} : { contextWindow: draft.contextWindow }),
    instructions: draft.instructions,
    ...(skills.length === 0 ? {} : { skills }),
    ...(allowedChildRoles.length === 0 ? {} : { allowedChildRoles }),
  });
  if (Exit.isSuccess(exit)) return { preset: exit.value };
  if (draft.id.trim() === "") return { error: "Give the role an id." };
  if (!isPresetId(draft.id.trim())) {
    return { error: "Ids are lowercase: a letter, then letters, digits, '-' or '_'." };
  }
  if (draft.label.trim() === "") return { error: "Give the role a label." };
  if (draft.model.trim() === "") return { error: "Pick a model." };
  return { error: "Check the role's fields; one of them is not valid." };
}

export interface RoleRowState {
  /** Where the value in effect comes from, as this layer sees it. */
  readonly sourceLabel: "Default" | "Edited" | "Custom" | "Environment";
  /** Resetting drops this layer's edit and shows the one below. */
  readonly canReset: boolean;
}

export function roleRowState(preset: EffectiveAgentRolePreset, layer: RoleLayer): RoleRowState {
  if (preset.source === "default") return { sourceLabel: "Default", canReset: false };
  if (preset.source !== layer) return { sourceLabel: "Environment", canReset: false };
  return preset.inherited
    ? { sourceLabel: "Edited", canReset: true }
    : { sourceLabel: "Custom", canReset: false };
}
