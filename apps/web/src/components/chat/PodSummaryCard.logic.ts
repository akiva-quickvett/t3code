import type { OrganCell, OrganGroup } from "@t3tools/client-runtime/state/subagentRuntime";
import type {
  OrchestrationDot,
  OrchestrationV2ThreadShell,
  OrganId,
  ThreadId,
} from "@t3tools/contracts";
import {
  foldOrchestrationDots,
  orchestrationParentThreadId,
} from "@t3tools/shared/orchestrationTree";

/**
 * Organs with a cell under the pod, from shells alone: each cell's lineage
 * carries its organ, so a collapsed card counts organs without the pod's
 * subagent records.
 */
export function podOrganCount(
  threads: ReadonlyArray<Pick<OrchestrationV2ThreadShell, "lineage">>,
  podId: ThreadId,
): number {
  const organs = new Set<OrganId>();
  for (const { lineage } of threads) {
    if (lineage.organ !== undefined && orchestrationParentThreadId(lineage) === podId) {
      organs.add(lineage.organ.id);
    }
  }
  return organs.size;
}

export function podSummaryText(organCount: number, needsYouCount: number): string {
  const organs =
    organCount === 0 ? "no organs" : `${organCount} ${organCount === 1 ? "organ" : "organs"}`;
  return needsYouCount > 0 ? `${organs} · ${needsYouCount} need you` : organs;
}

/** No client reads organ preset labels yet, so the id stands in. */
export function organName(presetId: string): string {
  const words = presetId.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const CELL_STATE_ORDER = [
  "needs you",
  "failed",
  "limited",
  "woke",
  "working",
  "waiting",
  "finished",
  "stopped",
  "idle",
] as const;
type CellState = (typeof CELL_STATE_ORDER)[number];

const DOT_STATES: Record<Exclude<OrchestrationDot, "idle">, CellState> = {
  "needs-you": "needs you",
  failed: "failed",
  limited: "limited",
  woke: "woke",
  working: "working",
  waiting: "waiting",
  "done-unread": "finished",
};

// An idle dot covers both a cell that has not started and one that finished
// and was read; its record's status tells them apart.
function cellState(cell: Pick<OrganCell, "dot" | "status">): CellState {
  if (cell.dot !== "idle") return DOT_STATES[cell.dot];
  if (cell.status === "completed") return "finished";
  if (cell.status === "cancelled" || cell.status === "interrupted") return "stopped";
  return "idle";
}

export interface PodOrganLine {
  readonly organId: OrganId;
  readonly name: string;
  readonly dot: OrchestrationDot;
  /** "r<round> · <count> <state> · …" over the latest round's cells. */
  readonly detail: string;
}

export function podOrganLines(groups: ReadonlyArray<OrganGroup>): ReadonlyArray<PodOrganLine> {
  return groups.map((group) => {
    const latest = group.rounds.at(-1);
    const cells = latest?.cells ?? [];
    const counts = new Map<CellState, number>();
    for (const cell of cells) {
      const state = cellState(cell);
      counts.set(state, (counts.get(state) ?? 0) + 1);
    }
    const parts = CELL_STATE_ORDER.flatMap((state) => {
      const count = counts.get(state);
      return count === undefined ? [] : [`${count} ${state}`];
    });
    return {
      organId: group.organId,
      name: organName(group.presetId),
      dot: foldOrchestrationDots(cells.map((cell) => cell.dot)).dot,
      detail: [...(latest === undefined ? [] : [`r${latest.round}`]), ...parts].join(" · "),
    };
  });
}
