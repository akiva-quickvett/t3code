import {
  isTerminalSubagentStatus,
  type OrganGroup,
  type RuntimeSubagent,
  type RuntimeSubagentStatus,
  type SubagentWorkflowGroup,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { isOrchestrationV2WorkActive, type OrchestrationDot, ThreadId } from "@t3tools/contracts";
import { formatModelSlugName } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";

export type OrganCellState =
  | "needs-you"
  | "failed"
  | "limited"
  | "woke"
  | "working"
  | "waiting"
  | "finished"
  | "stopped"
  | "idle";

export interface OrganCardCell {
  readonly key: string;
  /** Null until the cell's child thread exists; such a row cannot be opened. */
  readonly threadId: ThreadId | null;
  readonly role: string;
  readonly model: string | null;
  readonly dot: OrchestrationDot;
  readonly state: OrganCellState;
}

export interface OrganCardSection {
  readonly key: string;
  /** Null for a section without a header (workflow members outside any phase). */
  readonly title: string | null;
  readonly running: boolean;
  /** Whether the section is open until the user toggles it: only the section in play is. */
  readonly defaultOpen: boolean;
  readonly cells: ReadonlyArray<OrganCardCell>;
}

export interface OrganCardTiming {
  readonly status: RuntimeSubagentStatus;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

/**
 * What the card shell draws. Organ groups and provider-native workflow groups reach it through
 * separate adapters below; the shell knows neither data path.
 */
export interface OrganCardGroup {
  readonly kind: "organ" | "workflow";
  readonly id: string;
  readonly label: string;
  /** The latest round; the header shows it from round 2 on. */
  readonly round: number | null;
  readonly goal: string | null;
  readonly sections: ReadonlyArray<OrganCardSection>;
  /** Set once every cell is done. */
  readonly outcome: {
    readonly status: "completed" | "failed" | "stopped";
    readonly summary: string | null;
  } | null;
  readonly timing: OrganCardTiming;
}

export const ORGAN_CELL_STATE_LABELS: Record<OrganCellState, string> = {
  "needs-you": "needs you",
  failed: "failed",
  limited: "usage-limited",
  woke: "woke",
  working: "working",
  waiting: "waiting",
  finished: "finished",
  stopped: "stopped",
  idle: "idle",
};

// Most urgent first, matching the dot rank, so the summary leads with what needs attention.
const SUMMARY_ORDER: ReadonlyArray<OrganCellState> = [
  "needs-you",
  "failed",
  "limited",
  "woke",
  "working",
  "waiting",
  "finished",
  "stopped",
  "idle",
];

/**
 * The dot says what the cell's thread shows; for quiet dots the record's status still tells
 * finished from stopped.
 */
export function organCellState(
  dot: OrchestrationDot,
  status: RuntimeSubagentStatus,
): OrganCellState {
  switch (dot) {
    case "needs-you":
    case "failed":
    case "limited":
    case "woke":
    case "working":
    case "waiting":
      return dot;
    case "done-unread":
    case "idle":
      if (status === "completed") return "finished";
      if (status === "failed") return "failed";
      if (status === "cancelled" || status === "interrupted") return "stopped";
      return isOrchestrationV2WorkActive(status) ? "working" : "idle";
  }
}

export function organCardSummary(cells: ReadonlyArray<Pick<OrganCardCell, "state">>): string {
  const counts = new Map<OrganCellState, number>();
  for (const { state } of cells) counts.set(state, (counts.get(state) ?? 0) + 1);
  return SUMMARY_ORDER.flatMap((state) => {
    const count = counts.get(state);
    return count === undefined ? [] : [`${count} ${ORGAN_CELL_STATE_LABELS[state]}`];
  }).join(" · ");
}

/** Up to three model initials for the header avatars, plus how many cells they leave out. */
export function organCardAvatars(cells: ReadonlyArray<Pick<OrganCardCell, "key" | "model">>) {
  return {
    initials: cells
      .slice(0, 3)
      .map((cell) => ({ key: cell.key, initial: modelInitial(cell.model) })),
    overflow: Math.max(0, cells.length - 3),
  };
}

// "Claude Opus 5.5" → "O": the family name is the last word before the version.
function modelInitial(model: string | null): string {
  const words = (model ?? "").split(/[\s\-_.]+/).filter((word) => /^[a-z]/i.test(word));
  return words.at(-1)?.charAt(0).toUpperCase() ?? "?";
}

/**
 * Earliest start to latest end. While anything runs, or any member never recorded an end, there is
 * no end and the elapsed time keeps counting.
 */
export function organCardTiming(
  members: ReadonlyArray<{
    readonly status: RuntimeSubagentStatus;
    readonly startedAt: DateTime.Utc | null;
    readonly completedAt: DateTime.Utc | null;
  }>,
): OrganCardTiming {
  let startMs: number | null = null;
  let endMs: number | null = null;
  let endUnknown = false;
  for (const member of members) {
    if (member.startedAt) {
      const ms = DateTime.toEpochMillis(member.startedAt);
      startMs = startMs === null ? ms : Math.min(startMs, ms);
    }
    if (member.completedAt) {
      const ms = DateTime.toEpochMillis(member.completedAt);
      endMs = endMs === null ? ms : Math.max(endMs, ms);
    } else {
      endUnknown = true;
    }
  }
  const live = members.some(({ status }) => isOrchestrationV2WorkActive(status));
  return {
    status: live ? "running" : "completed",
    startedAt: startMs === null ? null : new Date(startMs).toISOString(),
    completedAt: live || endUnknown || endMs === null ? null : new Date(endMs).toISOString(),
  };
}

export function organCardFromOrgan(
  organ: OrganGroup,
  options: {
    /** The preset's display label; the preset id stands in when the preset is gone. */
    readonly label?: string | undefined;
    /** The organ's subagent records, for elapsed time; the group itself carries no dates. */
    readonly records: Parameters<typeof organCardTiming>[0];
  },
): OrganCardGroup {
  const lastRound = organ.rounds.at(-1)?.round ?? null;
  return {
    kind: "organ",
    id: organ.organId,
    label: options.label ?? organ.presetId,
    round: lastRound,
    goal: organ.goal,
    sections: organ.rounds.map(({ round, cells }) => ({
      key: `round:${round}`,
      title: `Round ${round}`,
      running: organ.running && round === lastRound,
      defaultOpen: round === lastRound,
      cells: cells.map((cell) => ({
        key: cell.childThreadId ?? cell.subagentId,
        threadId: cell.childThreadId,
        role: cell.role?.label ?? cell.title ?? "Cell",
        model: modelName(cell.model),
        dot: cell.dot,
        state: organCellState(cell.dot, cell.status),
      })),
    })),
    outcome: organ.outcome === undefined ? null : { status: organ.outcome, summary: null },
    timing: organCardTiming(options.records),
  };
}

function modelName(model: string | null): string | null {
  return model === null ? null : formatModelSlugName(model);
}

// A workflow member has no shell of its own to resolve a richer dot from.
function memberDot(status: RuntimeSubagentStatus): OrchestrationDot {
  if (isOrchestrationV2WorkActive(status)) return "working";
  return status === "failed" ? "failed" : "idle";
}

function workflowCell(member: RuntimeSubagent): OrganCardCell {
  const dot = memberDot(member.status);
  return {
    key: member.id,
    threadId: member.childThreadId === null ? null : ThreadId.make(member.childThreadId),
    role: member.role ?? member.title,
    model: modelName(member.model),
    dot,
    state: organCellState(dot, member.status),
  };
}

export function organCardFromWorkflow(group: SubagentWorkflowGroup): OrganCardGroup {
  const { workflow } = group;
  const sections: OrganCardSection[] = group.phases
    .filter((phase) => phase.members.length > 0)
    .map((phase, index, phases) => ({
      key: `phase:${phase.index}`,
      title: phase.title,
      running: phase.state === "running",
      defaultOpen: phase.state === "running" || index === phases.length - 1,
      cells: phase.members.map(workflowCell),
    }));
  if (group.unphasedMembers.length > 0) {
    sections.push({
      key: "unphased",
      title: null,
      defaultOpen: true,
      running: group.unphasedMembers.some((member) => isOrchestrationV2WorkActive(member.status)),
      cells: group.unphasedMembers.map(workflowCell),
    });
  }
  const members = [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
  const settled =
    isTerminalSubagentStatus(workflow.status) &&
    members.every((member) => isTerminalSubagentStatus(member.status));
  const statuses = [workflow.status, ...members.map((member) => member.status)];
  return {
    kind: "workflow",
    id: workflow.id,
    label: workflow.workflowName ?? workflow.title,
    round: null,
    goal: null,
    sections,
    outcome: settled
      ? {
          status: statuses.includes("failed")
            ? "failed"
            : statuses.some((status) => status === "cancelled" || status === "interrupted")
              ? "stopped"
              : "completed",
          summary: workflow.result,
        }
      : null,
    timing: workflow,
  };
}
