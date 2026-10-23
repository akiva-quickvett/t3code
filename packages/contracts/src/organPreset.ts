import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  AGENT_ROLE_PRESET_INSTRUCTIONS_MAX_LENGTH,
  AgentRolePresetId,
  AgentRolePresetLabel,
  AgentRolePresetScope,
  AgentRolePresetSource,
  AgentRolePresetTarget,
} from "./agentRole.ts";
import { PositiveInt, ProjectId, TrimmedString } from "./baseSchemas.ts";

export const ORGAN_GOAL_MAX_LENGTH = 500;
export const ORGAN_CELL_MAX_COUNT = 8;

/**
 * Minted by the server from the MCP request namespace and request key, so a
 * retried start reuses the organ. Persisted in thread and subagent payloads:
 * the pattern may widen later but must never narrow.
 */
export const OrganId = Schema.String.check(Schema.isPattern(/^organ_[A-Za-z0-9_-]{8,64}$/));
export type OrganId = typeof OrganId.Type;

/** Same shape as role preset ids, so preset records keep their insertion order. */
export const OrganPresetId = AgentRolePresetId.annotate({
  description: "Lowercase organ preset id: a letter, then letters, digits, '-' or '_'.",
});
export type OrganPresetId = typeof OrganPresetId.Type;

/**
 * Carried by the parent's subagent record and the child's lineage, so a cell
 * renders its organ header alone after a reload. `goal` is repeated in every
 * subagent update, hence the cap; the full brief is each cell's prompt.
 */
export const OrganLabel = Schema.Struct({
  id: OrganId,
  presetId: OrganPresetId,
  goal: Schema.String.check(Schema.isMaxLength(ORGAN_GOAL_MAX_LENGTH)),
  round: PositiveInt,
});
export type OrganLabel = typeof OrganLabel.Type;

export const OrganCellCount = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: ORGAN_CELL_MAX_COUNT }),
);

export const OrganPresetCell = Schema.Struct({
  role: AgentRolePresetId,
  count: OrganCellCount,
  /** Overrides the role preset's target for these cells. */
  target: Schema.optional(AgentRolePresetTarget),
});
export type OrganPresetCell = typeof OrganPresetCell.Type;

export const OrganPreset = Schema.Struct({
  id: OrganPresetId,
  label: AgentRolePresetLabel,
  goalTemplate: TrimmedString.check(Schema.isMaxLength(AGENT_ROLE_PRESET_INSTRUCTIONS_MAX_LENGTH)),
  cells: Schema.Array(OrganPresetCell).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
});
export type OrganPreset = typeof OrganPreset.Type;

/** Mirrors `AgentRolePresetLayer`: user edits only, over defaults seeded in code. */
export const OrganPresetLayer = Schema.Struct({
  overrides: Schema.Record(OrganPresetId, OrganPreset).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  /** Ids removed at this layer that a lower layer still defines. */
  removed: Schema.Array(OrganPresetId).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type OrganPresetLayer = typeof OrganPresetLayer.Type;

export const OrganPresetSettings = Schema.Struct({
  environment: OrganPresetLayer.pipe(
    Schema.withDecodingDefault(Effect.succeed({ overrides: {}, removed: [] })),
  ),
  projects: Schema.Record(ProjectId, OrganPresetLayer).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type OrganPresetSettings = typeof OrganPresetSettings.Type;

/** The server-merged preset a client renders; clients never merge layers themselves. */
export const EffectiveOrganPreset = Schema.Struct({
  ...OrganPreset.fields,
  /** The layer whose value is in effect. */
  source: AgentRolePresetSource,
  /** A layer below `source` defines this id, so resetting `source` restores it. */
  inherited: Schema.Boolean,
});
export type EffectiveOrganPreset = typeof EffectiveOrganPreset.Type;

export const RemovedOrganPreset = Schema.Struct({
  id: OrganPresetId,
  label: AgentRolePresetLabel,
  removedIn: Schema.Literals(["environment", "project"]),
});
export type RemovedOrganPreset = typeof RemovedOrganPreset.Type;

export const OrganPresetListInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
});
export type OrganPresetListInput = typeof OrganPresetListInput.Type;

export const OrganPresetList = Schema.Struct({
  presets: Schema.Array(EffectiveOrganPreset),
  removed: Schema.Array(RemovedOrganPreset),
});
export type OrganPresetList = typeof OrganPresetList.Type;

export const OrganPresetSaveInput = Schema.Struct({
  scope: AgentRolePresetScope,
  preset: OrganPreset,
});
export type OrganPresetSaveInput = typeof OrganPresetSaveInput.Type;

export const OrganPresetRemoveInput = Schema.Struct({
  scope: AgentRolePresetScope,
  id: OrganPresetId,
});
export type OrganPresetRemoveInput = typeof OrganPresetRemoveInput.Type;

/** Omit `id` to reset every preset in the scope. */
export const OrganPresetResetInput = Schema.Struct({
  scope: AgentRolePresetScope,
  id: Schema.optional(OrganPresetId),
});
export type OrganPresetResetInput = typeof OrganPresetResetInput.Type;

export class OrganPresetError extends Schema.TaggedError<OrganPresetError>()("OrganPresetError", {
  message: Schema.String,
}) {}
