import {
  type AgentRolePresetScope,
  type AgentRolePresetTarget,
  type EffectiveOrganPreset,
  ORGAN_CELL_MAX_COUNT,
  OrganPreset,
  OrganPresetId,
  type OrganPresetResetInput,
} from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

export type OrganLayer = "environment" | "project";

export interface OrganCellDraft {
  readonly role: string;
  readonly count: number;
  /** Kept as saved; the editor shows it but only clears it. */
  readonly target?: AgentRolePresetTarget;
}

export interface OrganDraft {
  readonly isNew: boolean;
  readonly id: string;
  readonly label: string;
  readonly goalTemplate: string;
  readonly cells: ReadonlyArray<OrganCellDraft>;
}

export const EMPTY_ORGAN_DRAFT: OrganDraft = {
  isNew: true,
  id: "",
  label: "",
  goalTemplate: "",
  cells: [{ role: "", count: 1 }],
};

export function organPresetToDraft(preset: EffectiveOrganPreset): OrganDraft {
  return {
    isNew: false,
    id: preset.id,
    label: preset.label,
    goalTemplate: preset.goalTemplate,
    cells: preset.cells.map((cell) => ({
      role: cell.role,
      count: cell.count,
      ...(cell.target === undefined ? {} : { target: cell.target }),
    })),
  };
}

export function clampCellCount(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(ORGAN_CELL_MAX_COUNT, Math.max(1, Math.round(value)));
}

/**
 * Cell roles the scope does not define. The server refuses such a save; this
 * only lets the editor say so first. Unknown until the roles load.
 */
export function missingCellRoles(
  draft: OrganDraft,
  roleIds: ReadonlySet<string> | null,
): ReadonlySet<string> {
  if (roleIds === null) return new Set();
  return new Set(
    draft.cells.map((cell) => cell.role.trim()).filter((role) => role !== "" && !roleIds.has(role)),
  );
}

const decodePreset = Schema.decodeUnknownExit(OrganPreset);
const isPresetId = Schema.is(OrganPresetId);

/** The server decodes again; this only lets the dialog say what is wrong before saving. */
export function organDraftToPreset(
  draft: OrganDraft,
): { readonly preset: OrganPreset } | { readonly error: string } {
  const exit = decodePreset({
    id: draft.id.trim(),
    label: draft.label,
    goalTemplate: draft.goalTemplate,
    cells: draft.cells.map((cell) => ({
      role: cell.role.trim(),
      count: clampCellCount(cell.count),
      ...(cell.target === undefined ? {} : { target: cell.target }),
    })),
  });
  if (Exit.isSuccess(exit)) return { preset: exit.value };
  if (draft.id.trim() === "") return { error: "Give the organ an id." };
  if (!isPresetId(draft.id.trim())) {
    return { error: "Ids are lowercase: a letter, then letters, digits, '-' or '_'." };
  }
  if (draft.label.trim() === "") return { error: "Give the organ a label." };
  if (draft.cells.length === 0) return { error: "Add at least one cell." };
  if (draft.cells.some((cell) => cell.role.trim() === ""))
    return { error: "Pick each cell's role." };
  return { error: "Check the organ's fields; one of them is not valid." };
}

export interface OrganRowState {
  /** Where the value in effect comes from, as this layer sees it. */
  readonly sourceLabel: "Built-in" | "Edited" | "Custom" | "Environment";
  /**
   * Set when this layer overrides a preset defined below. Removing the
   * override is a reset of that id: `organPresets.remove` would hide the
   * preset at this layer instead of restoring the one below.
   */
  readonly removeOverride: OrganPresetResetInput | null;
}

export function organRowState(
  preset: Pick<EffectiveOrganPreset, "id" | "source" | "inherited">,
  layer: OrganLayer,
  scope: AgentRolePresetScope,
): OrganRowState {
  if (preset.source === "default") return { sourceLabel: "Built-in", removeOverride: null };
  if (preset.source !== layer) return { sourceLabel: "Environment", removeOverride: null };
  return preset.inherited
    ? { sourceLabel: "Edited", removeOverride: { scope, id: preset.id } }
    : { sourceLabel: "Custom", removeOverride: null };
}
