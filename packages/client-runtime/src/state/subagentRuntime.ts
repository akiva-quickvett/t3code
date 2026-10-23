import { groupBy } from "effect/Array";
import * as DateTime from "effect/DateTime";
import type {
  OrchestrationDot,
  OrchestrationV2AppThread,
  OrchestrationV2Subagent,
  OrchestrationV2SubagentWorkflow,
  OrchestrationV2TurnItem,
  OrganId,
  OrganLabel,
  ThreadId,
  ThreadRolePreset,
} from "@t3tools/contracts";
import { isOrchestrationV2WorkActive, isProviderNativeSubagentThread } from "@t3tools/contracts";
import {
  resolveOrchestrationDot,
  type OrchestrationDotInput,
} from "@t3tools/shared/orchestrationTree";

export type RuntimeSubagentStatus =
  | "pending"
  | "running"
  | "waiting"
  | "idle"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface SubagentUsage {
  readonly totalTokens: number;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
  readonly toolUses?: number;
  readonly durationMs?: number;
}

export interface SubagentActivityEntry {
  readonly at: string;
  readonly summary: string;
}

export interface SubagentWorkflowPhase {
  readonly index: number;
  readonly title: string;
}

export interface SubagentRunHandles {
  readonly runId?: string | undefined;
  readonly scriptPath?: string | undefined;
  readonly transcriptDir?: string | undefined;
  readonly sessionUrl?: string | undefined;
}

export interface RuntimeSubagent {
  readonly id: string;
  readonly kind: "subagent" | "subagent_batch" | "workflow" | "workflow_agent";
  readonly title: string;
  readonly role: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly status: RuntimeSubagentStatus;
  readonly activationCount: number;
  readonly usage: SubagentUsage | null;
  readonly progress: string | null;
  readonly lastToolName: string | null;
  readonly result: string | null;
  readonly error: string | null;
  readonly outputFile: string | null;
  readonly parentAgentId: string | null;
  readonly agentIndex: number | null;
  readonly phaseIndex: number | null;
  readonly phaseTitle: string | null;
  readonly attempt: number | null;
  readonly workflowName: string | null;
  readonly phases: ReadonlyArray<SubagentWorkflowPhase>;
  readonly runHandles: SubagentRunHandles | null;
  readonly childThreadId: string | null;
  readonly recentActivity: ReadonlyArray<SubagentActivityEntry>;
  readonly firstSeenAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly updatedAt: string;
}

