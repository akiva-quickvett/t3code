import { PodRuntimeId, PodRuntimeSnapshot } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import { PersistenceDecodeError, PersistenceSqlError } from "../persistence/Errors.ts";
import { applyPodEvent, PodRuntimeEvent, type PodRuntimeRecord } from "./PodRuntimeLifecycle.ts";

export type PodRuntimeStoreError = PersistenceSqlError | PersistenceDecodeError;

const StoredRecord = Schema.Struct({
  snapshot: PodRuntimeSnapshot,
  dockerHost: Schema.String,
  worktreeReleased: Schema.optionalKey(Schema.Boolean),
});
const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRecord));
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(StoredRecord));
const encodeEvent = Schema.encodeEffect(Schema.fromJsonString(PodRuntimeEvent));
const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(PodRuntimeEvent));

/**
 * The pod journal and its projection. The projection is read from memory: it
 * is small (one row per pod) and the terminal and storage cleanup look it up
 * on paths they already hold.
 */
export class PodRuntimeStore extends Context.Service<
  PodRuntimeStore,
  {
    readonly list: Effect.Effect<ReadonlyArray<PodRuntimeRecord>>;
    readonly get: (podId: PodRuntimeId) => Effect.Effect<PodRuntimeRecord | undefined>;
    /**
     * The pod whose worktree is `path` or contains it: the live one, or with
     * `includeRemoved` the latest removed one whose worktree is still there.
     */
    readonly findByPath: (
      path: string,
      options?: { readonly includeRemoved?: boolean },
    ) => Effect.Effect<PodRuntimeRecord | undefined>;
    /** Appends one pod's events and its new projection row in one transaction. */
    readonly commit: (
      podId: PodRuntimeId,
      events: ReadonlyArray<PodRuntimeEvent>,
    ) => Effect.Effect<PodRuntimeRecord | undefined, PodRuntimeStoreError>;
    /** Replays the journal; the projection must equal it. */
    readonly replay: Effect.Effect<
      ReadonlyMap<PodRuntimeId, PodRuntimeRecord>,
      PodRuntimeStoreError
    >;
    /**
     * Each record as committed, published only after its transaction. Subscribe
     * before reading `list` so no commit falls between the two.
     */
    readonly subscribe: Effect.Effect<PubSub.Subscription<PodRuntimeRecord>, never, Scope.Scope>;
  }
>()("t3/pod/PodRuntimeStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const path = yield* Path.Path;
  const committed = yield* PubSub.unbounded<PodRuntimeRecord>();

  const sqlError = (operation: string) => (cause: unknown) =>
    new PersistenceSqlError({ operation, cause });
  const decodeError = (operation: string) => (cause: Schema.SchemaError) =>
    PersistenceDecodeError.fromSchemaError(operation, cause);

  const rows = yield* sql<{ record_json: string }>`SELECT record_json FROM pod_runtimes`.pipe(
    Effect.mapError(sqlError("PodRuntimeStore.load")),
    Effect.orDie,
  );
  const records = new Map<PodRuntimeId, PodRuntimeRecord>();
  for (const row of rows) {
    // An unreadable row must not stop the server; its containers then show as orphans.
    const record = yield* decodeRecord(row.record_json).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("skipped an unreadable pod record", {
          issue: decodeError("PodRuntimeStore.load")(cause).issue,
        }).pipe(Effect.as(undefined)),
      ),
    );
    if (record !== undefined) records.set(record.snapshot.id, record);
  }

  const inside = (root: string, candidate: string) => {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };

  const commit: PodRuntimeStore["Service"]["commit"] = (podId, events) =>
    Effect.gen(function* () {
      let record = records.get(podId);
      for (const event of events) record = applyPodEvent(record, event);
      if (record === undefined || events.length === 0) return record;
      const next = record;
      const recordJson = yield* encodeRecord(next).pipe(
        Effect.mapError(decodeError("PodRuntimeStore.commit")),
      );
      const eventRows = yield* Effect.forEach(events, (event) =>
        encodeEvent(event).pipe(
          Effect.map((payload) => ({ event, payload })),
          Effect.mapError(decodeError("PodRuntimeStore.commit")),
        ),
      );
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            let sequence = 0;
            for (const { event, payload } of eventRows) {
              const inserted = yield* sql<{ sequence: number }>`
                INSERT INTO pod_runtime_events (pod_id, event_type, payload_json, occurred_at)
                VALUES (${podId}, ${event.type}, ${payload}, ${event.occurredAt})
                RETURNING sequence
              `;
              sequence = inserted[0]?.sequence ?? sequence;
            }
            yield* sql`
              INSERT INTO pod_runtimes (pod_id, worktree_path, state, record_json, last_sequence)
              VALUES (${podId}, ${next.snapshot.worktreePath}, ${next.snapshot.state}, ${recordJson}, ${sequence})
              ON CONFLICT (pod_id) DO UPDATE SET
                state = excluded.state,
                record_json = excluded.record_json,
                last_sequence = excluded.last_sequence
            `;
          }),
        )
        .pipe(Effect.mapError(sqlError("PodRuntimeStore.commit")));
      records.set(podId, next);
      yield* PubSub.publish(committed, next);
      return next;
    });

  const replay: PodRuntimeStore["Service"]["replay"] = Effect.gen(function* () {
    const eventRows = yield* sql<{ payload_json: string }>`
      SELECT payload_json FROM pod_runtime_events ORDER BY sequence
    `.pipe(Effect.mapError(sqlError("PodRuntimeStore.replay")));
    const rebuilt = new Map<PodRuntimeId, PodRuntimeRecord>();
    for (const row of eventRows) {
      const event = yield* decodeEvent(row.payload_json).pipe(
        Effect.mapError(decodeError("PodRuntimeStore.replay")),
      );
      const record = applyPodEvent(rebuilt.get(event.podId), event);
      if (record !== undefined) rebuilt.set(event.podId, record);
    }
    return rebuilt;
  });

  return PodRuntimeStore.of({
    list: Effect.sync(() => [...records.values()]),
    get: (podId) => Effect.sync(() => records.get(podId)),
    findByPath: (target, options) =>
      Effect.sync(() => {
        const resolved = path.resolve(target);
        let latest: PodRuntimeRecord | undefined;
        for (const record of records.values()) {
          if (!inside(path.resolve(record.snapshot.worktreePath), resolved)) continue;
          if (record.snapshot.state !== "removed") return record;
          if (
            options?.includeRemoved === true &&
            record.worktreeReleased !== true &&
            (latest?.snapshot.updatedAt ?? "") < record.snapshot.updatedAt
          )
            latest = record;
        }
        return latest;
      }),
    commit,
    replay,
    subscribe: PubSub.subscribe(committed),
  });
});

export const layer = Layer.effect(PodRuntimeStore, make);
