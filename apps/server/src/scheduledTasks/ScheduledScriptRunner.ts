import { type ProjectId, type ProjectScript, ScheduledTaskError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { projectScriptRuntimeEnv, resolveProjectScripts } from "@t3tools/shared/projectScripts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { createTerminalSpawnEnv, terminalShellCandidates } from "../terminal/Manager.ts";

/** Scheduled tasks have no timeout of their own, so a hung script cannot hold its task forever. */
const SCHEDULED_SCRIPT_TIMEOUT_MINUTES = 30;
// The script's process group gets this long to exit after SIGTERM before SIGKILL.
const KILL_GRACE = "5 seconds";
// A child the script left running can hold its output open after it exits.
const OUTPUT_DRAIN_GRACE = "1 second";
const STDERR_TAIL_BYTES = 8 * 1024;
const ERROR_TAIL_LINES = 10;
export const SCRIPT_ERROR_MAX_CHARS = 500;

export interface ScheduledScriptRunInput {
  readonly projectId: ProjectId;
  readonly scriptId: string;
}

export class ScheduledScriptRunner extends Context.Service<
  ScheduledScriptRunner,
  {
    /** The project's script with this id, as its settings resolve them; null when there is none. */
    readonly findScript: (
      input: ScheduledScriptRunInput,
    ) => Effect.Effect<ProjectScript | null, ScheduledTaskError>;
    /**
     * Runs the script in the project root and resolves with why it failed, or null when it exited
     * with code 0. A missing project or script is a failed run, not an error.
     */
    readonly run: (
      input: ScheduledScriptRunInput,
    ) => Effect.Effect<{ readonly failure: string | null }, ScheduledTaskError>;
  }
>()("t3/scheduledTasks/ScheduledScriptRunner") {}

// The spawner reports a signal death only as its error's message.
const terminatingSignal = (error: PlatformError.PlatformError) => {
  const cause = error.reason.cause;
  return cause instanceof Error
    ? (/due to receipt of signal: '(SIG[A-Z0-9]+)'/.exec(cause.message)?.[1] ?? null)
    : null;
};

/** The last lines of a script's stderr, keeping the newest characters when it is too long. */
function stderrTail(bytes: Uint8Array, maxChars: number): string {
  const lines = new TextDecoder()
    .decode(bytes)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  const tail = lines.slice(-ERROR_TAIL_LINES).join("\n");
  return tail.length <= maxChars ? tail : `…${tail.slice(-(maxChars - 1))}`;
}

/** Short enough for a task row and a settings card, with the newest stderr kept. */
function scriptFailureMessage(input: {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stderr: Uint8Array;
}): string {
  const reason =
    input.signal !== null
      ? `Script was stopped by ${input.signal}.`
      : `Script exited with code ${input.exitCode ?? "unknown"}.`;
  const tail = stderrTail(input.stderr, SCRIPT_ERROR_MAX_CHARS - reason.length - 1);
  return tail === "" ? reason : `${reason}\n${tail}`;
}

/** Keeps only the newest bytes, so a chatty script costs a fixed amount of memory. */
function appendTail(tail: Uint8Array, chunk: Uint8Array): Uint8Array {
  if (chunk.byteLength >= STDERR_TAIL_BYTES) return chunk.slice(-STDERR_TAIL_BYTES);
  const keep = Math.min(tail.byteLength, STDERR_TAIL_BYTES - chunk.byteLength);
  const next = new Uint8Array(keep + chunk.byteLength);
  next.set(tail.subarray(tail.byteLength - keep), 0);
  next.set(chunk, keep);
  return next;
}

const toTaskError = (message: string) => (cause: unknown) =>
  new ScheduledTaskError({ message, cause });

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const hostEnv = yield* HostProcess.Environment;
  const home = yield* HostProcess.HomeDirectory;

  // cmd.exe's quoting needs verbatim arguments, which the spawner cannot pass;
  // PowerShell, its fallback, ships with every Windows.
  const shells = terminalShellCandidates(platform, hostEnv).flatMap((candidate) => {
    const name = path.basename(candidate.shell).toLowerCase();
    if (name === "cmd.exe" || name === "cmd") return [];
    const commandFlags = /^(pwsh|powershell)(\.exe)?$/.test(name)
      ? ["-NonInteractive", "-Command"]
      : ["-c"];
    return [{ shell: candidate.shell, args: [...(candidate.args ?? []), ...commandFlags] }];
  });

  const resolve = Effect.fn("ScheduledScriptRunner.resolve")(function* (
    input: ScheduledScriptRunInput,
  ) {
    const project = Option.getOrUndefined(
      yield* projects
        .getById(input.projectId)
        .pipe(Effect.mapError(toTaskError("Could not load the task's project."))),
    );
    if (project === undefined) return null;
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(toTaskError("Could not read project scripts.")),
    );
    const script = resolveProjectScripts(settings, project).find(
      (candidate) => candidate.id === input.scriptId,
    );
    return script === undefined ? null : { project, script };
  });

  const findScript: ScheduledScriptRunner["Service"]["findScript"] = (input) =>
    resolve(input).pipe(Effect.map((found) => found?.script ?? null));

  /**
   * A child process rather than a terminal: a scheduled run has no thread to show one in. Only the
   * configured script's command reaches the shell; the task contributes nothing but the id that
   * found it. On POSIX the spawner kills the script's whole process group when it exits or times out.
   */
  const run: ScheduledScriptRunner["Service"]["run"] = Effect.fn("ScheduledScriptRunner.run")(
    function* (input) {
      const found = yield* resolve(input);
      if (found === null) {
        return {
          failure: `Project script "${input.scriptId}" is no longer configured for this project.`,
        };
      }
      const { project, script } = found;
      const options = {
        cwd: project.workspaceRoot,
        // The terminal's env, as setup scripts get: no T3 server variables such as
        // T3CODE_HOME, PORT or ELECTRON_RUN_AS_NODE.
        env: createTerminalSpawnEnv(
          hostEnv,
          {
            ...projectScriptRuntimeEnv({ project: { cwd: project.workspaceRoot } }),
            COLORTERM: "",
            NO_COLOR: "1",
            FORCE_COLOR: "0",
          },
          platform,
          home,
        ),
        extendEnv: false,
        stdin: "ignore",
        forceKillAfter: KILL_GRACE,
      } satisfies ChildProcess.CommandOptions;
      let stderr: Uint8Array = new Uint8Array(0);
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* Effect.firstSuccessOf(
            shells.map((shell) =>
              spawner.spawn(
                ChildProcess.make(shell.shell, [...shell.args, script.command], options),
              ),
            ),
          );
          // Stdout is drained only so a chatty script never blocks on a full pipe.
          const drainStdout = yield* handle.stdout.pipe(
            Stream.runDrain,
            Effect.ignore,
            Effect.forkScoped,
          );
          const drainStderr = yield* handle.stderr.pipe(
            Stream.runForEach((chunk) =>
              Effect.sync(() => {
                stderr = appendTail(stderr, chunk);
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
          yield* Fiber.joinAll([drainStdout, drainStderr]).pipe(
            Effect.timeoutOption(OUTPUT_DRAIN_GRACE),
          );
          return exit;
        }),
      ).pipe(
        Effect.timeoutOption(Duration.minutes(SCHEDULED_SCRIPT_TIMEOUT_MINUTES)),
        Effect.mapError(toTaskError(`Could not start project script "${script.name}".`)),
      );
      if (Option.isNone(result)) {
        return {
          failure: `Script timed out after ${SCHEDULED_SCRIPT_TIMEOUT_MINUTES} minutes and was stopped.`,
        };
      }
      const { exitCode, signal } = result.value;
      return {
        failure:
          exitCode === 0 && signal === null
            ? null
            : scriptFailureMessage({ exitCode, signal, stderr }),
      };
    },
  );

  return ScheduledScriptRunner.of({ findScript, run });
});

export const layer = Layer.effect(ScheduledScriptRunner, make);
