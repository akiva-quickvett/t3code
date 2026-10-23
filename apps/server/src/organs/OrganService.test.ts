import { assert, describe, it } from "@effect/vitest";
import {
  type AgentRolePreset,
  DEFAULT_SERVER_SETTINGS,
  type OrganLabel,
  ProjectId,
  ProviderDriverKind,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { DEFAULT_AGENT_ROLE_PRESETS } from "../agentRoles/defaultAgentRolePresets.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as OrganService from "./OrganService.ts";

const projectId = ProjectId.make("project-organs");
const namespace = "provider-session-1";

function rolePreset(id: string, allowedChildRoles?: ReadonlyArray<string>): AgentRolePreset {
  const preset = DEFAULT_AGENT_ROLE_PRESETS.find((candidate) => candidate.id === id);
  if (preset === undefined) throw new Error(`No built-in role ${id}.`);
  const { allowedChildRoles: _builtIn, ...rest } = preset;
  return allowedChildRoles === undefined ? rest : { ...rest, allowedChildRoles };
}

// Starters get their allowed child roles from these overrides, never from the
// built-in lists, which may change independently of the enforcement rule.
function withEnvironmentRoles(...presets: ReadonlyArray<AgentRolePreset>): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    agentRolePresets: {
      environment: {
        overrides: Object.fromEntries(presets.map((preset) => [preset.id, preset])),
        removed: [],
      },
      projects: {},
    },
  };
}

const start = (
  settings: ServerSettings,
  input: Partial<OrganService.OrganStartInput> & { readonly presetId: string },
) =>
  OrganService.planOrganStart(settings, {
    starter: { projectId },
    goal: "Ship the organ start.",
    subagents: [],
    requestNamespace: namespace,
    requestKey: "key-1",
    ...input,
  });

const isRefusal = Schema.is(OrganService.OrganRefusal);

const plan = (result: OrganService.OrganStartPlan | OrganService.OrganRefusal) => {
  if (isRefusal(result)) return assert.fail(result.message);
  return result;
};

const refusal = (result: unknown) => {
  if (!isRefusal(result)) return assert.fail("Expected a refusal.");
  return result.message;
};

describe("planOrganStart", () => {
  it("expands a preset's cells and labels round 1", () => {
    const settings = withEnvironmentRoles(rolePreset("broker", ["implementor"]));
    const result = plan(
      start(settings, {
        presetId: "implementation",
        starter: { projectId, rolePreset: { id: "broker" } },
      }),
    );
    assert.deepStrictEqual(
      result.cells.map((cell) => [cell.index, cell.role]),
      [[0, "implementor"]],
    );
    assert.strictEqual(result.cells[0]?.prompt, "Implement: Ship the organ start.");
    assert.deepStrictEqual(result.organ, {
      id: OrganService.mintOrganId(namespace, "key-1"),
      presetId: "implementation",
      goal: "Ship the organ start.",
      round: 1,
    });
  });

  it("expands counts across cells in order", () => {
    const settings = withEnvironmentRoles(
      rolePreset("slice", ["review-t3", "review-t3-grok", "scout"]),
    );
    const result = plan(
      start(settings, {
        presetId: "review-t3-council",
        starter: { projectId, rolePreset: { id: "slice" } },
      }),
    );
    assert.deepStrictEqual(
      result.cells.map((cell) => [cell.index, cell.role]),
      [
        [0, "review-t3"],
        [1, "review-t3-grok"],
        [2, "scout"],
        [3, "scout"],
      ],
    );
  });

  it("replaces the preset's cells with per-call cells", () => {
    const target = { driverKind: ProviderDriverKind.make("codex"), model: "gpt-test" };
    const result = plan(
      start(DEFAULT_SERVER_SETTINGS, {
        presetId: "scouts",
        cells: [
          { role: "Scout", count: 2, target: { ...target } },
          { role: "research", count: 1 },
        ],
      }),
    );
    assert.deepStrictEqual(
      result.cells.map(({ index, role, target }) => ({ index, role, target })),
      [
        { index: 0, role: "scout", target },
        { index: 1, role: "scout", target },
        { index: 2, role: "research", target: undefined },
      ],
    );
  });

  it("names the starter's role, its layer and the missing child role", () => {
    const settings = withEnvironmentRoles(rolePreset("slice", ["broker", "scout"]));
    const message = refusal(
      start(settings, {
        presetId: "implementation",
        starter: { projectId, rolePreset: { id: "slice" } },
      }),
    );
    assert.strictEqual(
      message,
      "Role `slice` (defined in the environment layer) can't start `implementor`; add it to its allowed child roles.",
    );
    assert.include(
      refusal(
        start(withEnvironmentRoles(rolePreset("broker", ["implementor"])), {
          presetId: "scouts",
          starter: { projectId, rolePreset: { id: "broker" } },
        }),
      ),
      "can't start `scout`",
    );
  });

  it("names the project layer when the project overrides the starter's role", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      agentRolePresets: {
        environment: { overrides: {}, removed: [] },
        projects: {
          [projectId]: { overrides: { broker: rolePreset("broker", ["tester"]) }, removed: [] },
        },
      },
    };
    assert.include(
      refusal(
        start(settings, {
          presetId: "implementation",
          starter: { projectId, rolePreset: { id: "broker" } },
        }),
      ),
      "(defined in the project layer) can't start `implementor`",
    );
  });

  it("does not restrict starters without a role, with a removed role, or without a list", () => {
    const removed: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      agentRolePresets: {
        environment: { overrides: {}, removed: ["slice"] },
        projects: {},
      },
    };
    const unlisted = withEnvironmentRoles(rolePreset("slice"));
    for (const [settings, starter] of [
      [DEFAULT_SERVER_SETTINGS, { projectId }],
      [DEFAULT_SERVER_SETTINGS, { projectId, rolePreset: null }],
      [removed, { projectId, rolePreset: { id: "slice" } }],
      [unlisted, { projectId, rolePreset: { id: "slice" } }],
    ] as const) {
      assert.strictEqual(
        plan(start(settings, { presetId: "implementation", starter })).cells.length,
        1,
      );
    }
  });

  it("refuses cell roles that do not exist, even for an unrestricted starter", () => {
    assert.include(
      refusal(start(DEFAULT_SERVER_SETTINGS, { presetId: "scouts", cells: [{ role: "ghost" }] })),
      "`ghost` is not defined",
    );
  });

  it("refuses an unknown preset", () => {
    assert.include(
      refusal(start(DEFAULT_SERVER_SETTINGS, { presetId: "nope" })),
      'Unknown organ preset "nope"',
    );
  });

  it("caps the label's goal at 500 characters but sends the full goal", () => {
    const goal = "g".repeat(600);
    const result = plan(start(DEFAULT_SERVER_SETTINGS, { presetId: "scouts", goal }));
    assert.strictEqual(result.organ.goal.length, 500);
    assert.isTrue(result.organ.goal.endsWith("…"));
    assert.isTrue(result.cells.every((cell) => cell.prompt === `Scout: ${goal}`));
  });
});

