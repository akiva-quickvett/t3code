import type {
  EnvironmentId,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { scopedThreadKey, scopeThreadRef } from "../environment/scoped.ts";

export type ThreadRelationshipKind = "parent" | "fork" | "subagent" | "supervised" | "transfer";

export interface ThreadRelationshipNode {
  readonly threadId: ThreadId;
  readonly thread: OrchestrationV2ThreadShell | null;
  readonly missing: boolean;
}

export interface ThreadRelationshipEdge {
  readonly sourceThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly kind: ThreadRelationshipKind;
  readonly status: string | null;
}

export interface ThreadRelationshipGraph {
  readonly nodes: ReadonlyMap<ThreadId, ThreadRelationshipNode>;
  readonly edges: ReadonlyArray<ThreadRelationshipEdge>;
}

export interface ThreadRelationshipWalkRow {
  readonly threadId: ThreadId;
  readonly fromThreadId: ThreadId;
  readonly depth: number;
  readonly edge: ThreadRelationshipEdge;
}

export function resolveMergeBackTargetThreadId(
  projection: Pick<OrchestrationV2ThreadProjection, "thread"> | null,
): ThreadId | null {
  if (projection?.thread.lineage.relationshipToParent !== "fork") return null;
  return projection.thread.forkedFrom?.type === "run"
    ? projection.thread.forkedFrom.threadId
    : projection.thread.lineage.parentThreadId;
}

function edgeKey(edge: ThreadRelationshipEdge): string {
  return `${edge.sourceThreadId}\u001f${edge.targetThreadId}\u001f${edge.kind}`;
}

export function deriveThreadRelationshipGraph(input: {
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly projection: OrchestrationV2ThreadProjection | null;
}): ThreadRelationshipGraph {
  const threadsById = new Map<ThreadId, OrchestrationV2ThreadShell>();
  for (const thread of input.threads) {
    // Callers order shells from most to least authoritative. In particular,
    // live shells precede archived snapshots, which may still contain a stale
    // copy during archive refresh.
    if (!threadsById.has(thread.id)) {
      threadsById.set(thread.id, thread);
    }
  }
  const threads = [...threadsById.values()];
  const nodes = new Map<ThreadId, ThreadRelationshipNode>(
    threads.map((thread) => [thread.id, { threadId: thread.id, thread, missing: false }]),
  );
  const edgesByKey = new Map<string, ThreadRelationshipEdge>();
  const ensureNode = (threadId: ThreadId) => {
    if (!nodes.has(threadId)) {
      nodes.set(threadId, { threadId, thread: null, missing: true });
    }
  };
  const addEdge = (edge: ThreadRelationshipEdge) => {
    ensureNode(edge.sourceThreadId);
    ensureNode(edge.targetThreadId);
    edgesByKey.set(
      edgeKey(edge),
      edge.kind === "subagent" && edge.status === "rolled_back"
        ? { ...edge, status: "interrupted" }
        : edge,
    );
  };

  for (const thread of threads) {
    const status = thread.activityRunStatus ?? thread.status;
    const supervisorThreadId = thread.lineage.supervisorThreadId;
    if (supervisorThreadId !== undefined) {
      addEdge({
        sourceThreadId: supervisorThreadId,
        targetThreadId: thread.id,
        kind: "supervised",
        status,
      });
    }
    const parentThreadId =
      thread.forkedFrom?.type === "run"
        ? thread.forkedFrom.threadId
        : thread.lineage.parentThreadId;
    if (parentThreadId === null) continue;
    addEdge({
      sourceThreadId: parentThreadId,
      targetThreadId: thread.id,
      kind: thread.lineage.relationshipToParent === "subagent" ? "subagent" : "fork",
      status,
    });
  }

  if (input.projection !== null) {
    const ownerThreadId = input.projection.thread.id;
    for (const subagent of input.projection.subagents) {
      // A supervised thread's tasks only track its runs; its lineage edge already names it.
      if (subagent.childThreadId === null || subagent.supervised) continue;
      const child = threadsById.get(subagent.childThreadId);
      addEdge({
        sourceThreadId: ownerThreadId,
        targetThreadId: subagent.childThreadId,
        kind: "subagent",
        status:
          child?.activityRunStatus ?? (child?.latestRunId != null ? child.status : subagent.status),
      });
    }
    for (const transfer of input.projection.contextTransfers) {
      if (transfer.sourceThreadId === transfer.targetThreadId) continue;
      addEdge({
        sourceThreadId: transfer.sourceThreadId,
        targetThreadId: transfer.targetThreadId,
        kind: "transfer",
        status: transfer.status,
      });
    }
  }

  return { nodes, edges: [...edgesByKey.values()] };
}

export function relatedThreadIds(
  graph: ThreadRelationshipGraph,
  threadId: ThreadId,
): ReadonlyArray<ThreadId> {
  const ids = new Set<ThreadId>();
  for (const edge of graph.edges) {
    if (edge.sourceThreadId === threadId) ids.add(edge.targetThreadId);
    if (edge.targetThreadId === threadId) ids.add(edge.sourceThreadId);
  }
  return [...ids];
}

export function walkThreadRelationships(
  graph: ThreadRelationshipGraph,
  threadId: ThreadId,
): ReadonlyArray<ThreadRelationshipWalkRow> {
  const visited = new Set<ThreadId>([threadId]);
  const pending: Array<{ readonly threadId: ThreadId; readonly depth: number }> = [
    { threadId, depth: 0 },
  ];
  const rows: ThreadRelationshipWalkRow[] = [];

  for (let index = 0; index < pending.length; index += 1) {
    const current = pending[index];
    if (current === undefined) continue;
    for (const edge of graph.edges) {
      const relatedId =
        edge.sourceThreadId === current.threadId
          ? edge.targetThreadId
          : edge.targetThreadId === current.threadId
            ? edge.sourceThreadId
            : null;
      if (relatedId === null || visited.has(relatedId)) continue;
      visited.add(relatedId);
      const depth = current.depth + 1;
      rows.push({ threadId: relatedId, fromThreadId: current.threadId, depth, edge });
      pending.push({ threadId: relatedId, depth });
    }
  }

  return rows;
}

export function immediateThreadRelationships(
  graph: ThreadRelationshipGraph,
  threadId: ThreadId,
): ReadonlyArray<ThreadRelationshipWalkRow> {
  const visited = new Set<ThreadId>();
  const rows: ThreadRelationshipWalkRow[] = [];

  for (const edge of graph.edges) {
    const relatedId =
      edge.sourceThreadId === threadId
        ? edge.targetThreadId
        : edge.targetThreadId === threadId
          ? edge.sourceThreadId
          : null;
    if (relatedId === null || visited.has(relatedId)) continue;
    visited.add(relatedId);
    rows.push({ threadId: relatedId, fromThreadId: threadId, depth: 1, edge });
  }

  return rows;
}

export function isParentThreadRelationship(
  edge: ThreadRelationshipEdge,
  currentThreadId: ThreadId,
): boolean {
  return edge.kind !== "transfer" && edge.targetThreadId === currentThreadId;
}

export function threadRelationshipRowStatus(
  graph: ThreadRelationshipGraph,
  row: Pick<ThreadRelationshipWalkRow, "threadId" | "edge">,
): string | null {
  if (row.edge.kind === "transfer" || row.threadId === row.edge.targetThreadId) {
    return row.edge.status;
  }
  const thread = graph.nodes.get(row.threadId)?.thread;
  return thread?.activityRunStatus ?? thread?.status ?? null;
}

function threadCreatedAtMillis(node: ThreadRelationshipNode | undefined): number | null {
  const createdAt: unknown = node?.thread?.createdAt;
  if (!DateTime.isDateTime(createdAt)) return null;
  const millis = DateTime.toEpochMillis(createdAt);
  return Number.isFinite(millis) ? millis : null;
}

/**
 * Web-specific by design: the panel pins the parent row first and a distinct
 * merge-back target second so their actions stay where the user expects, and
 * only then falls back to newest-created-first. Mobile does not share that
 * exception, so this is not the canonical relationship order and should not be
 * reused as one.
 */
export function orderWebThreadLineageRows(input: {
  readonly graph: ThreadRelationshipGraph;
  readonly rows: ReadonlyArray<ThreadRelationshipWalkRow>;
  readonly currentThreadId: ThreadId;
  readonly mergeTargetThreadId: ThreadId | null;
}): ReadonlyArray<ThreadRelationshipWalkRow> {
  const pinRank = (row: ThreadRelationshipWalkRow): number => {
    if (isParentThreadRelationship(row.edge, input.currentThreadId)) return 0;
    if (row.threadId === input.mergeTargetThreadId) return 1;
    return 2;
  };

  return [...input.rows].sort((left, right) => {
    const rankDelta = pinRank(left) - pinRank(right);
    if (rankDelta !== 0) return rankDelta;
    const leftCreatedAt = threadCreatedAtMillis(input.graph.nodes.get(left.threadId));
    const rightCreatedAt = threadCreatedAtMillis(input.graph.nodes.get(right.threadId));
    if (leftCreatedAt !== rightCreatedAt) {
      if (leftCreatedAt === null) return 1;
      if (rightCreatedAt === null) return -1;
      return rightCreatedAt - leftCreatedAt;
    }
    return left.threadId < right.threadId ? -1 : left.threadId > right.threadId ? 1 : 0;
  });
}

type AgentTreeLineage = Pick<
  OrchestrationV2ThreadShell["lineage"],
  "parentThreadId" | "relationshipToParent" | "supervisorThreadId"
>;

export interface AgentTreeThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  /** ISO timestamp; siblings are ordered by it. */
  readonly createdAt: string;
  readonly lineage: AgentTreeLineage;
}

