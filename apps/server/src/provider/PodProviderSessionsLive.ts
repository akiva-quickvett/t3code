import type { PodRuntimeId, ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as PodMcpListener from "../mcp/PodMcpListener.ts";
import {
  podProviderCommand,
  resolveInstancePodDirectories,
  resolvePodProviderMounts,
} from "../pod/PodProviderMounts.ts";
import * as PodRuntimeService from "../pod/PodRuntimeService.ts";
import * as WorkspaceExecutionTarget from "../pod/WorkspaceExecutionTarget.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  HOST_PLACEMENT,
  podRefusalReason,
  PodProviderPlacement,
  type ProviderPlacementInput,
  ProviderPodProcess,
  ProviderPodRefusedError,
} from "./PodProviderSessions.ts";

const resolvePodTarget = (
  targets: WorkspaceExecutionTarget.WorkspaceExecutionTarget["Service"],
  cwd: string | null | undefined,
) =>
  cwd === null || cwd === undefined
    ? Effect.succeed(undefined)
    : targets
        .resolve(cwd)
        .pipe(Effect.map((target) => (target.type === "pod" ? target : undefined)));

/** Marks every process a launch starts in the container; children inherit it. */
export const POD_SESSION_ENV = "T3_POD_SESSION";

/**
 * Signals the container's processes carrying the session's mark, TERM and
 * then KILL. The mark rather than a pid: a pid can be reused by the next
 * session, and a child that left the process group still carries the mark.
 * Exits 3 when nothing carried it, so a stop that found nothing shows.
 */
const STOP_SESSION_SCRIPT = [
  "mark=$1",
  "found=0",
  "signal() {",
  "  for proc in /proc/[0-9]*; do",
  '    [ "${proc#/proc/}" = "$$" ] && continue',
  `    tr '\\0' '\\n' 2>/dev/null < "$proc/environ" | grep -qx "${POD_SESSION_ENV}=$mark" && { kill "-$1" "\${proc#/proc/}" 2>/dev/null; found=$((found + 1)); }`,
  "  done",
  "}",
  "signal TERM",
  '[ "$found" -gt 0 ] || exit 3',
  "sleep 2",
  "signal KILL",
  "true",
].join("\n");
const STOP_FOUND_NOTHING = 3;

const STOP_TIMEOUT_MS = 30_000;

export const layerProcess = Layer.effect(
  ProviderPodProcess,
  Effect.gen(function* () {
    const targets = yield* WorkspaceExecutionTarget.WorkspaceExecutionTarget;
    const uid = yield* HostProcess.UserId;
    const gid = yield* HostProcess.GroupId;
    const user = uid === undefined || gid === undefined ? undefined : `${uid}:${gid}`;
    const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const markPrefix = yield* (yield* Crypto.Crypto).randomUUIDv4().pipe(Effect.orDie);
    let launches = 0;
    return {
      resolve: (cwd) => resolvePodTarget(targets, cwd),
      command: (hostCommand) => podProviderCommand(hostCommand).pipe(Effect.provide(services)),
      launch: (target, spec) => {
        const mark = `${markPrefix}-${++launches}`;
        const asUser = user === undefined ? {} : { user };
        return {
          ...targets.launch(target, {
            ...spec,
            env: { ...spec.env, [POD_SESSION_ENV]: mark },
            ...asUser,
            tty: false,
          }),
          // As root: a process of the session running as another user, such
          // as a setuid helper, hides its environment from the host user. Only
          // processes carrying this launch's random mark are signalled.
          stop: targets
            .exec(target, {
              command: ["sh", "-c", STOP_SESSION_SCRIPT, "t3-pod-stop", mark],
              user: "0",
              timeoutMs: STOP_TIMEOUT_MS,
            })
            .pipe(
              Effect.flatMap(({ exitCode }) =>
                exitCode === 0
                  ? Effect.logDebug("stopped a pod session's processes", { podId: target.podId })
                  : exitCode === STOP_FOUND_NOTHING
                    ? Effect.logInfo("a pod session had no processes left to stop", {
                        podId: target.podId,
                      })
                    : Effect.logWarning("stopping a pod session's processes failed", {
                        podId: target.podId,
                        exitCode,
                      }),
              ),
              Effect.catch((error) =>
                Effect.logWarning("could not stop a pod session's processes", {
                  podId: target.podId,
                  detail: error.message,
                }),
              ),
            ),
        };
      },
    };
  }),
);

const MOUNT_CHECK_TIMEOUT_MS = 10_000;

