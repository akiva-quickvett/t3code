import { assert, describe, it } from "@effect/vitest";
import { ThreadId, UsageDay, type UsageProviderKind } from "@t3tools/contracts";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { UsageAggregator } from "./usageAggregation.ts";
import type { RateTable } from "./usagePricing.ts";
import {
  buildUsageThreadScope,
  readUsageThreadScopeRows,
  resolveWorkTreeRoot,
  summarizeUsageThreadTree,
  USAGE_THREAD_TREE_MAX_ROWS,
} from "./usageThreadTree.ts";
import {
  seedProviderThread,
  seedThread,
  type SeedProviderThread,
} from "./usageThreadTreeTestRows.ts";

const usageProviderByDriver: ReadonlyMap<string, UsageProviderKind> = new Map([
  ["claudeAgent", "claude"],
  ["codex", "codex"],
]);

const rates: RateTable = new Map([
  [
    "claude-fable-5",
    {
      inputCostPerToken: 1e-5,
      outputCostPerToken: 5e-5,
      cacheReadCostPerToken: 1e-6,
      cacheCreationCostPerToken: 1.25e-5,
      fast: null,
      ultrafast: null,
    },
  ],
]);

const id = ThreadId.make;

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    provider: "claude",
    timestampMs: Date.parse("2026-08-07T04:05:13.944Z"),
    model: "claude-fable-5",
    sessionId: "session-meta",
    totals: {
      uncachedInputTokens: 100,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 20,
      reasoningTokens: 0,
    },
    reportedCostUsd: null,
    speed: "standard",
    dedupeKey: null,
    ...overrides,
  };
}

const scopeFor = (threadId: string) =>
  Effect.gen(function* () {
    const rows = yield* readUsageThreadScopeRows(id(threadId));
    return rows === null ? null : buildUsageThreadScope(id(threadId), rows, usageProviderByDriver);
  });

const T0 = "2026-08-01T00:00:00.000Z";
const at = (minutes: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(Date.parse(T0) + minutes * 60_000));

/**
 * meta supervises a top-level slice; the slice delegated a broker, which delegated a cell. The
 * slice also has a fork, which copies a conversation and is not part of its work.
 */
const seedOrchTree = Effect.gen(function* () {
  yield* seedThread({ id: "meta", createdAt: at(0), preset: "meta" });
  yield* seedThread({
    id: "slice",
    createdAt: at(1),
    preset: "slice",
    supervisorThreadId: "meta",
  });
  yield* seedThread({
    id: "broker",
    createdAt: at(2),
    preset: "broker",
    parentThreadId: "slice",
    relationshipToParent: "subagent",
  });
  yield* seedThread({
    id: "cell",
    createdAt: at(3),
    title: "",
    parentThreadId: "broker",
    relationshipToParent: "subagent",
  });
  yield* seedThread({
    id: "slice-fork",
    createdAt: at(4),
    parentThreadId: "slice",
    relationshipToParent: "fork",
  });
});

describe("resolveWorkTreeRoot", () => {
  it("follows tree parents to the top", () => {
    const parentOf = new Map([
      [id("cell"), id("slice")],
      [id("slice"), id("meta")],
      [id("meta"), null],
    ]);
    assert.strictEqual(resolveWorkTreeRoot(id("cell"), parentOf), "meta");
    assert.strictEqual(resolveWorkTreeRoot(id("meta"), parentOf), "meta");
  });

  it("stops at the last known thread when a parent is missing", () => {
    const parentOf = new Map([
      [id("cell"), id("slice")],
      [id("slice"), id("deleted-meta")],
    ]);
    assert.strictEqual(resolveWorkTreeRoot(id("cell"), parentOf), "slice");
  });

  it("ends on a lineage cycle", () => {
    const parentOf = new Map([
      [id("a"), id("b")],
      [id("b"), id("c")],
      [id("c"), id("a")],
    ]);
    assert.include(["a", "b", "c"], resolveWorkTreeRoot(id("a"), parentOf));
    assert.strictEqual(
      resolveWorkTreeRoot(id("self"), new Map([[id("self"), id("self")]])),
      "self",
    );
  });
});

