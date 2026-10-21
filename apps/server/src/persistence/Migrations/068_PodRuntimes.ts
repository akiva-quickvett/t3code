import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS pod_runtime_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      pod_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pod_runtime_events_pod
    ON pod_runtime_events (pod_id, sequence)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS pod_runtimes (
      pod_id TEXT PRIMARY KEY,
      worktree_path TEXT NOT NULL,
      state TEXT NOT NULL,
      record_json TEXT NOT NULL,
      last_sequence INTEGER NOT NULL
    ) WITHOUT ROWID
  `;
});
