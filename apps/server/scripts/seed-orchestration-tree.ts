#!/usr/bin/env node

/**
 * Writes the committed orchestration seed tree (F1) into a worktree's `.t3`
 * for visual sign-off. Everything goes through the event sink with no effects,
 * so stored events and projections agree and a later dev server start runs
 * nothing.
 *
 * Runtime-only states (working, waiting, needs-you approvals, failed and
 * limited runs) need runs, sessions or runtime requests, which this script
 * never creates. Those threads land with their persisted fields only (metas,
 * lineage, organs, subagent records, settle/snooze/visit state); their live
 * dots are covered by client tests that use F1 directly.
 */

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  CommandId,
  EventId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import { resolveWorktreeT3Home } from "@t3tools/shared/devHome";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { orchestrationSeedTree, pad } from "@t3tools/shared/testing/orchestrationSeedTree";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { Command, Flag } from "effect/cli";

import * as EventSink from "../src/orchestration-v2/EventSink.ts";
import * as EventStore from "../src/orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../src/orchestration-v2/ProjectionStore.ts";
import { runMigrations } from "../src/persistence/Migrations.ts";

export class SeedOrchestrationTreeRefusedError extends Schema.TaggedError<SeedOrchestrationTreeRefusedError>()(
  "SeedOrchestrationTreeRefusedError",
  {
    reason: Schema.Literals(["not-in-worktree", "shared-home", "server-running", "busy"]),
    databasePath: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-in-worktree":
        return "Not inside a linked git worktree. Pass --base-dir to target an isolated .t3 directory.";
      case "shared-home":
        return "Refusing to seed the shared ~/.t3 state. Use a worktree's .t3 or an isolated --base-dir.";
      case "server-running":
        return `Database at '${this.databasePath}' is open by a running server (per server-runtime.json). Stop it first.`;
      case "busy":
        return `Database at '${this.databasePath}' looks in use. Stop the dev server first.`;
    }
  }
}

export interface RunSeedOrchestrationTreeInput {
  readonly baseDir?: string | undefined;
  /** Pads the seed with idle chats up to this many threads. */
  readonly pad?: number | undefined;
}

export interface RunSeedOrchestrationTreeOptions {
  /** Overridable for tests; the directory writes must never target. */
  readonly sharedHome?: string | undefined;
}

const ServerRuntimeState = Schema.fromJsonString(Schema.Struct({ pid: Schema.Number }));
const decodeServerRuntimeState = Schema.decodeEffect(ServerRuntimeState);

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Same checks as migrate-dev-db: a live server pid next to the db, a write lock, or a held WAL. */
const ensureNotInUse = Effect.fn("ensureSeedTargetNotInUse")(function* (databasePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtimeState = yield* fs
    .readFileString(path.join(path.dirname(databasePath), "server-runtime.json"))
    .pipe(Effect.flatMap(decodeServerRuntimeState), Effect.option);
  if (Option.isSome(runtimeState) && isProcessAlive(runtimeState.value.pid)) {
    return yield* new SeedOrchestrationTreeRefusedError({ reason: "server-running", databasePath });
  }
  if (!(yield* fs.exists(databasePath))) return;
  const checkpoint = yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe("PRAGMA busy_timeout = 0").unprepared;
    yield* sql.unsafe("BEGIN IMMEDIATE").unprepared;
    yield* sql.unsafe("ROLLBACK").unprepared;
    return yield* sql.unsafe<{ busy: number }>("PRAGMA wal_checkpoint(TRUNCATE)").unprepared;
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: databasePath })),
    Effect.mapError(() => new SeedOrchestrationTreeRefusedError({ reason: "busy", databasePath })),
  );
  if (checkpoint[0] !== undefined && Number(checkpoint[0].busy) !== 0) {
    return yield* new SeedOrchestrationTreeRefusedError({ reason: "busy", databasePath });
  }
});

/**
 * T3-launched worktrees live at `~/.t3/worktrees/<project>/<branch>`, so
 * "under the shared home" means anywhere in it except inside one of those.
 */
const isSharedHomeTarget = (path: Path.Path, target: string, sharedHome: string): boolean => {
  const relative = path.relative(sharedHome, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  const [first, , branch] = relative.split(path.sep);
  return first !== "worktrees" || branch === undefined;
};

/**
 * Resolves symlinks through the nearest existing ancestor, so a not-yet-created
 * target can't hide one. `realpathSync.native` returns the on-disk case, which
 * a case-insensitive filesystem (macOS) needs for `~/.T3` to match `~/.t3`. A
 * dangling link is followed to its target, which SQLite would create.
 */
const canonicalPath = (target: string): Effect.Effect<string> =>
  Effect.sync(() => {
    let existing = NodePath.resolve(target);
    const rest: Array<string> = [];
    for (let hops = 0; hops < 40;) {
      try {
        return NodePath.join(NodeFS.realpathSync.native(existing), ...rest);
      } catch {
        // Not there yet, or a dangling link.
      }
      let link: string | undefined;
      try {
        link = NodeFS.readlinkSync(existing);
      } catch {
        link = undefined;
      }
      if (link !== undefined) {
        existing = NodePath.resolve(NodePath.dirname(existing), link);
        hops += 1;
        continue;
      }
      const parent = NodePath.dirname(existing);
      if (parent === existing) break;
      rest.unshift(NodePath.basename(existing));
      existing = parent;
    }
    return NodePath.join(existing, ...rest);
  });

const seedThreadEvent = (
  type: "thread.created" | "thread.metadata-updated",
  thread: OrchestrationV2AppThread,
  occurredAt: DateTime.Utc,
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`seed:${thread.id}:${type}`),
  threadId: thread.id,
  occurredAt,
  type,
  payload: thread,
});