describe("usage thread scope", () => {
  it.effect("rolls a supervised slice and its subagents up to the supervisor's root", () =>
    Effect.gen(function* () {
      yield* seedOrchTree;
      const slice = yield* scopeFor("slice");
      assert.isNotNull(slice);
      assert.strictEqual(slice!.threadId, "slice");
      assert.strictEqual(slice!.rootThreadId, "meta");
      assert.deepStrictEqual(slice!.rows, [
        { threadId: id("slice"), parentThreadId: null, depth: 0, title: "slice", preset: "slice" },
        {
          threadId: id("broker"),
          parentThreadId: id("slice"),
          depth: 1,
          title: "broker",
          preset: "broker",
        },
        { threadId: id("cell"), parentThreadId: id("broker"), depth: 2 },
      ]);

      const cell = yield* scopeFor("cell");
      assert.strictEqual(cell!.rootThreadId, "meta");
      assert.deepStrictEqual(
        cell!.rows.map((row) => row.threadId),
        ["cell"],
      );

      const meta = yield* scopeFor("meta");
      assert.strictEqual(meta!.rootThreadId, "meta");
      assert.deepStrictEqual(
        meta!.rows.map((row) => [row.threadId, row.depth]),
        [
          ["meta", 0],
          ["slice", 1],
          ["broker", 2],
          ["cell", 3],
        ],
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("keeps a fork out of its origin's tree and roots it at itself", () =>
    Effect.gen(function* () {
      yield* seedOrchTree;
      const fork = yield* scopeFor("slice-fork");
      assert.strictEqual(fork!.rootThreadId, "slice-fork");
      assert.deepStrictEqual(
        fork!.rows.map((row) => row.threadId),
        ["slice-fork"],
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("stops at the last live thread when a supervisor or parent was deleted", () =>
    Effect.gen(function* () {
      yield* seedThread({ id: "gone-meta", createdAt: at(0), deleted: true });
      yield* seedThread({ id: "slice", createdAt: at(1), supervisorThreadId: "gone-meta" });
      yield* seedThread({
        id: "orphan",
        createdAt: at(2),
        parentThreadId: "never-existed",
        relationshipToParent: "subagent",
      });

      assert.strictEqual((yield* scopeFor("slice"))!.rootThreadId, "slice");
      assert.strictEqual((yield* scopeFor("orphan"))!.rootThreadId, "orphan");
      assert.isNull(yield* scopeFor("gone-meta"));
      assert.isNull(yield* scopeFor("no-such-thread"));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("ends on a lineage cycle and lists each thread once", () =>
    Effect.gen(function* () {
      yield* seedThread({ id: "a", createdAt: at(0), supervisorThreadId: "b" });
      yield* seedThread({
        id: "b",
        createdAt: at(1),
        parentThreadId: "a",
        relationshipToParent: "subagent",
      });
      yield* seedThread({
        id: "c",
        createdAt: at(2),
        parentThreadId: "b",
        relationshipToParent: "subagent",
      });

      const scope = yield* scopeFor("a");
      assert.include(["a", "b"], scope!.rootThreadId);
      assert.deepStrictEqual(
        scope!.rows.map((row) => [row.threadId, row.parentThreadId, row.depth]),
        [
          ["a", null, 0],
          ["b", "a", 1],
          ["c", "b", 2],
        ],
      );
      assert.include(["a", "b"], (yield* scopeFor("c"))!.rootThreadId);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("attributes sessions across provider instances, one thread per session", () =>
    Effect.gen(function* () {
      yield* seedOrchTree;
      yield* seedThread({ id: "outsider", createdAt: at(10) });
      const providerThreads: ReadonlyArray<SeedProviderThread> = [
        // Two Claude accounts of this environment, one usage provider.
        {
          id: "pt-slice",
          threadId: "slice",
          driver: "claudeAgent",
          instanceId: "claude_work",
          nativeId: "session-slice",
          createdAt: at(1),
        },
        {
          id: "pt-broker",
          threadId: "broker",
          driver: "claudeAgent",
          instanceId: "claude_personal",
          nativeId: "session-broker",
          createdAt: at(2),
        },
        {
          id: "pt-cell",
          threadId: "cell",
          driver: "codex",
          instanceId: "codex",
          nativeId: "session-cell",
          createdAt: at(3),
        },
        // The cell resumed the broker's session later: the session stays the broker's.
        {
          id: "pt-cell-resumed",
          threadId: "cell",
          driver: "claudeAgent",
          instanceId: "claude_work",
          nativeId: "session-broker",
          createdAt: at(5),
        },
        // A thread outside the tree opened this session first, so the slice never gets it.
        {
          id: "pt-outsider",
          threadId: "outsider",
          driver: "claudeAgent",
          instanceId: "claude_work",
          nativeId: "session-shared",
          createdAt: at(0),
        },
        {
          id: "pt-slice-shared",
          threadId: "slice",
          driver: "claudeAgent",
          instanceId: "claude_work",
          nativeId: "session-shared",
          createdAt: at(11),
        },
        // Same native id under a different usage provider is a different session.
        {
          id: "pt-cell-codex-shared",
          threadId: "cell",
          driver: "codex",
          instanceId: "codex",
          nativeId: "session-shared",
          createdAt: at(12),
        },
        {
          id: "pt-no-native",
          threadId: "broker",
          driver: "claudeAgent",
          instanceId: "claude_work",
          nativeId: null,
          createdAt: at(6),
        },
        // No usage reader for this driver: its sessions are never attributed.
        {
          id: "pt-unread",
          threadId: "broker",
          driver: "acpRegistry",
          instanceId: "acp",
          nativeId: "session-unread",
          createdAt: at(7),
        },
      ];
      for (const providerThread of providerThreads) yield* seedProviderThread(providerThread);

      const scope = (yield* scopeFor("slice"))!;
      const ownerOf = (provider: UsageProviderKind, sessionId: string) =>
        scope.attribute(record({ provider, sessionId }));
      assert.strictEqual(ownerOf("claude", "session-slice"), "slice");
      assert.strictEqual(ownerOf("claude", "session-broker"), "broker");
      assert.strictEqual(ownerOf("codex", "session-cell"), "cell");
      assert.strictEqual(ownerOf("claude", "session-shared"), undefined);
      assert.strictEqual(ownerOf("codex", "session-shared"), "cell");
      assert.strictEqual(ownerOf("codex", "session-slice"), undefined);
      assert.strictEqual(ownerOf("claude", "session-unread"), undefined);
      assert.strictEqual(ownerOf("claude", ""), undefined);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("gives a session shared with an older deleted thread to the live tree thread", () =>
    Effect.gen(function* () {
      yield* seedOrchTree;
      yield* seedThread({ id: "deleted-origin", createdAt: at(0), deleted: true });
      for (const [providerThreadId, threadId, createdAt] of [
        ["pt-deleted-origin", "deleted-origin", at(0)],
        ["pt-slice", "slice", at(5)],
      ] as const) {
        yield* seedProviderThread({
          id: providerThreadId,
          threadId,
          driver: "claudeAgent",
          instanceId: "claude_work",
          nativeId: "session-reused",
          createdAt,
        });
      }
      const scope = (yield* scopeFor("slice"))!;
      assert.strictEqual(scope.attribute(record({ sessionId: "session-reused" })), "slice");
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
});

describe("summarizeUsageThreadTree", () => {
  const SINCE = UsageDay.make("2026-08-01");

  it.effect("flags unpriced records and skips usage outside the tree", () =>
    Effect.gen(function* () {
      yield* seedOrchTree;
      yield* seedThread({ id: "outsider", createdAt: at(10) });
      for (const providerThread of [
        { id: "pt-slice", threadId: "slice", nativeId: "session-slice" },
        { id: "pt-broker", threadId: "broker", nativeId: "session-broker" },
        { id: "pt-outsider", threadId: "outsider", nativeId: "session-outsider" },
      ]) {
        yield* seedProviderThread({
          ...providerThread,
          driver: "claudeAgent",
          instanceId: "claude_work",
          createdAt: at(1),
        });
      }
      const scope = (yield* scopeFor("slice"))!;
      const aggregator = new UsageAggregator({
        timeZone: "UTC",
        sinceDay: "2026-08-01",
        untilDay: "2026-08-31",
        rates,
        attribute: scope.attribute,
      });
      aggregator.add(record({ sessionId: "session-slice", dedupeKey: "msg-1" }));
      aggregator.add(record({ sessionId: "session-broker", dedupeKey: "msg-2" }));
      aggregator.add(
        record({ sessionId: "session-broker", model: "unknown-model", dedupeKey: "msg-3" }),
      );
      aggregator.add(record({ sessionId: "session-outsider", dedupeKey: "msg-4" }));
      aggregator.add(record({ sessionId: "", dedupeKey: "msg-5" }));
      const recordCost = 100 * 1e-5 + 20 * 5e-5;

      const tree = summarizeUsageThreadTree(scope, aggregator.finish().buckets, SINCE);
      assert.strictEqual(tree.threadId, "slice");
      assert.strictEqual(tree.rootThreadId, "meta");
      assert.strictEqual(tree.sinceDay, SINCE);
      assert.deepStrictEqual(
        tree.threads.map((row) => [row.threadId, row.tokens, row.costUsd, row.unpricedRecords]),
        [
          ["slice", 120, recordCost, 0],
          ["broker", 240, recordCost, 1],
          ["cell", 0, 0, 0],
        ],
      );
      assert.strictEqual(tree.tokens, 360);
      assert.closeTo(tree.costUsd, 2 * recordCost, 1e-9);
      assert.strictEqual(tree.unpricedRecords, 1);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it("caps the rows depth-first and still totals every thread", () => {
    const children = USAGE_THREAD_TREE_MAX_ROWS + 5;
    const threads = [
      { threadId: id("root"), parentThreadId: null, title: "root", preset: null, createdAt: at(0) },
      ...Array.from({ length: children }, (_, index) => ({
        threadId: id(`cell-${String(index).padStart(4, "0")}`),
        parentThreadId: id("root"),
        title: "cell",
        preset: null,
        createdAt: at(index + 1),
      })),
    ];
    const last = threads[threads.length - 1]!.threadId;
    const scope = buildUsageThreadScope(
      id("root"),
      {
        ancestors: [{ threadId: id("root"), parentThreadId: null }],
        threads,
        sessionOwners: [{ threadId: last, driver: "claudeAgent", nativeId: "session-last" }],
      },
      usageProviderByDriver,
    );
    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      rates,
      attribute: scope.attribute,
    });
    aggregator.add(record({ sessionId: "session-last" }));

    const tree = summarizeUsageThreadTree(scope, aggregator.finish().buckets, SINCE);
    assert.lengthOf(tree.threads, USAGE_THREAD_TREE_MAX_ROWS);
    assert.strictEqual(tree.threads[0]!.threadId, "root");
    assert.isFalse(tree.threads.some((row) => row.threadId === last));
    assert.strictEqual(tree.omittedThreads, children + 1 - USAGE_THREAD_TREE_MAX_ROWS);
    assert.strictEqual(tree.tokens, 120);
  });

  it.effect("answers zeros for a thread with no usage", () =>
    Effect.gen(function* () {
      yield* seedThread({ id: "idle", createdAt: at(0), preset: "scout" });
      const tree = summarizeUsageThreadTree((yield* scopeFor("idle"))!, [], SINCE);
      assert.deepStrictEqual(tree, {
        threadId: id("idle"),
        rootThreadId: id("idle"),
        sinceDay: SINCE,
        tokens: 0,
        costUsd: 0,
        unpricedRecords: 0,
        threads: [
          {
            threadId: id("idle"),
            parentThreadId: null,
            depth: 0,
            title: "idle",
            preset: "scout",
            tokens: 0,
            costUsd: 0,
            unpricedRecords: 0,
          },
        ],
      });
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
});
