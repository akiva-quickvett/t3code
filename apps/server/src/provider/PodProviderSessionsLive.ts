import type { PodRuntimeId, ProviderInstanceId } from "@t3tools/contracts";
import { type ProviderPod, ProviderPodProcesses } from "@t3tools/provider-core/server/podProcess";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as PodMcpListener from "../mcp/PodMcpListener.ts";
import { podFilesDir, PodPaths } from "../pod/PodPaths.ts";
import {
  hostBinariesRunInPods,
  podProviderCommand,
  resolveInstancePodDirectories,
  resolvePodProviderMounts,
  unsafePodConfigDirs,
} from "../pod/PodProviderMounts.ts";
import type { PodRuntimeRecord } from "../pod/PodRuntimeLifecycle.ts";
import * as PodRuntimeService from "../pod/PodRuntimeService.ts";
import * as PodRuntimeStore from "../pod/PodRuntimeStore.ts";
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
 * Runs a launch with its pid recorded, so its stop can find the processes it
 * started that dropped the mark (a child given a cleaned environment, such
 * as Codex's stdio MCP servers). `exec` keeps the pid.
 */
// Without a writable /tmp the launch still starts; its mark alone then stops it.
const LAUNCH_SCRIPT = '{ echo "$$" > "$1"; } 2>/dev/null; shift; exec "$@"';

/** Inside the container, never the host's /tmp, which a pod does not mount. */
const launchPidFile = (mark: string) => `/tmp/t3-pod-session-${mark}.pid`;

/**
 * Signals a launch's processes, TERM and then KILL. `session <mark> <pidfile>`
 * takes those carrying the mark and the descendants of the launch's own
 * process, while it still runs with the mark: a reused pid carries none.
 * `others <prefix> -` takes those marked by an earlier server, whose stops
 * never ran. Marks rather than pids where possible: a child that left the
 * process group keeps its mark. After TERM it waits up to 2 s for the targets
 * to go, then KILLs what is left, signalling a pid only while its start time
 * is the one the TERM pass saw. Exits 3 when nothing matched, so a
 * stop that found nothing shows. A fourth argument replaces /proc, so a test
 * on a shared machine scans only its own processes.
 */
const STOP_SCRIPT = [
  "mode=$1",
  "value=$2",
  "pidfile=$3",
  "root=${4:-/proc}",
  "found=0",
  "targets=",
  'mark_of() { tr "\\0" "\\n" 2>/dev/null < "$root/$1/environ" | grep "^' +
    POD_SESSION_ENV +
    '=" | head -n 1; }',
  "stat_field() {",
  "  field=$2",
  '  stat=$(cat "$root/$1/stat" 2>/dev/null) || return 1',
  "  rest=${stat##*) }",
  "  set -- $rest",
  "  shift $((field - 3))",
  '  echo "$1"',
  "}",
  "matches() {",
  '  case "$1" in',
  '    "") return 1 ;;',
  '    "' + POD_SESSION_ENV + '=$value") [ "$mode" = session ] ;;',
  '    "' + POD_SESSION_ENV + '=$value-"*) return 1 ;;',
  '    *) [ "$mode" = others ] ;;',
  "  esac",
  "}",
  'add() { start=$(stat_field "$1" 22) && targets="$targets $1:$start"; }',
  'for proc in "$root"/[0-9]*; do',
  "  pid=${proc##*/}",
  '  [ "$pid" = "$$" ] && continue',
  '  matches "$(mark_of "$pid")" && add "$pid"',
  "done",
  'if [ "$mode" = session ] && [ -r "$pidfile" ]; then',
  '  top=$(cat "$pidfile")',
  '  if [ "$(mark_of "$top")" = "' + POD_SESSION_ENV + '=$value" ]; then',
  "    frontier=$top",
  '    while [ -n "$frontier" ]; do',
  "      next=",
  '      for proc in "$root"/[0-9]*; do',
  "        pid=${proc##*/}",
  '        parent=$(stat_field "$pid" 4) || continue',
  "        for candidate in $frontier; do",
  '          [ "$parent" = "$candidate" ] && { next="$next $pid"; add "$pid"; break; }',
  "        done",
  "      done",
  "      frontier=$next",
  "    done",
  "  fi",
  'rm -f "$pidfile"',
  "fi",
  'same() { [ "$(stat_field "${1%%:*}" 22)" = "${1#*:}" ]; }',
  "signal() {",
  "  for target in $targets; do",
  '    same "$target" && kill "-$1" "${target%%:*}" 2>/dev/null && found=$((found + 1))',
  "  done",
  "}",
  "alive() {",
  "  for target in $targets; do",
  '    same "$target" && [ "$(stat_field "${target%%:*}" 3)" != Z ] && return 0',
  "  done",
  "  return 1",
  "}",
  "signal TERM",
  '[ "$found" -gt 0 ] || exit 3',
  "tries=0",
  'while alive && [ "$tries" -lt 20 ]; do sleep 0.1; tries=$((tries + 1)); done',
  "signal KILL",
  "true",
].join("\n");
const STOP_FOUND_NOTHING = 3;

const STOP_TIMEOUT_MS = 30_000;

const layerPodProcess = Layer.effect(
  ProviderPodProcess,
  Effect.gen(function* () {
    const targets = yield* WorkspaceExecutionTarget.WorkspaceExecutionTarget;
    const store = yield* PodRuntimeStore.PodRuntimeStore;
    const uid = yield* HostProcess.UserId;
    const gid = yield* HostProcess.GroupId;
    const user = uid === undefined || gid === undefined ? undefined : `${uid}:${gid}`;
    const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const podPaths = yield* PodPaths;
    const markPrefix = yield* (yield* Crypto.Crypto).randomUUIDv4().pipe(Effect.orDie);
    let launches = 0;

    // As root: a process of the session running as another user, such as a
    // setuid helper, hides its environment from the host user. Only processes
    // carrying a T3 mark, or started by a launch's own marked process, are
    // ever signalled.
    const stopMarked = (
      target: WorkspaceExecutionTarget.PodExecutionTarget,
      mode: "session" | "others",
      value: string,
      pidFile: string,
    ) =>
      targets
        .exec(target, {
          command: ["sh", "-c", STOP_SCRIPT, "t3-pod-stop", mode, value, pidFile],
          user: "0",
          timeoutMs: STOP_TIMEOUT_MS,
        })
        .pipe(
          Effect.flatMap(({ exitCode }) =>
            exitCode === 0
              ? Effect.succeed("stopped" as const)
              : exitCode === STOP_FOUND_NOTHING
                ? Effect.succeed("none" as const)
                : Effect.logWarning("stopping a pod's marked processes failed", {
                    podId: target.podId,
                    exitCode,
                  }).pipe(Effect.as("failed" as const)),
          ),
          Effect.catch((error) =>
            Effect.logWarning("could not stop a pod's marked processes", {
              podId: target.podId,
              detail: error.message,
            }).pipe(Effect.as("failed" as const)),
          ),
        );

    /**
     * Sessions of a server that crashed or was killed never ran their stop, so
     * their processes would outlive it in the container. Each running pod is
     * swept once per start of its containers, for marks this server did not make.
     */
    const swept = new Set<string>();
    const sweep = (record: PodRuntimeRecord) => {
      const { snapshot } = record;
      const key = `${snapshot.id}\u0000${snapshot.startedAt ?? ""}`;
      if (snapshot.state !== "running" || swept.has(key)) return Effect.void;
      const target: WorkspaceExecutionTarget.PodExecutionTarget = {
        type: "pod",
        podId: snapshot.id,
        state: snapshot.state,
        worktreePath: snapshot.worktreePath,
        dockerHost: record.dockerHost,
      };
      // A failed sweep (the daemon was down) is tried again on the next event.
      return stopMarked(target, "others", markPrefix, "-").pipe(
        Effect.tap((outcome) =>
          Effect.sync(() => {
            if (outcome !== "failed") swept.add(key);
          }),
        ),
        Effect.flatMap((outcome) =>
          outcome === "stopped"
            ? Effect.logInfo("stopped an earlier server's sessions left in a pod", {
                podId: snapshot.id,
              })
            : Effect.void,
        ),
      );
    };
    const subscription = yield* store.subscribe;
    yield* Effect.forEach(yield* store.list, sweep, { discard: true }).pipe(
      Effect.andThen(Stream.fromSubscription(subscription).pipe(Stream.runForEach(sweep))),
      Effect.forkScoped,
    );

    return {
      resolve: (cwd) => resolvePodTarget(targets, cwd),
      command: (hostCommand) =>
        podProviderCommand(hostCommand, podPaths?.toolsDir).pipe(Effect.provide(services)),
      launch: (target, spec) => {
        const mark = `${markPrefix}-${++launches}`;
        const asUser = user === undefined ? {} : { user };
        return {
          ...targets.launch(target, {
            ...spec,
            command: [
              "sh",
              "-c",
              LAUNCH_SCRIPT,
              "t3-pod-launch",
              launchPidFile(mark),
              ...spec.command,
            ],
            env: { ...spec.env, [POD_SESSION_ENV]: mark },
            ...asUser,
            tty: false,
          }),
          stop: stopMarked(target, "session", mark, launchPidFile(mark)).pipe(
            Effect.flatMap((outcome) =>
              outcome === "stopped"
                ? Effect.logDebug("stopped a pod session's processes", { podId: target.podId })
                : outcome === "none"
                  ? Effect.logInfo("a pod session had no processes left to stop", {
                      podId: target.podId,
                    })
                  : Effect.void,
            ),
          ),
        };
      },
    };
  }),
);

/** What provider packages, which cannot see the pod runtime, spawn through. */
const layerProviderPodProcesses = Layer.effect(
  ProviderPodProcesses,
  Effect.gen(function* () {
    const podProcess = yield* ProviderPodProcess;
    const podPaths = yield* PodPaths;
    const hostBinariesRun = yield* hostBinariesRunInPods;
    const podFor = (target: WorkspaceExecutionTarget.PodExecutionTarget): ProviderPod => ({
      podId: target.podId,
      ...(podPaths === undefined ? {} : { fileDir: podFilesDir(podPaths.filesRoot, target.podId) }),
      hostBinariesRun,
      launch: (spec) =>
        podProcess.command(spec.command).pipe(
          Effect.map((command) =>
            podProcess.launch(target, {
              command: [command, ...spec.args],
              cwd: spec.cwd,
              env: spec.env,
              // Unlike Claude's, these envs hold nothing the server inherited.
              instanceCredentials: true,
            }),
          ),
        ),
    });
    return {
      forCwd: (cwd) =>
        podProcess
          .resolve(cwd)
          .pipe(Effect.map((target) => (target === undefined ? undefined : podFor(target)))),
    };
  }),
);

export const layerProcess = layerProviderPodProcesses.pipe(Layer.provideMerge(layerPodProcess));

const MOUNT_CHECK_TIMEOUT_MS = 10_000;

const MCP_PROBE_TIMEOUT_MS = 10_000;
const MCP_PROBE_CANNOT_TELL = 125;
/**
 * Run in the agent container, so it comes from the pod network as the agents
 * do. Any HTTP answer means the listener is reachable; curl without `-f` exits
 * 0 for one. Images without curl (`docker:27-cli`) have busybox's `nc`.
 */
const MCP_PROBE_SCRIPT = [
  'if command -v curl >/dev/null 2>&1; then curl -s -o /dev/null -m 3 "$1"; exit $?; fi',
  'if command -v nc >/dev/null 2>&1; then nc -z -w 3 "$2" "$3"; exit $?; fi',
  `exit ${MCP_PROBE_CANNOT_TELL}`,
].join("\n");

export const layerPlacement = Layer.effect(
  PodProviderPlacement,
  Effect.gen(function* () {
    const targets = yield* WorkspaceExecutionTarget.WorkspaceExecutionTarget;
    const pods = yield* PodRuntimeService.PodRuntimeService;
    const listener = yield* PodMcpListener.PodMcpListener;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const podLocks = yield* KeyedLock.make<PodRuntimeId>();
    const podPaths = yield* PodPaths;

    const refuse = (reason: string) => (cause?: unknown) =>
      new ProviderPodRefusedError({ reason, ...(cause === undefined ? {} : { cause }) });

    /**
     * Whether the pod's agents reach the listener. A host firewall that drops
     * the pod network is the usual reason they do not, and nothing else would
     * show it: agents then just run without T3's tools.
     */
    const probeMcpListener = (target: WorkspaceExecutionTarget.PodExecutionTarget) =>
      Effect.gen(function* () {
        const endpoint = new URL(yield* listener.endpointFor(target));
        const { exitCode } = yield* targets.exec(target, {
          command: [
            "sh",
            "-c",
            MCP_PROBE_SCRIPT,
            "t3-mcp-probe",
            endpoint.href,
            endpoint.hostname,
            endpoint.port,
          ],
          timeoutMs: MCP_PROBE_TIMEOUT_MS,
        });
        return exitCode === 0
          ? ("reachable" as const)
          : exitCode === null || exitCode === MCP_PROBE_CANNOT_TELL
            ? null
            : ("blocked" as const);
      }).pipe(Effect.orElseSucceed(() => null));

    const recordMcpListener = (
      target: WorkspaceExecutionTarget.PodExecutionTarget,
      startedAt: string | null,
    ) =>
      probeMcpListener(target).pipe(
        Effect.tap((status) =>
          status === "blocked"
            ? Effect.logWarning(
                "agents in a pod cannot reach T3's MCP listener; check the host firewall",
                { podId: target.podId },
              )
            : Effect.void,
        ),
        Effect.flatMap((status) => pods.noteMcpListener(target.podId, startedAt, status)),
        Effect.ignore,
      );

    // Once per start of a pod's containers; a session placed while the last
    // probe said blocked probes again, so a fixed firewall shows without polling.
    const probedStarts = new Set<string>();
    const layerScope = yield* Effect.scope;
    yield* pods.subscribe.pipe(
      Stream.flatMap((event) =>
        Stream.fromIterable(event.type === "snapshot" ? event.pods : [event.pod]),
      ),
      Stream.runForEach((snapshot) => {
        const key = `${snapshot.id}\u0000${snapshot.startedAt ?? ""}`;
        if (snapshot.state !== "running" || probedStarts.has(key)) return Effect.void;
        probedStarts.add(key);
        return targets.resolve(snapshot.worktreePath).pipe(
          Effect.flatMap((target) =>
            target.type === "pod" && target.podId === snapshot.id
              ? recordMcpListener(target, snapshot.startedAt)
              : Effect.void,
          ),
          Effect.forkIn(layerScope),
        );
      }),
      Effect.ignore,
      Effect.forkScoped,
    );

    /** Pi reads T3's extension from the pod's files dir, which pods made before it lack. */
    const driverDirectories = (
      target: WorkspaceExecutionTarget.PodExecutionTarget,
      driver: string,
    ) =>
      driver === "pi" && podPaths !== undefined
        ? [podFilesDir(podPaths.filesRoot, target.podId)]
        : [];

    const missingDirectories = (
      target: WorkspaceExecutionTarget.PodExecutionTarget,
      instanceId: ProviderInstanceId,
      driver: string,
    ) =>
      Effect.gen(function* () {
        const settings = yield* serverSettings.getSettings;
        const directories = [
          ...(yield* resolveInstancePodDirectories(settings, instanceId, podPaths).pipe(
            Effect.provide(services),
          )),
          ...driverDirectories(target, driver),
        ];
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
      driver: string,
      podBusy: (podId: PodRuntimeId) => Effect.Effect<boolean>,
    ) =>
      podLocks.withLock(
        target.podId,
        Effect.gen(function* () {
          const missing = yield* missingDirectories(target, instanceId, driver);
          if (missing.length === 0) return false;
          const pod = yield* pods.forPath(target.worktreePath);
          const mounts =
            pod === undefined
              ? undefined
              : yield* serverSettings.getSettings.pipe(
                  Effect.flatMap((settings) =>
                    resolvePodProviderMounts(settings, pod.projectId, podPaths).pipe(
                      Effect.provide(services),
                    ),
                  ),
                  Effect.mapError(refuse("The pod's provider mounts could not be read.")),
                );
          const mountable = new Set([
            ...(mounts?.configDirs ?? []),
            ...(mounts?.codexHomes ?? []),
            ...(mounts?.toolDirs ?? []),
            ...driverDirectories(target, driver),
          ]);
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
          if ((yield* missingDirectories(target, instanceId, driver)).length > 0)
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
          `${refusal} Give the thread a role preset with runsIn: host to run it on the host against this worktree, or pick a provider that runs in pods.`,
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
          const unsafe = yield* serverSettings.getSettings.pipe(
            Effect.flatMap((settings) =>
              unsafePodConfigDirs(settings, input.instanceId, podPaths).pipe(
                Effect.provide(services),
              ),
            ),
            Effect.mapError(refuse("The pod's provider mounts could not be read.")),
          );
          if (unsafe.length > 0)
            return yield* refuse(
              `This provider instance's config dir ${unsafe[0]} would give the pod far more than its login, since pods mount it read-write. Point the instance at a directory of its own to run it in a pod.`,
            )();
          const agentRecreated = yield* ensureInstanceMounted(
            target,
            input.instanceId,
            input.driver,
            input.podBusy,
          );
          const mcpEndpoint = yield* listener
            .endpointFor(target)
            .pipe(Effect.mapError((error) => refuse(error.message)(error)));
          // In the background: the session need not wait for a probe that may time out.
          const snapshot = yield* pods.forPath(target.worktreePath);
          if (snapshot?.id === target.podId && snapshot.mcpListener === "blocked")
            yield* recordMcpListener(target, snapshot.startedAt).pipe(Effect.forkIn(layerScope));
          return { type: "pod", podId: target.podId, mcpEndpoint, agentRecreated } as const;
        }),
    };
  }),
);
