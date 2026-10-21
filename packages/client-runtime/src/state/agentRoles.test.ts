import {
  type AgentRolePresetList,
  type EffectiveAgentRolePreset,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  createRolePresetLabelsAtomFamily,
  rolePresetDraftChoice,
  rolePresetLabelsKey,
  threadRoleBadge,
} from "./agentRoles.ts";

const environmentId = EnvironmentId.make("env");
const projectId = ProjectId.make("project");

const preset = (overrides: Partial<EffectiveAgentRolePreset> = {}): EffectiveAgentRolePreset => ({
  id: "scout",
  label: "Scout",
  target: {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    model: "claude-sonnet-5-5",
    options: [],
  },
  instructions: "Return distilled results.",
  source: "default",
  inherited: false,
  resolvedModelSelection: {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-sonnet-5-5",
    options: [{ id: "effort", value: "high" }],
  },
  unavailable: null,
  ...overrides,
});

describe("threadRoleBadge", () => {
  it("shows nothing for a thread without a role", () => {
    expect(threadRoleBadge(null, new Map())).toBeNull();
    expect(threadRoleBadge(undefined, null)).toBeNull();
  });

  it("follows a renamed preset and keeps the snapshot of a removed one, as missing", () => {
    const role = { id: "scout", label: "Scout" };
    expect(threadRoleBadge(role, new Map([["scout", "Field scout"]]))).toEqual({
      label: "Field scout",
      missing: false,
    });
    expect(threadRoleBadge(role, new Map())).toEqual({ label: "Scout", missing: true });
  });

  it("never calls a role missing before the presets load", () => {
    expect(threadRoleBadge({ id: "scout", label: "Scout" }, null)).toEqual({
      label: "Scout",
      missing: false,
    });
  });
});

describe("rolePresetDraftChoice", () => {
  it("takes the server's resolved model and the preset's modes", () => {
    expect(
      rolePresetDraftChoice(preset({ runtimeMode: "approval-required", interactionMode: "plan" })),
    ).toEqual({
      rolePreset: { id: "scout", label: "Scout" },
      modelSelection: {
        instanceId: "claudeAgent",
        model: "claude-sonnet-5-5",
        options: [{ id: "effort", value: "high" }],
      },
      runtimeMode: "approval-required",
      interactionMode: "plan",
    });
  });

  it("keeps the draft's model when nothing can run the preset", () => {
    expect(
      rolePresetDraftChoice(
        preset({
          resolvedModelSelection: null,
          unavailable: { kind: "provider", reason: "No claudeAgent provider is configured." },
        }),
      ),
    ).toEqual({ rolePreset: { id: "scout", label: "Scout" } });
  });
});

describe("createRolePresetLabelsAtomFamily", () => {
  it("re-emits only when a label or id changes, not on availability changes", () => {
    const live = Atom.make<AsyncResult.AsyncResult<AgentRolePresetList, unknown>>(
      AsyncResult.initial(),
    );
    const labelsFamily = createRolePresetLabelsAtomFamily(() => live);
    const labels = labelsFamily(rolePresetLabelsKey(environmentId, projectId));
    const registry = AtomRegistry.make();
    const seen: Array<unknown> = [];
    const unsubscribe = registry.subscribe(labels, (value) => seen.push(value), {
      immediate: true,
    });

    registry.set(live, AsyncResult.success({ presets: [preset()], removed: [] }));
    registry.set(
      live,
      AsyncResult.success({
        presets: [
          preset({
            resolvedModelSelection: null,
            unavailable: { kind: "provider", reason: "Signed out." },
          }),
        ],
        removed: [],
      }),
    );
    registry.set(
      live,
      AsyncResult.success({ presets: [preset({ label: "Field scout" })], removed: [] }),
    );

    expect(seen).toEqual([
      null,
      new Map([["scout", "Scout"]]),
      new Map([["scout", "Field scout"]]),
    ]);
    unsubscribe();
    registry.dispose();
  });
});
