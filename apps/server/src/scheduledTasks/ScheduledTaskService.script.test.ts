import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type Project,
  ProjectId,
  type ProjectScript,
  type ScheduledTask,
  ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ScheduledScriptRunner from "./ScheduledScriptRunner.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const PROJECT_ID = ProjectId.make("project-scripts");
const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

const scriptTaskInput = (overrides: Record<string, unknown> = {}) =>
  decodeUpsertInput({
    id: "scheduled-task:board-sync",
    title: "Board sync",
    prompt: "Runs the board sync script.",
    enabled: true,
    schedule: { type: "interval", everyMs: 3_600_000 },
    projectId: PROJECT_ID,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    action: { type: "script", scriptId: "board-sync" },
    ...overrides,
  });

const script = (command: string): ProjectScript => ({
  id: "board-sync",
  name: "Board sync",
  command,
  icon: "play",
  runOnWorktreeCreate: false,
});

/** Agent dispatch dies, so any test that reaches a provider fails loudly. */
const noAgentTurns = Layer.mergeAll(
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({
    launch: () => Effect.die("a script task must not launch a thread"),
  }),
  Layer.mock(ThreadManagementService.ThreadManagementService)({
    sendToThread: () => Effect.die("a script task must not send to a thread"),
  }),
  Layer.mock(SecretRequests.SecretRequests)({}),
  NodeCrypto.layer,
  Scheduler.layer,
);

/** The real runner against a temp project whose scripts the test can change. */
const withRealRunner = <A, E>(
  body: (input: {
    readonly service: ScheduledTaskService.ScheduledTaskService["Service"];
    readonly setScripts: (scripts: ReadonlyArray<ProjectScript>) => void;
    readonly root: string;
  }) => Effect.Effect<A, E, FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "scheduled-script-" });
    let scripts: ReadonlyArray<ProjectScript> = [];
    const project: Project = {
      id: PROJECT_ID,
      title: "Scripts",
      workspaceRoot: root,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      deletedAt: null,
    };
    const runner = ScheduledScriptRunner.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectService.ProjectService)({
            getById: (id) =>
              Effect.succeed(id === PROJECT_ID ? Option.some(project) : Option.none()),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.sync(() => ({
              ...DEFAULT_SERVER_SETTINGS,
              projectSettingsOverrides: { [PROJECT_ID]: { defaultProjectScripts: [...scripts] } },
            })),
          }),
        ),
      ),
    );
    return yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      return yield* body({
        service,
        setScripts: (next) => {
          scripts = next;
        },
        root,
      });
    }).pipe(
      Effect.provide(
        ScheduledTaskService.layer.pipe(Layer.provide(Layer.mergeAll(noAgentTurns, runner))),
      ),
      // A POSIX shell whatever the developer's own is.
      Effect.provideService(HostProcess.Environment, { ...process.env, SHELL: "/bin/sh" }),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.merge(SqlitePersistence.layerMemory, NodeServices.layer)),
  );

/** The task as the list shows it once a run of it has finished. */
const finishedRun = (service: ScheduledTaskService.ScheduledTaskService["Service"], id: string) =>
  service.subscribeList().pipe(
    Stream.map((list) => list.tasks.find((task) => task.id === id)),
    Stream.filter(
      (task): task is ScheduledTask =>
        task !== undefined && task.runCount > 0 && task.lastRunStatus !== "running",
    ),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

it.effect("runs the project script in the project root and records success", () =>
  withRealRunner(({ service, setScripts, root }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      setScripts([script(`pwd > ran.txt; printf '%s' "$T3CODE_PROJECT_ROOT" > root.txt`)]);
      const { task } = yield* service.upsert(yield* scriptTaskInput());
      assert.deepEqual(task.action, { type: "script", scriptId: "board-sync" });

      const started = yield* service.runNow({ id: task.id });
      assert.equal(started.task.lastRunStatus, "running");
      const finished = yield* finishedRun(service, task.id);
      assert.equal(finished.lastRunStatus, "succeeded");
      assert.isNull(finished.lastRunError);
      assert.equal(finished.runCount, 1);
      const realRoot = yield* fs.realPath(root);
      assert.equal((yield* fs.readFileString(`${root}/ran.txt`)).trim(), realRoot);
      assert.equal(yield* fs.readFileString(`${root}/root.txt`), root);
    }),
  ),
);

