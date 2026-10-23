import { OrganPreset } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_AGENT_ROLE_PRESETS } from "../agentRoles/defaultAgentRolePresets.ts";
import { DEFAULT_ORGAN_PRESETS } from "./defaultOrganPresets.ts";

const decodePreset = Schema.decodeUnknownSync(OrganPreset);
const byId = new Map(DEFAULT_ORGAN_PRESETS.map((preset) => [preset.id, preset]));

const BUILT_INS: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, number]>]> = [
  ["implementation", [["implementor", 1]]],
  [
    "review-t3-council",
    [
      ["review-t3", 1],
      ["review-t3-grok", 1],
      ["scout", 2],
    ],
  ],
  ["scouts", [["scout", 3]]],
  ["research", [["research", 2]]],
];

describe("DEFAULT_ORGAN_PRESETS", () => {
  it("ships exactly the built-in organs, in order", () => {
    expect([...byId.keys()]).toEqual(BUILT_INS.map(([id]) => id));
  });

  it.each(BUILT_INS)("ships %s", (id, cells) => {
    expect(byId.get(id)?.cells.map((cell) => [cell.role, cell.count])).toEqual(cells);
  });

  it("only names built-in roles", () => {
    const roles = new Set(DEFAULT_AGENT_ROLE_PRESETS.map((preset) => preset.id));
    for (const preset of DEFAULT_ORGAN_PRESETS) {
      for (const cell of preset.cells) {
        expect(roles.has(cell.role), `${preset.id} uses ${cell.role}`).toBe(true);
      }
    }
  });

  it("are valid presets", () => {
    for (const preset of DEFAULT_ORGAN_PRESETS) {
      expect(decodePreset(preset)).toEqual(preset);
    }
  });
});
