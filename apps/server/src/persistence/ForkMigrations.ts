import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import ForkMigration001 from "./Migrations/Fork001_ScheduledTaskActions.ts";
import ForkMigration002 from "./Migrations/Fork002_ProjectionThreadTreeParentIndex.ts";
import ForkMigration003 from "./Migrations/Fork003_ChatChannels.ts";
import ForkMigration004 from "./Migrations/Fork004_PodRuntimes.ts";

// Upstream owns effect_sql_migrations and its sequential ids in Migrations.ts. Fork-only
// migrations take the next id in this list, recorded in their own ledger, and never go in
// migrationEntries: the migrator skips every id below the highest recorded one, so a fork id
// there would hide upstream's.
export const forkMigrationEntries = [
  [1, "ScheduledTaskActions", ForkMigration001],
  [2, "ProjectionThreadTreeParentIndex", ForkMigration002],
  [3, "ChatChannels", ForkMigration003],
  [4, "PodRuntimes", ForkMigration004],
] as const;

const FORK_MIGRATIONS_TABLE = "fork_effect_sql_migrations";

// Earlier fork builds recorded these in the main ledger right after upstream's 64.
const legacyForkMigrationIds = new Map<string, readonly [mainId: number, forkId: number]>([
  ["ScheduledTaskActions", [65, 1]],
  ["ProjectionThreadTreeParentIndex", [66, 2]],
  ["ChatChannels", [67, 3]],
  ["PodRuntimes", [68, 4]],
]);

/**
 * Move fork migrations that earlier builds recorded in the main ledger into the fork ledger,
 * keeping their timestamps and without re-running them. Only exact id and name matches move, so
 * an upstream migration recorded at one of those ids stays put.
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
        const legacy = (yield* sql<{ readonly migration_id: number; readonly name: string }>`
          SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id BETWEEN 65 AND 68
        `).flatMap((row) => {
          const ids = legacyForkMigrationIds.get(row.name);
          return ids && ids[0] === row.migration_id ? [{ ...row, forkId: ids[1] }] : [];
        });
        if (legacy.length === 0) return;
        // Same shape the migrator creates, so it adopts this table as its own.
        yield* sql`
          CREATE TABLE IF NOT EXISTS ${sql(FORK_MIGRATIONS_TABLE)} (
            migration_id integer PRIMARY KEY NOT NULL,
            created_at datetime NOT NULL DEFAULT current_timestamp,
            name VARCHAR(255) NOT NULL
          )
        `;
        for (const row of legacy) {
          yield* sql`
            INSERT INTO ${sql(FORK_MIGRATIONS_TABLE)} (migration_id, name, created_at)
            SELECT ${row.forkId}, name, created_at FROM effect_sql_migrations
            WHERE migration_id = ${row.migration_id}
              AND NOT EXISTS (
                SELECT 1 FROM ${sql(FORK_MIGRATIONS_TABLE)} WHERE migration_id = ${row.forkId}
              )
          `;
          yield* sql`
            DELETE FROM effect_sql_migrations
            WHERE migration_id = ${row.migration_id} AND name = ${row.name}
          `;
        }
        yield* Effect.log("Moved fork migrations into the fork ledger").pipe(
          Effect.annotateLogs({
            forkMigrations: legacy.map((row) => `${row.migration_id}_${row.name} -> ${row.forkId}`),
          }),
        );
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

// Runs after the main ledger, since fork migrations alter upstream's tables.
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