export const layerPlacement = Layer.effect(
  PodProviderPlacement,
  Effect.gen(function* () {
    const targets = yield* WorkspaceExecutionTarget.WorkspaceExecutionTarget;
    const pods = yield* PodRuntimeService.PodRuntimeService;
    const listener = yield* PodMcpListener.PodMcpListener;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const podLocks = yield* KeyedLock.make<PodRuntimeId>();

    const refuse = (reason: string) => (cause?: unknown) =>
      new ProviderPodRefusedError({ reason, ...(cause === undefined ? {} : { cause }) });

    const missingDirectories = (
      target: WorkspaceExecutionTarget.PodExecutionTarget,
      instanceId: ProviderInstanceId,
    ) =>
      Effect.gen(function* () {
        const settings = yield* serverSettings.getSettings;
        const directories = yield* resolveInstancePodDirectories(settings, instanceId).pipe(
          Effect.provide(services),
        );
        return yield* Effect.filter(directories, (directory) =>
          targets
            .exec(target, { command: ["test", "-d", directory], timeoutMs: MOUNT_CHECK_TIMEOUT_MS })
            .pipe(Effect.map((result) => result.exitCode !== 0)),
        );
      }).pipe(Effect.mapError(refuse("The pod's agent container could not be checked.")));

    /**
     * The agent container mounts the config dirs of the project's enabled
     * instances as they were when it was made. Switching a pod thread to an
     * account it lacks makes it again with that dir; the daemon, its volume
     * and the stack stay. Refused rather than recreated when the new container
     * would still lack the dir, or when it would end another agent's turn.
     */
    const ensureInstanceMounted = (
      target: WorkspaceExecutionTarget.PodExecutionTarget,
      instanceId: ProviderInstanceId,
      podBusy: (podId: PodRuntimeId) => Effect.Effect<boolean>,
    ) =>
      podLocks.withLock(
        target.podId,
        Effect.gen(function* () {
          const missing = yield* missingDirectories(target, instanceId);
          if (missing.length === 0) return false;
          const pod = yield* pods.forPath(target.worktreePath);
          const mounts =
            pod === undefined
              ? undefined
              : yield* serverSettings.getSettings.pipe(
                  Effect.flatMap((settings) =>
                    resolvePodProviderMounts(settings, pod.projectId).pipe(
                      Effect.provide(services),
                    ),
                  ),
                  Effect.mapError(refuse("The pod's provider mounts could not be read.")),
                );
          const mountable = new Set([...(mounts?.configDirs ?? []), ...(mounts?.codexHomes ?? [])]);
          if (!missing.every((directory) => mountable.has(directory)))
            return yield* refuse(
              "This provider instance's config dir is not mounted in the pod; enable the instance for this project.",
            )();
          if (yield* podBusy(target.podId))
            return yield* refuse(
              "Another agent in this pod is mid-turn. Switching to this account recreates the pod's agent container, which would end that turn; try again when it finishes.",
            )();
          yield* Effect.logInfo("recreating a pod's agent container for a provider account", {
            podId: target.podId,
            instanceId,
          });
          const recreated = yield* pods
            .recreateAgentContainer(target.podId)
            .pipe(
              Effect.andThen(pods.awaitSettled(target.podId)),
              Effect.mapError(refuse("The pod's agent container could not be recreated.")),
            );
          if (recreated.state !== "running")
            return yield* refuse(
              `The pod's agent container could not be recreated: ${recreated.lastError?.message ?? recreated.state}.`,
            )();
          if ((yield* missingDirectories(target, instanceId)).length > 0)
            return yield* refuse(
              "This provider instance's config dir is still not mounted in the new agent container.",
            )();
          return true;
        }),
      );

    /** The pod a session must run in, or undefined for the host; refuses what cannot run there. */
    const podTargetFor = (input: ProviderPlacementInput) =>
      Effect.gen(function* () {
        const target = yield* resolvePodTarget(targets, input.cwd);
        if (target === undefined) return undefined;
        const refusal = podRefusalReason(input.driver);
        if (refusal === undefined) return target;
        if (input.runsIn === "host") return undefined;
        return yield* refuse(
          `${refusal} Give the thread a role preset with runsIn: host to run it on the host against this worktree, or pick Claude or Codex.`,
        )();
      });

    return {
      podFor: (input) => podTargetFor(input).pipe(Effect.map((target) => target?.podId)),
      place: (input) =>
        Effect.gen(function* () {
          const target = yield* podTargetFor(input);
          if (target === undefined) return HOST_PLACEMENT;
          if (target.state !== "running")
            return yield* refuse(
              `The pod is ${target.state}; start it to run this thread's agent.`,
            )();
          const agentRecreated = yield* ensureInstanceMounted(
            target,
            input.instanceId,
            input.podBusy,
          );
          const mcpEndpoint = yield* listener
            .endpointFor(target)
            .pipe(Effect.mapError((error) => refuse(error.message)(error)));
          return { type: "pod", podId: target.podId, mcpEndpoint, agentRecreated } as const;
        }),
    };
  }),
);
