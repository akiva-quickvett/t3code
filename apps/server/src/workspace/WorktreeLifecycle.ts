import {
  GitCommandError,
  type PodRuntimeSnapshot,
  type ProjectId,
  type ThreadId,
  WorktreePodTeardownError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  projectScriptRuntimeEnv,
  resolveProjectScripts,
  teardownProjectScript,
} from "@t3tools/shared/projectScripts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as PodRuntimeService from "../pod/PodRuntimeService.ts";
import * as WorkspaceExecutionTarget from "../pod/WorkspaceExecutionTarget.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { createTerminalSpawnEnv, terminalShellCandidates } from "../terminal/Manager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

export interface WorktreeRemoveInput {
  /** The checkout that owns the worktree; Git runs here. */
  readonly projectRoot: string;
  readonly worktreePath: string;
  readonly force: boolean;
  /** Whose teardown script runs. Without it, the project rooted at `projectRoot`. */
  readonly projectId?: ProjectId;
  readonly threadId?: ThreadId;
  /**
   * Storage cleanup's removal: optionally delete untracked files, then remove without force so
   * Git still refuses a tracked edit made after the sweep's last check, and report Git's reason.
   */
  readonly sweep?: { readonly cleanUntrackedFiles: boolean };
  /** "Remove anyway" for a pod's worktree: no teardown script, and the pod is forgotten even if Docker refuses. */
  readonly skipPodTeardown?: boolean;
}

export class WorktreeLifecycle extends Context.Service<
  WorktreeLifecycle,
  {
    /**
     * Runs the project's teardown script in the worktree, then removes the worktree. On the host
     * the script's failure or timeout is logged and never stops the removal. A pod's worktree runs
     * the script inside the pod, then removes the pod, and keeps the worktree if either fails.
     */
    readonly remove: (
      input: WorktreeRemoveInput,
    ) => Effect.Effect<void, GitCommandError | WorktreePodTeardownError>;
  }
>()("t3/workspace/WorktreeLifecycle") {}

// The script's process group gets this long to exit after SIGTERM before SIGKILL.
const TEARDOWN_KILL_GRACE = "5 seconds";
// A child the script left running can hold its output open after it exits.
const OUTPUT_DRAIN_GRACE = "1 second";
const SWEEP_GIT_TIMEOUT_MS = 300_000;

// The spawner reports a signal death only as its error's message.
const terminatingSignal = (error: PlatformError.PlatformError) => {
  const cause = error.reason.cause;
  return cause instanceof Error
    ? (/due to receipt of signal: '(SIG[A-Z0-9]+)'/.exec(cause.message)?.[1] ?? null)
    : null;
};

