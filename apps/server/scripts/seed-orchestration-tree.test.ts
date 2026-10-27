// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  SEED_CELL_COUNT,
  SEED_THREAD_COUNT,
  seedCellId,
  seedMetaId,
} from "@t3tools/shared/testing/orchestrationSeedTree";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "../src/orchestration-v2/ProjectionStore.ts";
import { runSeedOrchestrationTree } from "./seed-orchestration-tree.ts";

const tempDirIgnoresCase = (() => {
  const probe = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "seed-tree-case-"));
  try {
    const upper = NodePath.join(NodePath.dirname(probe), NodePath.basename(probe).toUpperCase());
    return NodeFS.existsSync(upper);
  } finally {
    NodeFS.rmSync(probe, { recursive: true });
  }
})();

const readSeeded = (databasePath: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const [counts] = yield* sql<{
      events: number;
      threads: number;
      metas: number;
      slices: number;
      pods: number;
      organCells: number;
      organRecords: number;
      outbox: number;
      runs: number;
      sessions: number;
    }>`
      SELECT
        (SELECT COUNT(*) FROM orchestration_events) AS events,
        (SELECT COUNT(*) FROM orchestration_v2_projection_threads) AS threads,
        (SELECT COUNT(*) FROM orchestration_v2_projection_threads
          WHERE json_extract(payload_json, '$.metaAt') IS NOT NULL) AS metas,
        (SELECT COUNT(*) FROM orchestration_v2_projection_threads
          WHERE thread_id LIKE 'seed-slice-%') AS slices,
        (SELECT COUNT(*) FROM orchestration_v2_projection_threads
          WHERE thread_id LIKE 'seed-pod-%') AS pods,
        (SELECT COUNT(*) FROM orchestration_v2_projection_threads
          WHERE json_extract(payload_json, '$.lineage.organ.id') IS NOT NULL) AS organCells,
        (SELECT COUNT(*) FROM orchestration_v2_projection_subagents
          WHERE json_extract(payload_json, '$.organ.id') IS NOT NULL) AS organRecords,
        (SELECT COUNT(*) FROM orchestration_v2_effect_outbox) AS outbox,
        (SELECT COUNT(*) FROM orchestration_v2_projection_runs) AS runs,
        (SELECT COUNT(*) FROM orchestration_v2_projection_provider_sessions) AS sessions`;
    const metaShell = yield* projections.getThreadShell(seedMetaId(1));
    const cellShell = yield* projections.getThreadShell(seedCellId(1, 1));
    return { counts: counts!, metaShell, cellShell };
  }).pipe(
    Effect.provide(
      ProjectionStore.layer.pipe(
        Layer.provideMerge(NodeSqliteClient.layer({ filename: databasePath })),
      ),
    ),
  );

