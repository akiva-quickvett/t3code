import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { agentTreeDescendants } from "./threadRelationships.ts";
import { threadHasActiveWork, threadTreeHasActiveWork } from "./threadSettled.ts";

const NOW = "2026-10-21T12:00:00.000Z";
const environmentId = EnvironmentId.make("env-1");

const thread = (
  id: string,
  options: {
    readonly parent?: string;
    readonly supervisor?: string;
    readonly status?: "idle" | "running" | "queued";
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