const failureTag = (error: unknown) =>
  typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : "Defect";

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pods = yield* PodRuntimeService.PodRuntimeService;
  const executionTarget = yield* WorkspaceExecutionTarget.WorkspaceExecutionTarget;

  // Two removers of one path would run its teardown twice, the second in a
  // directory the first is deleting.
  const removalLocks = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();
  const withRemovalLock = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      const lock = removalLocks.get(key) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
      removalLocks.set(key, lock);
      lock.users++;
      return lock.semaphore.withPermit(effect).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            lock.users--;
            if (lock.users === 0) removalLocks.delete(key);
          }),
        ),
      );
    });

  const platform = yield* HostProcess.Platform;
  const hostEnv = yield* HostProcess.Environment;
  const home = yield* HostProcess.HomeDirectory;

  // cmd.exe's quoting needs verbatim arguments, which the spawner cannot pass;
  // PowerShell, its fallback, ships with every Windows.
  const teardownShells = terminalShellCandidates(platform, hostEnv).flatMap((candidate) => {
    const name = path.basename(candidate.shell).toLowerCase();
    if (name === "cmd.exe" || name === "cmd") return [];
    const commandFlags = /^(pwsh|powershell)(\.exe)?$/.test(name)
      ? ["-NonInteractive", "-Command"]
      : ["-c"];
    return [{ shell: candidate.shell, args: [...(candidate.args ?? []), ...commandFlags] }];
  });

  const resolveProject = (input: WorktreeRemoveInput) =>
    input.projectId === undefined
      ? projects.getByWorkspaceRoot(input.projectRoot)
      : projects.getById(input.projectId, { includeDeleted: true });

  // The path can come from a client, so the script only ever runs in a linked
  // worktree of the project it belongs to, never in the main checkout.
  const isLinkedWorktreeOf = Effect.fn("WorktreeLifecycle.isLinkedWorktreeOf")(function* (
    projectRoot: string,
    worktreePath: string,
  ) {
    const realPath = (target: string) =>
      fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => target));
    const target = yield* realPath(worktreePath);
    // Git lists the main worktree first.
    const [, ...linked] = yield* Effect.forEach(
      yield* git.listWorktreePaths(projectRoot),
      realPath,
    );
    return linked.includes(target) && target !== (yield* realPath(projectRoot));
  });

  /**
   * A child process rather than a ProjectSetupScriptRunner terminal: opening a
   * terminal takes the worktree's workspace lease, which storage cleanup holds
   * while it removes, so a terminal here would deadlock the sweep. On POSIX the
   * spawner kills the script's whole process group when it exits or times out,
   * so nothing it started keeps running in the deleted directory. On Windows
   * only a timeout kills the tree; children of a script that exits on its own
   * keep running.
   */
  const resolveTeardown = Effect.fn("WorktreeLifecycle.resolveTeardown")(function* (
    input: WorktreeRemoveInput,
    worktreePath: string,
  ) {
    const project = Option.getOrUndefined(yield* resolveProject(input));
    if (project === undefined) {
      yield* Effect.logInfo("no teardown: no project matches the worktree's checkout", {
        threadId: input.threadId ?? null,
        worktreePath,
      });
      return null;
    }
    const settings = yield* serverSettings.getSettings;
    const script = teardownProjectScript(resolveProjectScripts(settings, project));
    if (script === null || !(yield* fileSystem.exists(worktreePath))) return null;
    const logContext = {
      threadId: input.threadId ?? null,
      worktreePath,
      projectId: project.id,
      scriptId: script.id,
    };
    if (!(yield* isLinkedWorktreeOf(input.projectRoot, worktreePath))) {
      yield* Effect.logWarning(
        "skipped worktree teardown: path is not a linked worktree of the project",
        logContext,
      );
      return null;
    }
    return {
      script,
      logContext,
      timeoutMs: settings.worktreeRemovePolicy.timeoutMs,
      env: projectScriptRuntimeEnv({ project: { cwd: project.workspaceRoot }, worktreePath }),
    };
  });

  /**
   * A child process rather than a ProjectSetupScriptRunner terminal: opening a
   * terminal takes the worktree's workspace lease, which storage cleanup holds
   * while it removes, so a terminal here would deadlock the sweep. On POSIX the
   * spawner kills the script's whole process group when it exits or times out,
   * so nothing it started keeps running in the deleted directory. On Windows
   * only a timeout kills the tree; children of a script that exits on its own
   * keep running.
   */
  const runTeardown = Effect.fn("WorktreeLifecycle.runTeardown")(function* (
    input: WorktreeRemoveInput,
    worktreePath: string,
  ) {
    const teardown = yield* resolveTeardown(input, worktreePath);
    if (teardown === null) return false;
    const { script, logContext } = teardown;
    const options = {
      cwd: worktreePath,
      // The terminal's env, as setup gets: no T3 server variables such as
      // T3CODE_HOME, PORT or ELECTRON_RUN_AS_NODE.
      env: createTerminalSpawnEnv(
        hostEnv,
        {
          ...teardown.env,
          COLORTERM: "",
          NO_COLOR: "1",
          FORCE_COLOR: "0",
        },
        platform,
        home,
      ),
      extendEnv: false,
      stdin: "ignore",
      forceKillAfter: TEARDOWN_KILL_GRACE,
    } satisfies ChildProcess.CommandOptions;
    const timeoutMs = teardown.timeoutMs;
    const startedAt = yield* Clock.currentTimeMillis;
    let outputBytes = 0;
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* Effect.firstSuccessOf(
          teardownShells.map((shell) =>
            spawner.spawn(ChildProcess.make(shell.shell, [...shell.args, script.command], options)),
          ),
        );
        // Output is drained only so a chatty script never blocks on a full pipe;
        // it can carry credentials, so only its size is logged.
        const drain = yield* handle.all.pipe(
          Stream.runForEach((chunk) =>
            Effect.sync(() => {
              outputBytes += chunk.byteLength;
            }),
          ),
          Effect.ignore,
          Effect.forkScoped,
        );
        const exit = yield* handle.exitCode.pipe(
          Effect.map((exitCode) => ({ exitCode: exitCode as number | null, signal: null })),
          Effect.catch((error) => {
            const signal = terminatingSignal(error);
            return signal === null
              ? Effect.fail(error)
              : Effect.succeed({ exitCode: null, signal });
          }),
        );
        yield* Fiber.join(drain).pipe(Effect.timeoutOption(OUTPUT_DRAIN_GRACE));
        return exit;
      }),
    ).pipe(Effect.timeoutOption(timeoutMs));
    const outcome = {
      ...logContext,
      exitCode: Option.isSome(result) ? result.value.exitCode : null,
      signal: Option.isSome(result) ? result.value.signal : null,
      timedOut: Option.isNone(result),
      durationMs: (yield* Clock.currentTimeMillis) - startedAt,
      outputBytes,
    };
    if (outcome.timedOut) {
      yield* Effect.logWarning("worktree teardown script timed out; removing anyway", {
        ...outcome,
        timeoutMs,
      });
    } else if (outcome.exitCode !== 0) {
      yield* Effect.logWarning("worktree teardown script failed; removing anyway", outcome);
    }
    return true;
  });

  /**
   * The script runs inside the pod, which is started for it if it is not
   * running, then the pod is removed. Any failure keeps the worktree.
   */
  const teardownPod = Effect.fn("WorktreeLifecycle.teardownPod")(function* (
    input: WorktreeRemoveInput,
    worktreePath: string,
    pod: PodRuntimeSnapshot,
  ) {
    const failed = (
      step: WorktreePodTeardownError["step"],
      extra?: Partial<Pick<WorktreePodTeardownError, "state" | "exitCode" | "cause">>,
    ) => new WorktreePodTeardownError({ podId: pod.id, step, ...extra });
    const teardown =
      input.skipPodTeardown === true
        ? null
        : yield* resolveTeardown(input, worktreePath).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.fail(failed("script", { exitCode: null, cause: Cause.squash(cause) })),
            ),
          );
    if (teardown !== null) {
      yield* pods.ensureRunning(pod.id, { forTeardown: true }).pipe(
        Effect.catchTags({
          PodRuntimeError: (error) =>
            Effect.fail(
              failed("start", { ...(error.state ? { state: error.state } : {}), cause: error }),
            ),
        }),
      );
      const target = yield* executionTarget.resolve(worktreePath);
      if (target.type === "pod") {
        const result = yield* executionTarget
          .exec(target, {
            command: ["sh", "-c", teardown.script.command],
            cwd: worktreePath,
            env: { ...teardown.env, NO_COLOR: "1", FORCE_COLOR: "0" },
            timeoutMs: teardown.timeoutMs,
          })
          .pipe(
            Effect.catchTags({
              ContainerDriverError: (error) =>
                Effect.fail(failed("script", { exitCode: null, cause: error })),
            }),
          );
        if (result.exitCode !== 0) {
          yield* Effect.logWarning("pod teardown script failed; keeping the worktree", {
            ...teardown.logContext,
            podId: pod.id,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
          });
          return yield* failed("script", { exitCode: result.exitCode });
        }
      }
    }
    const removed = yield* pods
      .remove({ podId: pod.id, ...(input.skipPodTeardown === true ? { force: true } : {}) })
      .pipe(
        Effect.andThen(pods.awaitSettled(pod.id)),
        Effect.catchTags({
          PodRuntimeError: (error) => Effect.fail(failed("remove", { cause: error })),
        }),
      );
    if (removed.state !== "removed") return yield* failed("remove", { state: removed.state });
    return teardown !== null;
  });

  const sweepGit = Effect.fn("WorktreeLifecycle.sweepGit")(function* (
    cwd: string,
    args: ReadonlyArray<string>,
    command: string,
  ) {
    const result = yield* git.execute({
      operation: "StorageCleanup.cleanupGit",
      cwd,
      args,
      allowNonZeroExit: true,
      timeoutMs: SWEEP_GIT_TIMEOUT_MS,
    });
    if (result.exitCode !== 0)
      return yield* new GitCommandError({
        operation: "StorageCleanup.cleanupGit",
        command,
        cwd,
        detail: result.stderr.trim().split(/\r?\n/)[0]?.slice(0, 1000) || "command failed",
      });
  });

  const removeCheckout = (
    input: WorktreeRemoveInput,
    worktreePath: string,
    teardownRan: boolean,
  ) =>
    input.sweep === undefined
      ? gitWorkflow.removeWorktree({
          cwd: input.projectRoot,
          path: worktreePath,
          force: input.force,
        })
      : Effect.gen(function* () {
          // Another remover won the removal lock; the worktree is already gone.
          const exists = yield* fileSystem
            .exists(worktreePath)
            .pipe(Effect.orElseSucceed(() => true));
          if (!exists) return;
          if (input.sweep?.cleanUntrackedFiles)
            yield* sweepGit(worktreePath, ["clean", "-ffdx"], "git clean");
          // The sweep's final check, under the same workspace lease, found no
          // untracked files its policy protects, so any now are the script's.
          // Ignored files never block removal; a tracked edit still does.
          else if (teardownRan) yield* sweepGit(worktreePath, ["clean", "-fd"], "git clean");
          yield* sweepGit(
            input.projectRoot,
            ["-c", "status.showUntrackedFiles=normal", "worktree", "remove", "--", worktreePath],
            "git worktree remove",
          );
        });

  const remove: WorktreeLifecycle["Service"]["remove"] = Effect.fn("WorktreeLifecycle.remove")(
    function* (input) {
      const worktreePath = path.resolve(input.worktreePath);
      // Keyed on the real path, so two spellings of one worktree share a lock.
      const lockKey = yield* fileSystem
        .realPath(worktreePath)
        .pipe(Effect.orElseSucceed(() => worktreePath));
      const pod = yield* pods.forPath(worktreePath, { includeRemoved: true });
      yield* withRemovalLock(
        lockKey,
        (pod?.state === "removed"
          ? // Its script was written for the pod; on the host it would act on the host's Docker.
            Effect.logInfo("skipped worktree teardown: its pod was removed earlier", {
              threadId: input.threadId ?? null,
              worktreePath,
              podId: pod.id,
            }).pipe(Effect.as(false))
          : pod === undefined
            ? runTeardown(input, worktreePath).pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.interrupt
                    : Effect.logWarning("worktree teardown failed; removing anyway", {
                        threadId: input.threadId ?? null,
                        worktreePath,
                        projectId: input.projectId ?? null,
                        // Platform errors quote the script's command line, so only the tag.
                        error: failureTag(Cause.squash(cause)),
                      }).pipe(Effect.as(false)),
                ),
              )
            : teardownPod(input, worktreePath, pod)
        ).pipe(
          Effect.flatMap((teardownRan) => removeCheckout(input, worktreePath, teardownRan)),
          // The pod is removed by now; the path is free for a host worktree again.
          Effect.tap(() =>
            pod === undefined
              ? Effect.void
              : pods.releaseWorktree(worktreePath).pipe(
                  Effect.catchTags({
                    PodRuntimeError: (error) =>
                      Effect.logWarning("could not record a pod worktree as removed", {
                        podId: pod.id,
                        reason: error.reason,
                      }),
                  }),
                ),
          ),
        ),
      );
    },
  );

  return WorktreeLifecycle.of({ remove });
});

export const layer = Layer.effect(WorktreeLifecycle, make);