it.effect("records a non-zero exit with its code and the last lines of stderr, capped", () =>
  withRealRunner(({ service, setScripts }) =>
    Effect.gen(function* () {
      const longLine = "x".repeat(120);
      setScripts([
        script(
          `for i in 1 2 3 4 5 6 7 8 9 10 11 12; do echo "line $i ${longLine}" >&2; done; echo out; exit 3`,
        ),
      ]);
      const { task } = yield* service.upsert(yield* scriptTaskInput());
      yield* service.runNow({ id: task.id });
      const finished = yield* finishedRun(service, task.id);
      assert.equal(finished.lastRunStatus, "failed");
      const error = finished.lastRunError ?? "";
      assert.isTrue(error.startsWith("Script exited with code 3."), error);
      assert.isTrue(error.includes(`line 12 ${longLine}`), error);
      assert.isFalse(error.includes("line 2 "), error);
      assert.isFalse(error.includes("out"), error);
      assert.isAtMost(error.length, ScheduledScriptRunner.SCRIPT_ERROR_MAX_CHARS);
    }),
  ),
);

it.effect(
  "refuses a script the project does not have, and fails a run whose script was removed",
  () =>
    withRealRunner(({ service, setScripts }) =>
      Effect.gen(function* () {
        const refused = yield* Effect.flip(service.upsert(yield* scriptTaskInput()));
        assert.include(refused.message, `Project script "board-sync" is not configured`);

        setScripts([script("true")]);
        const { task } = yield* service.upsert(yield* scriptTaskInput());
        setScripts([]);
        yield* service.runNow({ id: task.id });
        const finished = yield* finishedRun(service, task.id);
        assert.equal(finished.lastRunStatus, "failed");
        assert.equal(
          finished.lastRunError,
          `Project script "board-sync" is no longer configured for this project.`,
        );
      }),
    ),
);

it.effect("keeps a script action across a save that does not name one", () =>
  withRealRunner(({ service, setScripts }) =>
    Effect.gen(function* () {
      setScripts([script("true")]);
      yield* service.upsert(yield* scriptTaskInput());
      // What a stock client sends when it edits the title: every field it knows, no action.
      const { action: _action, ...stockEdit } = yield* scriptTaskInput({ title: "Renamed" });
      const kept = yield* service.upsert(stockEdit);
      assert.equal(kept.task.title, "Renamed");
      assert.deepEqual(kept.task.action, { type: "script", scriptId: "board-sync" });

      const switched = yield* service.upsert(
        yield* scriptTaskInput({ action: { type: "agentTurn" } }),
      );
      assert.isUndefined(switched.task.action);
    }),
  ),
);

it.effect("refuses a script task bound to a thread or a workspace other than the root", () =>
  withRealRunner(({ service, setScripts }) =>
    Effect.gen(function* () {
      setScripts([script("true")]);
      const bound = yield* Effect.flip(
        service.upsert(yield* scriptTaskInput({ threadId: "thread-1" })),
      );
      assert.include(bound.message, "cannot be bound to a thread");
      const worktree = yield* Effect.flip(
        service.upsert(
          yield* scriptTaskInput({ workspaceStrategy: { type: "worktree", baseRef: "main" } }),
        ),
      );
      assert.include(worktree.message, "project root");
    }),
  ),
);

it.effect("runs only enabled script tasks when they come due", () =>
  Effect.gen(function* () {
    const now = Date.parse("2026-10-01T12:00:00.000Z");
    yield* TestClock.setTime(now);
    const ran: Array<string> = [];
    const enabledRan = yield* Deferred.make<void>();
    const runner = Layer.mock(ScheduledScriptRunner.ScheduledScriptRunner)({
      findScript: ({ scriptId }) => Effect.succeed(script(`echo ${scriptId}`)),
      run: ({ scriptId }) =>
        Effect.sync(() => ran.push(scriptId)).pipe(
          Effect.andThen(
            scriptId === "enabled" ? Deferred.succeed(enabledRan, undefined) : Effect.void,
          ),
          Effect.as({ failure: null }),
        ),
    });
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      for (const [id, enabled] of [
        ["disabled", false],
        ["enabled", true],
      ] as const) {
        yield* service.upsert(
          yield* scriptTaskInput({
            id: `scheduled-task:${id}`,
            enabled,
            schedule: { type: "interval", everyMs: 60_000 },
            action: { type: "script", scriptId: id },
          }),
        );
      }
      yield* TestClock.adjust("90 seconds");
      yield* Deferred.await(enabledRan);
      const finished = yield* finishedRun(service, "scheduled-task:enabled");
      assert.equal(finished.lastRunStatus, "succeeded");
      assert.deepEqual(ran, ["enabled"]);
      const { tasks } = yield* service.list();
      const disabled = tasks.find((task) => task.id === "scheduled-task:disabled");
      assert.equal(disabled?.lastRunStatus, "never");
      assert.isNull(disabled?.nextRunAt);
    }).pipe(
      Effect.provide(
        ScheduledTaskService.layer.pipe(Layer.provide(Layer.mergeAll(noAgentTurns, runner))),
      ),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
