import {
  type AgentRolePreset,
  type AgentRolePresetSettings,
  ProjectId,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type AgentRolePresetEdit,
  applyAgentRolePresetEdit,
  applyPresetEdit,
  layerAgentRolePresets,
  layerPresets,
  type PresetEdit,
  type PresetSettings,
} from "./agentRolePresetLayers.ts";

const preset = (id: string, label = id): AgentRolePreset => ({
  id,
  label,
  target: {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    model: "claude-opus-5-5",
    options: [],
  },
  instructions: `${label} instructions`,
});

const defaults = [preset("scout"), preset("review-t1")];
const projectId = ProjectId.make("project-1");
const none: AgentRolePresetSettings = {
  environment: { overrides: {}, removed: [] },
  projects: {},
};
const edit = (settings: AgentRolePresetSettings, ...edits: ReadonlyArray<AgentRolePresetEdit>) =>
  edits.reduce(
    (current, next) => applyAgentRolePresetEdit({ defaults, settings: current, edit: next }),
    settings,
  );
const summary = (settings: AgentRolePresetSettings, project?: ProjectId) => {
  const layered = layerAgentRolePresets({ defaults, settings, projectId: project });
  return {
    presets: layered.presets.map((entry) => [entry.preset.label, entry.source, entry.inherited]),
    removed: layered.removed.map((entry) => [entry.id, entry.removedIn]),
  };
};

describe("layerAgentRolePresets", () => {
  it("shows the defaults when nothing was edited", () => {
    expect(summary(none)).toEqual({
      presets: [
        ["scout", "default", false],
        ["review-t1", "default", false],
      ],
      removed: [],
    });
  });

  it("applies the environment and then the project, in place", () => {
    const settings = edit(
      none,
      { type: "save", scope: { type: "environment" }, preset: preset("scout", "Env scout") },
      { type: "save", scope: { type: "environment" }, preset: preset("ticket", "Ticket") },
      {
        type: "save",
        scope: { type: "project", projectId },
        preset: preset("scout", "Project scout"),
      },
      { type: "remove", scope: { type: "project", projectId }, id: "review-t1" },
    );
    expect(summary(settings)).toEqual({
      presets: [
        ["Env scout", "environment", true],
        ["review-t1", "default", false],
        ["Ticket", "environment", false],
      ],
      removed: [],
    });
    expect(summary(settings, projectId)).toEqual({
      presets: [
        ["Project scout", "project", true],
        ["Ticket", "environment", false],
      ],
      removed: [["review-t1", "project"]],
    });
  });
});

describe("applyAgentRolePresetEdit", () => {
  const environment = { type: "environment" } as const;

  it("resets one preset back to the layer below", () => {
    const settings = edit(
      none,
      { type: "save", scope: environment, preset: preset("scout", "Edited") },
      { type: "reset", scope: environment, id: "scout" },
    );
    expect(settings).toEqual(none);
  });

  it("tombstones a removed default so a reset brings it back", () => {
    const removed = edit(none, { type: "remove", scope: environment, id: "scout" });
    expect(removed.environment).toEqual({ overrides: {}, removed: ["scout"] });
    expect(summary(removed).removed).toEqual([["scout", "environment"]]);
    expect(edit(removed, { type: "reset", scope: environment, id: "scout" })).toEqual(none);
  });

  it("deletes a preset added at the layer without leaving a tombstone", () => {
    const settings = edit(
      none,
      { type: "save", scope: environment, preset: preset("ticket") },
      { type: "remove", scope: environment, id: "ticket" },
    );
    expect(settings).toEqual(none);
  });

  it("saving a removed preset again lifts its tombstone", () => {
    const settings = edit(
      none,
      { type: "remove", scope: environment, id: "scout" },
      { type: "save", scope: environment, preset: preset("scout", "Back") },
    );
    expect(settings.environment).toEqual({
      overrides: { scout: preset("scout", "Back") },
      removed: [],
    });
  });

  it("resets a whole layer and drops an emptied project entry", () => {
    const project = { type: "project", projectId } as const;
    const settings = edit(
      none,
      { type: "save", scope: environment, preset: preset("ticket") },
      { type: "save", scope: project, preset: preset("scout", "Project") },
      { type: "remove", scope: project, id: "review-t1" },
    );
    expect(edit(settings, { type: "reset", scope: project })).toEqual(
      edit(none, { type: "save", scope: environment, preset: preset("ticket") }),
    );
    expect(edit(settings, { type: "reset", scope: environment }).environment).toEqual(
      none.environment,
    );
  });
});

describe("layerPresets", () => {
  interface Shelf {
    readonly id: string;
    readonly label: string;
    readonly slots: number;
  }
  const shelf = (id: string, slots: number): Shelf => ({ id, label: id, slots });
  const shelves = [shelf("small", 1), shelf("large", 4)];
  const empty: PresetSettings<Shelf> = {
    environment: { overrides: {}, removed: [] },
    projects: {},
  };

  it("layers any preset with an id and a label like role presets", () => {
    const settings = [
      { type: "save", scope: { type: "environment" }, preset: shelf("large", 6) },
      { type: "save", scope: { type: "project", projectId }, preset: shelf("large", 8) },
      { type: "remove", scope: { type: "environment" }, id: "small" },
    ] satisfies ReadonlyArray<PresetEdit<Shelf>>;
    const edited = settings.reduce(
      (current, next) => applyPresetEdit({ defaults: shelves, settings: current, edit: next }),
      empty,
    );
    const slots = (project?: ProjectId) =>
      layerPresets({ defaults: shelves, settings: edited, projectId: project }).presets.map(
        (entry) => [entry.preset.id, entry.preset.slots, entry.source],
      );

    expect(slots()).toEqual([["large", 6, "environment"]]);
    expect(slots(projectId)).toEqual([["large", 8, "project"]]);
    expect(layerPresets({ defaults: shelves, settings: edited }).removed).toEqual([
      { id: "small", label: "small", removedIn: "environment" },
    ]);
    expect(
      applyPresetEdit({
        defaults: shelves,
        settings: edited,
        edit: { type: "reset", scope: { type: "environment" } },
      }).environment,
    ).toEqual(empty.environment);
  });
});
