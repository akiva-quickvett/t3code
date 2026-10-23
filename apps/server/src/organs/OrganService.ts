import {
  type AgentRolePresetSource,
  type AgentRolePresetTarget,
  ORGAN_GOAL_MAX_LENGTH,
  type OrchestratorMcpStartOrganCell,
  type OrchestratorMcpTarget,
  type OrganId,
  type OrganLabel,
  type ProjectId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the organ id must be a synchronous, deterministic hash.
import * as NodeCrypto from "node:crypto";

import { layerAgentRolePresets } from "../agentRoles/agentRolePresetLayers.ts";
import { findAgentRolePresetIn } from "../agentRoles/AgentRolePresetService.ts";
import { DEFAULT_AGENT_ROLE_PRESETS } from "../agentRoles/defaultAgentRolePresets.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import { buildOrganPresetList, unknownOrganCellRoles } from "./OrganPresetService.ts";

export class OrganRefusal extends Schema.TaggedError<OrganRefusal>()("OrganRefusal", {
  message: Schema.String,
}) {}

/** The thread starting an organ or adding a round to one. */
export interface OrganStarter {
  readonly projectId: ProjectId;
  readonly rolePreset?: { readonly id: string } | null | undefined;
}

export interface OrganCellPlan {
  /** Position in the expanded cell list; seeds the cell's command id. */
  readonly index: number;
  readonly role: string;
  /** From the preset cell or the per-call override; absent means the role's own target. */
  readonly target?: OrchestratorMcpTarget;
  /** The expanded goal template, carrying the full goal. */
  readonly prompt: string;
  readonly title: string;
  /**
   * Set only when the organ already started under this key: a cell its starter
   * may no longer start fails on its own, while cells that started still replay.
   */
  readonly refusal?: string;
}

export interface OrganStartPlan {
  readonly organ: OrganLabel;
  readonly cells: ReadonlyArray<OrganCellPlan>;
}

export interface OrganStartInput {
  readonly starter: OrganStarter;
  readonly presetId: string;
  readonly goal: string;
  readonly cells?: ReadonlyArray<OrchestratorMcpStartOrganCell> | undefined;
  /** The starter's subagent records, which show whether this key already started the organ. */
  readonly subagents: ReadonlyArray<{ readonly organ?: OrganLabel | undefined }>;
  /** The MCP request namespace (the provider session) and the call's request key. */
  readonly requestNamespace: string;
  readonly requestKey: string;
}

export interface OrganRoundInput {
  readonly starter: OrganStarter;
  /** The starter's subagent records; the organ must already be on one of them. */
  readonly subagents: ReadonlyArray<{ readonly organ?: OrganLabel | undefined }>;
  readonly organ: { readonly id: OrganId; readonly round?: number | undefined };
  readonly role: string | undefined;
}

/**
 * Derived from the session and request key, so a keyed retry reuses the organ
 * while the same key in another session, or a key-less call, gets a new one.
 */
export function mintOrganId(requestNamespace: string, requestKey: string): OrganId {
  const digest = NodeCrypto.createHash("sha256")
    .update(`${requestNamespace}:${requestKey}`)
    .digest("base64url");
  return `organ_${digest.slice(0, 32)}`;
}

/** Cuts at a code unit boundary, so a surrogate pair is never split. */
function clip(text: string, length: number, ellipsis: string): string {
  if (text.length <= length) return text;
  const end = length - ellipsis.length;
  const code = text.charCodeAt(end - 1);
  return `${text.slice(0, code >= 0xd800 && code <= 0xdbff ? end - 1 : end)}${ellipsis}`;
}

export function organGoalLabel(goal: string): string {
  return clip(goal, ORGAN_GOAL_MAX_LENGTH, "…");
}

function expandGoalTemplate(template: string, goal: string): string {
  // split/join, not replaceAll: a string replacement would expand `$&` and friends in the goal.
  if (template.includes("{goal}")) return template.split("{goal}").join(goal);
  return template.length === 0 ? goal : `${template}\n\n${goal}`;
}

function cellTitle(role: string, index: number, goal: string): string {
  return clip(`${role} ${index + 1}: ${goal.replace(/\s+/g, " ").trim()}`, 80, "...");
}

function toMcpTarget(target: AgentRolePresetTarget): OrchestratorMcpTarget {
  return {
    ...(target.providerInstanceId === undefined
      ? {}
      : { providerInstanceId: target.providerInstanceId }),
    ...(target.driverKind === undefined ? {} : { driverKind: target.driverKind }),
    model: target.model,
    ...(target.options.length === 0 ? {} : { options: target.options }),
  };
}

const LAYER_NAMES: Record<AgentRolePresetSource, string> = {
  default: "built-in",
  environment: "environment",
  project: "project",
};

/**
 * The only place `allowedChildRoles` is enforced, and only for organ
 * delegations. Unknown roles are always refused; a starter without a role, with
 * a removed role, or whose role has no list is unrestricted.
 */
function checkCellRoles(
  settings: ServerSettings,
  starter: OrganStarter,
  roles: ReadonlyArray<string>,
): string | undefined {
  const unknown = unknownOrganCellRoles(settings, starter.projectId, roles);
  if (unknown.length > 0) {
    return `${unknown.length === 1 ? "Role" : "Roles"} ${unknown.map((role) => `\`${role}\``).join(", ")} ${unknown.length === 1 ? "is" : "are"} not defined for this project.`;
  }
  if (starter.rolePreset == null) return undefined;
  const starterId = starter.rolePreset.id;
  const entry = layerAgentRolePresets({
    defaults: DEFAULT_AGENT_ROLE_PRESETS,
    settings: settings.agentRolePresets,
    projectId: starter.projectId,
  }).presets.find((candidate) => candidate.preset.id === starterId);
  const allowed = entry?.preset.allowedChildRoles;
  if (entry === undefined || allowed === undefined) return undefined;
  const missing = roles.find((role) => !allowed.includes(role));
  return missing === undefined
    ? undefined
    : `Role \`${starterId}\` (defined in the ${LAYER_NAMES[entry.source]} layer) can't start \`${missing}\`; add it to its allowed child roles.`;
}

