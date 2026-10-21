import {
  type EffectiveAgentRolePreset,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_ROLE_DRAFT,
  draftToPreset,
  presetToDraft,
  roleRowState,
} from "./agentRolesSettings.logic";

const preset: EffectiveAgentRolePreset = {
  id: "review-t3-grok",
  label: "Reviewer (tier 3, Grok)",
  target: {
    driverKind: ProviderDriverKind.make("cursor"),
    model: "grok-4.7",
    options: [{ id: "effort", value: "high" }],
  },
  isolation: "shared",
  runsIn: "host",
  instructions: "Never edit code.",
  skills: ["t3-orchestration"],
  source: "default",
  inherited: false,
  resolvedModelSelection: {
    instanceId: ProviderInstanceId.make("cursor"),
    model: "grok-4.7",
  },
  unavailable: null,
};

describe("role drafts", () => {
  it("round-trip a preset through the editor unchanged", () => {
    const {
      source: _source,
      inherited: _inherited,
      resolvedModelSelection: _resolved,
      unavailable: _unavailable,
      ...stored
    } = preset;
    expect(draftToPreset(presetToDraft(preset))).toEqual({ preset: stored });
  });

  it("pins the preset to the chosen instance when asked", () => {
    const result = draftToPreset({ ...presetToDraft(preset), pinInstance: true });
    expect("preset" in result && result.preset.target).toEqual({
      providerInstanceId: "cursor",
      model: "grok-4.7",
      options: [{ id: "effort", value: "high" }],
    });
  });

  it.each([
    [{ id: "" }, "Give the role an id."],
    [{ id: "Review" }, "Ids are lowercase: a letter, then letters, digits, '-' or '_'."],
    [{ id: "reviewer", label: "" }, "Give the role a label."],
    [{ id: "reviewer", label: "Reviewer", driverKind: "cursor", model: "" }, "Pick a model."],
  ])("explains what blocks saving %j", (patch, error) => {
    expect(draftToPreset({ ...EMPTY_ROLE_DRAFT, ...patch })).toEqual({ error });
  });
});

describe("roleRowState", () => {
  it.each([
    [{ source: "default" as const, inherited: false }, "environment" as const, "Default", false],
    [{ source: "environment" as const, inherited: true }, "environment" as const, "Edited", true],
    [{ source: "environment" as const, inherited: false }, "environment" as const, "Custom", false],
    [
      { source: "environment" as const, inherited: false },
      "project" as const,
      "Environment",
      false,
    ],
    [{ source: "project" as const, inherited: true }, "project" as const, "Edited", true],
  ])("labels %j viewed from the %s layer", (origin, layer, sourceLabel, canReset) => {
    expect(roleRowState({ ...preset, ...origin }, layer)).toEqual({ sourceLabel, canReset });
  });
});