describe("planOrganStart on a retry", () => {
  const organ = {
    id: OrganService.mintOrganId(namespace, "key-1"),
    presetId: "scouts",
    goal: "Ship the organ start.",
    round: 1,
  };

  it("refuses a key that already started a different organ", () => {
    assert.strictEqual(
      refusal(start(DEFAULT_SERVER_SETTINGS, { presetId: "research", subagents: [{ organ }] })),
      `clientRequestId \`key-1\` already started organ \`${organ.id}\` for a different preset or goal (preset \`scouts\`); use a new clientRequestId.`,
    );
    assert.include(
      refusal(
        start(DEFAULT_SERVER_SETTINGS, {
          presetId: "scouts",
          goal: "Another goal.",
          subagents: [{ organ }],
        }),
      ),
      "already started organ",
    );
  });

  it("names the organ when its preset was removed after it started", () => {
    const removed: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      organPresets: { environment: { overrides: {}, removed: ["scouts"] }, projects: {} },
    };
    assert.include(
      refusal(start(removed, { presetId: "scouts", subagents: [{ organ }] })),
      `organ \`${organ.id}\` cannot resume`,
    );
    assert.include(
      refusal(start(removed, { presetId: "scouts" })),
      'Unknown organ preset "scouts"',
    );
  });

  it("matches a replayed cell by its role, number and full goal", () => {
    const cell = { index: 1, role: "scout" };
    const goal = "x".repeat(600);
    const record = { title: "scout 2: xxx...", prompt: `Scout: ${goal}` };
    assert.strictEqual(OrganService.replayedCellMatches(cell, goal, record), "match");
    assert.strictEqual(
      OrganService.replayedCellMatches({ ...cell, role: "research" }, goal, record),
      "cells",
    );
    assert.strictEqual(
      OrganService.replayedCellMatches(cell, `${"x".repeat(599)}y`, record),
      "goal",
    );
  });

  it("refuses cells one by one once the organ started, instead of the whole call", () => {
    const settings = withEnvironmentRoles(rolePreset("broker", ["implementor"]));
    const starter = { projectId, rolePreset: { id: "broker" } };
    assert.include(refusal(start(settings, { presetId: "scouts", starter })), "can't start");
    const retried = plan(start(settings, { presetId: "scouts", starter, subagents: [{ organ }] }));
    assert.lengthOf(retried.cells, 3);
    assert.isTrue(retried.cells.every((cell) => cell.refusal?.includes("can't start `scout`")));
    const fresh = plan(start(DEFAULT_SERVER_SETTINGS, { presetId: "scouts" }));
    assert.isTrue(fresh.cells.every((cell) => cell.refusal === undefined));
  });
});

