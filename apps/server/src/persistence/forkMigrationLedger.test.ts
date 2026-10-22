import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { forkMigrationEntries } from "./ForkMigrations.ts";
import { migrationEntries, migrationManifest, runMigrations } from "./Migrations.ts";

const LAST_SHARED_UPSTREAM_ID = 64;
const forkManifest = forkMigrationEntries.map(([id, name]) => [id, name] as const);

// How fork builds before the separate ledger recorded their migrations in effect_sql_migrations.
const legacyForkLayout = [
  [65, "ScheduledTaskActions", "2026-08-01 00:00:00"],
  [66, "ProjectionThreadTreeParentIndex", "2026-08-02 00:00:00"],
  [67, "ChatChannels", "2026-08-03 00:00:00"],
  [68, "PodRuntimes", "2026-08-04 00:00:00"],
] as const;

const ledger = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const exists =
      yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}`;
    if (exists.length === 0) return [];
    return yield* sql<{
      readonly migration_id: number;
      readonly name: string;
      readonly created_at: string;
    }>`SELECT migration_id, name, created_at FROM ${sql(table)} ORDER BY migration_id`;
  });

const history = (table: string) =>
  Effect.map(ledger(table), (rows) => rows.map((row) => [row.migration_id, row.name] as const));

const mainHistory = history("effect_sql_migrations");
const forkHistory = history("fork_effect_sql_migrations");

const schemaObject = (type: "table" | "index", name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`SELECT name FROM sqlite_master WHERE type = ${type} AND name = ${name}`;
    return rows.length === 1;
  });

const hasActionJsonColumn = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scheduled_tasks)`;
  return columns.some((column) => column.name === "action_json");
});

// One artefact each fork migration creates, in fork id order.
const forkArtefacts = Effect.all([
  hasActionJsonColumn,
  schemaObject("index", "orchestration_v2_projection_threads_tree_parent_idx"),
  schemaObject("table", "chat_channels"),
  schemaObject("table", "pod_runtimes"),
]);

/**
 * The database as live fork nodes hold it today: upstream through 64, then the fork migration
 * bodies applied by the same migrator and recorded in the main ledger at 65.., with distinct
 * timestamps so a later copy can be told apart from a fresh insert.
 */
const seedLegacyForkDatabase = (count: number = legacyForkLayout.length) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: LAST_SHARED_UPSTREAM_ID });
    const layout = legacyForkLayout.slice(0, count);
    const executed = yield* Migrator.make({})({
      loader: Migrator.fromRecord(
        Object.fromEntries(
          layout.map(([id, name]) => [
            `${id}_${name}`,
            forkMigrationEntries.find((entry) => entry[1] === name)![2],
          ]),
        ),
      ),
    });
    assert.deepStrictEqual(
      executed,
      layout.map(([id, name]) => [id, name]),
    );
    for (const [id, , createdAt] of layout) {
      yield* sql`UPDATE effect_sql_migrations SET created_at = ${createdAt} WHERE migration_id = ${id}`;
    }
  });

const marker = (name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(`CREATE TABLE ${name}_marker (id INTEGER)`);
  });

// Stand-ins for upstream's next migrations, loaded the way runMigrations loads the main ledger.
const upstreamStubs = [
  [65, "CodexUsageNativeTurnIndex"],
  [66, "RepairClientSettlementTimestamps"],
  [67, "WebhookDedupe"],
] as const;

