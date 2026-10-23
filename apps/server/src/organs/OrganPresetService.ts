import {
  type AgentRolePresetScope,
  type EffectiveOrganPreset,
  type OrganPreset,
  OrganPresetError,
  OrganPresetList,
  type OrganPresetListInput,
  type OrganPresetRemoveInput,
  type OrganPresetResetInput,
  type OrganPresetSaveInput,
  type ProjectId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  applyPresetEdit,
  layerAgentRolePresets,
  layerPresets,
  type PresetEdit,
} from "../agentRoles/agentRolePresetLayers.ts";
import { findAgentRolePresetIn } from "../agentRoles/AgentRolePresetService.ts";
import { DEFAULT_AGENT_ROLE_PRESETS } from "../agentRoles/defaultAgentRolePresets.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import { DEFAULT_ORGAN_PRESETS } from "./defaultOrganPresets.ts";

function buildOrganPresetList(
  settings: ServerSettings,
  projectId: ProjectId | undefined,
): OrganPresetList {
  const layered = layerPresets({
    defaults: DEFAULT_ORGAN_PRESETS,
    settings: settings.organPresets,
    projectId,
  });
  return {
    presets: layered.presets.map(({ preset, source, inherited }) => ({
      ...preset,
      source,
      inherited,
    })),
    removed: layered.removed,
  };
}

const projectOf = (scope: AgentRolePresetScope) =>
  scope.type === "project" ? scope.projectId : undefined;

/**
 * Roles that do not resolve in the scope's own effective role list. A project
 * scope sees its project's roles; the environment scope sees only its own.
 */
function unknownCellRoles(input: OrganPresetSaveInput, settings: ServerSettings) {
  const roles = new Set(
    layerAgentRolePresets({
      defaults: DEFAULT_AGENT_ROLE_PRESETS,
      settings: settings.agentRolePresets,
      projectId: projectOf(input.scope),
    }).presets.map((entry) => entry.preset.id),
  );
  return [...new Set(input.preset.cells.map((cell) => cell.role))].filter(
    (role) => !roles.has(role),
  );
}

const listsEqual = Schema.toEquivalence(OrganPresetList);

export class OrganPresetService extends Context.Service<
  OrganPresetService,
  {
    /** Built-ins, then the environment layer, then the project's when `projectId` is given. */
    readonly list: (
      input?: OrganPresetListInput,
    ) => Effect.Effect<OrganPresetList, OrganPresetError>;
    /**
     * The effective preset and the layer it comes from, or undefined when the
     * id is unknown or removed. Ids are matched forgiving case and padding.
     */
    readonly find: (input: {
      readonly projectId?: ProjectId | undefined;
      readonly id: string;
    }) => Effect.Effect<EffectiveOrganPreset | undefined, OrganPresetError>;
    /** Emits the list now and again whenever a settings change alters it. */
    readonly subscribe: (
      input?: OrganPresetListInput,
    ) => Stream.Stream<OrganPresetList, OrganPresetError>;
    /** Refused, with settings unchanged, when a cell role is unknown in that scope. */
    readonly save: (
      input: OrganPresetSaveInput,
    ) => Effect.Effect<OrganPresetList, OrganPresetError>;
    readonly remove: (
      input: OrganPresetRemoveInput,
    ) => Effect.Effect<OrganPresetList, OrganPresetError>;
    readonly reset: (
      input: OrganPresetResetInput,
    ) => Effect.Effect<OrganPresetList, OrganPresetError>;
  }
>()("t3/organs/OrganPresetService") {}

const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService.ServerSettingsService;

  const readSettings = serverSettings.getSettings.pipe(
    Effect.mapError(() => new OrganPresetError({ message: "Could not read organ presets." })),
  );

  const listFor = (projectId: ProjectId | undefined) =>
    readSettings.pipe(Effect.map((settings) => buildOrganPresetList(settings, projectId)));

  const list: OrganPresetService["Service"]["list"] = (input) => listFor(input?.projectId);

  const find: OrganPresetService["Service"]["find"] = (input) =>
    listFor(input.projectId).pipe(
      Effect.map((current) => findAgentRolePresetIn(current.presets, input.id)),
    );

  const subscribe: OrganPresetService["Service"]["subscribe"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribed before the first read so an edit landing in between is not lost.
        const settingsChanges = yield* serverSettings.subscribeChanges;
        return Stream.concat(
          Stream.fromEffect(list(input)),
          settingsChanges.pipe(Stream.mapEffect(() => list(input))),
        ).pipe(Stream.changesWith(listsEqual));
      }),
    );

  const edit = (input: PresetEdit<OrganPreset>) =>
    serverSettings
      .updateOrganPresets((current) =>
        applyPresetEdit({ defaults: DEFAULT_ORGAN_PRESETS, settings: current, edit: input }),
      )
      .pipe(
        Effect.mapError(() => new OrganPresetError({ message: "Could not save organ presets." })),
        Effect.flatMap(() => listFor(projectOf(input.scope))),
      );

  const save: OrganPresetService["Service"]["save"] = (input) =>
    readSettings.pipe(
      Effect.flatMap((settings) => {
        const unknown = unknownCellRoles(input, settings);
        return unknown.length === 0
          ? edit({ type: "save", ...input })
          : Effect.fail(
              new OrganPresetError({
                message: `Organ preset ${input.preset.id} names ${unknown.length === 1 ? "a role" : "roles"} not defined in this scope: ${unknown.join(", ")}.`,
              }),
            );
      }),
    );

  const remove: OrganPresetService["Service"]["remove"] = (input) =>
    listFor(projectOf(input.scope)).pipe(
      Effect.flatMap((current) =>
        current.presets.some((preset) => preset.id === input.id)
          ? edit({ type: "remove", ...input })
          : Effect.fail(
              new OrganPresetError({ message: `Organ preset ${input.id} was not found.` }),
            ),
      ),
    );

  return OrganPresetService.of({
    list,
    find,
    subscribe,
    save,
    remove,
    reset: (input) => edit({ type: "reset", ...input }),
  });
});

export const layer = Layer.effect(OrganPresetService, make);