const writeSeed = Effect.fn("writeOrchestrationSeed")(function* (padTo: number | undefined) {
  const sink = yield* EventSink.EventSinkV2;
  const seed = padTo === undefined ? orchestrationSeedTree : pad(orchestrationSeedTree, padTo);
  let committed = 0;
  const count = (result: { readonly committed: boolean }) => {
    if (result.committed) committed += 1;
  };

  for (const project of seed.projects) {
    const commandId = CommandId.make(`seed:${project.id}:created`);
    const acceptedAt = DateTime.makeUnsafe(project.createdAt);
    count(
      yield* sink.commitProjectCommand({
        commandId,
        projectId: project.id,
        commandType: "project.create",
        acceptedAt,
        event: {
          eventId: EventId.make(`seed:${project.id}:project.created`),
          aggregateKind: "project",
          aggregateId: project.id,
          occurredAt: project.createdAt,
          commandId,
          causationEventId: null,
          correlationId: commandId,
          metadata: {},
          type: "project.created",
          payload: {
            projectId: project.id,
            title: project.title,
            workspaceRoot: project.workspaceRoot,
            defaultModelSelection: project.defaultModelSelection,
            faviconPath: null,
            projectIcon: null,
            scripts: [...project.scripts],
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
          },
        },
      }),
    );
  }

  const commit = (
    step: string,
    threadId: OrchestrationV2AppThread["id"],
    commandType: string,
    event: OrchestrationV2DomainEvent,
  ) =>
    sink
      .commitCommand({
        commandId: CommandId.make(`seed:${threadId}:${step}`),
        threadId,
        commandType,
        acceptedAt: event.occurredAt,
        events: [event],
        effects: [],
      })
      .pipe(Effect.map(count));

  // `appThreads` is in tree order, so every parent exists before its children.
  for (const thread of seed.appThreads) {
    yield* commit(
      "created",
      thread.id,
      "thread.create",
      seedThreadEvent("thread.created", thread, thread.createdAt),
    );
  }
  for (const thread of seed.appThreads) {
    for (const subagent of seed.subagentsByThreadId[thread.id] ?? []) {
      yield* commit(`subagent:${subagent.childThreadId}`, thread.id, "subagent.update", {
        id: EventId.make(`seed:${thread.id}:subagent:${subagent.childThreadId}`),
        threadId: thread.id,
        occurredAt: subagent.updatedAt,
        type: "subagent.updated",
        payload: subagent,
      });
    }
  }
  for (const thread of seed.appThreads) {
    yield* commit(
      "metadata",
      thread.id,
      "thread.metadata.update",
      seedThreadEvent("thread.metadata-updated", thread, thread.updatedAt),
    );
  }
  return { threads: seed.appThreads.length, committedCommands: committed };
});

export const runSeedOrchestrationTree = Effect.fn("runSeedOrchestrationTree")(function* (
  input: RunSeedOrchestrationTreeInput,
  options: RunSeedOrchestrationTreeOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const sharedHome = path.resolve(options.sharedHome ?? path.join(NodeOS.homedir(), ".t3"));
  const baseDir =
    input.baseDir !== undefined
      ? path.resolve(input.baseDir)
      : yield* resolveWorktreeT3Home(process.cwd());
  if (baseDir === undefined) {
    return yield* new SeedOrchestrationTreeRefusedError({ reason: "not-in-worktree" });
  }
  const stateDir = path.join(baseDir, "userdata");
  const databasePath = path.join(stateDir, "statev2.sqlite");
  // Any link along the way (base dir, userdata, the db file) could point into live state.
  const canonicalSharedHome = yield* canonicalPath(sharedHome);
  for (const target of [baseDir, stateDir, databasePath]) {
    if (
      isSharedHomeTarget(path, target, sharedHome) ||
      isSharedHomeTarget(path, yield* canonicalPath(target), canonicalSharedHome)
    ) {
      return yield* new SeedOrchestrationTreeRefusedError({ reason: "shared-home" });
    }
  }
  yield* fs.makeDirectory(stateDir, { recursive: true });
  yield* ensureNotInUse(databasePath);

  const result = yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Mirror server boot (persistence/Sqlite.ts).
    yield* sql.unsafe("PRAGMA journal_mode = WAL").unprepared;
    yield* sql.unsafe("PRAGMA foreign_keys = ON").unprepared;
    yield* runMigrations();
    return yield* writeSeed(input.pad).pipe(
      Effect.provide(
        EventSink.layer.pipe(Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer))),
      ),
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));
  return { databasePath, ...result };
});

export const seedOrchestrationTreeCommand = Command.make(
  "seed-orchestration-tree",
  {
    baseDir: Flag.String("base-dir").pipe(
      Flag.optional,
      Flag.withDescription("Isolated .t3 directory. Defaults to the current worktree's .t3."),
    ),
    pad: Flag.Int("pad").pipe(
      Flag.optional,
      Flag.withDescription("Pad the seed with idle chats up to this many threads."),
    ),
  },
  ({ baseDir, pad: padTo }) =>
    Effect.gen(function* () {
      const result = yield* runSeedOrchestrationTree({
        baseDir: Option.getOrUndefined(baseDir),
        pad: Option.getOrUndefined(padTo),
      });
      yield* Console.log(
        `Seeded ${result.threads} threads into ${result.databasePath} (${result.committedCommands} new commands).`,
      );
    }),
).pipe(
  Command.withDescription(
    "Write the orchestration sign-off seed tree into the worktree dev database. Stop the dev server first.",
  ),
);

if (import.meta.main) {
  Command.run(seedOrchestrationTreeCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