it.layer(NodeServices.layer)("seed-orchestration-tree", (it) => {
  it.effect("seeds the tree through the sink with no effects, idempotently", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sharedHome = yield* fs.makeTempDirectoryScoped({ prefix: "seed-tree-home-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "seed-tree-dest-" });

      const first = yield* runSeedOrchestrationTree({ baseDir }, { sharedHome });
      const seeded = yield* readSeeded(first.databasePath);

      assert.equal(seeded.counts.threads, SEED_THREAD_COUNT);
      assert.equal(seeded.counts.metas, 2);
      assert.equal(seeded.counts.slices, 6);
      assert.equal(seeded.counts.pods, 15);
      assert.equal(seeded.counts.organCells, SEED_CELL_COUNT);
      assert.equal(seeded.counts.organRecords, SEED_CELL_COUNT);
      assert.equal(seeded.counts.outbox, 0);
      assert.equal(seeded.counts.runs, 0);
      assert.equal(seeded.counts.sessions, 0);
      assert.isDefined(seeded.metaShell?.metaAt);
      assert.equal(seeded.cellShell?.lineage.organ?.presetId, "review-t3-council");

      const second = yield* runSeedOrchestrationTree({ baseDir }, { sharedHome });
      assert.equal(second.committedCommands, 0);
      const reseeded = yield* readSeeded(second.databasePath);
      assert.deepStrictEqual(reseeded.counts, seeded.counts);
    }),
  );

  it.effect("pads the seed to the requested thread count", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sharedHome = yield* fs.makeTempDirectoryScoped({ prefix: "seed-tree-home-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "seed-tree-dest-" });

      const result = yield* runSeedOrchestrationTree({ baseDir, pad: 60 }, { sharedHome });
      const seeded = yield* readSeeded(result.databasePath);
      assert.equal(seeded.counts.threads, 60);
    }),
  );

  it.effect("refuses the shared home before opening its database", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sharedHome = yield* fs.makeTempDirectoryScoped({ prefix: "seed-tree-home-" });

      const links = yield* fs.makeTempDirectoryScoped({ prefix: "seed-tree-links-" });
      const homeLink = path.join(links, "home");
      yield* fs.symlink(sharedHome, homeLink);

      for (const baseDir of [
        sharedHome,
        path.join(sharedHome, "dev"),
        path.join(sharedHome, "worktrees", "project"),
        homeLink,
        // Not created yet, so only its existing ancestor reveals the link.
        path.join(homeLink, "new"),
      ]) {
        const error = yield* Effect.flip(runSeedOrchestrationTree({ baseDir }, { sharedHome }));
        assert.equal(error._tag, "SeedOrchestrationTreeRefusedError");
        assert.equal(
          error._tag === "SeedOrchestrationTreeRefusedError" && error.reason,
          "shared-home",
        );
        assert.isFalse(yield* fs.exists(path.join(sharedHome, "userdata")));
      }
    }),
  );

  it.effect("refuses a worktree whose userdata links into the shared home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sharedHome = yield* fs.makeTempDirectoryScoped({ prefix: "seed-tree-home-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "seed-tree-dest-" });
      const liveDatabase = path.join(sharedHome, "userdata", "statev2.sqlite");
      yield* fs.makeDirectory(path.dirname(liveDatabase), { recursive: true });
      yield* fs.writeFileString(liveDatabase, "live");
      yield* fs.symlink(path.join(sharedHome, "userdata"), path.join(baseDir, "userdata"));

      const error = yield* Effect.flip(runSeedOrchestrationTree({ baseDir }, { sharedHome }));
      assert.equal(
        error._tag === "SeedOrchestrationTreeRefusedError" && error.reason,
        "shared-home",
      );
      assert.equal(yield* fs.readFileString(liveDatabase), "live");
    }),
  );

  it.effect("refuses a dangling database link into the shared home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sharedHome = yield* fs.makeTempDirectoryScoped({ prefix: "seed-tree-home-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "seed-tree-dest-" });
      const liveDatabase = path.join(sharedHome, "userdata", "statev2.sqlite");
      yield* fs.makeDirectory(path.dirname(liveDatabase), { recursive: true });
      yield* fs.makeDirectory(path.join(baseDir, "userdata"));
      yield* fs.symlink(liveDatabase, path.join(baseDir, "userdata", "statev2.sqlite"));

      const error = yield* Effect.flip(runSeedOrchestrationTree({ baseDir }, { sharedHome }));
      assert.equal(
        error._tag === "SeedOrchestrationTreeRefusedError" && error.reason,
        "shared-home",
      );
      assert.isFalse(yield* fs.exists(liveDatabase));
    }),
  );

  // Only meaningful where the temp filesystem ignores case (macOS APFS by default).
  it.effect.skipIf(!tempDirIgnoresCase)("refuses the shared home spelled in a different case", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sharedHome = yield* fs.makeTempDirectoryScoped({ prefix: "seed-tree-home-" });
      const baseDir = path.join(path.dirname(sharedHome), path.basename(sharedHome).toUpperCase());

      const error = yield* Effect.flip(runSeedOrchestrationTree({ baseDir }, { sharedHome }));
      assert.equal(
        error._tag === "SeedOrchestrationTreeRefusedError" && error.reason,
        "shared-home",
      );
      assert.isFalse(yield* fs.exists(path.join(sharedHome, "userdata")));
    }),
  );

  it.effect("accepts a T3-launched worktree under the shared home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sharedHome = yield* fs.makeTempDirectoryScoped({ prefix: "seed-tree-home-" });
      const baseDir = path.join(sharedHome, "worktrees", "project", "branch", ".t3");

      const result = yield* runSeedOrchestrationTree({ baseDir }, { sharedHome });
      assert.equal(result.databasePath, path.join(baseDir, "userdata", "statev2.sqlite"));
      assert.isAbove(result.committedCommands, 0);
    }),
  );

  it.effect("refuses a database held by a running server", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sharedHome = yield* fs.makeTempDirectoryScoped({ prefix: "seed-tree-home-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "seed-tree-dest-" });
      const stateDir = path.join(baseDir, "userdata");
      yield* fs.makeDirectory(stateDir, { recursive: true });
      // This test process stands in for the live server.
      yield* fs.writeFileString(
        path.join(stateDir, "server-runtime.json"),
        JSON.stringify({ pid: process.pid }),
      );

      const error = yield* Effect.flip(runSeedOrchestrationTree({ baseDir }, { sharedHome }));
      assert.equal(
        error._tag === "SeedOrchestrationTreeRefusedError" && error.reason,
        "server-running",
      );
      assert.isFalse(yield* fs.exists(path.join(stateDir, "statev2.sqlite")));
    }),
  );
});
