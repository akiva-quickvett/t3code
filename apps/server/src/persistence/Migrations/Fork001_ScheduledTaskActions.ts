import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A node rolled back to a pre-ledger build re-runs this as main 65 on a schema that has the column.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scheduled_tasks)`;
  if (columns.some((column) => column.name === "action_json")) return;

  // Null is an agent turn, so every existing row keeps running as it did.
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN action_json TEXT`;
});
