import {
  isParentThreadRelationship,
  type ThreadRelationshipWalkRow,
} from "@t3tools/client-runtime/state/thread-relationships";
import type { OrganLabel, ThreadId } from "@t3tools/contracts";

import { organName } from "./PodSummaryCard.logic";

const SETTLED_EDGE_STATUSES = new Set([
  "completed",
  "failed",
  "error",
  "cancelled",
  "interrupted",
  "idle",
]);

export interface ThreadLineageGroupModel {
  readonly id: string;
  readonly label: string | null;
  readonly rows: ReadonlyArray<ThreadRelationshipWalkRow>;
  readonly expanded: boolean;
  /** Organ headers name a whole group, so their size shows even while open. */
  readonly alwaysShowCount: boolean;
}

/**
 * Related threads, then active agents, then one group per organ, then previous agents. An organ's
 * cells leave the active and previous lists together, so a round that is half finished stays in
 * one place; the group starts open while any cell is still active.
 */
export function threadLineageGroups(
  rows: ReadonlyArray<ThreadRelationshipWalkRow>,
  currentThreadId: ThreadId,
  organOf: (threadId: ThreadId) => OrganLabel | undefined,
): {
  readonly active: ReadonlyArray<ThreadRelationshipWalkRow>;
  readonly groups: ReadonlyArray<ThreadLineageGroupModel>;
} {
  const related: ThreadRelationshipWalkRow[] = [];
  const active: ThreadRelationshipWalkRow[] = [];
  const looseActive: ThreadRelationshipWalkRow[] = [];
  const loosePrevious: ThreadRelationshipWalkRow[] = [];
  const organs = new Map<
    string,
    { presetId: string; round: number; active: boolean; rows: ThreadRelationshipWalkRow[] }
  >();
  for (const row of rows) {
    if (row.edge.kind !== "subagent" || isParentThreadRelationship(row.edge, currentThreadId)) {
      related.push(row);
      continue;
    }
    const isActive = !SETTLED_EDGE_STATUSES.has(row.edge.status ?? "");
    if (isActive) active.push(row);
    const organ = organOf(row.threadId);
    if (organ === undefined) {
      (isActive ? looseActive : loosePrevious).push(row);
      continue;
    }
    const group = organs.get(organ.id);
    if (group === undefined) {
      organs.set(organ.id, {
        presetId: organ.presetId,
        round: organ.round,
        active: isActive,
        rows: [row],
      });
    } else {
      group.round = Math.max(group.round, organ.round);
      group.active ||= isActive;
      group.rows.push(row);
    }
  }
  return {
    active,
    groups: [
      { id: "related", label: null, rows: related, expanded: true, alwaysShowCount: false },
      { id: "active", label: null, rows: looseActive, expanded: true, alwaysShowCount: false },
      ...Array.from(organs, ([id, organ]) => ({
        id: `organ:${id}`,
        label: `${organName(organ.presetId)} · r${organ.round}`,
        rows: organ.rows,
        expanded: organ.active,
        alwaysShowCount: true,
      })),
      {
        id: "previous",
        label: "Previous agents",
        rows: loosePrevious,
        expanded: false,
        alwaysShowCount: false,
      },
    ],
  };
}