const normalizeRole = (role: string) => role.trim().toLowerCase();

export function planOrganStart(
  settings: ServerSettings,
  input: OrganStartInput,
): OrganStartPlan | OrganRefusal {
  const presets = buildOrganPresetList(settings, input.starter.projectId).presets;
  const preset = findAgentRolePresetIn(presets, input.presetId);
  if (preset === undefined) {
    return new OrganRefusal({
      message: `Unknown organ preset "${input.presetId}". Known presets: ${presets.map((entry) => entry.id).join(", ")}.`,
    });
  }
  const sourceCells =
    input.cells?.map((cell) => ({
      role: normalizeRole(cell.role),
      count: cell.count ?? 1,
      target: cell.target,
    })) ??
    preset.cells.map((cell) => ({
      role: cell.role,
      count: cell.count,
      target: cell.target === undefined ? undefined : toMcpTarget(cell.target),
    }));
  const organ: OrganLabel = {
    id: mintOrganId(input.requestNamespace, input.requestKey),
    presetId: preset.id,
    goal: organGoalLabel(input.goal),
    round: 1,
  };
  const started = input.subagents.flatMap((task) =>
    task.organ?.id === organ.id ? [task.organ] : [],
  );
  const other = started.find(
    (label) => label.presetId !== organ.presetId || label.goal !== organ.goal,
  );
  if (other !== undefined) {
    return new OrganRefusal({
      message: `clientRequestId \`${input.requestKey}\` already started organ \`${organ.id}\` (preset \`${other.presetId}\`); use a new clientRequestId.`,
    });
  }
  // A new organ is refused whole. A retry of a started one is replayed instead:
  // only a cell that never started can still be refused, and then on its own.
  if (started.length === 0) {
    const refusal = checkCellRoles(
      settings,
      input.starter,
      sourceCells.map((cell) => cell.role),
    );
    if (refusal !== undefined) return new OrganRefusal({ message: refusal });
  }
  const prompt = expandGoalTemplate(preset.goalTemplate, input.goal);
  const cells = sourceCells
    .flatMap((cell) => Array.from({ length: cell.count }, () => cell))
    .map((cell, index): OrganCellPlan => {
      const refusal =
        started.length === 0 ? undefined : checkCellRoles(settings, input.starter, [cell.role]);
      return {
        index,
        role: cell.role,
        ...(cell.target === undefined ? {} : { target: cell.target }),
        prompt,
        title: cellTitle(cell.role, index, organ.goal),
        ...(refusal === undefined ? {} : { refusal }),
      };
    });
  return { organ, cells };
}

export function planOrganRound(
  settings: ServerSettings,
  input: OrganRoundInput,
): OrganLabel | OrganRefusal {
  const siblings = input.subagents.flatMap((task) =>
    task.organ?.id === input.organ.id ? [task.organ] : [],
  );
  const latest = siblings.reduce<OrganLabel | undefined>(
    (best, organ) => (best === undefined || organ.round > best.round ? organ : best),
    undefined,
  );
  if (latest === undefined) {
    return new OrganRefusal({
      message: `Organ ${input.organ.id} was not started by this thread. Nothing was created.`,
    });
  }
  if (input.role === undefined) {
    return new OrganRefusal({
      message: "An organ round needs preset: the role of the cell to add. Nothing was created.",
    });
  }
  const refusal = checkCellRoles(settings, input.starter, [normalizeRole(input.role)]);
  if (refusal !== undefined) return new OrganRefusal({ message: refusal });
  return { ...latest, round: input.organ.round ?? latest.round + 1 };
}

export class OrganService extends Context.Service<
  OrganService,
  {
    /** Resolves the preset and cells, enforces roles, and mints the label for round 1. */
    readonly planStart: (input: OrganStartInput) => Effect.Effect<OrganStartPlan, OrganRefusal>;
    /** The label for a cell added to an organ already on the starter's records. */
    readonly planRound: (input: OrganRoundInput) => Effect.Effect<OrganLabel, OrganRefusal>;
  }
>()("t3/organs/OrganService") {}

const isOrganRefusal = Schema.is(OrganRefusal);

const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService.ServerSettingsService;
  const withSettings = <A>(plan: (settings: ServerSettings) => A | OrganRefusal) =>
    serverSettings.getSettings.pipe(
      Effect.orDie,
      Effect.flatMap((settings) => {
        const result = plan(settings);
        return isOrganRefusal(result) ? Effect.fail(result) : Effect.succeed(result);
      }),
    );
  return OrganService.of({
    planStart: (input) => withSettings((settings) => planOrganStart(settings, input)),
    planRound: (input) => withSettings((settings) => planOrganRound(settings, input)),
  });
});

export const layer = Layer.effect(OrganService, make);