export interface AgentTree<T extends AgentTreeThread> {
  /** Every thread with no parent in the tree, in the caller's order. */
  readonly roots: ReadonlyArray<T>;
  /** Children by parent key, oldest first. */
  readonly childrenByKey: ReadonlyMap<string, ReadonlyArray<T>>;
  readonly parentKeyByKey: ReadonlyMap<string, string>;
}

export interface AgentTreeRow<T extends AgentTreeThread> {
  readonly thread: T;
  readonly key: string;
  readonly depth: number;
  readonly childCount: number;
  readonly expanded: boolean;
}

/**
 * The thread an agent tree nests this one under: the thread that delegated it,
 * or the thread supervising it. A supervised thread is top-level everywhere
 * else, so `supervisorThreadId` is the only edge that puts it in the tree.
 * Forks stay at the top level.
 */
export function agentTreeParentThreadId(thread: { readonly lineage: AgentTreeLineage }) {
  if (thread.lineage.relationshipToParent === "subagent") return thread.lineage.parentThreadId;
  return thread.lineage.supervisorThreadId ?? null;
}

/**
 * The thread "Go to parent" opens: the thread this one was delegated or forked
 * from, else its supervisor.
 */
export function navigationParentThreadId(
  thread: Pick<OrchestrationV2ThreadShell, "forkedFrom"> & { readonly lineage: AgentTreeLineage },
): ThreadId | null {
  const parentThreadId =
    thread.forkedFrom?.type === "run" ? thread.forkedFrom.threadId : thread.lineage.parentThreadId;
  return parentThreadId ?? thread.lineage.supervisorThreadId ?? null;
}

