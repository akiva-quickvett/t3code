import {
  DEFAULT_PULL_REQUEST_AGENT_LABELS,
  ProjectId,
  READY_FOR_HUMAN_REVIEW_LABEL,
  SourceControlProviderKind,
  ThreadId,
  type OrchestrationV2Command,
  type PullRequestLabelChangeInput,
  type PullRequestSummary,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as PullRequestLabelReactor from "./PullRequestLabelReactor.ts";
import type { WorkTreeNode } from "./pullRequestAgentState.ts";

const PROJECT_ID = ProjectId.make("label-project");
const SLICE = ThreadId.make("slice");
const LINKED_AT = "2026-10-01T00:00:00.000Z";
const LINKED_MS = Date.parse(LINKED_AT);
const NOW_MS = LINKED_MS + 60 * 60_000;

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(1),
  digest: (_algorithm, data) => Effect.succeed(data),
});

function link(overrides: Partial<ThreadPullRequestLink> = {}): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "owner/repo",
    number: 5,
    url: "https://github.com/owner/repo/pull/5",
    source: "manual",
    linkedAt: LINKED_AT,
    snapshot: null,
    stack: null,
    ...overrides,
  };
}

function summary(labels: ReadonlyArray<string>, overrides: Partial<PullRequestSummary> = {}) {
  return {
    provider: SourceControlProviderKind.make("github"),
    projectId: PROJECT_ID,
    repository: "owner/repo",
    number: 5,
    title: "Feature",
    url: "https://github.com/owner/repo/pull/5",
    state: "open",
    isDraft: true,
    headBranch: "feature",
    baseBranch: "main",
    updatedAt: LINKED_AT,
    labels: labels.map((name) => ({ name, color: null })),
    ...overrides,
  } satisfies PullRequestSummary;
}

function observation(
  pullRequest: PullRequestSummary,
  threadLink: ThreadPullRequestLink = link(),
): PullRequestLabelReactor.PullRequestLabelObservation {
  return {
    summary: pullRequest,
    entries: [
      {
        thread: {
          id: SLICE,
          projectId: PROJECT_ID,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: SLICE },
          settledOverride: null,
          settledAt: null,
          pullRequests: [threadLink],
        },
        link: threadLink,
      },
    ],
  };
}

const sliceNode = (overrides: Partial<WorkTreeNode> = {}): WorkTreeNode => ({
  threadId: SLICE,
  parentThreadId: null,
  rolePresetId: null,
  running: false,
  latestRunRequestedAtMs: null,
  latestRunCompletedAtMs: null,
  ...overrides,
});

const building = [
  sliceNode(),
  sliceNode({
    threadId: ThreadId.make("impl"),
    parentThreadId: SLICE,
    running: true,
    latestRunRequestedAtMs: LINKED_MS + 1,
  }),
];
const quietAfterWork = [
  sliceNode({ latestRunRequestedAtMs: LINKED_MS + 1, latestRunCompletedAtMs: LINKED_MS + 2 }),
];

const makeHarness = Effect.fn("makeLabelHarness")(function* (options: {
  readonly nodes: ReadonlyArray<WorkTreeNode>;
  readonly enabled?: boolean;
}) {
  const writes = yield* Ref.make<ReadonlyArray<PullRequestLabelChangeInput>>([]);
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2Command["type"] | string>>([]);
  const layer = PullRequestLabelReactor.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          dispatch: (command) =>
            Ref.update(commands, (recorded) => [...recorded, command.type]).pipe(
              Effect.as({ sequence: 1, storedEvents: [] }),
            ),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getWorkTreeNodes: () => Effect.succeed(options.nodes),
        }),
        Layer.mock(PullRequestService.PullRequestService)({
          setLabels: (input, writeOptions) => {
            assert.isTrue(writeOptions?.background);
            return Ref.update(writes, (recorded) => [...recorded, input]);
          },
        }),
        ServerSettings.ServerSettingsService.layerTest({
          pullRequestLabelRules: { enabled: options.enabled ?? true },
        }),
        Layer.succeed(Crypto.Crypto, testCrypto),
      ),
    ),
  );
  return { writes, commands, layer };
});

