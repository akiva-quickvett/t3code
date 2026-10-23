import { assert, it } from "@effect/vitest";
import {
  type AgentRolePreset,
  DEFAULT_SERVER_SETTINGS,
  type OrganPreset,
  ProjectId,
  ProviderDriverKind,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerSettingsService from "../serverSettings.ts";
import * as OrganPresetService from "./OrganPresetService.ts";

const projectId = ProjectId.make("project-1");
const otherProjectId = ProjectId.make("project-2");
const environment = { type: "environment" } as const;
const project = { type: "project", projectId } as const;

const scouts = (count: number): OrganPreset => ({
  id: "scouts",
  label: "Scouts",
  goalTemplate: "Scout: {goal}",
  cells: [{ role: "scout", count }],
});

const auditor: AgentRolePreset = {
  id: "auditor",
  label: "Auditor",
  target: {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    model: "claude-opus-5-5",
    options: [],
  },
  instructions: "Audit.",
};

const withService = <A, E>(
  use: (
    service: OrganPresetService.OrganPresetService["Service"],
    settings: ServerSettingsService.ServerSettingsService["Service"],
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const service = yield* OrganPresetService.OrganPresetService;
    const settings = yield* ServerSettingsService.ServerSettingsService;
    return yield* use(service, settings);
  }).pipe(
    Effect.provide(
      OrganPresetService.layer.pipe(Layer.provideMerge(ServerSettingsService.layerTest())),
    ),
  );

const scoutCount = (
  service: OrganPresetService.OrganPresetService["Service"],
  forProject?: ProjectId,
) =>
  service
    .find({ projectId: forProject, id: "scouts" })
    .pipe(Effect.map((found) => [found?.cells[0]?.count, found?.source]));

it.effect("layers the project over the environment over the built-ins", () =>
  withService((service) =>
    Effect.gen(function* () {
      const count = (forProject?: ProjectId) => scoutCount(service, forProject);
      assert.deepEqual(yield* count(), [3, "default"]);

      yield* service.save({ scope: environment, preset: scouts(2) });
      yield* service.save({ scope: project, preset: scouts(4) });

      assert.deepEqual(yield* count(projectId), [4, "project"]);
      assert.deepEqual(yield* count(otherProjectId), [2, "environment"]);
      assert.deepEqual(yield* count(), [2, "environment"]);
      assert.isTrue((yield* service.find({ projectId, id: " Scouts " }))?.inherited);
    }),
  ),
);

it.effect("hides a removed built-in until its layer is reset", () =>
  withService((service) =>
    Effect.gen(function* () {
      const removed = yield* service.remove({ scope: environment, id: "research" });
      assert.isFalse(removed.presets.some((preset) => preset.id === "research"));
      assert.deepEqual(removed.removed, [
        { id: "research", label: "Research", removedIn: "environment" },
      ]);
      assert.isUndefined(yield* service.find({ projectId, id: "research" }));

      const restored = yield* service.reset({ scope: environment, id: "research" });
      assert.deepInclude(
        restored.presets.find((preset) => preset.id === "research"),
        { source: "default", inherited: false },
      );

      const missing = yield* service
        .remove({ scope: environment, id: "nothing" })
        .pipe(Effect.flip);
      assert.include(missing.message, "nothing");
    }),
  ),
);

it.effect("refuses a cell role the scope does not define and leaves settings unchanged", () =>
  withService((service, settings) =>
    Effect.gen(function* () {
      const before = yield* settings.getSettings;
      const error = yield* service
        .save({
          scope: environment,
          preset: { ...scouts(1), cells: [...scouts(1).cells, { role: "ghost", count: 1 }] },
        })
        .pipe(Effect.flip);

      assert.include(error.message, "ghost");
      assert.notInclude(error.message, "scout,");
      assert.deepEqual((yield* settings.getSettings).organPresets, before.organPresets);
    }),
  ),
);

it.effect("accepts a role defined only in the project, at that project's scope", () =>
  withService((service, settings) =>
    Effect.gen(function* () {
      yield* settings.updateAgentRolePresets((current) => ({
        ...current,
        projects: { [projectId]: { overrides: { auditor }, removed: [] } },
      }));
      const audit: OrganPreset = {
        id: "audit",
        label: "Audit",
        goalTemplate: "Audit: {goal}",
        cells: [{ role: "auditor", count: 2 }],
      };

      const refused = yield* service.save({ scope: environment, preset: audit }).pipe(Effect.flip);
      assert.include(refused.message, "auditor");

      const saved = yield* service.save({ scope: project, preset: audit });
      assert.deepInclude(saved.presets.at(-1), {
        id: "audit",
        source: "project",
        inherited: false,
      });
      assert.isUndefined(yield* service.find({ id: "audit" }));
    }),
  ),
);

it.effect("pushes the list only when a settings change alters it", () =>
  Effect.gen(function* () {
    const withRole: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      agentRolePresets: {
        environment: { overrides: { auditor }, removed: [] },
        projects: {},
      },
    };
    const withOrgan: ServerSettings = {
      ...withRole,
      organPresets: {
        environment: { overrides: { scouts: scouts(5) }, removed: [] },
        projects: {},
      },
    };
    const reads = [DEFAULT_SERVER_SETTINGS, withRole, withRole, withOrgan];
    let next = 0;
    const lists = yield* Effect.gen(function* () {
      const service = yield* OrganPresetService.OrganPresetService;
      return yield* service.subscribe().pipe(Stream.runCollect);
    }).pipe(
      Effect.provide(
        OrganPresetService.layer.pipe(
          Layer.provide(
            Layer.mock(ServerSettingsService.ServerSettingsService)({
              getSettings: Effect.sync(() => reads[next++]!),
              subscribeChanges: Effect.succeed(Stream.make(withRole, withRole, withOrgan)),
            }),
          ),
        ),
      ),
    );

    assert.deepEqual(
      Array.from(lists, (list) => list.presets.find((preset) => preset.id === "scouts")?.cells),
      [[{ role: "scout", count: 3 }], [{ role: "scout", count: 5 }]],
    );
  }),
);