function agentTreeKey(thread: Pick<AgentTreeThread, "environmentId" | "id">): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

function compareAgentTreeSiblings(left: AgentTreeThread, right: AgentTreeThread): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * Nests threads under their agent parent. A thread whose parent is not in
 * `threads` (deleted, archived, filtered out) is a root, and so is the first
 * thread of any cycle in the lineage data, so every thread appears exactly once.
 */
export function deriveAgentTree<T extends AgentTreeThread>(
  threads: ReadonlyArray<T>,
): AgentTree<T> {
  const byKey = new Map<string, T>();
  for (const thread of threads) {
    const key = agentTreeKey(thread);
    if (!byKey.has(key)) byKey.set(key, thread);
  }
  const childrenByKey = new Map<string, T[]>();
  const parentKeyByKey = new Map<string, string>();
  const rootKeys = new Set<string>();
  for (const [key, thread] of byKey) {
    const parentThreadId = agentTreeParentThreadId(thread);
    const parentKey =
      parentThreadId === null
        ? null
        : agentTreeKey({ environmentId: thread.environmentId, id: parentThreadId });
    if (parentKey === null || parentKey === key || !byKey.has(parentKey)) {
      rootKeys.add(key);
      continue;
    }
    parentKeyByKey.set(key, parentKey);
    const siblings = childrenByKey.get(parentKey);
    if (siblings === undefined) childrenByKey.set(parentKey, [thread]);
    else siblings.push(thread);
  }

  const reached = new Set<string>();
  const reachFrom = (rootKey: string) => {
    const pending = [rootKey];
    for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
      reached.add(key);
      for (const child of childrenByKey.get(key) ?? []) pending.push(agentTreeKey(child));
    }
  };
  for (const key of rootKeys) reachFrom(key);
  // Whatever no root reaches hangs off a cycle. Cutting the edge into its first
  // thread makes that thread a root and the rest of the cycle its descendants.
  if (reached.size < byKey.size) {
    for (const [key, thread] of byKey) {
      if (reached.has(key)) continue;
      const parentKey = parentKeyByKey.get(key)!;
      parentKeyByKey.delete(key);
      const siblings = childrenByKey.get(parentKey)!;
      siblings.splice(siblings.indexOf(thread), 1);
      rootKeys.add(key);
      reachFrom(key);
    }
  }

  for (const siblings of childrenByKey.values()) siblings.sort(compareAgentTreeSiblings);
  return {
    roots: [...byKey].flatMap(([key, thread]) => (rootKeys.has(key) ? [thread] : [])),
    childrenByKey,
    parentKeyByKey,
  };
}