describe("cell prompts, titles and labels", () => {
  it("sends the goal verbatim, replacement patterns included", () => {
    const goal = "Keep $& and $' and $` and $$ as typed.";
    assert.strictEqual(
      plan(start(DEFAULT_SERVER_SETTINGS, { presetId: "scouts", goal })).cells[0]?.prompt,
      `Scout: ${goal}`,
    );
  });

  it("gives each cell a distinct, bounded title", () => {
    const titles = plan(
      start(DEFAULT_SERVER_SETTINGS, { presetId: "scouts", goal: "Map\nthe  path. ".repeat(20) }),
    ).cells.map((cell) => cell.title);
    assert.strictEqual(new Set(titles).size, 3);
    assert.isTrue(titles.every((title) => title.length <= 80 && !title.includes("\n")));
    assert.isTrue(titles[0]?.startsWith("scout 1: Map the path."));
  });

  it("does not split a surrogate pair at the label cut", () => {
    const goal = `${"g".repeat(498)}😀${"g".repeat(100)}`;
    const label = OrganService.organGoalLabel(goal);
    assert.strictEqual(label, `${"g".repeat(498)}…`);
  });
});

describe("mintOrganId", () => {
  it("is stable for a key and distinct across keys and sessions", () => {
    const id = OrganService.mintOrganId(namespace, "review-1");
    assert.match(id, /^organ_[A-Za-z0-9_-]{32}$/);
    assert.strictEqual(OrganService.mintOrganId(namespace, "review-1"), id);
    assert.notStrictEqual(OrganService.mintOrganId(namespace, "review-2"), id);
    assert.notStrictEqual(OrganService.mintOrganId("provider-session-2", "review-1"), id);
  });
});

describe("planOrganRound", () => {
  const organ: OrganLabel = {
    id: OrganService.mintOrganId(namespace, "key-1"),
    presetId: "implementation",
    goal: "Ship it.",
    round: 1,
  };
  const subagents = [{}, { organ }, { organ: { ...organ, round: 2 } }];

  it("copies the organ and defaults the round to the next one", () => {
    const result = OrganService.planOrganRound(DEFAULT_SERVER_SETTINGS, {
      starter: { projectId },
      subagents,
      organ: { id: organ.id },
      role: "review-t1",
    });
    assert.deepStrictEqual(result, { ...organ, round: 3 });
  });

  it("keeps an explicit round", () => {
    const result = OrganService.planOrganRound(DEFAULT_SERVER_SETTINGS, {
      starter: { projectId },
      subagents,
      organ: { id: organ.id, round: 2 },
      role: "implementor",
    });
    assert.deepStrictEqual(result, { ...organ, round: 2 });
  });

  it("refuses an organ that is not on the starter's records", () => {
    assert.include(
      refusal(
        OrganService.planOrganRound(DEFAULT_SERVER_SETTINGS, {
          starter: { projectId },
          subagents,
          organ: { id: OrganService.mintOrganId(namespace, "other") },
          role: "implementor",
        }),
      ),
      "was not started by this thread",
    );
  });

  it("enforces the starter's allowed child roles", () => {
    const settings = withEnvironmentRoles(rolePreset("broker", ["implementor"]));
    assert.include(
      refusal(
        OrganService.planOrganRound(settings, {
          starter: { projectId, rolePreset: { id: "broker" } },
          subagents,
          organ: { id: organ.id },
          role: "scout",
        }),
      ),
      "Role `broker` (defined in the environment layer) can't start `scout`",
    );
  });
});

describe("OrganService", () => {
  it.effect("plans from the current settings", () =>
    Effect.gen(function* () {
      const service = yield* OrganService.OrganService;
      const started = yield* service.planStart({
        starter: { projectId },
        presetId: "research",
        goal: "Compare.",
        subagents: [],
        requestNamespace: namespace,
        requestKey: "key-1",
      });
      assert.strictEqual(started.cells.length, 2);
      const failure = yield* service
        .planStart({
          starter: { projectId },
          presetId: "missing",
          goal: "Compare.",
          subagents: [],
          requestNamespace: namespace,
          requestKey: "key-1",
        })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "OrganRefusal");
    }).pipe(
      Effect.provide(OrganService.layer.pipe(Layer.provide(ServerSettingsService.layerTest()))),
    ),
  );
});
