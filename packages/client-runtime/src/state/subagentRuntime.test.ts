import { describe, expect, it } from "vite-plus/test";
import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Subagent,
  type OrchestrationV2SubagentWorkflow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  deriveOrganGroups,
  deriveWorkflowGroups,
  isWorkflowScriptMessage,
  organIdsBySubagentId,
  projectedSubagentsToRuntime,
  resolveWorkflowOpening,
  workflowOpeningHeadline,
  workflowOpeningParentThreadId,
} from "./subagentRuntime.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

type ProjectedSubagent = Parameters<typeof projectedSubagentsToRuntime>[0][number];

function subagent(overrides: Partial<ProjectedSubagent> = {}): ProjectedSubagent {
  return {
    id: "coordinator",
    title: "probe",
    prompt: "export const meta = …",
    model: "claude-opus-5[1m]",
    status: "running" satisfies OrchestrationV2Subagent["status"],
    result: null,
    startedAt: at("2026-08-01T10:00:00.000Z"),
    completedAt: null,
    updatedAt: at("2026-08-01T10:00:05.000Z"),
    ...overrides,
  };
}

const member = (
  overrides: Partial<OrchestrationV2SubagentWorkflow["agents"][number]> = {},
): OrchestrationV2SubagentWorkflow["agents"][number] => ({
  index: 1,
  label: "alpha:one",
  state: "running",
  phaseIndex: 1,
  phaseTitle: "Alpha",
  ...overrides,
});

const groupsOf = (subagents: ReadonlyArray<ProjectedSubagent>) =>
  deriveWorkflowGroups(projectedSubagentsToRuntime(subagents));

