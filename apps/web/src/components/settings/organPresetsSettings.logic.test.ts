import { type EffectiveOrganPreset, ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_ORGAN_DRAFT,
  clampCellCount,
  missingCellRoles,
  organDraftToPreset,
  organPresetToDraft,
  organRowState,
} from "./organPresetsSettings.logic";

const council: EffectiveOrganPreset = {
  id: "review-t3-council",
  label: "Review council",
  goalTemplate: "Review {goal}",
  cells: [
    { role: "review-t3", count: 1 },
    {
      role: "review-t3-grok",
      count: 1,
      target: { driverKind: ProviderDriverKind.make("cursor"), model: "grok-4.7", options: [] },
    },
    { role: "scout", count: 2 },
  ],
  source: "environment",
  inherited: true,
};

describe("organ draft", () => {
  it("round-trips a preset, targets included", () => {
    const { source: _source, inherited: _inherited, ...preset } = council;
    expect(organDraftToPreset(organPresetToDraft(council))).toEqual({ preset });
  });

  it("clamps a cell count to 1..8", () => {
    expect([0, -3, 1, 4.4, 8, 9, 100, Number.NaN].map(clampCellCount)).toEqual([
      1, 1, 1, 4, 8, 8, 8, 1,
    ]);
    const draft = { ...organPresetToDraft(council), cells: [{ role: "scout", count: 12 }] };
    const decoded = organDraftToPreset(draft);
    expect("preset" in decoded && decoded.preset.cells[0]?.count).toBe(8);
  });

  it("says what a new draft is missing", () => {
    expect(organDraftToPreset(EMPTY_ORGAN_DRAFT)).toEqual({ error: "Give the organ an id." });
    expect(organDraftToPreset({ ...EMPTY_ORGAN_DRAFT, id: "x", label: "X" })).toEqual({
      error: "Pick each cell's role.",
    });
  });
});

describe("missingCellRoles", () => {
  const draft = {
    ...EMPTY_ORGAN_DRAFT,
    cells: [
      { role: "planner", count: 1 },
      { role: "scout", count: 2 },
      { role: "", count: 1 },
    ],
  };

  it("flags roles the scope does not define", () => {
    expect([...missingCellRoles(draft, new Set(["scout"]))]).toEqual(["planner"]);
  });

  it("flags nothing until the roles load", () => {
    expect(missingCellRoles(draft, null).size).toBe(0);
  });
});

describe("organRowState", () => {
  const environment = { type: "environment" } as const;

  it("removes an override by resetting it, so the layer below shows again", () => {
    expect(organRowState(council, "environment", environment)).toEqual({
      sourceLabel: "Edited",
      removeOverride: { scope: environment, id: "review-t3-council" },
    });
  });

  it("offers no override removal where nothing below defines the preset", () => {
    expect(
      organRowState({ ...council, inherited: false }, "environment", environment).removeOverride,
    ).toBeNull();
    expect(
      organRowState(
        { ...council, source: "default", inherited: false },
        "environment",
        environment,
      ),
    ).toEqual({ sourceLabel: "Built-in", removeOverride: null });
  });

  it("leaves an environment override alone from a project", () => {
    const project = { type: "project", projectId: "p" } as never;
    expect(organRowState(council, "project", project)).toEqual({
      sourceLabel: "Environment",
      removeOverride: null,
    });
  });
});