const applyWith = (
  harness: Effect.Success<ReturnType<typeof makeHarness>>,
  observations: ReadonlyArray<PullRequestLabelReactor.PullRequestLabelObservation>,
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW_MS);
    const reactor = yield* PullRequestLabelReactor.PullRequestLabelReactor;
    yield* reactor.apply(observations);
  }).pipe(Effect.provide(harness.layer));

describe("PullRequestLabelReactor", () => {
  it.effect("adds the state's label and removes only the other agent labels", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ nodes: building });
      yield* applyWith(harness, [
        observation(
          summary(["bug", READY_FOR_HUMAN_REVIEW_LABEL, "Agent Investigating", "agent done"]),
        ),
      ]);
      assert.deepEqual(yield* Ref.get(harness.writes), [
        {
          projectId: PROJECT_ID,
          repository: "owner/repo",
          number: 5,
          labels: [DEFAULT_PULL_REQUEST_AGENT_LABELS.building],
          applied: true,
        },
        {
          projectId: PROJECT_ID,
          repository: "owner/repo",
          number: 5,
          labels: ["Agent Investigating", "agent done"],
          applied: false,
        },
      ]);
    }),
  );

  it.effect("writes nothing when the pull request already shows the state", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ nodes: building });
      yield* applyWith(harness, [observation(summary(["Agent Building", "bug"]))]);
      assert.deepEqual(yield* Ref.get(harness.writes), []);
    }),
  );

  it.effect("leaves merged and closed pull requests, unlabelled reads and disabled rules", () =>
    Effect.gen(function* () {
      const enabled = yield* makeHarness({ nodes: building });
      yield* applyWith(enabled, [
        observation(summary(["Agent Reviewing"], { state: "merged" })),
        observation(summary(["Agent Reviewing"], { state: "closed" })),
        observation({ ...summary([]), labels: undefined }),
      ]);
      assert.deepEqual(yield* Ref.get(enabled.writes), []);

      const disabled = yield* makeHarness({ nodes: building, enabled: false });
      yield* applyWith(disabled, [observation(summary([]))]);
      assert.deepEqual(yield* Ref.get(disabled.writes), []);
    }),
  );

  it.effect("records the first done before labelling, and only once", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ nodes: quietAfterWork });
      yield* applyWith(harness, [observation(summary(["Agent Building"]))]);
      assert.deepEqual(yield* Ref.get(harness.commands), ["thread.pull-request-link.agent-done"]);
      assert.deepEqual(
        (yield* Ref.get(harness.writes)).map((write) => [write.labels, write.applied]),
        [
          [["Agent Done"], true],
          [["Agent Building"], false],
        ],
      );

      const again = yield* makeHarness({ nodes: quietAfterWork });
      yield* applyWith(again, [
        observation(summary(["Agent Done"]), link({ agentDoneAt: LINKED_AT })),
      ]);
      assert.deepEqual(yield* Ref.get(again.commands), []);
      assert.deepEqual(yield* Ref.get(again.writes), []);
    }),
  );

  it.effect("labels work after the first done as revising", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ nodes: building });
      yield* applyWith(harness, [
        observation(summary(["Agent Done"]), link({ agentDoneAt: LINKED_AT })),
      ]);
      assert.deepEqual(
        (yield* Ref.get(harness.writes)).map((write) => [write.labels, write.applied]),
        [
          [["Agent Revising"], true],
          [["Agent Done"], false],
        ],
      );
    }),
  );
});

describe("agentLabelChange", () => {
  it("matches names without regard to case and never lists a foreign label", () => {
    assert.deepEqual(
      PullRequestLabelReactor.agentLabelChange(DEFAULT_PULL_REQUEST_AGENT_LABELS, "reviewing", [
        "agent reviewing",
        "Agent Building",
        "needs-design",
        READY_FOR_HUMAN_REVIEW_LABEL,
      ]),
      { add: [], remove: ["Agent Building"] },
    );
  });
});
