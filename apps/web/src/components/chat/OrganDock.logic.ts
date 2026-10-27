import type { OrchestrationDot, OrganId, ThreadId } from "@t3tools/contracts";
import {
  isTerminalSubagentStatus,
  type OrganCell,
  type OrganGroup,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { foldOrchestrationDots } from "@t3tools/shared/orchestrationTree";

/** Only what the dock draws, so anything else a cell streams leaves it equal. */
export interface OrganDockCell {
  readonly key: string;
  readonly childThreadId: ThreadId | null;
  readonly role: string | null;
  readonly model: string | null;
  readonly status: OrganCell["status"];
  readonly dot: OrchestrationDot;
}

export interface OrganDockOrgan {
  readonly organId: OrganId;
  readonly label: string;
  readonly goal: string;
  readonly round: number;
  readonly cells: ReadonlyArray<OrganDockCell>;
}

export const NO_DOCK_ORGANS: ReadonlyArray<OrganDockOrgan> = [];

/** Running organs only, each with its latest round's cells, as in the timeline card's live round. */
export function selectOrganDockOrgans(
  groups: ReadonlyArray<OrganGroup>,
  labelOf: (group: OrganGroup) => string = (group) => group.presetId,
): ReadonlyArray<OrganDockOrgan> {
  const organs: OrganDockOrgan[] = [];
  for (const group of groups) {
    const round = group.rounds.at(-1);
    if (!group.running || round === undefined) continue;
    organs.push({
      organId: group.organId,
      label: labelOf(group),
      goal: group.goal,
      round: round.round,
      cells: round.cells.map((cell) => ({
        key: cell.childThreadId ?? cell.subagentId,
        childThreadId: cell.childThreadId,
        role: cell.role?.label ?? cell.title,
        model: cell.model,
        status: cell.status,
        dot: cell.dot,
      })),
    });
  }
  return organs.length === 0 ? NO_DOCK_ORGANS : organs;
}

function cellsEqual(a: OrganDockCell, b: OrganDockCell): boolean {
  return (
    a.key === b.key &&
    a.childThreadId === b.childThreadId &&
    a.role === b.role &&
    a.model === b.model &&
    a.status === b.status &&
    a.dot === b.dot
  );
}

export function organDockOrgansEqual(
  a: ReadonlyArray<OrganDockOrgan>,
  b: ReadonlyArray<OrganDockOrgan>,
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((organ, index) => {
    const other = b[index]!;
    return (
      organ.organId === other.organId &&
      organ.label === other.label &&
      organ.goal === other.goal &&
      organ.round === other.round &&
      organ.cells.length === other.cells.length &&
      organ.cells.every((cell, cellIndex) => cellsEqual(cell, other.cells[cellIndex]!))
    );
  });
}

export function organDockRowSummary(organ: OrganDockOrgan) {
  return {
    dot: foldOrchestrationDots(organ.cells.map((cell) => cell.dot)).dot,
    settled: organ.cells.filter((cell) => isTerminalSubagentStatus(cell.status)).length,
    total: organ.cells.length,
  };
}

/** "3 organs running · 2 need you · 1 limited"; zero counts are left out. */
export function organDockSummaryText(organs: ReadonlyArray<OrganDockOrgan>): string {
  const dots = organs.flatMap((organ) => organ.cells.map((cell) => cell.dot));
  const needsYou = foldOrchestrationDots(dots).needsYouCount;
  const limited = dots.filter((dot) => dot === "limited").length;
  const failed = dots.filter((dot) => dot === "failed").length;
  return [
    `${organs.length} ${organs.length === 1 ? "organ" : "organs"} running`,
    needsYou > 0 ? `${needsYou} ${needsYou === 1 ? "needs" : "need"} you` : null,
    limited > 0 ? `${limited} limited` : null,
    failed > 0 ? `${failed} failed` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

/**
 * Child threads of running organs' cells. The background-work banner would list these same
 * cells and, ranking ahead of the dock, hide it; callers drop them from its tasks.
 */
export function runningOrganCellThreadIds(
  groups: ReadonlyArray<OrganGroup>,
): ReadonlySet<ThreadId> {
  const ids = new Set<ThreadId>();
  for (const group of groups) {
    if (!group.running) continue;
    for (const round of group.rounds) {
      for (const cell of round.cells) {
        if (cell.childThreadId !== null) ids.add(cell.childThreadId);
      }
    }
  }
  return ids;
}
