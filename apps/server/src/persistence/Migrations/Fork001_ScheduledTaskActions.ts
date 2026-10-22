import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Fork ledger id 1. Databases from builds that recorded this as main id 65 are moved into the
// fork ledger without re-running; the guard keeps it harmless on any other half-migrated copy.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scheduled_tasks)`;
  if (columns.some((column) => column.name === "action_json")) return;

  // Null is an agent turn, so every existing row keeps running as it did.
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN action_json TEXT`;
});
