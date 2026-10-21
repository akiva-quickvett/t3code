import type {
  AgentRolePreset,
  AgentRolePresetId,
  AgentRolePresetLayer,
  AgentRolePresetScope,
  AgentRolePresetSettings,
  AgentRolePresetSource,
  ProjectId,
  RemovedAgentRolePreset,
} from "@t3tools/contracts";

interface LayeredAgentRolePreset {
  readonly preset: AgentRolePreset;
  readonly source: AgentRolePresetSource;
  readonly inherited: boolean;
}

interface LayeredAgentRolePresets {
  readonly presets: ReadonlyArray<LayeredAgentRolePreset>;
  readonly removed: ReadonlyArray<RemovedAgentRolePreset>;
}

export type AgentRolePresetEdit =
  | {
      readonly type: "save";
      readonly scope: AgentRolePresetScope;
      readonly preset: AgentRolePreset;
    }
  | {
      readonly type: "remove";
      readonly scope: AgentRolePresetScope;
      readonly id: AgentRolePresetId;
    }
  | {
      readonly type: "reset";
      readonly scope: AgentRolePresetScope;
      readonly id?: AgentRolePresetId | undefined;
    };

const EMPTY_LAYER: AgentRolePresetLayer = { overrides: {}, removed: [] };

/**
 * Defaults, then the environment's edits, then the project's. A later layer
 * replaces a preset in place, appends a new one, or removes one below it.
 */
export function layerAgentRolePresets(input: {
  readonly defaults: ReadonlyArray<AgentRolePreset>;
  readonly settings: AgentRolePresetSettings;
  readonly projectId?: ProjectId | undefined;
}): LayeredAgentRolePresets {
  const presets = new Map<string, LayeredAgentRolePreset>(
    input.defaults.map((preset) => [preset.id, { preset, source: "default", inherited: false }]),
  );
  const removed = new Map<string, RemovedAgentRolePreset>();
  const apply = (layer: AgentRolePresetLayer, source: "environment" | "project") => {
    for (const preset of Object.values(layer.overrides)) {
      presets.set(preset.id, { preset, source, inherited: presets.has(preset.id) });
    }
    for (const id of layer.removed) {
      const below = presets.get(id);
      if (below === undefined) continue;
      presets.delete(id);
      removed.set(id, { id, label: below.preset.label, removedIn: source });
    }
  };
  apply(input.settings.environment, "environment");
  if (input.projectId !== undefined) {
    apply(input.settings.projects[input.projectId] ?? EMPTY_LAYER, "project");
  }
  return {
    presets: [...presets.values()],
    removed: [...removed.values()].filter((entry) => !presets.has(entry.id)),
  };
}

function layerAt(settings: AgentRolePresetSettings, scope: AgentRolePresetScope) {
  return scope.type === "environment"
    ? settings.environment
    : (settings.projects[scope.projectId] ?? EMPTY_LAYER);
}

function withLayer(
  settings: AgentRolePresetSettings,
  scope: AgentRolePresetScope,
  layer: AgentRolePresetLayer,
): AgentRolePresetSettings {
  if (scope.type === "environment") return { ...settings, environment: layer };
  const { [scope.projectId]: _replaced, ...projects } = settings.projects;
  // An empty project layer is dropped so settings.json keeps no husk per project.
  const isEmpty = Object.keys(layer.overrides).length === 0 && layer.removed.length === 0;
  return { ...settings, projects: isEmpty ? projects : { ...projects, [scope.projectId]: layer } };
}

/** Whether a layer below `scope` defines `id`, so removing it there needs a tombstone. */
function definedBelow(input: {
  readonly defaults: ReadonlyArray<AgentRolePreset>;
  readonly settings: AgentRolePresetSettings;
  readonly scope: AgentRolePresetScope;
  readonly id: AgentRolePresetId;
}): boolean {
  if (input.scope.type === "environment") {
    return input.defaults.some((preset) => preset.id === input.id);
  }
  return layerAgentRolePresets({ defaults: input.defaults, settings: input.settings }).presets.some(
    (entry) => entry.preset.id === input.id,
  );
}

export function applyAgentRolePresetEdit(input: {
  readonly defaults: ReadonlyArray<AgentRolePreset>;
  readonly settings: AgentRolePresetSettings;
  readonly edit: AgentRolePresetEdit;
}): AgentRolePresetSettings {
  const { edit, settings } = input;
  const layer = layerAt(settings, edit.scope);
  switch (edit.type) {
    case "save":
      return withLayer(settings, edit.scope, {
        overrides: { ...layer.overrides, [edit.preset.id]: edit.preset },
        removed: layer.removed.filter((id) => id !== edit.preset.id),
      });
    case "remove": {
      const { [edit.id]: _removed, ...overrides } = layer.overrides;
      const tombstone =
        !layer.removed.includes(edit.id) &&
        definedBelow({ defaults: input.defaults, settings, scope: edit.scope, id: edit.id });
      return withLayer(settings, edit.scope, {
        overrides,
        removed: tombstone ? [...layer.removed, edit.id] : layer.removed,
      });
    }
    case "reset": {
      if (edit.id === undefined) return withLayer(settings, edit.scope, EMPTY_LAYER);
      const { [edit.id]: _reset, ...overrides } = layer.overrides;
      return withLayer(settings, edit.scope, {
        overrides,
        removed: layer.removed.filter((id) => id !== edit.id),
      });
    }
  }
}
