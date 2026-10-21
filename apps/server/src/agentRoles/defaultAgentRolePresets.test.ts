import { AgentRolePreset } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  getClaudeCatalogModelCapabilities,
} from "../provider/ClaudeModelCatalog.ts";
import { DEFAULT_AGENT_ROLE_PRESETS } from "./defaultAgentRolePresets.ts";

const decodePreset = Schema.decodeUnknownSync(AgentRolePreset);
const byId = new Map(DEFAULT_AGENT_ROLE_PRESETS.map((preset) => [preset.id, preset]));

describe("DEFAULT_AGENT_ROLE_PRESETS", () => {
  it("mirrors orch's roles, without a monitor", () => {
    expect([...byId.keys()]).toEqual([
      "meta",
      "slice",
      "broker",
      "implementor",
      "tester",
      "scout",
      "research",
      "review-t1",
      "review-t2",
      "review-t3",
      "review-t3-grok",
      "review-t4",
      "review-t5",
      "governor",
      "ticket",
      "bugbot",
      "investigator",
    ]);
  });

  it("only lets a role delegate to roles that exist", () => {
    for (const preset of DEFAULT_AGENT_ROLE_PRESETS) {
      for (const child of preset.allowedChildRoles ?? []) {
        expect(byId.has(child), `${preset.id} delegates to ${child}`).toBe(true);
      }
    }
  });

  it("are valid presets", () => {
    for (const preset of DEFAULT_AGENT_ROLE_PRESETS) {
      expect(decodePreset(preset)).toEqual(preset);
    }
  });

  it.each([
    ["implementor", "claude-opus-5-5", "high"],
    ["research", "claude-sonnet-5-5", "high"],
    ["review-t1", "claude-sonnet-5-5", "high"],
    ["review-t3", "claude-opus-5-5", "high"],
    ["review-t4", "claude-opus-5-5", "xhigh"],
    ["review-t5", "claude-opus-5-5", "xhigh"],
    ["governor", "claude-fable-5-1", "high"],
  ])("runs %s on Claude %s at %s effort", (id, model, effort) => {
    const preset = byId.get(id);
    expect(preset?.target).toEqual({
      driverKind: "claudeAgent",
      model,
      options: [{ id: "effort", value: effort }],
    });
    const effortChoices = getClaudeCatalogModelCapabilities(
      BUNDLED_CLAUDE_MODEL_CATALOG,
      model,
    ).optionDescriptors?.find((descriptor) => descriptor.id === "effort");
    expect(
      effortChoices?.type === "select" &&
        effortChoices.options.some((choice) => choice.id === effort),
    ).toBe(true);
  });

  it("runs the second tier 3 reviewer on Grok through Cursor, on the host", () => {
    expect(byId.get("review-t3-grok")).toMatchObject({
      target: {
        driverKind: "cursor",
        model: "grok-4.7",
        options: [{ id: "effort", value: "high" }],
      },
      runsIn: "host",
    });
  });

  it("points reviewers away from editing and the ticket agent at a duplicate check", () => {
    expect(byId.get("review-t2")?.instructions).toContain("Never edit code");
    expect(byId.get("ticket")?.instructions).toContain("duplicates first");
    expect(byId.get("ticket")?.skills).toContain("aman-style");
  });
});
