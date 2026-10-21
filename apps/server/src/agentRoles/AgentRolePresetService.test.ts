import { assert, it } from "@effect/vitest";
import {
  type AgentRolePreset,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentRolePresetService from "./AgentRolePresetService.ts";

const projectId = ProjectId.make("project-1");
const claudeDriver = ProviderDriverKind.make("claudeAgent");

const claudeProvider = (
  instanceId: string,
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: claudeDriver,
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-20T00:00:00.000Z",
  models: [
    {
      slug: "claude-opus-5-5",
      name: "Opus",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select",
            options: [{ id: "high", label: "High" }],
          },
        ],
      },
    },
  ],
  slashCommands: [],
  skills: [],
  ...overrides,
});

const reviewer: AgentRolePreset = {
  id: "reviewer",
  label: "Reviewer",
  target: {
    driverKind: claudeDriver,
    model: "claude-opus-5-5",
    options: [
      { id: "effort", value: "high" },
      { id: "thinking", value: true },
    ],
  },
  instructions: "Never edit code.",
};

const withService = <A, E>(
  providers: ReadonlyArray<ServerProvider>,
  use: (service: AgentRolePresetService.AgentRolePresetService["Service"]) => Effect.Effect<A, E>,
) =>
  AgentRolePresetService.AgentRolePresetService.pipe(
    Effect.flatMap(use),
    Effect.provide(
      AgentRolePresetService.layer.pipe(
        Layer.provide(
          Layer.merge(
            ServerSettings.layerTest(),
            Layer.mock(ProviderRegistry.ProviderRegistry)({
              getProviders: Effect.succeed(providers),
            }),
          ),
        ),
      ),
    ),
  );

it.effect("saves, removes and resets presets per environment and project", () =>
  withService([claudeProvider("claudeAgent")], (service) =>
    Effect.gen(function* () {
      const environment = { type: "environment" } as const;
      const project = { type: "project", projectId } as const;

      const saved = yield* service.save({ scope: environment, preset: reviewer });
      assert.deepInclude(saved.presets.at(-1), { id: "reviewer", source: "environment" });

      const edited = yield* service.save({
        scope: project,
        preset: { ...reviewer, label: "Project reviewer" },
      });
      assert.deepInclude(edited.presets.at(-1), {
        label: "Project reviewer",
        source: "project",
        inherited: true,
      });
      assert.equal((yield* service.list()).presets.at(-1)?.label, "Reviewer");

      const removed = yield* service.remove({ scope: project, id: "scout" });
      assert.isFalse(removed.presets.some((preset) => preset.id === "scout"));
      assert.deepEqual(removed.removed, [{ id: "scout", label: "Scout", removedIn: "project" }]);

      const restored = yield* service.reset({ scope: project, id: "scout" });
      assert.isTrue(restored.presets.some((preset) => preset.id === "scout"));

      yield* service.reset({ scope: project });
      assert.equal((yield* service.list(projectId)).presets.at(-1)?.label, "Reviewer");
      yield* service.reset({ scope: environment });
      assert.isFalse((yield* service.list()).presets.some((preset) => preset.id === "reviewer"));

      const missing = yield* service
        .remove({ scope: environment, id: "reviewer" })
        .pipe(Effect.flip);
      assert.include(missing.message, "reviewer");
    }),
  ),
);

it("resolves a driver target to its first usable instance, keeping offered options only", () => {
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    projectSettingsOverrides: {
      [projectId]: {
        providerInstances: { [ProviderInstanceId.make("claude-work")]: { enabled: false } },
      },
    },
    agentRolePresets: {
      environment: { overrides: { reviewer }, removed: [] },
      projects: {},
    },
  };
  const providers = [
    claudeProvider("claude-off", { enabled: false }),
    claudeProvider("claude-work"),
    // A custom instance id counts as enabled only once configured; the built-in id always does.
    claudeProvider("claudeAgent"),
  ];
  const resolve = (projectOrNone: ProjectId | undefined) =>
    AgentRolePresetService.buildAgentRolePresetList({
      settings,
      providers,
      projectId: projectOrNone,
    }).presets.find((preset) => preset.id === "reviewer");

  assert.deepEqual(resolve(undefined)?.resolvedModelSelection, {
    instanceId: ProviderInstanceId.make("claude-work"),
    model: "claude-opus-5-5",
    options: [{ id: "effort", value: "high" }],
  });
  assert.equal(
    resolve(projectId)?.resolvedModelSelection?.instanceId,
    ProviderInstanceId.make("claudeAgent"),
  );
});

it("says why a preset cannot start", () => {
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    agentRolePresets: {
      environment: {
        overrides: {
          reviewer: { ...reviewer, target: { ...reviewer.target, model: "claude-opus-9" } },
        },
        removed: [],
      },
      projects: {},
    },
  };
  const list = AgentRolePresetService.buildAgentRolePresetList({
    settings,
    providers: [claudeProvider("claudeAgent")],
    projectId: undefined,
  });
  assert.deepEqual(list.presets.find((preset) => preset.id === "reviewer")?.unavailable, {
    kind: "model",
    reason: "claudeAgent does not offer claude-opus-9.",
  });
  assert.deepEqual(list.presets.find((preset) => preset.id === "review-t3-grok")?.unavailable, {
    kind: "provider",
    reason: "No cursor provider is configured.",
  });
});

it("finds a thread's preset by a loosely typed id", () => {
  const settings = DEFAULT_SERVER_SETTINGS;
  assert.equal(
    AgentRolePresetService.findAgentRolePreset({ settings, projectId, id: " Ticket " })?.id,
    "ticket",
  );
  assert.isUndefined(
    AgentRolePresetService.findAgentRolePreset({ settings, projectId, id: "monitor" }),
  );
});