describe("projectedSubagentsToRuntime workflow expansion", () => {
  it("leaves a plain subagent flat", () => {
    const [agent, ...rest] = projectedSubagentsToRuntime([subagent()]);
    expect(rest).toEqual([]);
    expect(agent?.kind).toBe("subagent");
    expect(agent?.phases).toEqual([]);
  });

  it("projects a coordinator plus one row per member", () => {
    const rows = projectedSubagentsToRuntime([
      subagent({
        workflow: {
          name: "probe-wf",
          phases: [
            { index: 1, title: "Alpha" },
            { index: 2, title: "Beta" },
          ],
          agents: [member(), member({ index: 2, label: "alpha:two", state: "queued" })],
          totalTokens: 1000,
        },
      }),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["workflow", "workflow_agent", "workflow_agent"]);
    expect(rows[0]?.workflowName).toBe("probe-wf");
    expect(rows[0]?.usage?.totalTokens).toBe(1000);
    expect(rows[1]).toMatchObject({
      id: "coordinator:agent:1",
      title: "alpha:one",
      parentAgentId: "coordinator",
      phaseIndex: 1,
      phaseTitle: "Alpha",
      status: "running",
    });
    expect(rows[2]?.status).toBe("pending");
    expect(rows[2]?.startedAt).toBeNull();
  });

  it("derives a settled member's end from its reported duration", () => {
    const [, settled] = projectedSubagentsToRuntime([
      subagent({
        workflow: {
          phases: [],
          agents: [
            member({
              state: "completed",
              startedAt: Date.UTC(2026, 7, 1, 10, 0, 0),
              durationMs: 1500,
              totalTokens: 71_141,
              toolCalls: 3,
              prompt: "Reply with exactly: A1",
              result: "A1",
            }),
          ],
        },
      }),
    ]);
    expect(settled?.status).toBe("completed");
    expect(settled?.completedAt).toBe("2026-08-01T10:00:01.500Z");
    expect(settled?.result).toBe("A1");
    expect(settled?.progress).toBe("Reply with exactly: A1");
    expect(settled?.usage).toEqual({ totalTokens: 71_141, toolUses: 3, durationMs: 1500 });
  });

  it.each(["completed", "cancelled", "failed"] as const)(
    "settles unfinished members when the coordinator is %s",
    (status) => {
      const groups = groupsOf([
        subagent({
          status,
          completedAt: at("2026-08-01T10:00:09.000Z"),
          workflow: {
            phases: [],
            agents: [
              member(),
              member({ index: 2, state: "queued" }),
              member({ index: 3, state: "completed" }),
            ],
          },
        }),
      ]);
      expect(groups[0]?.workflow.status).toBe(status);
      const members = groups[0]?.phases.flatMap((phase) => phase.members);
      expect(members?.map((agent) => agent.status)).toEqual([status, status, "completed"]);
      expect(members?.[0]?.completedAt).toBe("2026-08-01T10:00:09.000Z");
    },
  );

  it("surfaces a retried member through the row's activation count", () => {
    const [, retried] = projectedSubagentsToRuntime([
      subagent({ workflow: { phases: [], agents: [member({ attempt: 3 })] } }),
    ]);
    expect(retried?.activationCount).toBe(3);
    expect(retried?.attempt).toBe(3);
  });
});

describe("deriveWorkflowGroups over a dynamic workflow", () => {
  it("groups members under their phases and counts the run", () => {
    const groups = groupsOf([
      subagent({
        workflow: {
          name: "probe-wf",
          phases: [
            { index: 1, title: "Alpha" },
            { index: 2, title: "Beta" },
          ],
          agents: [
            member({ state: "completed" }),
            member({ index: 2, label: "alpha:two", state: "failed" }),
            member({ index: 3, label: "beta:one", phaseIndex: 2, phaseTitle: "Beta" }),
            member({
              index: 4,
              label: "beta:two",
              phaseIndex: 2,
              phaseTitle: "Beta",
              state: "queued",
            }),
          ],
        },
      }),
    ]);
    const group = groups[0];
    expect(group?.phases.map((phase) => [phase.title, phase.state])).toEqual([
      ["Alpha", "done"],
      ["Beta", "running"],
    ]);
    expect(group?.phases.map((phase) => phase.settledCount)).toEqual([2, 0]);
    expect(group?.phases.flatMap((phase) => phase.members)).toHaveLength(4);
    expect(group?.unphasedMembers).toEqual([]);
  });

  it("shows a phase the script only reached at runtime", () => {
    const groups = groupsOf([
      subagent({
        workflow: {
          phases: [{ index: 1, title: "Alpha" }],
          agents: [
            member({ state: "completed" }),
            member({ index: 2, label: "dynamic:late", phaseIndex: 3, phaseTitle: "Gamma" }),
          ],
        },
      }),
    ]);
    const group = groups[0];
    expect(group?.phases.map((phase) => phase.title)).toEqual(["Alpha", "Gamma"]);
    expect(group?.unphasedMembers).toEqual([]);
  });

  it.each([false, true])("keeps a reported phase title, missing title first=%s", (missingFirst) => {
    const agents = [member({ phaseTitle: "Review" }), member({ index: 2, phaseTitle: undefined })];
    const groups = groupsOf([
      subagent({ workflow: { phases: [], agents: missingFirst ? agents.toReversed() : agents } }),
    ]);
    expect(groups[0]?.phases[0]?.title).toBe("Review");
  });

  it("keeps unphased members with their workflow and excludes unrelated agents", () => {
    const runtime = projectedSubagentsToRuntime([
      subagent({ id: "ordinary" }),
      subagent({
        id: "__proto__",
        workflow: {
          phases: [],
          agents: [member({ phaseIndex: undefined, phaseTitle: undefined })],
        },
      }),
      subagent({ id: "constructor", workflow: { phases: [], agents: [] } }),
      subagent({ id: "orphan", workflow: { phases: [], agents: [member()] } }),
    ]);
    const groups = deriveWorkflowGroups(runtime.filter((agent) => agent.id !== "orphan"));
    expect(groups.map((group) => group.workflow.id)).toEqual(["__proto__", "constructor"]);
    expect(groups[0]?.phases).toEqual([]);
    expect(groups[0]?.unphasedMembers.map((agent) => agent.title)).toEqual(["alpha:one"]);
    expect(groups[1]?.phases).toEqual([]);
    expect(groups[1]?.unphasedMembers).toEqual([]);
  });
});

describe("resolveWorkflowOpening", () => {
  const SCRIPT = '// probe\nexport const meta = { name: "probe-wf" };\nconst GROUPS = [];';
  const childThread = {
    id: ThreadId.make("child"),
    lineage: {
      parentThreadId: ThreadId.make("parent"),
      relationshipToParent: "subagent" as const,
      rootThreadId: ThreadId.make("parent"),
    },
    creationSource: "provider" as const,
  };
  const coordinator = (workflow?: OrchestrationV2SubagentWorkflow) => ({
    ...subagent({
      title: "Run the alpha workflow",
      childThreadId: "child",
      ...(workflow === undefined ? {} : { workflow }),
    }),
    driver: ProviderDriverKind.make("claudeAgent"),
    providerInstanceId: ProviderInstanceId.make("claude"),
  });
  const brief = (text: string, workflowScript?: boolean) => ({
    id: "message-1",
    role: "user",
    text,
    ...(workflowScript === undefined ? {} : { workflowScript }),
  });

  it("opens a marked thread with the coordinator's plan and members", () => {
    const opening = resolveWorkflowOpening({
      thread: childThread,
      messages: [brief(SCRIPT, true)],
      parentSubagents: [
        coordinator({
          name: "probe-wf",
          phases: [{ index: 1, title: "Alpha" }],
          agents: [member({ childThreadId: ThreadId.make("member-1") })],
        }),
      ],
    });
    expect(opening).toMatchObject({
      messageId: "message-1",
      script: SCRIPT,
      name: "probe-wf",
      description: "Run the alpha workflow",
    });
    expect(
      opening?.group?.phases.map((phase) => ({
        title: phase.title,
        members: phase.members.map((agent) => [agent.title, agent.status, agent.childThreadId]),
      })),
    ).toEqual([{ title: "Alpha", members: [["alpha:one", "running", "member-1"]] }]);
  });

  it("recognizes an unmarked script before the parent loads", () => {
    const opening = resolveWorkflowOpening({
      thread: childThread,
      messages: [brief(SCRIPT)],
      parentSubagents: null,
    });
    expect(opening).toMatchObject({ script: SCRIPT, name: null, group: null });
  });

  it("recognizes an unmarked first message from the parent's workflow row", () => {
    const opening = resolveWorkflowOpening({
      thread: childThread,
      messages: [brief("Run the alpha workflow.")],
      parentSubagents: [coordinator({ name: "probe-wf", phases: [], agents: [] })],
    });
    expect(opening?.name).toBe("probe-wf");
  });

  it("leaves an ordinary subagent thread and other threads alone", () => {
    expect(
      resolveWorkflowOpening({
        thread: childThread,
        messages: [brief("Audit the last five commits.")],
        parentSubagents: [coordinator()],
      }),
    ).toBeNull();
    expect(
      resolveWorkflowOpening({
        thread: {
          ...childThread,
          lineage: { ...childThread.lineage, relationshipToParent: null, parentThreadId: null },
        },
        messages: [brief(SCRIPT)],
        parentSubagents: null,
      }),
    ).toBeNull();
    expect(isWorkflowScriptMessage({ role: "user", text: "Explain `export const meta`." })).toBe(
      false,
    );
    expect(isWorkflowScriptMessage({ role: "assistant", text: SCRIPT })).toBe(false);
  });

  it("trusts a brief marked as not a script even when its text looks like one", () => {
    expect(isWorkflowScriptMessage(brief(SCRIPT, false))).toBe(false);
    expect(
      resolveWorkflowOpening({
        thread: childThread,
        messages: [brief(SCRIPT, false)],
        parentSubagents: [coordinator()],
      }),
    ).toBeNull();
    expect(
      workflowOpeningParentThreadId({ thread: childThread, messages: [brief(SCRIPT, false)] }),
    ).toBeNull();
  });

  it("loads the parent only for a thread that opens with a workflow script", () => {
    expect(
      workflowOpeningParentThreadId({ thread: childThread, messages: [brief(SCRIPT, true)] }),
    ).toBe("parent");
    expect(workflowOpeningParentThreadId({ thread: childThread, messages: [brief(SCRIPT)] })).toBe(
      "parent",
    );
    expect(
      workflowOpeningParentThreadId({
        thread: childThread,
        messages: [brief("Audit the last five commits.")],
      }),
    ).toBeNull();
  });

  it("heads the opening with the workflow name, description, and agent tally", () => {
    const opening = resolveWorkflowOpening({
      thread: childThread,
      messages: [brief(SCRIPT, true)],
      parentSubagents: [
        coordinator({
          name: "probe-wf",
          phases: [{ index: 1, title: "Alpha" }],
          agents: [
            member(),
            member({ index: 2, label: "alpha:two", state: "completed" }),
            member({ index: 3, label: "loose", state: "failed", phaseIndex: undefined }),
          ],
        }),
      ],
    });
    expect(opening && workflowOpeningHeadline(opening)).toEqual({
      title: "probe-wf",
      description: "Run the alpha workflow",
      agents: "3 agents · 1 working · 1 done · 1 failed",
    });
    const unloaded = resolveWorkflowOpening({
      thread: childThread,
      messages: [brief(SCRIPT)],
      parentSubagents: null,
    });
    expect(unloaded && workflowOpeningHeadline(unloaded)).toEqual({
      title: "Workflow",
      description: null,
      agents: null,
    });
  });
});

describe("deriveOrganGroups", () => {
  type OrganRecord = Parameters<typeof deriveOrganGroups>[0][number];
  type CellShell = NonNullable<ReturnType<Parameters<typeof deriveOrganGroups>[1]>>;
  const organ = (id: string, round: number) => ({
    id: `organ_${id}`,
    presetId: "implementation",
    goal: `Goal of ${id}`,
    round,
  });
  const record = (
    id: string,
    child: string | null,
    label: ReturnType<typeof organ> | undefined,
    overrides: Partial<OrganRecord> = {},
  ): OrganRecord => ({
    id: NodeId.make(id),
    childThreadId: child === null ? null : ThreadId.make(child),
    ...(label === undefined ? {} : { organ: label }),
    status: "running",
    model: "gpt-5.5",
    title: id,
    updatedAt: at("2026-08-01T10:00:00.000Z"),
    ...overrides,
  });
  const shell = (overrides: Partial<CellShell> = {}): CellShell => ({
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    runtimeStatus: null,
    latestRun: null,
    lastErrorClass: null,
    wokeAt: null,
    backgroundWorkHoldsCompletion: false,
    lastVisitedAt: null,
    settled: false,
    snoozed: false,
    limitParked: false,
    environmentConnected: true,
    shellStatus: "live",
    ...overrides,
  });
  const noShells = () => undefined;

  it("puts a later round into the existing organ group", () => {
    const groups = deriveOrganGroups(
      [
        record("a", "child-a", organ("one", 1)),
        record("b", "child-b", organ("one", 1)),
        record("plain", "child-plain", undefined),
        record("c", "child-c", organ("one", 1)),
        record("other", "child-other", organ("two", 1)),
        record("d", "child-d", organ("one", 2)),
      ],
      noShells,
    );
    expect(groups.map((group) => group.organId)).toEqual(["organ_one", "organ_two"]);
    expect(groups[0]).toMatchObject({ presetId: "implementation", goal: "Goal of one" });
    expect(
      groups[0]!.rounds.map(({ round, cells }) => [round, cells.map((cell) => cell.subagentId)]),
    ).toEqual([
      [1, ["a", "b", "c"]],
      [2, ["d"]],
    ]);
  });

  it("lists a followed-up cell once with its latest record's status", () => {
    const [group] = deriveOrganGroups(
      [
        record("follow-up", "child-a", organ("one", 1), {
          status: "running",
          updatedAt: at("2026-08-01T10:05:00.000Z"),
        }),
        record("first", "child-a", organ("one", 1), {
          status: "completed",
          updatedAt: at("2026-08-01T10:01:00.000Z"),
        }),
        record("b", "child-b", organ("one", 1)),
      ],
      noShells,
    );
    expect(group!.rounds).toHaveLength(1);
    expect(
      group!.rounds[0]!.cells.map(({ childThreadId, subagentId, status }) => ({
        childThreadId,
        subagentId,
        status,
      })),
    ).toEqual([
      { childThreadId: "child-a", subagentId: "follow-up", status: "running" },
      { childThreadId: "child-b", subagentId: "b", status: "running" },
    ]);
  });

  it("takes each cell's role and attention from the child's own shell", () => {
    const shells = new Map([
      ["child-a", shell({ rolePreset: { id: "reviewer", label: "Reviewer" } })],
      ["child-b", shell({ hasPendingApprovals: true })],
    ]);
    const [group] = deriveOrganGroups(
      [
        record("a", "child-a", organ("one", 1)),
        record("b", "child-b", organ("one", 1)),
        record("pending", null, organ("one", 1)),
      ],
      (childThreadId) => shells.get(childThreadId),
    );
    expect(
      group!.rounds[0]!.cells.map(({ subagentId, role, dot }) => ({ subagentId, role, dot })),
    ).toEqual([
      { subagentId: "a", role: { id: "reviewer", label: "Reviewer" }, dot: "idle" },
      { subagentId: "b", role: null, dot: "needs-you" },
      { subagentId: "pending", role: null, dot: "working" },
    ]);
  });

  it("resolves a cell's dot from its shell, falling back to the record without one", () => {
    const shells = new Map([
      ["child-working", shell({ runtimeStatus: "running" })],
      ["child-limited", shell({ runtimeStatus: "failed", lastErrorClass: "usage_limit" })],
      ["child-plan", shell({ hasActionableProposedPlan: true })],
      ["child-empty", shell({ shellStatus: "empty" })],
    ]);
    const [group] = deriveOrganGroups(
      [
        record("working", "child-working", organ("one", 1), { status: "completed" }),
        record("limited", "child-limited", organ("one", 1), { status: "failed" }),
        record("plan", "child-plan", organ("one", 1)),
        record("empty-running", "child-empty", organ("one", 1)),
        record("unloaded-running", "child-unloaded-1", organ("one", 1)),
        record("unloaded-failed", "child-unloaded-2", organ("one", 1), { status: "failed" }),
        record("unloaded-done", "child-unloaded-3", organ("one", 1), { status: "completed" }),
      ],
      (childThreadId) => shells.get(childThreadId),
    );
    expect(group!.rounds[0]!.cells.map(({ subagentId, dot }) => [subagentId, dot])).toEqual([
      ["working", "working"],
      ["limited", "limited"],
      ["plan", "needs-you"],
      ["empty-running", "working"],
      ["unloaded-running", "working"],
      ["unloaded-failed", "failed"],
      ["unloaded-done", "idle"],
    ]);
  });

  it.each([
    { statuses: ["running", "completed"], running: true, outcome: undefined },
    { statuses: ["idle", "completed"], running: false, outcome: undefined },
    { statuses: ["completed", "completed"], running: false, outcome: "completed" },
    { statuses: ["completed", "interrupted"], running: false, outcome: "stopped" },
    { statuses: ["cancelled", "failed"], running: false, outcome: "failed" },
  ] as const)(
    "derives running $running and outcome $outcome from $statuses",
    ({ statuses, running, outcome }) => {
      const [group] = deriveOrganGroups(
        statuses.map((status, index) =>
          record(`cell-${index}`, `child-${index}`, organ("one", 1), { status }),
        ),
        noShells,
      );
      expect(group!.running).toBe(running);
      expect(group!.outcome).toBe(outcome);
    },
  );

  it("ignores unlabelled records and returns the same empty result without organs", () => {
    const unlabelled = [record("a", "child-a", undefined), record("b", "child-b", undefined)];
    const first = deriveOrganGroups(unlabelled, noShells);
    expect(first).toEqual([]);
    expect(deriveOrganGroups([], noShells)).toBe(first);
    expect(organIdsBySubagentId(unlabelled)).toBeUndefined();
    expect(organIdsBySubagentId([...unlabelled, record("c", "child-c", organ("one", 2))])).toEqual(
      new Map([["c", "organ_one"]]),
    );
  });
});
