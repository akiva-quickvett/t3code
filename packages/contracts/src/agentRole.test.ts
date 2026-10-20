import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { AgentRolePreset, AgentRolePresetSettings, ThreadRolePreset } from "./agentRole.ts";
import {
  OrchestratorMcpCreateThreadRequest,
  OrchestratorMcpDelegateTaskInput,
} from "./orchestratorMcp.ts";
import { DEFAULT_SERVER_SETTINGS, ServerSettings } from "./settings.ts";

const decodePreset = Schema.decodeUnknownExit(AgentRolePreset);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const encodeServerSettings = Schema.encodeSync(ServerSettings);

const minimalPreset = {
  id: "review-t1",
  label: "Reviewer",
  target: { driverKind: "claudeAgent", model: "claude-sonnet-5-5" },
  instructions: "Never edit code.",
};

describe("AgentRolePreset", () => {
  it("decodes a minimal preset and defaults its target options", () => {
    const exit = decodePreset(minimalPreset);
    expect(Exit.isSuccess(exit) && exit.value.target.options).toEqual([]);
  });

  it("keeps every optional field", () => {
    const full = {
      ...minimalPreset,
      target: {
        providerInstanceId: "cursor",
        model: "grok-4.7",
        options: [{ id: "effort", value: "high" }],
      },
      runtimeMode: "approval-required",
      interactionMode: "plan",
      isolation: "shared",
      runsIn: "host",
      contextWindow: "200k",
      skills: ["t3-orchestration", "anthropic-skills:docs"],
      allowedChildRoles: ["scout"],
    };
    const exit = decodePreset(full);
    expect(Exit.isSuccess(exit) && exit.value).toEqual(full);
  });

  it.each([
    ["an id that is not a lowercase slug", { ...minimalPreset, id: "Review T1" }],
    ["an id that starts with a digit", { ...minimalPreset, id: "1review" }],
    ["a target without a provider", { ...minimalPreset, target: { model: "x" } }],
    ["an unknown context window", { ...minimalPreset, contextWindow: "500k" }],
    ["instructions over the limit", { ...minimalPreset, instructions: "x".repeat(8_001) }],
  ])("rejects %s", (_, input) => {
    expect(Exit.isFailure(decodePreset(input))).toBe(true);
  });
});

describe("agent role presets in server settings", () => {
  it("default to no edits", () => {
    expect(DEFAULT_SERVER_SETTINGS.agentRolePresets).toEqual({
      environment: { overrides: {}, removed: [] },
      projects: {},
    });
  });

  it("round-trip environment and project layers", () => {
    const agentRolePresets = {
      environment: { overrides: { "review-t1": minimalPreset }, removed: ["governor"] },
      projects: { "project-1": { overrides: {}, removed: ["review-t1"] } },
    };
    const decoded = decodeServerSettings({ agentRolePresets });
    expect(encodeServerSettings(decoded).agentRolePresets).toMatchObject(agentRolePresets);
    expect(Schema.decodeUnknownSync(AgentRolePresetSettings)({})).toEqual(
      DEFAULT_SERVER_SETTINGS.agentRolePresets,
    );
  });
});

describe("preset fields on existing contracts", () => {
  it("are optional, so older callers still decode", () => {
    const delegate = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskInput);
    expect(delegate({ task: "Review" }).preset).toBeUndefined();
    expect(delegate({ task: "Review", role: "review", preset: "Review-T1" })).toMatchObject({
      role: "review",
      preset: "Review-T1",
    });
    expect(
      Schema.decodeUnknownSync(OrchestratorMcpCreateThreadRequest)({ preset: "ticket" }).preset,
    ).toBe("ticket");
  });

  it("record a thread's role as an id and a label snapshot", () => {
    expect(Schema.decodeUnknownSync(ThreadRolePreset)({ id: "ticket", label: "Ticket" })).toEqual({
      id: "ticket",
      label: "Ticket",
    });
  });
});
