import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Null is an agent turn, so every existing row keeps running as it did.
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN action_json TEXT`;
});