/**
 * The rows shown for `roots`: each root, then its descendants depth-first while
 * their parent is expanded. Children are collapsed unless `isExpanded` says so.
 */
export function flattenAgentTree<T extends AgentTreeThread>(
  tree: Pick<AgentTree<T>, "childrenByKey">,
  roots: ReadonlyArray<T>,
  isExpanded: (key: string) => boolean,
): ReadonlyArray<AgentTreeRow<T>> {
  const rows: AgentTreeRow<T>[] = [];
  const pending: Array<{ readonly thread: T; readonly depth: number }> = roots
    .map((thread) => ({ thread, depth: 0 }))
    .reverse();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const key = agentTreeKey(next.thread);
    const children = tree.childrenByKey.get(key) ?? [];
    const expanded = children.length > 0 && isExpanded(key);
    rows.push({ ...next, key, childCount: children.length, expanded });
    if (!expanded) continue;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push({ thread: children[index]!, depth: next.depth + 1 });
    }
  }
  return rows;
}

/** The thread's agent ancestors, nearest first, stopping at a missing thread or a cycle. */
export function agentTreeAncestorIds(
  threadId: ThreadId,
  lookup: (threadId: ThreadId) => { readonly lineage: AgentTreeLineage } | null,
): ReadonlyArray<ThreadId> {
  const ancestors: ThreadId[] = [];
  const seen = new Set<ThreadId>([threadId]);
  let current = lookup(threadId);
  while (current !== null) {
    const parentThreadId = agentTreeParentThreadId(current);
    if (parentThreadId === null || seen.has(parentThreadId)) break;
    seen.add(parentThreadId);
    ancestors.push(parentThreadId);
    current = lookup(parentThreadId);
  }
  return ancestors;
}
