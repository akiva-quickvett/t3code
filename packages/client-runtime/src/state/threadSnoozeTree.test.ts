import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { agentTreeDescendants } from "./threadRelationships.ts";
import {
  isSettlePending,
  threadHasActiveWork,
  threadHasSettleBlocker,
  threadTreeHasSettleBlocker,
  threadSettleTreeState,
  threadTreeHasActiveWork,
} from "./threadSettled.ts";

const NOW = "2026-10-21T12:00:00.000Z";
const environmentId = EnvironmentId.make("env-1");

const thread = (
  id: string,
  options: {
    readonly parent?: string;
    readonly supervisor?: string;
    readonly status?: "idle" | "running" | "queued" | "waiting";
    readonly approval?: boolean;
    readonly settled?: boolean;
    readonly environment?: string;
  } = {},
) => ({
  environmentId: EnvironmentId.make(options.environment ?? environmentId),
  id: ThreadId.make(id),
  createdAt: NOW,
  lineage: {
    parentThreadId: options.parent === undefined ? null : ThreadId.make(options.parent),
    relationshipToParent: options.parent === undefined ? null : ("subagent" as const),
    ...(options.supervisor === undefined
      ? {}
      : { supervisorThreadId: ThreadId.make(options.supervisor) }),
  },
  hasPendingApprovals: options.approval === true,
  hasPendingUserInput: false,
  latestUserMessageAt: null,
  runtime:
    options.status === undefined
      ? null
      : {
          status: options.status,
          activeRunId: null,
          providerInstanceId: "codex" as never,
          providerName: null,
          lastError: null,
          updatedAt: NOW,
        },
  archivedAt: null,
  settledOverride: options.settled === true ? ("settled" as const) : null,
});

describe("agent tree descendants", () => {
  it("follows delegation and supervision, nearest first, in one environment", () => {
    const threads = [
      thread("meta"),
      thread("slice", { supervisor: "meta" }),
      thread("broker", { parent: "slice" }),
      thread("cell", { parent: "broker" }),
      thread("other"),
      thread("elsewhere", { parent: "meta", environment: "env-2" }),
    ];
    expect(agentTreeDescendants(threads[0]!, threads).map((entry) => entry.id)).toEqual([
      "slice",
      "broker",
      "cell",
    ]);
    expect(agentTreeDescendants(threads[3]!, threads)).toEqual([]);
  });

  it("lists each thread once when the lineage loops", () => {
    const threads = [thread("a", { parent: "b" }), thread("b", { parent: "a" })];
    expect(agentTreeDescendants(threads[0]!, threads).map((entry) => entry.id)).toEqual(["b"]);
  });
});

describe("active work", () => {
  it("counts runs, queued work and waiting requests, not an idle thread", () => {
    expect(threadHasActiveWork(thread("a"), { now: NOW })).toBe(false);
    expect(threadHasActiveWork(thread("a", { status: "running" }), { now: NOW })).toBe(true);
    expect(threadHasActiveWork(thread("a", { status: "queued" }), { now: NOW })).toBe(true);
    expect(threadHasActiveWork(thread("a", { approval: true }), { now: NOW })).toBe(true);
  });

  it("finds work anywhere under the root, but not in settled threads", () => {
    const idle = [thread("root"), thread("child", { parent: "root" })];
    expect(threadTreeHasActiveWork(idle[0]!, idle, { now: NOW })).toBe(false);
    const busy = [thread("root"), thread("child", { parent: "root", status: "running" })];
    expect(threadTreeHasActiveWork(busy[0]!, busy, { now: NOW })).toBe(true);
    const settled = [
      thread("root"),
      thread("child", { parent: "root", status: "running", settled: true }),
    ];
    expect(threadTreeHasActiveWork(settled[0]!, settled, { now: NOW })).toBe(false);
  });

  it("counts background work the agent waits for, but not a shell command or a PR watch", () => {
    const waiting = (kind: "subagent" | "command" | "monitor", taskId = "task-1") => ({
      ...thread("a"),
      pendingBackgroundTasks: [{ kind, taskId } as never],
    });
    expect(threadHasActiveWork(waiting("subagent"), { now: NOW })).toBe(true);
    expect(threadHasActiveWork(waiting("command"), { now: NOW })).toBe(false);
    // A pull request watch is how a snoozed thread wakes, not work it is doing.
    expect(
      threadHasActiveWork(waiting("monitor", "pull-request-watch:github.com/o/r#1"), { now: NOW }),
    ).toBe(false);
  });

  it("leaves a descendant parked until its limit resets out of the tree's work", () => {
    const tree = [
      thread("root"),
      {
        ...thread("limited", { parent: "root", status: "running" }),
        snoozedUntil: "2026-10-21T17:00:00.000Z",
        limitRecovery: { snooze: true },
      },
    ];
    expect(threadTreeHasActiveWork(tree[0]!, tree, { now: NOW })).toBe(false);
  });
});

