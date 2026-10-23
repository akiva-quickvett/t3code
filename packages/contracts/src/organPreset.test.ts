import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { OrganId, OrganLabel, OrganPreset, OrganPresetList } from "./organPreset.ts";
import { ServerSettings, ServerSettingsPatch } from "./settings.ts";

const decodeOrganId = Schema.decodeUnknownSync(OrganId);
const decodeOrganLabel = Schema.decodeUnknownSync(OrganLabel);
const decodeOrganPreset = Schema.decodeUnknownSync(OrganPreset);

const implementation = {
  id: "implementation",
  label: "Implementation",
  goalTemplate: "Build {goal}",
  cells: [{ role: "implementor", count: 1 }],
};

describe("organ preset contracts", () => {
  it("bounds organ ids", () => {
    expect(decodeOrganId(`organ_${"Ab1-_".repeat(6)}Ab`)).toHaveLength(38);
    expect(decodeOrganId("organ_abcdefgh")).toBe("organ_abcdefgh");
    expect(decodeOrganId(`organ_${"a".repeat(64)}`)).toHaveLength(70);
    for (const id of ["organ_x", "foo_abcdefgh", `organ_${"a".repeat(65)}`, "organ_abc+defgh"]) {
      expect(() => decodeOrganId(id)).toThrow();
    }
  });

  it("caps the organ goal at 500 characters", () => {
    const label = { id: "organ_abcdefgh", presetId: "implementation", round: 1 };
    expect(decodeOrganLabel({ ...label, goal: "g".repeat(500) }).goal).toHaveLength(500);
    expect(() => decodeOrganLabel({ ...label, goal: "g".repeat(501) })).toThrow();
  });

  it("bounds cell counts to 1..8 and leaves the target optional", () => {
    expect(decodeOrganPreset(implementation).cells[0]?.target).toBeUndefined();
    expect(
      decodeOrganPreset({ ...implementation, cells: [{ role: "scout", count: 8 }] }).cells[0]
        ?.count,
    ).toBe(8);
    for (const count of [0, 9, 1.5]) {
      expect(() =>
        decodeOrganPreset({ ...implementation, cells: [{ role: "scout", count }] }),
      ).toThrow();
    }
  });

  it("decodes a preset list shaped like the agent role list", () => {
    const list = Schema.decodeSync(OrganPresetList)({
      presets: [{ ...implementation, source: "default", inherited: false }],
      removed: [{ id: "design", label: "Design", removedIn: "environment" }],
    });
    expect(list.presets.map((preset) => preset.id)).toEqual(["implementation"]);
    expect(list.removed[0]?.removedIn).toBe("environment");
  });

  it("defaults the settings layers and keeps them out of the settings patch", () => {
    expect(Schema.decodeSync(ServerSettings)({}).organPresets).toEqual({
      environment: { overrides: {}, removed: [] },
      projects: {},
    });
    expect(Object.keys(ServerSettingsPatch.fields)).not.toContain("organPresets");
    expect(
      Schema.decodeUnknownSync(ServerSettingsPatch)({ organPresets: { projects: {} } }),
    ).not.toHaveProperty("organPresets");
  });
});
