import {
  ThreadId,
  type UsageDay,
  type UsageProviderKind,
  type UsageThreadTree,
  type UsageThreadTreeRow,
} from "@t3tools/contracts";
import { totalTokens, type UsageRecord } from "@t3tools/provider-core/server/usage";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { PROJECTION_THREAD_TREE_PARENT } from "../persistence/Migrations/066_ProjectionThreadTreeParentIndex.ts";
import { roundUsd, type AttributedUsageBucket } from "./usageAggregation.ts";

interface TreeThreadRow {
  readonly threadId: ThreadId;
  readonly parentThreadId: ThreadId | null;
  readonly title: string;
  readonly preset: string | null;
  readonly createdAt: string;
}

interface SessionOwnerRow {
  readonly threadId: ThreadId;
  readonly driver: string;
  readonly nativeId: string;
}

export interface UsageThreadScopeRows {
  /** The thread and its live ancestors, each with its tree parent. */
  readonly ancestors: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly parentThreadId: ThreadId | null;
  }>;
  /** The thread and its live descendants. */
  readonly threads: ReadonlyArray<TreeThreadRow>;
  /**
   * Every provider thread, in any thread, that shares a native session id with one in the tree,
   * live threads first, then oldest first: a session belongs to the thread that opened it, unless
   * that thread was deleted and a live one shares it.
   */
  readonly sessionOwners: ReadonlyArray<SessionOwnerRow>;
}

export const readUsageThreadScopeRows = Effect.fn("readUsageThreadScopeRows")(function* (
  threadId: ThreadId,
) {
  const sql = yield* SqlClient.SqlClient;
  const parent = sql.literal(PROJECTION_THREAD_TREE_PARENT);
  // UNION, not UNION ALL, so a cycle in the lineage ends the walk instead of looping.
  const ancestors = yield* sql<{
    readonly thread_id: string;
    readonly parent_thread_id: string | null;
  }>`
    WITH RECURSIVE up(id) AS (
      SELECT ${threadId}
      UNION
      SELECT ${parent} FROM up, orchestration_v2_projection_threads
      WHERE thread_id = up.id AND deleted_at IS NULL AND ${parent} IS NOT NULL
    )
    SELECT thread_id, ${parent} AS parent_thread_id
    FROM orchestration_v2_projection_threads
    WHERE thread_id IN (SELECT id FROM up) AND deleted_at IS NULL
  `;
  if (!ancestors.some((row) => row.thread_id === threadId)) return null;
  // The unary plus lets SQLite look each step up in the tree-parent index (see getWorkTreeNodes).
  const threads = yield* sql<{
    readonly thread_id: string;
    readonly parent_thread_id: string | null;
    readonly title: string;
    readonly preset: string | null;
    readonly created_at: string;
  }>`
    WITH RECURSIVE tree(id) AS (
      SELECT ${threadId}
      UNION
      SELECT thread_id FROM tree, orchestration_v2_projection_threads
      WHERE ${parent} = +tree.id AND deleted_at IS NULL
    )
    SELECT
      thread_id,
      ${parent} AS parent_thread_id,
      title,
      CASE WHEN json_valid(payload_json)
        THEN json_extract(payload_json, '$.rolePreset.id') END AS preset,
      created_at
    FROM orchestration_v2_projection_threads
    WHERE thread_id IN (SELECT id FROM tree) AND deleted_at IS NULL
  `;
  // Holders outside the tree are read too, so a shared session still counts once. Without an
  // index on the native id that is a scan, so it reads one JSON field per row.
  // CASE, not AND: SQLite may evaluate AND terms in any order, and one malformed payload must not
  // fail the read.
  const jsonField = (payload: string, path: string) =>
    sql.literal(`CASE WHEN json_valid(${payload}) THEN json_extract(${payload}, '${path}') END`);
  const nativeIdOf = (payload: string) => jsonField(payload, "$.nativeThreadRef.nativeId");
  const sessionOwners = yield* sql<{
    readonly thread_id: string;
    readonly driver: string;
    readonly native_id: string;
  }>`
    WITH tree_sessions AS (
      SELECT driver, ${nativeIdOf("payload_json")} AS native_id
      FROM orchestration_v2_projection_provider_threads
      WHERE thread_id IN ${sql.in(threads.map((row) => row.thread_id))}
        AND ${nativeIdOf("payload_json")} IS NOT NULL
    )
    SELECT holders.thread_id, holders.driver, ${nativeIdOf("holders.payload_json")} AS native_id
    FROM orchestration_v2_projection_provider_threads AS holders
    LEFT JOIN orchestration_v2_projection_threads AS threads
      ON threads.thread_id = holders.thread_id
    WHERE holders.thread_id IS NOT NULL
      AND (holders.driver, ${nativeIdOf("holders.payload_json")}) IN (
        SELECT driver, native_id FROM tree_sessions
      )
    ORDER BY
      threads.deleted_at IS NOT NULL,
      ${jsonField("holders.payload_json", "$.createdAt")} ASC,
      holders.provider_thread_id ASC
  `;
  return {
    ancestors: ancestors.map((row) => ({
      threadId: ThreadId.make(row.thread_id),
      parentThreadId: row.parent_thread_id === null ? null : ThreadId.make(row.parent_thread_id),
    })),
    threads: threads.map((row) => ({
      threadId: ThreadId.make(row.thread_id),
      parentThreadId: row.parent_thread_id === null ? null : ThreadId.make(row.parent_thread_id),
      title: row.title,
      preset: row.preset,
      createdAt: row.created_at,
    })),
    sessionOwners: sessionOwners.map((row) => ({
      threadId: ThreadId.make(row.thread_id),
      driver: row.driver,
      nativeId: row.native_id,
    })),
  } satisfies UsageThreadScopeRows;
});

