import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export interface SeedThread {
  readonly id: string;
  readonly createdAt: string;
  readonly title?: string;
  readonly preset?: string;
  readonly parentThreadId?: string;
  readonly relationshipToParent?: "fork" | "subagent";
  readonly supervisorThreadId?: string;
  readonly deleted?: boolean;
}

export interface SeedProviderThread {
  readonly id: string;
  readonly threadId: string;
  readonly driver: string;
  readonly instanceId: string;
  /** The provider's native session id, which usage records carry as `sessionId`. */
  readonly nativeId: string | null;
  readonly createdAt: string;
}

/** Writes a thread projection row with only the fields a usage thread tree reads. */
export const seedThread = (thread: SeedThread) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const payload = yield* encodePayload({
      lineage: {
        parentThreadId: thread.parentThreadId ?? null,
        relationshipToParent: thread.relationshipToParent ?? null,
        rootThreadId: thread.parentThreadId ?? thread.id,
        ...(thread.supervisorThreadId === undefined
          ? {}
          : { supervisorThreadId: thread.supervisorThreadId }),
      },
      ...(thread.preset === undefined ? {} : { rolePreset: { id: thread.preset } }),
    });
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, deleted_at, payload_json
      ) VALUES (
        ${thread.id}, 'project-1', ${thread.title ?? thread.id}, 'codex', 'full-access', 'default',
        ${thread.createdAt}, ${thread.createdAt},
        ${thread.deleted === true ? thread.createdAt : null}, ${payload}
      )
    `;
  });

export const seedProviderThread = (providerThread: SeedProviderThread) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const payload = yield* encodePayload({
      id: providerThread.id,
      driver: providerThread.driver,
      providerInstanceId: providerThread.instanceId,
      appThreadId: providerThread.threadId,
      nativeThreadRef:
        providerThread.nativeId === null
          ? null
          : {
              driver: providerThread.driver,
              nativeId: providerThread.nativeId,
              strength: "strong",
            },
      createdAt: providerThread.createdAt,
      updatedAt: providerThread.createdAt,
    });
    yield* sql`
      INSERT INTO orchestration_v2_projection_provider_threads (
        provider_thread_id, thread_id, provider, driver, provider_instance_id, status,
        updated_at, payload_json
      ) VALUES (
        ${providerThread.id}, ${providerThread.threadId}, ${providerThread.instanceId},
        ${providerThread.driver}, ${providerThread.instanceId}, 'idle',
        ${providerThread.createdAt}, ${payload}
      )
    `;
  });