const TERMINAL_STATUSES: ReadonlySet<RuntimeSubagentStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export function isTerminalSubagentStatus(status: RuntimeSubagentStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function isActiveSubagentStatus(status: RuntimeSubagentStatus): boolean {
  return isOrchestrationV2WorkActive(status);
}

export function isLiveSubagentTurnItem(item: OrchestrationV2TurnItem): boolean {
  return item.type === "subagent" && isOrchestrationV2WorkActive(item.status);
}

export interface SubagentWorkflowGroup {
  readonly workflow: RuntimeSubagent;
  readonly phases: ReadonlyArray<{
    readonly index: number;
    readonly title: string;
    readonly members: ReadonlyArray<RuntimeSubagent>;
    readonly state: "pending" | "running" | "done";
    readonly settledCount: number;
  }>;
  readonly unphasedMembers: ReadonlyArray<RuntimeSubagent>;
}

function workflowUsage(source: {
  readonly totalTokens?: number | undefined;
  readonly toolCalls?: number | undefined;
  readonly durationMs?: number | undefined;
}): SubagentUsage | null {
  if (source.totalTokens === undefined) return null;
  return {
    totalTokens: source.totalTokens,
    ...(source.toolCalls === undefined ? {} : { toolUses: source.toolCalls }),
    ...(source.durationMs === undefined ? {} : { durationMs: source.durationMs }),
  };
}

function isoFromEpochMillis(value: number | undefined): string | null {
  return value === undefined ? null : DateTime.formatIso(DateTime.makeUnsafe(value));
}

function workflowMembersToRuntime(
  coordinator: RuntimeSubagent,
  workflow: OrchestrationV2SubagentWorkflow,
): ReadonlyArray<RuntimeSubagent> {
  return workflow.agents.map((agent) => {
    const status =
      (agent.state === "queued" || agent.state === "running") &&
      isTerminalSubagentStatus(coordinator.status)
        ? coordinator.status
        : agent.state === "queued"
          ? "pending"
          : agent.state;
    const failed = status === "failed";
    const startedAt = isoFromEpochMillis(agent.startedAt);
    const completedAt = isTerminalSubagentStatus(status)
      ? agent.startedAt !== undefined && agent.durationMs !== undefined
        ? isoFromEpochMillis(agent.startedAt + agent.durationMs)
        : coordinator.completedAt
      : null;
    return {
      ...coordinator,
      id: `${coordinator.id}:agent:${agent.index}`,
      kind: "workflow_agent" as const,
      title: agent.label,
      model: agent.model ?? null,
      status,
      activationCount: agent.attempt ?? 1,
      usage: workflowUsage(agent),
      progress: agent.prompt ?? null,
      result: failed ? null : (agent.result ?? null),
      error: failed ? (agent.result ?? null) : null,
      parentAgentId: coordinator.id,
      agentIndex: agent.index,
      phaseIndex: agent.phaseIndex ?? null,
      phaseTitle: agent.phaseTitle ?? null,
      attempt: agent.attempt ?? null,
      phases: [],
      childThreadId: agent.childThreadId ?? null,
      recentActivity: [],
      firstSeenAt: isoFromEpochMillis(agent.queuedAt) ?? startedAt ?? coordinator.firstSeenAt,
      startedAt,
      completedAt,
      updatedAt: completedAt ?? startedAt ?? coordinator.firstSeenAt,
    } satisfies RuntimeSubagent;
  });
}

export function projectedSubagentsToRuntime(
  subagents: ReadonlyArray<{
    readonly id: string;
    readonly title: string | null;
    readonly prompt: string;
    readonly model: string | null;
    readonly status: OrchestrationV2Subagent["status"];
    readonly progress?: string | undefined;
    readonly childThreadId?: string | null | undefined;
    readonly workflow?: OrchestrationV2SubagentWorkflow | undefined;
    readonly result: string | null;
    readonly startedAt: DateTime.Utc | null;
    readonly completedAt: DateTime.Utc | null;
    readonly updatedAt: DateTime.Utc;
  }>,
): ReadonlyArray<RuntimeSubagent> {
  return subagents.flatMap((subagent) => {
    const updatedAt = DateTime.formatIso(subagent.updatedAt);
    const startedAt = subagent.startedAt === null ? null : DateTime.formatIso(subagent.startedAt);
    const firstSeenAt = startedAt ?? updatedAt;
    const { workflow } = subagent;
    const runHandles = workflow?.runHandles ?? null;
    const coordinator = {
      id: subagent.id,
      kind: workflow === undefined ? "subagent" : "workflow",
      title:
        subagent.title ??
        (subagent.prompt.length > 80 ? `${subagent.prompt.slice(0, 77)}...` : subagent.prompt),
      role: null,
      model: subagent.model,
      effort: null,
      status: subagent.status,
      activationCount: 1,
      usage: workflow === undefined ? null : workflowUsage(workflow),
      progress: subagent.progress ?? null,
      lastToolName: null,
      result: subagent.result,
      error: subagent.status === "failed" ? (subagent.result ?? null) : null,
      outputFile: null,
      parentAgentId: null,
      agentIndex: null,
      phaseIndex: null,
      phaseTitle: null,
      attempt: null,
      workflowName: workflow?.name ?? null,
      phases: workflow?.phases ?? [],
      runHandles,
      childThreadId: subagent.childThreadId ?? null,
      recentActivity: [],
      firstSeenAt,
      startedAt,
      completedAt: subagent.completedAt === null ? null : DateTime.formatIso(subagent.completedAt),
      updatedAt,
    } satisfies RuntimeSubagent;
    return workflow === undefined
      ? [coordinator]
      : [coordinator, ...workflowMembersToRuntime(coordinator, workflow)];
  });
}

export function deriveWorkflowGroups(
  agents: ReadonlyArray<RuntimeSubagent>,
): ReadonlyArray<SubagentWorkflowGroup> {
  const workflows = agents
    .filter((agent) => agent.kind === "workflow")
    .sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id.localeCompare(b.id));
  const members = groupBy(
    agents.filter((agent) => agent.kind !== "workflow" && agent.parentAgentId !== null),
    (agent) => agent.parentAgentId!,
  );

  return workflows.map((workflow) => {
    const workflowMembers = Object.hasOwn(members, workflow.id) ? members[workflow.id]! : [];
    // Union, not either/or: the declared plan lags the members, because the
    // provider only admits a phase once something in it starts. Members seed
    // the map; the declared titles then overwrite whatever they guessed.
    const phaseTitles = new Map<number, string>();
    for (const member of workflowMembers) {
      if (member.phaseIndex === null) continue;
      phaseTitles.set(
        member.phaseIndex,
        member.phaseTitle ?? phaseTitles.get(member.phaseIndex) ?? `Phase ${member.phaseIndex + 1}`,
      );
    }
    for (const phase of workflow.phases) phaseTitles.set(phase.index, phase.title);
    const knownPhases = Array.from(phaseTitles.entries())
      .map(([index, title]) => ({ index, title }))
      .sort((a, b) => a.index - b.index);

    const phases = knownPhases.map((phase) => {
      const phaseMembers = workflowMembers
        .filter((member) => member.phaseIndex === phase.index)
        .sort((a, b) => (a.agentIndex ?? 0) - (b.agentIndex ?? 0));
      const hasActiveMember = phaseMembers.some(
        // Idle members count as active for phase-liveness: a resumable Codex
        // member has not finished the phase.
        (member) => isActiveSubagentStatus(member.status) || member.status === "idle",
      );
      const settledCount = phaseMembers.filter((member) =>
        isTerminalSubagentStatus(member.status),
      ).length;
      const state: "pending" | "running" | "done" =
        phaseMembers.length === 0 ? "pending" : hasActiveMember ? "running" : "done";
      return {
        index: phase.index,
        title: phase.title,
        members: phaseMembers,
        state,
        settledCount,
      };
    });

    const unphasedMembers = workflowMembers
      .filter((member) => member.phaseIndex === null)
      .sort((a, b) => (a.agentIndex ?? 0) - (b.agentIndex ?? 0));

    return { workflow, phases, unphasedMembers };
  });
}

