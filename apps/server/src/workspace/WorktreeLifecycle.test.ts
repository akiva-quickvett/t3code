import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type GitCommandError,
  ProjectId,
  ThreadId,
  type ProjectScript,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as WorktreeLifecycle from "./WorktreeLifecycle.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");

const teardown = (command: string): ProjectScript => ({
  id: "teardown",
  name: "Teardown",
  command,
  icon: "play",
  runOnWorktreeCreate: false,
  runOnWorktreeRemove: true,
});

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** `ps` prints nothing for a reaped process and `Z` for one awaiting its parent. */
const processRunning = (pid: number) =>
  Effect.gen(function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    const { stdout } = yield* runner.run({ command: "ps", args: ["-o", "stat=", "-p", `${pid}`] });
    return stdout.trim() !== "" && !stdout.trim().startsWith("Z");
  }).pipe(Effect.orElseSucceed(() => false));

const fixture = (scripts: (out: string) => ReadonlyArray<ProjectScript>, timeoutMs = 60_000) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const repo = yield* fs.makeTempDirectoryScoped({ prefix: "lifecycle-repo-" });
    const worktrees = yield* fs.makeTempDirectoryScoped({ prefix: "lifecycle-worktrees-" });
    const out = yield* fs.makeTempDirectoryScoped({ prefix: "lifecycle-out-" });
    const command = (cwd: string, args: string[]) =>
      git.execute({ operation: "lifecycle-test", cwd, args });
    yield* command(repo, ["init", "-b", "main"]);
    yield* command(repo, ["config", "user.email", "lifecycle@example.test"]);
    yield* command(repo, ["config", "user.name", "Lifecycle test"]);
    yield* fs.writeFileString(`${repo}/tracked.txt`, "original\n");
    yield* command(repo, ["add", "."]);
    yield* command(repo, ["commit", "-m", "initial"]);
    const worktree = `${worktrees}/feature`;
    yield* command(repo, ["worktree", "add", "-b", "feature", worktree]);
    const project = { id: PROJECT_ID, workspaceRoot: repo, scripts: scripts(out) };
    const projectWhen = (matches: boolean) =>
      Effect.succeed(matches ? Option.some(project) : Option.none());
    const context = yield* Layer.build(WorktreeLifecycle.layer).pipe(
      Effect.provideService(ProjectService.ProjectService, {
        getById: (id: ProjectId) => projectWhen(id === PROJECT_ID),
        getByWorkspaceRoot: (root: string) => projectWhen(root === repo),
      } as unknown as ProjectService.ProjectService["Service"]),
      Effect.provideService(ServerSettings.ServerSettingsService, {
        getSettings: Effect.succeed({
          ...DEFAULT_SERVER_SETTINGS,
          worktreeRemovePolicy: { timeoutMs },
        }),
      } as unknown as ServerSettings.ServerSettingsService["Service"]),
      Effect.provideService(GitWorkflowService.GitWorkflowService, {
        removeWorktree: git.removeWorktree,
      } as unknown as GitWorkflowService.GitWorkflowService["Service"]),
      // A POSIX shell whatever the developer's own is, plus server-only
      // variables a script must never see.
      Effect.provideService(HostProcess.Environment, {
        ...process.env,
        SHELL: "/bin/sh",
        T3CODE_HOME: "/live/t3",
        PORT: "3773",
        ELECTRON_RUN_AS_NODE: "1",
      }),
    );
    return {
      lifecycle: Context.get(context, WorktreeLifecycle.WorktreeLifecycle),
      fs,
      repo,
      worktree,
      out,
      realWorktree: yield* fs.realPath(worktree),
      readOut: (name: string) =>
        fs.readFileString(`${out}/${name}`).pipe(Effect.orElseSucceed(() => null)),
    };
  });

const testLayer = Layer.merge(GitVcsDriver.layer, ProcessRunner.layer).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "worktree-lifecycle-" })),
  Layer.provideMerge(NodeServices.layer),
);

const captureWarnings = () => {
  const warnings: Array<{
    readonly message: string;
    readonly annotations: Record<string, unknown>;
  }> = [];
  const logger = Logger.make(({ message, logLevel }) => {
    if (logLevel !== "Warn") return;
    const [text, annotations] = Array.isArray(message) ? message : [message];
    warnings.push({ message: String(text), annotations: { ...annotations } });
  });
  return { warnings, layer: Logger.layer([logger], { mergeWithExisting: false }) };
};

