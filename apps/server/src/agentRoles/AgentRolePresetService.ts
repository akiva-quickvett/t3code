import {
  type AgentRolePreset,
  AgentRolePresetError,
  type AgentRolePresetRunsIn,
  AgentRolePresetList,
  type AgentRolePresetRemoveInput,
  type AgentRolePresetResetInput,
  type AgentRolePresetSaveInput,
  type AgentRolePresetScope,
  type EffectiveAgentRolePreset,
  isProviderAvailable,
  type ProjectId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  resolveProjectProviderInstanceEnabled,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import {
  type AgentRolePresetEdit,
  applyAgentRolePresetEdit,
  layerAgentRolePresets,
} from "./agentRolePresetLayers.ts";
import { DEFAULT_AGENT_ROLE_PRESETS } from "./defaultAgentRolePresets.ts";

/** Agents and people type ids loosely; lookups forgive case and padding. */
export function findAgentRolePresetIn<Preset extends { readonly id: string }>(
  presets: ReadonlyArray<Preset>,
  id: string,
): Preset | undefined {
  const normalized = id.trim().toLowerCase();
  return presets.find((preset) => preset.id === normalized);
}

export function unknownAgentRolePresetMessage(
  id: string,
  presets: ReadonlyArray<{ readonly id: string }>,
): string {
  return `Unknown role preset "${id}". Known presets: ${presets.map((preset) => preset.id).join(", ")}.`;
}

function providerUnavailableReason(input: {
  readonly provider: ServerProvider | undefined;
  readonly settings: ServerSettings;
  readonly projectId: ProjectId | undefined;
}): string | null {
  const { provider } = input;
  if (provider === undefined) return "The provider instance is not configured.";
  if (!provider.enabled) return `${provider.instanceId} is disabled.`;
  if (!isProviderAvailable(provider)) {
    return provider.unavailableReason ?? `${provider.instanceId} is unavailable.`;
  }
  if (!provider.installed) return `${provider.instanceId} is not installed.`;
  if (provider.auth.status === "unauthenticated") {
    return `${provider.instanceId} is not signed in.`;
  }
  if (
    input.projectId !== undefined &&
    !resolveProjectProviderInstanceEnabled(input.settings, input.projectId, provider.instanceId)
  ) {
    return `${provider.instanceId} is disabled for this project.`;
  }
  return null;
}

function offersOption(
  selection: ProviderOptionSelection,
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
): boolean {
  if (descriptors === undefined) return true;
  const descriptor = descriptors.find((candidate) => candidate.id === selection.id);
  if (descriptor === undefined) return false;
  return descriptor.type === "boolean"
    ? typeof selection.value === "boolean"
    : descriptor.options.some((choice) => choice.id === selection.value);
}

/**
 * The named instance, or the first usable instance of the driver. Options the
 * model does not offer are dropped: presets outlive the models they name.
 */
function resolvePresetAvailability(input: {
  readonly preset: AgentRolePreset;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: ServerSettings;
  readonly projectId: ProjectId | undefined;
}): Pick<EffectiveAgentRolePreset, "resolvedModelSelection" | "unavailable"> {
  const { target } = input.preset;
  const reasonFor = (provider: ServerProvider | undefined) =>
    providerUnavailableReason({ ...input, provider });
  const unavailable = (kind: "provider" | "model", reason: string) => ({
    resolvedModelSelection: null,
    unavailable: { kind, reason },
  });
  const offering = (provider: ServerProvider) => {
    const model = provider.models.find((candidate) => candidate.slug === target.model);
    if (provider.models.length > 0 && model === undefined) {
      return unavailable("model", `${provider.instanceId} does not offer ${target.model}.`);
    }
    const options = target.options.filter((selection) =>
      offersOption(selection, model?.capabilities?.optionDescriptors),
    );
    return {
      resolvedModelSelection: {
        instanceId: provider.instanceId,
        model: target.model,
        ...(options.length === 0 ? {} : { options }),
      },
      unavailable: null,
    };
  };
  if (target.providerInstanceId === undefined) {
    const candidates = input.providers.filter((entry) => entry.driver === target.driverKind);
    const usable = candidates.find((entry) => reasonFor(entry) === null);
    if (usable !== undefined) return offering(usable);
    return unavailable(
      "provider",
      candidates.length === 0
        ? `No ${target.driverKind} provider is configured.`
        : `No enabled ${target.driverKind} provider is available.`,
    );
  }
  const provider = input.providers.find((entry) => entry.instanceId === target.providerInstanceId);
  const reason = reasonFor(provider);
  return provider === undefined || reason !== null
    ? unavailable("provider", reason ?? "The provider instance is not configured.")
    : offering(provider);
}

/** Every caller merges through here, so clients and agents see one list. */
export function buildAgentRolePresetList(input: {
  readonly settings: ServerSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly projectId: ProjectId | undefined;
}): AgentRolePresetList {
  const layered = layerAgentRolePresets({
    defaults: DEFAULT_AGENT_ROLE_PRESETS,
    settings: input.settings.agentRolePresets,
    projectId: input.projectId,
  });
  return {
    presets: layered.presets.map(({ preset, source, inherited }) => ({
      ...preset,
      source,
      inherited,
      ...resolvePresetAvailability({ ...input, preset }),
    })),
    removed: layered.removed,
  };
}

/** The effective preset, or undefined when the id is unknown or was removed. */
export function findAgentRolePreset(input: {
  readonly settings: ServerSettings;
  readonly projectId: ProjectId;
  readonly id: string;
}): AgentRolePreset | undefined {
  const presets = layerAgentRolePresets({
    defaults: DEFAULT_AGENT_ROLE_PRESETS,
    settings: input.settings.agentRolePresets,
    projectId: input.projectId,
  }).presets.map((entry) => entry.preset);
  return findAgentRolePresetIn(presets, input.id);
}

/** Where the thread's role preset runs a provider that cannot run in a pod. */
export function threadRolePresetRunsIn(
  settings: ServerSettings,
  thread: {
    readonly projectId: ProjectId;
    readonly rolePreset?: { readonly id: string } | null | undefined;
  },
): AgentRolePresetRunsIn | undefined {
  return thread.rolePreset == null
    ? undefined
    : findAgentRolePreset({ settings, projectId: thread.projectId, id: thread.rolePreset.id })
        ?.runsIn;
}

const listsEqual = Schema.toEquivalence(AgentRolePresetList);

export class AgentRolePresetService extends Context.Service<
  AgentRolePresetService,
  {
    readonly list: (
      projectId?: ProjectId,
    ) => Effect.Effect<AgentRolePresetList, AgentRolePresetError>;
    /** Emits the list now and again whenever settings or provider availability change it. */
    readonly subscribe: (
      projectId?: ProjectId,
    ) => Stream.Stream<AgentRolePresetList, AgentRolePresetError>;
    readonly save: (
      input: AgentRolePresetSaveInput,
    ) => Effect.Effect<AgentRolePresetList, AgentRolePresetError>;
    readonly remove: (
      input: AgentRolePresetRemoveInput,
    ) => Effect.Effect<AgentRolePresetList, AgentRolePresetError>;
    readonly reset: (
      input: AgentRolePresetResetInput,
    ) => Effect.Effect<AgentRolePresetList, AgentRolePresetError>;
  }
>()("t3/agentRoles/AgentRolePresetService") {}

const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;

  const readSettings = serverSettings.getSettings.pipe(
    Effect.mapError(() => new AgentRolePresetError({ message: "Could not read role presets." })),
  );

  const list: AgentRolePresetService["Service"]["list"] = (projectId) =>
    Effect.gen(function* () {
      const settings = yield* readSettings;
      const providers = yield* providerRegistry.getProviders;
      return buildAgentRolePresetList({ settings, providers, projectId });
    });

  const subscribe: AgentRolePresetService["Service"]["subscribe"] = (projectId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribed before the first read so an edit landing in between is not lost.
        const settingsChanges = yield* serverSettings.subscribeChanges;
        return Stream.concat(
          Stream.fromEffect(list(projectId)),
          Stream.merge(settingsChanges, providerRegistry.streamChanges).pipe(
            Stream.mapEffect(() => list(projectId)),
          ),
        ).pipe(Stream.changesWith(listsEqual));
      }),
    );

  const projectOf = (scope: AgentRolePresetScope) =>
    scope.type === "project" ? scope.projectId : undefined;

  const edit = (input: AgentRolePresetEdit) =>
    serverSettings
      .updateAgentRolePresets((current) =>
        applyAgentRolePresetEdit({
          defaults: DEFAULT_AGENT_ROLE_PRESETS,
          settings: current,
          edit: input,
        }),
      )
      .pipe(
        Effect.mapError(
          () => new AgentRolePresetError({ message: "Could not save role presets." }),
        ),
        Effect.flatMap(() => list(projectOf(input.scope))),
      );

  const remove: AgentRolePresetService["Service"]["remove"] = (input) =>
    list(projectOf(input.scope)).pipe(
      Effect.flatMap((current) =>
        current.presets.some((preset) => preset.id === input.id)
          ? edit({ type: "remove", ...input })
          : Effect.fail(
              new AgentRolePresetError({ message: `Role preset ${input.id} was not found.` }),
            ),
      ),
    );

  return AgentRolePresetService.of({
    list,
    subscribe,
    save: (input) => edit({ type: "save", ...input }),
    remove,
    reset: (input) => edit({ type: "reset", ...input }),
  });
});

export const layer = Layer.effect(AgentRolePresetService, make);
