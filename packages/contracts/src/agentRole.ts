import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ProjectId, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { ProviderOptionSelection } from "./model.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

export const AGENT_ROLE_PRESET_INSTRUCTIONS_MAX_LENGTH = 8_000;

/**
 * Starts with a letter so preset records keep their insertion order: JavaScript
 * moves integer-like keys to the front of an object.
 */
export const AgentRolePresetId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z][a-z0-9_-]*$/),
).annotate({
  description: "Lowercase role preset id: a letter, then letters, digits, '-' or '_'.",
});
export type AgentRolePresetId = typeof AgentRolePresetId.Type;

export const AgentRolePresetLabel = TrimmedNonEmptyString.check(Schema.isMaxLength(64));

export const AgentRolePresetTarget = Schema.Struct({
  providerInstanceId: Schema.optional(ProviderInstanceId),
  driverKind: Schema.optional(ProviderDriverKind),
  model: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  options: Schema.Array(ProviderOptionSelection)
    .check(Schema.isMaxLength(16))
    .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
}).check(
  Schema.makeFilter(
    (target) =>
      target.providerInstanceId !== undefined ||
      target.driverKind !== undefined ||
      "A role preset target needs a providerInstanceId or a driverKind.",
  ),
);
export type AgentRolePresetTarget = typeof AgentRolePresetTarget.Type;

export const AgentRolePresetIsolation = Schema.Literals(["shared", "worktree"]);
export type AgentRolePresetIsolation = typeof AgentRolePresetIsolation.Type;

/** Stored and listed only until pods exist. */
export const AgentRolePresetRunsIn = Schema.Literals(["host", "pod"]);
export type AgentRolePresetRunsIn = typeof AgentRolePresetRunsIn.Type;

/** Claude only; other providers ignore it. */
export const AgentRolePresetContextWindow = Schema.Literals(["200k", "1m"]);
export type AgentRolePresetContextWindow = typeof AgentRolePresetContextWindow.Type;

const SkillName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
);

export const AgentRolePreset = Schema.Struct({
  id: AgentRolePresetId,
  label: AgentRolePresetLabel,
  target: AgentRolePresetTarget,
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  isolation: Schema.optional(AgentRolePresetIsolation),
  runsIn: Schema.optional(AgentRolePresetRunsIn),
  contextWindow: Schema.optional(AgentRolePresetContextWindow),
  instructions: TrimmedString.check(Schema.isMaxLength(AGENT_ROLE_PRESET_INSTRUCTIONS_MAX_LENGTH)),
  skills: Schema.optional(Schema.Array(SkillName).check(Schema.isMaxLength(32))),
  /** Listed for the orchestration skill; the server does not enforce it. */
  allowedChildRoles: Schema.optional(Schema.Array(AgentRolePresetId).check(Schema.isMaxLength(64))),
});
export type AgentRolePreset = typeof AgentRolePreset.Type;

/**
 * One layer of user edits over the layers below it. Seeded defaults live in
 * code, so a default improved there reaches every user who never edited it.
 */
export const AgentRolePresetLayer = Schema.Struct({
  overrides: Schema.Record(AgentRolePresetId, AgentRolePreset).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  /** Ids removed at this layer that a lower layer still defines. */
  removed: Schema.Array(AgentRolePresetId).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type AgentRolePresetLayer = typeof AgentRolePresetLayer.Type;

export const AgentRolePresetSettings = Schema.Struct({
  environment: AgentRolePresetLayer.pipe(
    Schema.withDecodingDefault(Effect.succeed({ overrides: {}, removed: [] })),
  ),
  projects: Schema.Record(ProjectId, AgentRolePresetLayer).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type AgentRolePresetSettings = typeof AgentRolePresetSettings.Type;

export const AgentRolePresetScope = Schema.Union([
  Schema.Struct({ type: Schema.Literal("environment") }),
  Schema.Struct({ type: Schema.Literal("project"), projectId: ProjectId }),
]);
export type AgentRolePresetScope = typeof AgentRolePresetScope.Type;

export const AgentRolePresetSource = Schema.Literals(["default", "environment", "project"]);
export type AgentRolePresetSource = typeof AgentRolePresetSource.Type;

/** The server-merged preset a client renders; clients never merge layers themselves. */
export const EffectiveAgentRolePreset = Schema.Struct({
  ...AgentRolePreset.fields,
  /** The layer whose value is in effect. */
  source: AgentRolePresetSource,
  /** A layer below `source` defines this id, so resetting `source` restores it. */
  inherited: Schema.Boolean,
  /**
   * What a new thread with this role starts on: the named instance or the
   * first usable one of the driver, with the options its model offers. Null
   * when nothing can run it, and `unavailable` says why.
   */
  resolvedModelSelection: Schema.NullOr(ModelSelection),
  unavailable: Schema.NullOr(
    Schema.Struct({ kind: Schema.Literals(["provider", "model"]), reason: Schema.String }),
  ),
});
export type EffectiveAgentRolePreset = typeof EffectiveAgentRolePreset.Type;

export const RemovedAgentRolePreset = Schema.Struct({
  id: AgentRolePresetId,
  label: AgentRolePresetLabel,
  removedIn: Schema.Literals(["environment", "project"]),
});
export type RemovedAgentRolePreset = typeof RemovedAgentRolePreset.Type;

export const AgentRolePresetListInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
});
export type AgentRolePresetListInput = typeof AgentRolePresetListInput.Type;

export const AgentRolePresetList = Schema.Struct({
  presets: Schema.Array(EffectiveAgentRolePreset),
  removed: Schema.Array(RemovedAgentRolePreset),
});
export type AgentRolePresetList = typeof AgentRolePresetList.Type;

export const AgentRolePresetSaveInput = Schema.Struct({
  scope: AgentRolePresetScope,
  preset: AgentRolePreset,
});
export type AgentRolePresetSaveInput = typeof AgentRolePresetSaveInput.Type;

export const AgentRolePresetRemoveInput = Schema.Struct({
  scope: AgentRolePresetScope,
  id: AgentRolePresetId,
});
export type AgentRolePresetRemoveInput = typeof AgentRolePresetRemoveInput.Type;

/** Omit `id` to reset every preset in the scope. */
export const AgentRolePresetResetInput = Schema.Struct({
  scope: AgentRolePresetScope,
  id: Schema.optional(AgentRolePresetId),
});
export type AgentRolePresetResetInput = typeof AgentRolePresetResetInput.Type;

export class AgentRolePresetError extends Schema.TaggedError<AgentRolePresetError>()(
  "AgentRolePresetError",
  { message: Schema.String },
) {}

/**
 * What a thread records about its role. The label is a snapshot, so a thread
 * whose preset was later removed still names it.
 */
export const ThreadRolePreset = Schema.Struct({
  id: AgentRolePresetId,
  label: AgentRolePresetLabel,
});
export type ThreadRolePreset = typeof ThreadRolePreset.Type;
