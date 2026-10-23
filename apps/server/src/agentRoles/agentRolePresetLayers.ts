import type {
  AgentRolePreset,
  AgentRolePresetScope,
  AgentRolePresetSettings,
  AgentRolePresetSource,
  ProjectId,
  RemovedAgentRolePreset,
} from "@t3tools/contracts";

/** Role and organ presets share this layering; their ids and labels are plain strings. */
interface LayerablePreset {
  readonly id: string;
  readonly label: string;
}

/** One layer of user edits, keyed by preset id. */
export interface PresetLayer<T> {
  readonly overrides: { readonly [id: string]: T };
  /** Ids removed at this layer that a lower layer still defines. */
  readonly removed: ReadonlyArray<string>;
}

export interface PresetSettings<T> {
  readonly environment: PresetLayer<T>;
  readonly projects: { readonly [projectId: ProjectId]: PresetLayer<T> };
}

export interface LayeredPreset<T> {
  readonly preset: T;
  readonly source: AgentRolePresetSource;
  readonly inherited: boolean;
}

export interface LayeredPresets<T> {
  readonly presets: ReadonlyArray<LayeredPreset<T>>;
  readonly removed: ReadonlyArray<RemovedAgentRolePreset>;
}

export type PresetEdit<T> =
  | {
      readonly type: "save";
      readonly scope: AgentRolePresetScope;
      readonly preset: T;
    }
  | {
      readonly type: "remove";
      readonly scope: AgentRolePresetScope;
      readonly id: string;
    }
  | {
      readonly type: "reset";
      readonly scope: AgentRolePresetScope;
      readonly id?: string | undefined;
    };

export type AgentRolePresetEdit = PresetEdit<AgentRolePreset>;

const EMPTY_LAYER: PresetLayer<never> = { overrides: {}, removed: [] };

/**
 * Defaults, then the environment's edits, then the project's. A later layer
 * replaces a preset in place, appends a new one, or removes one below it.
 */
export function layerPresets<T extends LayerablePreset>(input: {
  readonly defaults: ReadonlyArray<T>;
  readonly settings: PresetSettings<T>;
  readonly projectId?: ProjectId | undefined;
}): LayeredPresets<T> {
  const presets = new Map<string, LayeredPreset<T>>(
    input.defaults.map((preset) => [preset.id, { preset, source: "default", inherited: false }]),
  );
  const removed = new Map<string, RemovedAgentRolePreset>();
  const apply = (layer: PresetLayer<T>, source: "environment" | "project") => {
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

function layerAt<T>(settings: PresetSettings<T>, scope: AgentRolePresetScope): PresetLayer<T> {
  return scope.type === "environment"
    ? settings.environment
    : (settings.projects[scope.projectId] ?? EMPTY_LAYER);
}

function withLayer<T>(
  settings: PresetSettings<T>,
  scope: AgentRolePresetScope,
  layer: PresetLayer<T>,
): PresetSettings<T> {
  if (scope.type === "environment") return { ...settings, environment: layer };
  const { [scope.projectId]: _replaced, ...projects } = settings.projects;
  // An empty project layer is dropped so settings.json keeps no husk per project.
  const isEmpty = Object.keys(layer.overrides).length === 0 && layer.removed.length === 0;
  return { ...settings, projects: isEmpty ? projects : { ...projects, [scope.projectId]: layer } };
}

/** Whether a layer below `scope` defines `id`, so removing it there needs a tombstone. */
function definedBelow<T extends LayerablePreset>(input: {
  readonly defaults: ReadonlyArray<T>;
  readonly settings: PresetSettings<T>;
  readonly scope: AgentRolePresetScope;
  readonly id: string;
}): boolean {
  if (input.scope.type === "environment") {
    return input.defaults.some((preset) => preset.id === input.id);
  }
  return layerPresets({ defaults: input.defaults, settings: input.settings }).presets.some(
    (entry) => entry.preset.id === input.id,
  );
}

export function applyPresetEdit<T extends LayerablePreset>(input: {
  readonly defaults: ReadonlyArray<T>;
  readonly settings: PresetSettings<T>;
  readonly edit: PresetEdit<T>;
}): PresetSettings<T> {
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

export function layerAgentRolePresets(input: {
  readonly defaults: ReadonlyArray<AgentRolePreset>;
  readonly settings: AgentRolePresetSettings;
  readonly projectId?: ProjectId | undefined;
}): LayeredPresets<AgentRolePreset> {
  return layerPresets(input);
}

export function applyAgentRolePresetEdit(input: {
  readonly defaults: ReadonlyArray<AgentRolePreset>;
  readonly settings: AgentRolePresetSettings;
  readonly edit: AgentRolePresetEdit;
}): AgentRolePresetSettings {
  return applyPresetEdit(input);
}