type OrganRecord = Pick<
  OrchestrationV2Subagent,
  "id" | "childThreadId" | "organ" | "status" | "model" | "title" | "updatedAt"
>;

/**
 * The child's OrchestrationDotInput; build it with the same mapping the Orchestration sidebar
 * uses so card and sidebar agree.
 */
export interface OrganCellShell extends OrchestrationDotInput {
  readonly rolePreset?: ThreadRolePreset | null | undefined;
}

export interface OrganCell {
  readonly childThreadId: ThreadId | null;
  /** The latest record's id; follow-up records replace the first one's. */
  readonly subagentId: string;
  readonly title: string | null;
  readonly role: ThreadRolePreset | null;
  readonly model: string | null;
  readonly status: OrchestrationV2Subagent["status"];
  readonly dot: OrchestrationDot;
}

export interface OrganGroup {
  readonly organId: OrganId;
  readonly presetId: OrganLabel["presetId"];
  readonly goal: string;
  readonly rounds: ReadonlyArray<{
    readonly round: number;
    readonly cells: ReadonlyArray<OrganCell>;
  }>;
  readonly running: boolean;
  /** Set once every cell is terminal. */
  readonly outcome?: "completed" | "failed" | "stopped";
}

/**
 * Before the child exists, or while it has no shell or the shell has not loaded yet, the parent's
 * record is the only evidence; it cannot show a request, a wake or a usage limit, so those dots
 * never come from it.
 */
function recordDot(status: OrchestrationV2Subagent["status"]): OrchestrationDot {
  if (isOrchestrationV2WorkActive(status)) return "working";
  return status === "failed" ? "failed" : "idle";
}

