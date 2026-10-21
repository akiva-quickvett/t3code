import { ThreadId, type PullRequestAgentState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_DONE_SETTLE_MS,
  deriveAgentState,
  workTreeOf,
  type WorkTreeNode,
} from "./pullRequestAgentState.ts";

const LINKED = 1_000_000;
const BEFORE = LINKED - 60_000;
const AFTER = LINKED + 60_000;
const NOW = AFTER + 10 * 60_000;

const node = (id: string, overrides: Partial<WorkTreeNode> = {}): WorkTreeNode => ({
  threadId: ThreadId.make(id),
  parentThreadId: id === "slice" ? null : ThreadId.make("slice"),
  rolePresetId: null,
  running: false,
  latestRunRequestedAtMs: null,
  latestRunCompletedAtMs: null,
  ...overrides,
});

const slice = (overrides: Partial<WorkTreeNode> = {}) => node("slice", overrides);
const idleWork = { latestRunRequestedAtMs: AFTER, latestRunCompletedAtMs: AFTER };
const runningWork = { running: true, latestRunRequestedAtMs: AFTER };

describe("deriveAgentState", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly tree: ReadonlyArray<WorkTreeNode>;
    readonly doneBefore?: boolean;
    readonly nowMs?: number;
    readonly expected: PullRequestAgentState | null;
  }> = [
    { name: "linked, nothing run since", tree: [slice()], expected: "investigating" },
    {
      name: "the turn that linked it is still running",
      tree: [slice({ running: true, latestRunRequestedAtMs: BEFORE })],
      expected: "investigating",
    },
    {
      name: "a child started after the link",
      tree: [slice(), node("impl", runningWork)],
      expected: "building",
    },
    {
      name: "a reviewer is running",
      tree: [slice(), node("review", { ...runningWork, rolePresetId: "review-t3" })],
      expected: "reviewing",
    },
    {
      name: "a reviewer and an implementor are running",
      tree: [
        slice(runningWork),
        node("impl", runningWork),
        node("review", { ...runningWork, rolePresetId: "review-t3-grok" }),
      ],
      expected: "reviewing",
    },
    {
      name: "the tree went quiet a moment ago",
      tree: [slice(idleWork), node("impl", idleWork)],
      nowMs: AFTER + AGENT_DONE_SETTLE_MS - 1,
      expected: null,
    },
    {
      name: "the tree has been quiet since its work",
      tree: [slice(idleWork), node("impl", idleWork)],
      expected: "done",
    },
    {
      name: "work after the first done",
      tree: [slice(idleWork), node("impl", runningWork)],
      doneBefore: true,
      expected: "revising",
    },
    {
      name: "review after the first done",
      tree: [slice(), node("review", { ...runningWork, rolePresetId: "review-t1" })],
      doneBefore: true,
      expected: "reviewing",
    },
    {
      name: "quiet again after revising",
      tree: [slice(idleWork)],
      doneBefore: true,
      expected: "done",
    },
    {
      name: "a role that only starts with review is not a reviewer",
      tree: [slice(), node("rev", { ...runningWork, rolePresetId: "reviewer-bot" })],
      expected: "building",
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(
        deriveAgentState({
          tree: testCase.tree,
          linkedAtMs: LINKED,
          doneBefore: testCase.doneBefore ?? false,
          nowMs: testCase.nowMs ?? NOW,
        }),
      ).toBe(testCase.expected);
    });
  }
});

describe("workTreeOf", () => {
  it("collects supervised and delegated descendants, not siblings or ancestors", () => {
    const nodes = [
      node("meta", { parentThreadId: null }),
      slice({ parentThreadId: ThreadId.make("meta") }),
      node("broker"),
      node("impl", { parentThreadId: ThreadId.make("broker") }),
      node("other", { parentThreadId: ThreadId.make("meta") }),
    ];
    expect(
      workTreeOf(ThreadId.make("slice"), nodes)
        .map((entry) => entry.threadId)
        .toSorted(),
    ).toEqual(["broker", "impl", "slice"]);
  });
});