/**
 * Walks up the tree parents. `parentOf` holds only live threads, so the walk stops at the last
 * one whose parent was deleted or never existed, and at the first thread it would revisit.
 */
export function resolveWorkTreeRoot(
  threadId: ThreadId,
  parentOf: ReadonlyMap<ThreadId, ThreadId | null>,
): ThreadId {
  const seen = new Set([threadId]);
  let current = threadId;
  for (;;) {
    const parent = parentOf.get(current);
    if (parent == null || !parentOf.has(parent) || seen.has(parent)) return current;
    seen.add(parent);
    current = parent;
  }
}

export interface UsageThreadScope {
  readonly threadId: ThreadId;
  readonly rootThreadId: ThreadId;
  /** Depth-first from `threadId`, without usage yet. */
  readonly rows: ReadonlyArray<Omit<UsageThreadTreeRow, "tokens" | "costUsd" | "unpricedRecords">>;
  readonly oldestCreatedAt: string;
  readonly attribute: (record: UsageRecord) => ThreadId | undefined;
}

const sessionKey = (provider: UsageProviderKind, sessionId: string) =>
  `${provider}\u0000${sessionId}`;

export function buildUsageThreadScope(
  threadId: ThreadId,
  rows: UsageThreadScopeRows,
  usageProviderByDriver: ReadonlyMap<string, UsageProviderKind>,
): UsageThreadScope {
  const rootThreadId = resolveWorkTreeRoot(
    threadId,
    new Map(rows.ancestors.map((row) => [row.threadId, row.parentThreadId])),
  );
  const children = new Map<ThreadId, TreeThreadRow[]>();
  for (const row of rows.threads) {
    if (row.parentThreadId === null) continue;
    const siblings = children.get(row.parentThreadId) ?? [];
    siblings.push(row);
    children.set(row.parentThreadId, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.threadId.localeCompare(b.threadId),
    );
  }

  const start = rows.threads.find((row) => row.threadId === threadId);
  const ordered: Array<UsageThreadScope["rows"][number]> = [];
  let oldestCreatedAt = start?.createdAt ?? "";
  // A lineage cycle can make the thread its own descendant; `visited` keeps every thread once.
  const visited = new Set<ThreadId>();
  const visit = (row: TreeThreadRow, parentThreadId: ThreadId | null, depth: number) => {
    if (visited.has(row.threadId)) return;
    visited.add(row.threadId);
    if (row.createdAt < oldestCreatedAt) oldestCreatedAt = row.createdAt;
    ordered.push({
      threadId: row.threadId,
      parentThreadId,
      depth,
      ...(row.title.length === 0 ? {} : { title: row.title }),
      ...(row.preset === null ? {} : { preset: row.preset }),
    });
    for (const child of children.get(row.threadId) ?? []) visit(child, row.threadId, depth + 1);
  };
  if (start !== undefined) visit(start, null, 0);

  const sessions = new Map<string, ThreadId>();
  const claimed = new Set<string>();
  for (const owner of rows.sessionOwners) {
    const provider = usageProviderByDriver.get(owner.driver);
    if (provider === undefined) continue;
    const key = sessionKey(provider, owner.nativeId);
    if (claimed.has(key)) continue;
    claimed.add(key);
    if (visited.has(owner.threadId)) sessions.set(key, owner.threadId);
  }

  return {
    threadId,
    rootThreadId,
    rows: ordered,
    oldestCreatedAt,
    attribute: (record) =>
      record.sessionId.length === 0
        ? undefined
        : sessions.get(sessionKey(record.provider, record.sessionId)),
  };
}

/** Keeps an agent's context and the dialog small; totals still cover every thread. */
export const USAGE_THREAD_TREE_MAX_ROWS = 200;

export function summarizeUsageThreadTree(
  scope: UsageThreadScope,
  buckets: ReadonlyArray<AttributedUsageBucket>,
  sinceDay: UsageDay,
): UsageThreadTree {
  const usage = new Map<ThreadId, { tokens: number; costUsd: number; unpricedRecords: number }>();
  for (const bucket of buckets) {
    if (bucket.threadId === undefined) continue;
    const sum = usage.get(bucket.threadId) ?? { tokens: 0, costUsd: 0, unpricedRecords: 0 };
    sum.tokens += totalTokens(bucket.totals);
    sum.costUsd += bucket.costUsd;
    sum.unpricedRecords += bucket.unpricedRecords;
    usage.set(bucket.threadId, sum);
  }
  const threads = scope.rows.slice(0, USAGE_THREAD_TREE_MAX_ROWS).map((row): UsageThreadTreeRow => {
    const sum = usage.get(row.threadId);
    return {
      ...row,
      tokens: sum?.tokens ?? 0,
      costUsd: roundUsd(sum?.costUsd ?? 0),
      unpricedRecords: sum?.unpricedRecords ?? 0,
    };
  });
  let tokens = 0;
  let costUsd = 0;
  let unpricedRecords = 0;
  for (const sum of usage.values()) {
    tokens += sum.tokens;
    costUsd += sum.costUsd;
    unpricedRecords += sum.unpricedRecords;
  }
  return {
    threadId: scope.threadId,
    rootThreadId: scope.rootThreadId,
    sinceDay,
    tokens,
    costUsd: roundUsd(costUsd),
    unpricedRecords,
    threads,
    ...(scope.rows.length > threads.length
      ? { omittedThreads: scope.rows.length - threads.length }
      : {}),
  };
}