const NO_ORGAN_GROUPS: ReadonlyArray<OrganGroup> = [];

/**
 * One group per organ, in order of its first record. A follow-up task copies its cell's label,
 * so records sharing a child thread are one cell: it keeps the round it started in and takes the
 * latest record's status. The role comes from the child's shell because the parent's record
 * never carries it.
 */
export function deriveOrganGroups(
  subagents: ReadonlyArray<OrganRecord>,
  shellOf: (childThreadId: ThreadId) => OrganCellShell | null | undefined,
): ReadonlyArray<OrganGroup> {
  const organs = new Map<
    OrganId,
    { label: OrganLabel; cells: Map<string, { round: number; record: OrganRecord }> }
  >();
  for (const record of subagents) {
    if (record.organ === undefined) continue;
    let organ = organs.get(record.organ.id);
    if (organ === undefined) {
      organ = { label: record.organ, cells: new Map() };
      organs.set(record.organ.id, organ);
    }
    const key = record.childThreadId ?? record.id;
    const cell = organ.cells.get(key);
    if (cell === undefined) {
      organ.cells.set(key, { round: record.organ.round, record });
    } else if (
      DateTime.toEpochMillis(record.updatedAt) >= DateTime.toEpochMillis(cell.record.updatedAt)
    ) {
      cell.record = record;
    }
  }
  if (organs.size === 0) return NO_ORGAN_GROUPS;

  return Array.from(organs.values(), ({ label, cells }) => {
    const rounds = new Map<number, OrganCell[]>();
    let running = false;
    let settled = true;
    let failed = false;
    let stopped = false;
    for (const { round, record } of cells.values()) {
      const shell = record.childThreadId === null ? null : shellOf(record.childThreadId);
      const status = record.status;
      running ||= isOrchestrationV2WorkActive(status);
      settled &&= isTerminalSubagentStatus(status);
      failed ||= status === "failed";
      stopped ||= status === "cancelled" || status === "interrupted";
      let roundCells = rounds.get(round);
      if (roundCells === undefined) {
        roundCells = [];
        rounds.set(round, roundCells);
      }
      roundCells.push({
        childThreadId: record.childThreadId,
        subagentId: record.id,
        title: record.title,
        role: shell?.rolePreset ?? null,
        model: record.model,
        status,
        dot:
          shell == null || shell.shellStatus === "empty"
            ? recordDot(status)
            : resolveOrchestrationDot(shell, null).dot,
      });
    }
    return {
      organId: label.id,
      presetId: label.presetId,
      goal: label.goal,
      rounds: Array.from(rounds, ([round, roundCells]) => ({ round, cells: roundCells })).sort(
        (a, b) => a.round - b.round,
      ),
      running,
      ...(settled ? { outcome: failed ? "failed" : stopped ? "stopped" : "completed" } : {}),
    } satisfies OrganGroup;
  });
}

/**
 * Which organ each labelled subagent record belongs to, for timeline grouping. Undefined when no
 * record is labelled, so threads without organs keep a stable (absent) input.
 */
export function organIdsBySubagentId(
  subagents: ReadonlyArray<Pick<OrchestrationV2Subagent, "id" | "organ">>,
): ReadonlyMap<string, OrganId> | undefined {
  let byId: Map<string, OrganId> | undefined;
  for (const subagent of subagents) {
    if (subagent.organ === undefined) continue;
    byId ??= new Map();
    byId.set(subagent.id, subagent.organ.id);
  }
  return byId;
}

