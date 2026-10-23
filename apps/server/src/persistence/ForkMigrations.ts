import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import ForkMigration001 from "./Migrations/Fork001_ScheduledTaskActions.ts";
import ForkMigration002 from "./Migrations/Fork002_ProjectionThreadTreeParentIndex.ts";
import ForkMigration003 from "./Migrations/Fork003_ChatChannels.ts";
import ForkMigration004 from "./Migrations/Fork004_PodRuntimes.ts";

// Upstream owns effect_sql_migrations and its sequential ids in Migrations.ts. Fork-only
// migrations take the next id in this list, recorded in their own ledger, and never go in
// migrationEntries: the migrator skips every id at or below the highest recorded one, so a fork
// id there would hide upstream's. The same holds here: a fork id is permanent once a build that
// records it has run on a live node, so when two branches take the same next id, renumber the
// one that never shipped. Fork migrations run after every upstream one, while existing databases
// ran them between upstream migrations, so re-check them whenever an upstream migration rewrites
// a table they alter.
export const forkMigrationEntries = [
  [1, "ScheduledTaskActions", ForkMigration001],
  [2, "ProjectionThreadTreeParentIndex", ForkMigration002],
  [3, "ChatChannels", ForkMigration003],
  [4, "PodRuntimes", ForkMigration004],
] as const;

const FORK_MIGRATIONS_TABLE = "fork_effect_sql_migrations";

// Earlier fork builds recorded fork id N as main id 64 + N.
const LEGACY_FORK_ROWS = `(migration_id, name) IN (VALUES
  (65, 'ScheduledTaskActions'),
  (66, 'ProjectionThreadTreeParentIndex'),
  (67, 'ChatChannels'),
  (68, 'PodRuntimes')
)`;

/**
 * Fail when the fork migrator would skip a fork migration: it skips every id up to the highest
 * recorded one, whatever name was recorded. Ids this build does not know came from a newer build
 * and are left alone.
 */
const assertForkHistoryMatches = Effect.fn("assertForkHistoryMatches")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${FORK_MIGRATIONS_TABLE}
  `;
  if (tables.length === 0) return;
  const recorded = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM ${sql(FORK_MIGRATIONS_TABLE)}
  `;
  const latestRecordedId = Math.max(0, ...recorded.map((row) => row.migration_id));
  const recordedNames = new Map(recorded.map((row) => [row.migration_id, row.name]));
  const skipped = forkMigrationEntries.flatMap(([id, name]) => {
    if (id > latestRecordedId) return [];
    const recordedName = recordedNames.get(id);
    return recordedName === name ? [] : [`${id}_${name} (recorded: ${recordedName ?? "nothing"})`];
  });
  if (skipped.length === 0) return;
  return yield* new Migrator.MigrationError({
    kind: "BadState",
    message: `This database's fork migration history would skip required fork migrations: ${skipped.join(", ")}. Fork ids are skipped up to the highest recorded id (${latestRecordedId}), regardless of name. It was probably written by a fork build that numbered its migrations differently.`,
  });
});

/**
 * Move fork migrations that earlier builds recorded in the main ledger into the fork ledger,
 * keeping their timestamps and without re-running them, then check the fork ledger. Only exact
 * id and name matches move, so an upstream migration recorded at one of those ids stays put. The
 * check shares the transaction so a fork id already holding another name rolls the move back.
 */
export const reconcileLegacyForkMigrations = Effect.fn("reconcileLegacyForkMigrations")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const tables = yield* sql`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
        `;
        if (tables.length === 0) return;
        const legacy = yield* sql<{ readonly migration_id: number; readonly name: string }>`
          SELECT migration_id, name FROM effect_sql_migrations
          WHERE ${sql.unsafe(LEGACY_FORK_ROWS)}
          ORDER BY migration_id
        `;
        if (legacy.length > 0) {
          // Same shape the migrator creates, so it adopts this table as its own.
          yield* sql`
            CREATE TABLE IF NOT EXISTS ${sql(FORK_MIGRATIONS_TABLE)} (
              migration_id integer PRIMARY KEY NOT NULL,
              created_at datetime NOT NULL DEFAULT current_timestamp,
              name VARCHAR(255) NOT NULL
            )
          `;
          yield* sql`
            INSERT OR IGNORE INTO ${sql(FORK_MIGRATIONS_TABLE)} (migration_id, name, created_at)
            SELECT migration_id - 64, name, created_at FROM effect_sql_migrations
            WHERE ${sql.unsafe(LEGACY_FORK_ROWS)}
          `;
          yield* sql`DELETE FROM effect_sql_migrations WHERE ${sql.unsafe(LEGACY_FORK_ROWS)}`;
          yield* Effect.log("Moved fork migrations into the fork ledger").pipe(
            Effect.annotateLogs({
              forkMigrations: legacy.map(
                (row) => `${row.migration_id}_${row.name} -> ${row.migration_id - 64}`,
              ),
            }),
          );
        }
        yield* assertForkHistoryMatches();
      }),
    );
  },
);

const run = Migrator.make({});

const forkMigrationLoader = Migrator.fromRecord(
  Object.fromEntries(
    forkMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
  ),
);

// Runs after the main ledger, since fork migrations alter upstream's tables. Call it after
// reconcileLegacyForkMigrations, which checks the fork ledger.
export const runForkMigrations = Effect.fn("runForkMigrations")(function* () {
  const forkMigrations = (yield* run({
    loader: forkMigrationLoader,
    table: FORK_MIGRATIONS_TABLE,
  })).map(([id, name]) => `${id}_${name}`);
  if (forkMigrations.length > 0) {
    yield* Effect.log("Fork migrations ran successfully").pipe(
      Effect.annotateLogs({ forkMigrations }),
    );
  }
});