describe("settle tree state", () => {
  it("finds live and unsettled descendants, ignoring archived ones and other trees", () => {
    const threads = [
      thread("meta"),
      thread("broker", { parent: "meta" }),
      thread("cell", { parent: "broker", settled: true }),
      thread("other"),
    ];
    expect(threadSettleTreeState(threads[0]!, threads)).toEqual({
      hasUnsettledDescendants: true,
      hasDescendants: true,
    });
    expect(threadSettleTreeState(threads[2]!, threads)).toEqual({
      hasUnsettledDescendants: false,
      hasDescendants: false,
    });
    const archived = threads.map((entry) =>
      entry.id === "broker" ? { ...entry, archivedAt: NOW as string | null } : entry,
    );
    expect(threadSettleTreeState(archived[0]!, archived)).toEqual({
      hasUnsettledDescendants: false,
      hasDescendants: true,
    });
  });

  it("calls a settle pending only while the server holds a wait for it", () => {
    expect(isSettlePending({})).toBe(false);
    expect(isSettlePending({ settleWhenIdle: null })).toBe(false);
    expect(isSettlePending({ settleWhenIdle: { requestedAt: NOW } })).toBe(true);
  });
});

describe("settle blocker", () => {
  it("counts approvals and runs in flight, not user input or background work", () => {
    expect(threadHasSettleBlocker(thread("a"), { now: NOW })).toBe(false);
    expect(threadHasSettleBlocker(thread("a", { approval: true }), { now: NOW })).toBe(true);
    expect(threadHasSettleBlocker(thread("a", { status: "running" }), { now: NOW })).toBe(true);
    const askingByMessage = { ...thread("a"), hasPendingUserInput: true };
    expect(threadHasSettleBlocker(askingByMessage, { now: NOW })).toBe(false);
    const subagentWork = {
      ...thread("a"),
      pendingBackgroundTasks: [{ kind: "subagent", taskId: "task-1" } as never],
    };
    expect(threadHasSettleBlocker(subagentWork, { now: NOW })).toBe(false);
  });

  it("counts a turn a person queued, not a queued delivery", () => {
    const queued = (latestUserAuthoredMessageAt: string | null) => ({
      ...thread("a", { status: "queued" }),
      latestUserMessageAt: NOW as string | null,
      latestUserAuthoredMessageAt,
    });
    expect(threadHasSettleBlocker(queued(NOW), { now: NOW })).toBe(true);
    expect(threadHasSettleBlocker(queued("2026-10-21T11:00:00.000Z"), { now: NOW })).toBe(false);
    expect(threadHasSettleBlocker(queued(null), { now: NOW })).toBe(false);
  });

  it("checks the root whatever its state and live, unsettled threads under it", () => {
    const tree = (rootSettled: boolean, child: Parameters<typeof thread>[1]) => [
      thread("root", { settled: rootSettled }),
      thread("child", { parent: "root", ...child }),
    ];
    const blocks = (threads: ReturnType<typeof tree>) =>
      threadTreeHasSettleBlocker(threads[0]!, threads, { now: NOW });
    expect(blocks(tree(false, {}))).toBe(false);
    expect(blocks(tree(false, { status: "waiting" }))).toBe(true);
    expect(blocks(tree(false, { status: "running", settled: true }))).toBe(false);
    const settledRootRunning = [thread("root", { settled: true, status: "running" })];
    expect(
      threadTreeHasSettleBlocker(settledRootRunning[0]!, settledRootRunning, { now: NOW }),
    ).toBe(true);
    const archived = tree(false, { status: "running" }).map((entry) =>
      entry.id === "child" ? { ...entry, archivedAt: NOW as string | null } : entry,
    );
    expect(threadTreeHasSettleBlocker(archived[0]!, archived, { now: NOW })).toBe(false);
  });
});