// Workflow scripts open with their `meta` export, after any leading comments.
const WORKFLOW_SCRIPT_START = /^\s*(?:(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*export\s+const\s+meta\b/;

/**
 * Whether a user message is the script a provider-native workflow runs. Servers mark every
 * subagent prompt either way; only threads recorded before the mark fall back to the text.
 */
export function isWorkflowScriptMessage(message: {
  readonly role: string;
  readonly text: string;
  readonly workflowScript?: boolean | undefined;
}): boolean {
  return (
    message.role === "user" && (message.workflowScript ?? WORKFLOW_SCRIPT_START.test(message.text))
  );
}

type ProjectedSubagent = Parameters<typeof projectedSubagentsToRuntime>[0][number] &
  Pick<OrchestrationV2Subagent, "driver" | "providerInstanceId">;

export interface WorkflowOpening {
  readonly messageId: string;
  readonly script: string;
  readonly name: string | null;
  readonly description: string | null;
  readonly driver: OrchestrationV2Subagent["driver"] | null;
  readonly providerInstanceId: OrchestrationV2Subagent["providerInstanceId"] | null;
  /** Null until the parent thread's coordinator row is loaded. */
  readonly group: SubagentWorkflowGroup | null;
}

/**
 * The opening of a workflow coordinator's thread: its first user message is the workflow script,
 * shown as the workflow's plan. The coordinator row lives on the parent thread, so
 * `parentSubagents` is the parent projection's subagents, or null when it is not loaded.
 */
export function resolveWorkflowOpening(input: {
  readonly thread: Pick<OrchestrationV2AppThread, "id" | "lineage" | "creationSource">;
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly role: string;
    readonly text: string;
    readonly workflowScript?: boolean | undefined;
  }>;
  readonly parentSubagents: ReadonlyArray<ProjectedSubagent> | null;
}): WorkflowOpening | null {
  if (!isProviderNativeSubagentThread(input.thread)) return null;
  const first = input.messages.find((message) => message.role === "user");
  if (first === undefined) return null;
  const coordinator = input.parentSubagents?.find(
    (subagent) => subagent.childThreadId === input.thread.id,
  );
  if (first.workflowScript === false) return null;
  if (coordinator?.workflow === undefined && !isWorkflowScriptMessage(first)) return null;
  return {
    messageId: first.id,
    script: first.text,
    name: coordinator?.workflow?.name ?? null,
    description: coordinator?.title ?? null,
    driver: coordinator?.driver ?? null,
    providerInstanceId: coordinator?.providerInstanceId ?? null,
    group:
      coordinator?.workflow === undefined
        ? null
        : (deriveWorkflowGroups(projectedSubagentsToRuntime([coordinator]))[0] ?? null),
  };
}

/**
 * The parent thread whose subagent rows describe this thread's workflow, or null when the thread
 * does not open with a workflow script. Gates loading the parent so ordinary subagent threads
 * never subscribe to their parent's detail.
 */
export function workflowOpeningParentThreadId(input: {
  readonly thread: Pick<OrchestrationV2AppThread, "lineage" | "creationSource">;
  readonly messages: ReadonlyArray<Parameters<typeof isWorkflowScriptMessage>[0]>;
}): OrchestrationV2AppThread["id"] | null {
  if (!isProviderNativeSubagentThread(input.thread)) return null;
  const first = input.messages.find((message) => message.role === "user");
  return first !== undefined && isWorkflowScriptMessage(first)
    ? input.thread.lineage.parentThreadId
    : null;
}

/** The opening block's heading: the workflow, what it does, and how its agents stand. */
export function workflowOpeningHeadline(opening: WorkflowOpening): {
  readonly title: string;
  readonly description: string | null;
  readonly agents: string | null;
} {
  const title = opening.name ?? opening.description ?? "Workflow";
  const members =
    opening.group === null
      ? []
      : [
          ...opening.group.phases.flatMap((phase) => phase.members),
          ...opening.group.unphasedMembers,
        ];
  const counts = new Map<string, number>();
  for (const member of members) {
    const key = isTerminalSubagentStatus(member.status)
      ? member.status === "completed"
        ? "done"
        : member.status === "failed"
          ? "failed"
          : "stopped"
      : "working";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const agents =
    members.length === 0
      ? null
      : `${members.length} ${members.length === 1 ? "agent" : "agents"} · ${[
          "working",
          "done",
          "failed",
          "stopped",
        ]
          .filter((key) => counts.has(key))
          .map((key) => `${counts.get(key)} ${key}`)
          .join(" · ")}`;
  return {
    title,
    description:
      opening.description !== null && opening.description !== title ? opening.description : null,
    agents,
  };
}
