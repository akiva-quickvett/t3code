import type { PodRuntimeId, ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as PodMcpListener from "../mcp/PodMcpListener.ts";
import { podProviderCommand, resolveInstancePodDirectories } from "../pod/PodProviderMounts.ts";
import * as PodRuntimeService from "../pod/PodRuntimeService.ts";
import * as WorkspaceExecutionTarget from "../pod/WorkspaceExecutionTarget.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  HOST_PLACEMENT,
  podRefusalReason,
  PodProviderPlacement,
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

export const layerProcess = Layer.effect(
  ProviderPodProcess,
  Effect.gen(function* () {
    const targets = yield* WorkspaceExecutionTarget.WorkspaceExecutionTarget;
    const uid = yield* HostProcess.UserId;
    const gid = yield* HostProcess.GroupId;
    const user = uid === undefined || gid === undefined ? undefined : `${uid}:${gid}`;
    const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    return {
      resolve: (cwd) => resolvePodTarget(targets, cwd),
      command: (hostCommand) => podProviderCommand(hostCommand).pipe(Effect.provide(services)),
      launch: (target, spec) =>
        targets.launch(target, { ...spec, ...(user === undefined ? {} : { user }), tty: false }),
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
     * The agent container mounts the config dirs of the instances enabled
     * when it was made. Switching a pod thread to an account it lacks makes
     * it again with that dir; the daemon, its volume and the stack stay.
     */
    const ensureInstanceMounted = (
      target: WorkspaceExecutionTarget.PodExecutionTarget,
      instanceId: ProviderInstanceId,
    ) =>
      podLocks.withLock(
        target.podId,
        Effect.gen(function* () {
          if ((yield* missingDirectories(target, instanceId)).length === 0) return false;
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
              "This provider instance's config dir is not mounted in the pod; enable the instance for this project.",
            )();
          return true;
        }),
      );

    return {
      podOf: (cwd) => resolvePodTarget(targets, cwd).pipe(Effect.map((target) => target?.podId)),
      place: (input) =>
        Effect.gen(function* () {
          const target = yield* resolvePodTarget(targets, input.cwd);
          if (target === undefined) return HOST_PLACEMENT;
          const refusal = podRefusalReason(input.driver);
          if (refusal !== undefined) {
            if (input.runsIn === "host") return HOST_PLACEMENT;
            return yield* refuse(
              `${refusal} Give the thread a role preset with runsIn: host to run it on the host against this worktree, or pick Claude or Codex.`,
            )();
          }
          if (target.state !== "running")
            return yield* refuse(
              `The pod is ${target.state}; start it to run this thread's agent.`,
            )();
          const agentRecreated = yield* ensureInstanceMounted(target, input.instanceId);
          const mcpEndpoint = yield* listener
            .endpointFor(target)
            .pipe(Effect.mapError((error) => refuse(error.message)(error)));
          return { type: "pod", podId: target.podId, mcpEndpoint, agentRecreated } as const;
        }),
    };
  }),
);
