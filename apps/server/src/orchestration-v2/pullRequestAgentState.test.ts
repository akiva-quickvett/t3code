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
  const DONE_AT = AFTER + 60_000;
  const reviewer = (overrides: Partial<WorkTreeNode>) =>
    node("review", { rolePresetId: "review-t3", ...overrides });
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly tree: ReadonlyArray<WorkTreeNode>;
    readonly doneAtMs?: number;
    readonly nowMs?: number;
    readonly expected: PullRequestAgentState | null;
    readonly recordDone?: boolean;
  }> = [
    { name: "linked, nothing run since", tree: [slice()], expected: "investigating" },
    {
      name: "the turn that linked it is still running",
      tree: [slice({ running: true, latestRunRequestedAtMs: BEFORE })],
      expected: "investigating",
    },
    {
      name: "built and opened in one turn that has ended",
      tree: [slice({ latestRunRequestedAtMs: BEFORE, latestRunCompletedAtMs: AFTER })],
      expected: "done",
      recordDone: false,
    },
    {
      name: "the linking turn ended a moment ago",
      tree: [slice({ latestRunRequestedAtMs: BEFORE, latestRunCompletedAtMs: AFTER })],
      nowMs: AFTER + AGENT_DONE_SETTLE_MS - 1,
      expected: null,
    },
    {
      name: "a child started after the link",
      tree: [slice(), node("impl", runningWork)],
      expected: "building",
    },
    {
      name: "a reviewer is running",
      tree: [slice(), reviewer(runningWork)],
      expected: "reviewing",
    },
    {
      name: "fixes between review rounds stay reviewing",
      tree: [slice(), node("impl", runningWork), reviewer(idleWork)],
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
      recordDone: true,
    },
    {
      name: "a run that ended without a completion time counts from its request",
      tree: [slice({ latestRunRequestedAtMs: AFTER })],
      expected: "done",
      recordDone: true,
    },
    {
      name: "work after the first done",
      tree: [slice(idleWork), node("impl", { running: true, latestRunRequestedAtMs: DONE_AT + 1 })],
      doneAtMs: DONE_AT,
      expected: "revising",
    },
    {
      name: "a review from before the first done does not make revising a review",
      tree: [
        reviewer(idleWork),
        node("impl", { running: true, latestRunRequestedAtMs: DONE_AT + 1 }),
      ],
      doneAtMs: DONE_AT,
      expected: "revising",
    },
    {
      name: "review after the first done",
      tree: [slice(), reviewer({ running: true, latestRunRequestedAtMs: DONE_AT + 1 })],
      doneAtMs: DONE_AT,
      expected: "reviewing",
    },
    {
      name: "done after a revision records it again",
      tree: [slice({ latestRunRequestedAtMs: DONE_AT + 1, latestRunCompletedAtMs: DONE_AT + 2 })],
      doneAtMs: DONE_AT,
      expected: "done",
      recordDone: true,
    },
    {
      name: "done with nothing new since the last done records nothing",
      tree: [slice(idleWork)],
      doneAtMs: DONE_AT,
      expected: "done",
      recordDone: false,
    },
    {
      name: "the second revision starts as revising, not with the first revision's review",
      tree: [
        slice(),
        reviewer({ latestRunRequestedAtMs: DONE_AT + 1, latestRunCompletedAtMs: DONE_AT + 2 }),
        node("impl", { running: true, latestRunRequestedAtMs: DONE_AT + 10 }),
      ],
      doneAtMs: DONE_AT + 5,
      expected: "revising",
    },
    {
      name: "a role that only starts with review is not a reviewer",
      tree: [slice(), node("rev", { ...runningWork, rolePresetId: "reviewer-bot" })],
      expected: "building",
    },
  ];

  it.each(cases)("$name", (testCase) => {
    const result = deriveAgentState({
      tree: testCase.tree,
      linkedAtMs: LINKED,
      doneAtMs: testCase.doneAtMs ?? null,
      nowMs: testCase.nowMs ?? NOW,
    });
    expect(result?.state ?? null).toBe(testCase.expected);
    if (testCase.recordDone !== undefined) expect(result?.recordDone).toBe(testCase.recordDone);
  });
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