describe("WorktreeLifecycle.remove", () => {
  it.effect(
    "runs the teardown script in the worktree, with the terminal env, before removing it",
    () =>
      Effect.gen(function* () {
        const t = yield* fixture((out) => [
          teardown(
            `{ pwd -P; echo "$T3CODE_PROJECT_ROOT"; echo "$T3CODE_WORKTREE_PATH"; echo "\${T3CODE_HOME-unset} \${PORT-unset} \${ELECTRON_RUN_AS_NODE-unset}"; cat tracked.txt; } > ${quote(`${out}/ran`)}`,
          ),
        ]);
        yield* t.lifecycle.remove({
          projectRoot: t.repo,
          worktreePath: t.worktree,
          force: true,
          projectId: PROJECT_ID,
          threadId: THREAD_ID,
        });
        assert.strictEqual(
          yield* t.readOut("ran"),
          `${t.realWorktree}\n${t.repo}\n${t.worktree}\nunset unset unset\noriginal\n`,
        );
        assert.isFalse(yield* t.fs.exists(t.worktree));
      }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("resolves the project from its root when no project id is given", () =>
    Effect.gen(function* () {
      const t = yield* fixture((out) => [teardown(`touch ${quote(`${out}/ran`)}`)]);
      yield* t.lifecycle.remove({ projectRoot: t.repo, worktreePath: t.worktree, force: true });
      assert.strictEqual(yield* t.readOut("ran"), "");
      assert.isFalse(yield* t.fs.exists(t.worktree));
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("removes the worktree as before when the project has no teardown script", () =>
    Effect.gen(function* () {
      const t = yield* fixture((out) => [
        { ...teardown(`touch ${quote(`${out}/ran`)}`), runOnWorktreeRemove: false },
      ]);
      yield* t.lifecycle.remove({
        projectRoot: t.repo,
        worktreePath: t.worktree,
        force: true,
        projectId: PROJECT_ID,
      });
      assert.isNull(yield* t.readOut("ran"));
      assert.isFalse(yield* t.fs.exists(t.worktree));
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("logs a failing script with its output and still removes the worktree", () => {
    const { warnings, layer } = captureWarnings();
    return Effect.gen(function* () {
      const t = yield* fixture(() => [teardown("echo compose down failed; exit 3")]);
      yield* t.lifecycle.remove({
        projectRoot: t.repo,
        worktreePath: t.worktree,
        force: true,
        projectId: PROJECT_ID,
        threadId: THREAD_ID,
      });
      assert.isFalse(yield* t.fs.exists(t.worktree));
      const warning = warnings.find((entry) => entry.message.includes("teardown script failed"));
      assert.deepInclude(warning?.annotations, {
        threadId: THREAD_ID,
        worktreePath: t.worktree,
        projectId: PROJECT_ID,
        scriptId: "teardown",
        exitCode: 3,
        signal: null,
        timedOut: false,
        outputBytes: "compose down failed\n".length,
      });
      // Script output can carry credentials, so no log field holds it.
      assert.notInclude(JSON.stringify(warnings), "compose down failed");
    }).pipe(Effect.provide(Layer.merge(testLayer, layer)), Effect.scoped);
  });

  it.effect("logs the signal that killed a script and still removes the worktree", () => {
    const { warnings, layer } = captureWarnings();
    return Effect.gen(function* () {
      // SIGKILL, because a shell may handle SIGTERM and exit 143 instead.
      const t = yield* fixture(() => [teardown("kill -KILL $$")]);
      yield* t.lifecycle.remove({
        projectRoot: t.repo,
        worktreePath: t.worktree,
        force: true,
        projectId: PROJECT_ID,
        threadId: THREAD_ID,
      });
      assert.isFalse(yield* t.fs.exists(t.worktree));
      const warning = warnings.find((entry) => entry.message.includes("teardown script failed"));
      assert.deepInclude(warning?.annotations, {
        exitCode: null,
        signal: "SIGKILL",
        timedOut: false,
      });
    }).pipe(Effect.provide(Layer.merge(testLayer, layer)), Effect.scoped);
  });

  // The timeout is the behavior under test, so these run on the real clock.
  // Rollbacks remove from uninterruptible error handlers, where it must still fire.
  it.live.each([
    ["", (effect: Effect.Effect<void, GitCommandError>) => effect],
    [" in an uninterruptible region", Effect.uninterruptible],
  ] as const)(
    "kills a script that outlives the timeout%s, with its children, and removes anyway",
    ([, region]) => {
      const { warnings, layer } = captureWarnings();
      return Effect.gen(function* () {
        const t = yield* fixture(
          (out) => [teardown(`echo stuck; sleep 30 & echo $! > ${quote(`${out}/pid`)}; wait`)],
          200,
        );
        yield* region(
          t.lifecycle.remove({
            projectRoot: t.repo,
            worktreePath: t.worktree,
            force: true,
            projectId: PROJECT_ID,
            threadId: THREAD_ID,
          }),
        );
        assert.isFalse(yield* t.fs.exists(t.worktree));
        assert.isFalse(yield* processRunning(Number((yield* t.readOut("pid"))?.trim())));
        const warning = warnings.find((entry) => entry.message.includes("timed out"));
        assert.deepInclude(warning?.annotations, {
          threadId: THREAD_ID,
          timeoutMs: 200,
          timedOut: true,
          exitCode: null,
          outputBytes: "stuck\n".length,
        });
        assert.isAtLeast(Number(warning?.annotations.durationMs), 200);
      }).pipe(Effect.provide(Layer.merge(testLayer, layer)), Effect.scoped);
    },
  );

  it.live("kills the script and skips removal when the caller is interrupted", () =>
    Effect.gen(function* () {
      const runner = yield* ProcessRunner.ProcessRunner;
      const t = yield* fixture((out) => [
        teardown(
          `sleep 30 & echo $! > ${quote(`${out}/pid`)}; echo started > ${quote(`${out}/started`)}; wait`,
        ),
      ]);
      // Reading a fifo blocks until the script writes it, so the test knows it runs.
      yield* runner.run({ command: "mkfifo", args: [`${t.out}/started`] });
      const removal = yield* t.lifecycle
        .remove({
          projectRoot: t.repo,
          worktreePath: t.worktree,
          force: true,
          projectId: PROJECT_ID,
        })
        .pipe(Effect.forkChild);
      yield* t.fs.readFileString(`${t.out}/started`);
      yield* Fiber.interrupt(removal);
      assert.isTrue(yield* t.fs.exists(t.worktree));
      assert.isFalse(yield* processRunning(Number((yield* t.readOut("pid"))?.trim())));
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("treats a storage cleanup removal of a worktree already removed as done", () =>
    Effect.gen(function* () {
      const t = yield* fixture(() => []);
      const input = { projectRoot: t.repo, worktreePath: t.worktree, projectId: PROJECT_ID };
      yield* t.lifecycle.remove({ ...input, force: true });
      yield* t.lifecycle.remove({ ...input, force: false, sweep: { cleanUntrackedFiles: false } });
      assert.isFalse(yield* t.fs.exists(t.worktree));
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("never runs the script outside a linked worktree of the project", () =>
    Effect.gen(function* () {
      const t = yield* fixture((out) => [teardown(`touch ${quote(`${out}/ran`)}`)]);
      const removeMain = yield* t.lifecycle
        .remove({ projectRoot: t.repo, worktreePath: t.repo, force: true, projectId: PROJECT_ID })
        .pipe(Effect.exit);
      assert.isTrue(removeMain._tag === "Failure");
      assert.isNull(yield* t.readOut("ran"));
      assert.isTrue(yield* t.fs.exists(t.repo));
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("runs the script once when two removals of one worktree race", () =>
    Effect.gen(function* () {
      const t = yield* fixture((out) => [teardown(`echo ran >> ${quote(`${out}/runs`)}`)]);
      const input = {
        projectRoot: t.repo,
        worktreePath: t.worktree,
        force: true,
        projectId: PROJECT_ID,
      };
      yield* Effect.all([t.lifecycle.remove(input), t.lifecycle.remove(input)], {
        concurrency: "unbounded",
      });
      assert.strictEqual(yield* t.readOut("runs"), "ran\n");
      assert.isFalse(yield* t.fs.exists(t.worktree));
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("cleans untracked files and refuses tracked edits on a storage cleanup removal", () =>
    Effect.gen(function* () {
      const t = yield* fixture(() => [
        teardown("echo scratch > scratch.log && echo edited > tracked.txt"),
      ]);
      const failure = yield* t.lifecycle
        .remove({
          projectRoot: t.repo,
          worktreePath: t.worktree,
          force: false,
          projectId: PROJECT_ID,
          sweep: { cleanUntrackedFiles: true },
        })
        .pipe(Effect.flip);
      assert.strictEqual(failure.command, "git worktree remove");
      assert.isTrue(yield* t.fs.exists(`${t.worktree}/tracked.txt`));
      assert.isFalse(yield* t.fs.exists(`${t.worktree}/scratch.log`));
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("is the only way server code removes a project worktree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverSource = path.join(import.meta.dirname, "..");
      const sources = (yield* fs.readDirectory(serverSource, { recursive: true })).filter(
        (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
      );
      const removers = yield* Effect.filter(sources, (file) =>
        fs
          .readFileString(path.join(serverSource, file))
          .pipe(Effect.map((source) => /\.removeWorktree\(|"worktree",\s*"remove"/.test(source))),
      );
      assert.deepStrictEqual(removers.toSorted(), [
        // The primitive this service calls, and the git command beneath it.
        "git/GitWorkflowService.ts",
        // A scratch review checkout no setup script ran in.
        "pullRequest/PullRequestReviewGuideService.ts",
        "vcs/GitVcsDriverCore.ts",
        "workspace/WorktreeLifecycle.ts",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
