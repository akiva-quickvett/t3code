import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Config JSON holds secret refs only; credentials and numbers stay in the secret store.
  yield* sql`
    CREATE TABLE IF NOT EXISTS chat_channels (
      channel_id TEXT PRIMARY KEY,
      config_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS chat_contacts (
      contact_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      config_json TEXT NOT NULL,
      thread_id TEXT,
      thread_bound_at TEXT,
      last_inbound_at TEXT,
      last_inbound_number_ref TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (channel_id, slug)
    )
  `;

  // The message log and the outbound outbox in one table: an outbound row is
  // its own durable send request, claimed by status like the orchestration outbox.
  yield* sql`
    CREATE TABLE IF NOT EXISTS chat_messages (
      message_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      content_json TEXT NOT NULL,
      status TEXT NOT NULL,
      idempotency_key TEXT,
      provider_message_id TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_idempotency
    ON chat_messages(channel_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_inbound
    ON chat_messages(channel_id, provider_message_id)
    WHERE direction = 'inbound'
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_chat_messages_outbox
    ON chat_messages(status, available_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_chat_messages_contact
    ON chat_messages(contact_id, status)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS chat_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      production_access TEXT NOT NULL
    )
  `;
});