const runMainLedgerWithUpstreamStubs = Migrator.make({})({
  loader: Migrator.fromRecord({
    ...Object.fromEntries(
      migrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
    ...Object.fromEntries(upstreamStubs.map(([id, name]) => [`${id}_${name}`, marker(name)])),
  }),
});

const upstreamStubMarkers = Effect.all(
  upstreamStubs.map(([, name]) => schemaObject("table", `${name}_marker`)),
);

const migrationsAfterSharedUpstream = migrationManifest.filter(
  ([id]) => id > LAST_SHARED_UPSTREAM_ID,
);

const sqlite = NodeSqliteClient.layer({ filename: ":memory:" });

describe("fork migration ledger", () => {
  it.effect("migrates a fresh database into separate main and fork ledgers", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* runMigrations(), migrationManifest);
      assert.deepStrictEqual(yield* mainHistory, migrationManifest);
      assert.deepStrictEqual(yield* forkHistory, [
        [1, "ScheduledTaskActions"],
        [2, "ProjectionThreadTreeParentIndex"],
        [3, "ChatChannels"],
        [4, "PodRuntimes"],
      ]);
      assert.deepStrictEqual(yield* forkArtefacts, [true, true, true, true]);

      const main = yield* ledger("effect_sql_migrations");
      const fork = yield* ledger("fork_effect_sql_migrations");
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* ledger("effect_sql_migrations"), main);
      assert.deepStrictEqual(yield* ledger("fork_effect_sql_migrations"), fork);
    }).pipe(Effect.provide(sqlite)),
  );

  it.effect("moves a legacy fork history into the fork ledger without re-running it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedLegacyForkDatabase();
      yield* sql`
        INSERT INTO chat_channels (channel_id, config_json, created_at)
        VALUES ('sentinel', '{}', '2026-08-05')
      `;
      // Each body would recreate its artefact if it ran again.
      yield* sql`ALTER TABLE scheduled_tasks DROP COLUMN action_json`;
      yield* sql`DROP INDEX orchestration_v2_projection_threads_tree_parent_idx`;
      yield* sql`DROP TABLE chat_settings`;
      yield* sql`DROP TABLE pod_runtimes`;

      assert.deepStrictEqual(yield* runMigrations(), migrationsAfterSharedUpstream);

      assert.deepStrictEqual(yield* mainHistory, migrationManifest);
      assert.deepStrictEqual(
        yield* ledger("fork_effect_sql_migrations"),
        legacyForkLayout.map(([id, name, created_at]) => ({
          migration_id: id - LAST_SHARED_UPSTREAM_ID,
          name,
          created_at,
        })),
      );
      assert.deepStrictEqual(yield* forkArtefacts, [false, false, true, false]);
      assert.isFalse(yield* schemaObject("table", "chat_settings"));
      assert.deepStrictEqual(yield* sql`SELECT channel_id FROM chat_channels`, [
        { channel_id: "sentinel" },
      ]);

      const fork = yield* ledger("fork_effect_sql_migrations");
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* mainHistory, migrationManifest);
      assert.deepStrictEqual(yield* ledger("fork_effect_sql_migrations"), fork);
    }).pipe(Effect.provide(sqlite)),
  );

  it.effect("moves a partial legacy fork history and runs the rest fresh", () =>
    Effect.gen(function* () {
      yield* seedLegacyForkDatabase(2);
      assert.deepStrictEqual(yield* forkArtefacts, [true, true, false, false]);

      assert.deepStrictEqual(yield* runMigrations(), migrationsAfterSharedUpstream);

      assert.deepStrictEqual(yield* mainHistory, migrationManifest);
      assert.deepStrictEqual(yield* forkHistory, forkManifest);
      const fork = yield* ledger("fork_effect_sql_migrations");
      assert.deepStrictEqual(
        fork.slice(0, 2).map((row) => row.created_at),
        ["2026-08-01 00:00:00", "2026-08-02 00:00:00"],
      );
      assert.deepStrictEqual(yield* forkArtefacts, [true, true, true, true]);
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* ledger("fork_effect_sql_migrations"), fork);
    }).pipe(Effect.provide(sqlite)),
  );

  it.effect.each(["CodexUsageNativeTurnIndex", "ChatChannels"])(
    "leaves %s recorded at 65 in the main ledger",
    (name) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: LAST_SHARED_UPSTREAM_ID });
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name, created_at)
          VALUES (65, ${name}, '2026-09-01 00:00:00')
        `;

        assert.deepStrictEqual(yield* runMigrations(), []);

        assert.deepStrictEqual(
          yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id = 65`,
          [{ migration_id: 65, name, created_at: "2026-09-01 00:00:00" }],
        );
        assert.deepStrictEqual(yield* forkHistory, forkManifest);
        assert.deepStrictEqual(yield* forkArtefacts, [true, true, true, true]);
      }).pipe(Effect.provide(sqlite)),
  );

  it.effect.each([54, LAST_SHARED_UPSTREAM_ID])(
    "a run bounded at %s leaves a legacy fork history in place",
    (toMigrationInclusive) =>
      Effect.gen(function* () {
        yield* seedLegacyForkDatabase();
        const main = yield* ledger("effect_sql_migrations");

        assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive }), []);

        assert.deepStrictEqual(yield* ledger("effect_sql_migrations"), main);
        assert.isFalse(yield* schemaObject("table", "fork_effect_sql_migrations"));
      }).pipe(Effect.provide(sqlite)),
  );

  it.effect("rolls the move back when it fails part way and retries cleanly", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedLegacyForkDatabase();
      const main = yield* ledger("effect_sql_migrations");
      yield* sql`
        CREATE TABLE fork_effect_sql_migrations (
          migration_id integer PRIMARY KEY NOT NULL,
          created_at datetime NOT NULL DEFAULT current_timestamp,
          name VARCHAR(255) NOT NULL
        )
      `;
      yield* sql`
        CREATE TRIGGER fail_fork_move BEFORE INSERT ON fork_effect_sql_migrations
        WHEN NEW.migration_id = 3
        BEGIN SELECT RAISE(ABORT, 'injected failure'); END
      `;

      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(yield* ledger("effect_sql_migrations"), main);
      assert.deepStrictEqual(yield* forkHistory, []);

      yield* sql`DROP TRIGGER fail_fork_move`;
      assert.deepStrictEqual(yield* runMigrations(), migrationsAfterSharedUpstream);
      assert.deepStrictEqual(yield* mainHistory, migrationManifest);
      assert.deepStrictEqual(yield* forkHistory, forkManifest);
    }).pipe(Effect.provide(sqlite)),
  );

  describe("upstream migrations after 64", () => {
    it.effect("apply normally once the legacy fork history is moved", () =>
      Effect.gen(function* () {
        yield* seedLegacyForkDatabase();
        yield* runMigrations();
        const fork = yield* ledger("fork_effect_sql_migrations");

        assert.deepStrictEqual(yield* runMainLedgerWithUpstreamStubs, upstreamStubs);

        assert.deepStrictEqual(yield* mainHistory, [...migrationManifest, ...upstreamStubs]);
        assert.deepStrictEqual(yield* upstreamStubMarkers, [true, true, true]);
        assert.deepStrictEqual(yield* ledger("fork_effect_sql_migrations"), fork);
      }).pipe(Effect.provide(sqlite)),
    );

    // Why the move exists: the migrator skips every id up to the highest recorded one.
    it.effect("would be skipped while fork migrations still hold 65-68", () =>
      Effect.gen(function* () {
        yield* seedLegacyForkDatabase();

        assert.deepStrictEqual(yield* runMainLedgerWithUpstreamStubs, []);

        assert.deepStrictEqual(yield* upstreamStubMarkers, [false, false, false]);
        assert.deepStrictEqual(
          (yield* mainHistory).slice(-4),
          legacyForkLayout.map(([id, name]) => [id, name]),
        );
      }).pipe(Effect.provide(sqlite)),
    );

    // Covers upstream's real migrations past 64 as soon as they join the manifest.
    it.effect("run from the manifest on a legacy fork database", () =>
      Effect.gen(function* () {
        yield* seedLegacyForkDatabase();

        assert.deepStrictEqual(yield* runMigrations(), migrationsAfterSharedUpstream);

        assert.deepStrictEqual(yield* mainHistory, migrationManifest);
        assert.deepStrictEqual(yield* forkHistory, forkManifest);
      }).pipe(Effect.provide(sqlite)),
    );
  });
});
