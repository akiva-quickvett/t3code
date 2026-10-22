import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The thread a thread works for: its supervisor, or the parent that delegated to it. Forks copy
 * a conversation rather than take work, so they have none. SQLite uses the index only for a query
 * that repeats this expression exactly.
 */
export const PROJECTION_THREAD_TREE_PARENT = `CASE WHEN json_valid(payload_json) THEN COALESCE(
  json_extract(payload_json, '$.lineage.supervisorThreadId'),
  CASE WHEN json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent'
    THEN json_extract(payload_json, '$.lineage.parentThreadId') END
) END`;

// A node rolled back to a pre-ledger build re-runs this as main 66 on a schema that has the index.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe(
    `CREATE INDEX IF NOT EXISTS orchestration_v2_projection_threads_tree_parent_idx
      ON orchestration_v2_projection_threads(${PROJECTION_THREAD_TREE_PARENT})`,
  );
});
