import type { PodRuntimeId, T3ProjectFilePod } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import {
  type ContainerDriverError,
  type ContainerHost,
  outputTail,
  type PodContainerInfo,
  type PodContainerSpec,
} from "./ContainerDriver.ts";
import {
  POD_ENVIRONMENT_LABEL,
  POD_LABEL,
  POD_PROXY_CA_PATH,
  type PodPlan,
  podSafeEnv,
} from "./PodContainerPlan.ts";
import type { PodInternalOperation } from "./PodRuntimeLifecycle.ts";

/** A pod operation stopped at a step; the message is shown on the pod as its last error. */
export class PodStepError extends Schema.TaggedError<PodStepError>()("PodStepError", {
  step: Schema.String,
  exitCode: Schema.NullOr(Schema.Number),
  timedOut: Schema.Boolean,
  daemonMessage: Schema.NullOr(Schema.String),
  /** The end of what a command printed, such as compose's reason for failing. */
  outputTail: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    if (this.daemonMessage !== null) return `${this.step} failed: ${this.daemonMessage}`;
    if (this.timedOut) return `${this.step} timed out.`;
    const failed =
      this.exitCode === null
        ? `${this.step} failed`
        : `${this.step} failed (exit ${this.exitCode})`;
    return this.outputTail === undefined || this.outputTail.length === 0
      ? `${failed}.`
      : `${failed}: ${this.outputTail}`;
  }
}

export interface PodOperationContext {
  readonly podId: PodRuntimeId;
  readonly environmentId: string;
  readonly host: ContainerHost;
  readonly plan: PodPlan;
  readonly network: string;
  readonly config: T3ProjectFilePod;
  readonly worktreePath: string;
  /** Fails naming the port when something else now holds one the daemon publishes. */
  readonly checkHostPorts: Effect.Effect<void, PodStepError>;
  /** In hostname mode: the proxy's network, which the daemon joins so the proxy reaches its services. */
  readonly proxyNetwork: string | null;
  /** What the pod's record says it was built with; a start finds every one of them or fails. */
  readonly recorded: {
    readonly containerIds: ReadonlyArray<string>;
    readonly volumeIds: ReadonlyArray<string>;
  };
  /** Fails when the resolver the daemon was pinned to has moved since it was built. */
  readonly checkDnsPin: Effect.Effect<void, PodStepError>;
}

export interface PodOperationResult {
  readonly containerIds: ReadonlyArray<string>;
  readonly volumeIds: ReadonlyArray<string>;
}

const DAEMON_READY_ATTEMPTS = 60;
const STACK_COMMAND_TIMEOUT_MS = 1_800_000;
const COMPOSE_STOP_TIMEOUT_MS = 300_000;
const AGENT_STOP_SECONDS = 10;
/** Long enough for the inner daemon to stop the stack's containers itself. */
const DIND_STOP_SECONDS = 120;

const step =
  (name: string) =>
  <A, R>(effect: Effect.Effect<A, ContainerDriverError, R>) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new PodStepError({
            step: name,
            exitCode: cause.exitCode,
            timedOut: false,
            daemonMessage: cause.daemonMessage,
            cause,
          }),
      ),
    );

const composeArgs = (config: T3ProjectFilePod) =>
  config.compose === undefined
    ? ["docker", "compose"]
    : ["docker", "compose", "-f", config.compose];

/** Only this pod's own containers, by both labels; nothing else on the daemon is ever touched. */
const podContainers = (context: PodOperationContext) =>
  context.host.list(POD_LABEL).pipe(
    Effect.map(({ containers, volumes }) => {
      const owned = (labels: Readonly<Record<string, string>>) =>
        labels[POD_LABEL] === context.podId &&
        labels[POD_ENVIRONMENT_LABEL] === context.environmentId;
      const byName = (name: string) =>
        containers.find((container) => container.name === name && owned(container.labels));
      return {
        dind: byName(context.plan.dind.name),
        agent: byName(context.plan.agent.name),
        volume: volumes.find(
          (volume) => volume.name === context.plan.volume.name && owned(volume.labels),
        ),
      };
    }),
    step("Listing the pod's containers"),
  );

const execIn = (
  context: PodOperationContext,
  containerId: string,
  name: string,
  command: ReadonlyArray<string>,
  timeoutMs: number,
) =>
  context.host
    .exec(containerId, {
      command,
      cwd: context.worktreePath,
      env: podSafeEnv(context.config.env ?? {}),
      timeoutMs,
    })
    .pipe(
      step(name),
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.void
          : Effect.fail(
              new PodStepError({
                step: name,
                exitCode: result.exitCode,
                timedOut: result.timedOut,
                daemonMessage: null,
                outputTail: result.outputTail,
              }),
            ),
      ),
    );

const DAEMON_LOG_LINES = 5;
const DAEMON_EXITED_STEP = "Starting the pod's Docker daemon";

/**
 * A daemon that exited will never answer; failing at once, with what it
 * printed, beats waiting out every attempt for a misleading timeout.
 */
const failIfDaemonExited = (context: PodOperationContext) =>
  Effect.gen(function* () {
    const { dind } = yield* podContainers(context);
    if (dind !== undefined && dind.status !== "exited" && dind.status !== "dead") return;
    const logs =
      dind === undefined
        ? ""
        : yield* context.host
            .logs(dind.id, DAEMON_LOG_LINES * 4)
            .pipe(Effect.orElseSucceed(() => ""));
    const tail = outputTail(logs);
    return yield* new PodStepError({
      step: DAEMON_EXITED_STEP,
      exitCode: null,
      timedOut: false,
      daemonMessage:
        dind === undefined
          ? "its container is gone."
          : `it ${dind.status === "dead" ? "died" : "exited"}${tail.length === 0 ? "." : `: ${tail}`}`,
    });
  });

/** However each probe fares, a daemon not ready by then is not coming. */
const DAEMON_READY_DEADLINE = "2 minutes";

const awaitDaemon = (context: PodOperationContext, dindId: string) =>
  execIn(context, dindId, "Waiting for the pod's Docker daemon", ["docker", "info"], 30_000).pipe(
    Effect.tapError(() => failIfDaemonExited(context)),
    Effect.retry({
      schedule: Schedule.spaced("1 second"),
      times: DAEMON_READY_ATTEMPTS,
      while: (error) => error.step !== DAEMON_EXITED_STEP,
    }),
    Effect.timeoutOrElse({
      duration: DAEMON_READY_DEADLINE,
      orElse: () =>
        Effect.fail(
          new PodStepError({
            step: "Waiting for the pod's Docker daemon",
            exitCode: null,
            timedOut: true,
            daemonMessage: null,
          }),
        ),
    }),
  );

/**
 * Stack commands run in the agent container as the host user, against the
 * pod's daemon, so what they write in the worktree stays the user's. The
 * image must bring the docker CLI with its compose plugin.
 */
const requireCompose = (context: PodOperationContext, agentId: string) =>
  execIn(
    context,
    agentId,
    "Finding docker compose in the agent image",
    ["docker", "compose", "version"],
    30_000,
  );

const ensureContainer = (
  context: PodOperationContext,
  existing: PodContainerInfo | undefined,
  spec: PodContainerSpec,
  name: string,
) =>
  existing === undefined
    ? context.host.createContainer(spec).pipe(step(name))
    : Effect.succeed(existing.id);

const startIfStopped = (
  context: PodOperationContext,
  id: string,
  status: PodContainerInfo["status"] | undefined,
  name: string,
) =>
  status === "running"
    ? Effect.void
    : status === "paused"
      ? context.host.unpause(id).pipe(step(name))
      : context.host.start(id).pipe(step(name));

/**
 * Adds the mounted proxy CA to the agent image's system store, as root, so
 * curl, git and gh in the pod trust its hostnames. An image without the tool
 * still runs; only its TLS to the hostnames fails, so this never fails the pod.
 */
const trustProxyCa = (context: PodOperationContext, agentId: string) =>
  context.host
    .exec(agentId, { command: ["update-ca-certificates"], user: "0", timeoutMs: 120_000 })
    .pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.void
          : Effect.logWarning("the agent image could not trust the hostname proxy's CA", {
              podId: context.podId,
              exitCode: result.exitCode,
              output: result.outputTail,
            }),
      ),
      Effect.catch((error) =>
        Effect.logWarning("the agent image could not trust the hostname proxy's CA", {
          podId: context.podId,
          operation: error.operation,
        }),
      ),
    );

/**
 * Creates whatever of the pod is missing and starts it; `fresh` also brings
 * the stack up, and `checkStack` first confirms a start finds the stack's
 * containers that its last stop recorded.
 */
const bringUp = (
  context: PodOperationContext,
  fresh: boolean,
  options: { readonly checkStack?: boolean } = {},
) =>
  Effect.gen(function* () {
    const found = yield* podContainers(context);
    yield* context.host.ensureNetwork(context.network).pipe(step("Creating the pods network"));
    if (found.volume === undefined)
      yield* context.host
        .createVolume(context.plan.volume)
        .pipe(step("Creating the pod's Docker volume"));
    // A running or paused daemon already holds its ports.
    if (found.dind?.status !== "running" && found.dind?.status !== "paused")
      yield* context.checkHostPorts;
    const dindId = yield* ensureContainer(
      context,
      found.dind,
      context.plan.dind,
      "Creating the pod's Docker daemon",
    );
    // Before it starts, so its stack's DNS reaches the proxy's resolver from the
    // outset. Building the pod found the network, so a failed join is a fault:
    // the daemon's resolver is only reachable through it.
    if (context.proxyNetwork !== null)
      yield* context.host
        .connectNetwork(context.proxyNetwork, dindId)
        .pipe(step("Joining the hostname proxy's network"));
    yield* startIfStopped(context, dindId, found.dind?.status, "Starting the pod's Docker daemon");
    yield* awaitDaemon(context, dindId);
    if (options.checkStack === true && found.dind?.status !== "paused")
      yield* checkStack(context, dindId);
    const agentId = yield* ensureContainer(
      context,
      found.agent,
      context.plan.agent,
      "Creating the agent container",
    );
    yield* startIfStopped(context, agentId, found.agent?.status, "Starting the agent container");
    if (context.plan.agent.mounts.some((mount) => mount.target === POD_PROXY_CA_PATH))
      yield* trustProxyCa(context, agentId);
    if (fresh) {
      yield* requireCompose(context, agentId);
      const up = context.config.up?.map((command) => ["sh", "-c", command]) ?? [
        [...composeArgs(context.config), "up", "-d"],
      ];
      for (const [index, command] of up.entries())
        yield* execIn(
          context,
          agentId,
          `Stack command ${index + 1} of ${up.length}`,
          command,
          STACK_COMMAND_TIMEOUT_MS,
        );
      const seeds = context.config.seeds ?? [];
      for (const [index, command] of seeds.entries())
        yield* execIn(
          context,
          agentId,
          `Seed command ${index + 1} of ${seeds.length}`,
          ["sh", "-c", command],
          STACK_COMMAND_TIMEOUT_MS,
        );
    } else if (found.dind?.status !== "paused") {
      // Never `up`: a start resumes the stack as it was, it does not rebuild it.
      yield* execIn(
        context,
        agentId,
        "Starting the stack",
        [...composeArgs(context.config), "start"],
        STACK_COMMAND_TIMEOUT_MS,
      );
    }
    return { containerIds: [dindId, agentId], volumeIds: [context.plan.volume.name] };
  });

/** Compose runs from the agent, so it can only run while both containers do. */
const composeReachable = (found: {
  readonly dind: PodContainerInfo | undefined;
  readonly agent: PodContainerInfo | undefined;
}) =>
  found.dind?.status === "running" && found.agent?.status === "running" ? found.agent : undefined;

const removeAll = (context: PodOperationContext) =>
  Effect.gen(function* () {
    const found = yield* podContainers(context);
    const agent = composeReachable(found);
    if (agent !== undefined)
      yield* execIn(
        context,
        agent.id,
        "Taking the stack down",
        [...composeArgs(context.config), "down"],
        COMPOSE_STOP_TIMEOUT_MS,
      ).pipe(
        // The containers and their volume go next whatever compose managed.
        Effect.catch((error) => Effect.logWarning("pod compose down failed", { step: error.step })),
      );
    if (found.agent !== undefined)
      yield* context.host
        .removeContainer(found.agent.id)
        .pipe(step("Removing the agent container"));
    if (found.dind !== undefined)
      yield* context.host
        .removeContainer(found.dind.id)
        .pipe(step("Removing the pod's Docker daemon"));
    if (found.volume !== undefined)
      yield* context.host
        .removeVolume(found.volume.name)
        .pipe(step("Removing the pod's Docker volume"));
  });

const stop = (context: PodOperationContext) =>
  Effect.gen(function* () {
    const listed = yield* podContainers(context);
    for (const container of [listed.dind, listed.agent])
      if (container?.status === "paused")
        yield* context.host.unpause(container.id).pipe(step("Unfreezing the pod"));
    const found = yield* podContainers(context);
    if (found.dind?.status === "running") yield* recordStack(context, found.dind.id);
    const agent = composeReachable(found);
    if (agent !== undefined)
      yield* execIn(
        context,
        agent.id,
        "Stopping the stack",
        [...composeArgs(context.config), "stop"],
        COMPOSE_STOP_TIMEOUT_MS,
      ).pipe(
        // Stopping the daemon below still stops what compose could not.
        Effect.catch((error) => Effect.logWarning("pod compose stop failed", { step: error.step })),
      );
    if (found.agent !== undefined)
      yield* context.host
        .stop(found.agent.id, AGENT_STOP_SECONDS)
        .pipe(step("Stopping the agent container"));
    if (found.dind !== undefined)
      yield* context.host
        .stop(found.dind.id, DIND_STOP_SECONDS)
        .pipe(step("Stopping the pod's Docker daemon"));
    return {
      containerIds: [found.dind?.id, found.agent?.id].filter((id) => id !== undefined),
      volumeIds: found.volume === undefined ? [] : [found.volume.name],
    };
  });

/** Agent first, so nothing runs against a daemon that is already frozen. */
const freeze = (context: PodOperationContext) =>
  Effect.gen(function* () {
    const found = yield* podContainers(context);
    if (found.agent?.status === "running")
      yield* context.host.pause(found.agent.id).pipe(step("Freezing the agent container"));
    if (found.dind?.status === "running")
      yield* context.host.pause(found.dind.id).pipe(step("Freezing the pod's Docker daemon"));
    return {
      containerIds: [found.dind?.id, found.agent?.id].filter((id) => id !== undefined),
      volumeIds: found.volume === undefined ? [] : [found.volume.name],
    };
  });

const CHECK_CONTAINERS_STEP = "Checking the pod's containers";

/**
 * A start resumes exactly what was stopped and never builds anything again, so
 * a container or volume gone since is the user's to decide about: Recreate.
 */
const verifyRecorded = (context: PodOperationContext) =>
  Effect.gen(function* () {
    const { containerIds, volumeIds } = context.recorded;
    if (containerIds.length === 0 && volumeIds.length === 0) return;
    const listed = yield* context.host.list(POD_LABEL).pipe(step(CHECK_CONTAINERS_STEP));
    const owned = (labels: Readonly<Record<string, string>>) =>
      labels[POD_LABEL] === context.podId &&
      labels[POD_ENVIRONMENT_LABEL] === context.environmentId;
    const containers = new Set(
      listed.containers.filter((container) => owned(container.labels)).map((c) => c.id),
    );
    const volumes = new Set(
      listed.volumes.filter((volume) => owned(volume.labels)).map((volume) => volume.name),
    );
    const missing = [
      ...containerIds
        .filter((id) => !containers.has(id))
        .map((id) => `container ${id.slice(0, 12)}`),
      ...volumeIds.filter((name) => !volumes.has(name)).map((name) => `volume ${name}`),
    ];
    if (missing.length > 0)
      return yield* new PodStepError({
        step: CHECK_CONTAINERS_STEP,
        exitCode: null,
        timedOut: false,
        daemonMessage: `${missing.join(", ")} recorded for this pod ${missing.length === 1 ? "is" : "are"} gone. Recreate the pod to build it again; its stack's data is lost.`,
      });
  });

/** Kept in the daemon's own volume, so it lasts exactly as long as the stack it lists. */
const STACK_LIST_PATH = "/var/lib/docker/t3-stack-containers";

/**
 * Run in the daemon container: records every stack container as `<id> <name>`.
 * The old list goes first, so a stop that cannot write one leaves none, and a
 * start never checks against a list older than the last stop.
 */
const RECORD_STACK_SCRIPT = `rm -f ${STACK_LIST_PATH} && docker ps -a --no-trunc --format '{{.ID}} {{.Names}}' > ${STACK_LIST_PATH}.next && mv ${STACK_LIST_PATH}.next ${STACK_LIST_PATH}`;

/**
 * Prints the names of recorded stack containers that are gone and exits 3.
 * `compose start` silently skips a service whose container was removed, so
 * without this a start would report success with part of the stack missing.
 */
const CHECK_STACK_SCRIPT = [
  `[ -r ${STACK_LIST_PATH} ] || exit 0`,
  "missing=",
  `while read -r id name; do docker inspect "$id" >/dev/null 2>&1 || missing="$missing $name"; done < ${STACK_LIST_PATH}`,
  '[ -z "$missing" ] && exit 0',
  'echo "missing:$missing"',
  "exit 3",
].join("\n");

const STACK_CHECK_STEP = "Checking the stack's containers";

const recordStack = (context: PodOperationContext, dindId: string) =>
  context.host.exec(dindId, { command: ["sh", "-c", RECORD_STACK_SCRIPT], timeoutMs: 60_000 }).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.void
        : Effect.logWarning("could not record the pod's stack containers", {
            podId: context.podId,
            exitCode: result.exitCode,
          }),
    ),
    // The next start then checks against the list from the stop before.
    Effect.catch((error) =>
      Effect.logWarning("could not record the pod's stack containers", {
        podId: context.podId,
        operation: error.operation,
      }),
    ),
  );

const checkStack = (context: PodOperationContext, dindId: string) =>
  context.host.exec(dindId, { command: ["sh", "-c", CHECK_STACK_SCRIPT], timeoutMs: 60_000 }).pipe(
    step(STACK_CHECK_STEP),
    Effect.flatMap((result) => {
      if (result.exitCode === 0) return Effect.void;
      const names = result.outputTail.replace(/^.*missing:/, "").trim();
      return Effect.fail(
        new PodStepError({
          step: STACK_CHECK_STEP,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          daemonMessage:
            result.exitCode === 3 && names.length > 0
              ? `the stack's containers ${names} are gone, and compose start cannot bring them back. Recreate the pod, or bring the stack up from the pod shell and Retry.`
              : null,
          outputTail: result.outputTail,
        }),
      );
    }),
  );

const HOSTNAME_PROBE_ATTEMPTS = 10;
const HOSTNAME_PROBE_STEP = "Checking the pod's hostname";

/**
 * Asks the proxy for `hostname` from the daemon's own network and resolver, so
 * it checks the DNS pin, the proxy's route and its certificate together, as the
 * pod's stack sees them. Any HTTP answer counts: a stack still booting gets a
 * 502 from the proxy, which still proves the route. The daemon image ships
 * openssl, which the agent image may not.
 */
export const probePodHostname = (host: ContainerHost, dindName: string, hostname: string) =>
  host
    .exec(dindName, {
      command: [
        "sh",
        "-c",
        'printf "HEAD / HTTP/1.1\\r\\nHost: %s\\r\\nConnection: close\\r\\n\\r\\n" "$1" | timeout 10 openssl s_client -quiet -connect "$1:443" -servername "$1" 2>/dev/null | head -n 1',
        "sh",
        hostname,
      ],
      timeoutMs: 30_000,
    })
    .pipe(
      step(HOSTNAME_PROBE_STEP),
      Effect.flatMap((result) =>
        result.outputTail.startsWith("HTTP/")
          ? Effect.void
          : Effect.fail(
              new PodStepError({
                step: HOSTNAME_PROBE_STEP,
                exitCode: result.exitCode,
                timedOut: result.timedOut,
                daemonMessage: `${hostname} does not answer through the hostname proxy.`,
              }),
            ),
      ),
      // The proxy's certificate for a route it just loaded can take a moment.
      Effect.retry({ schedule: Schedule.spaced("1 second"), times: HOSTNAME_PROBE_ATTEMPTS - 1 }),
    );

/** Never `rm`, `down` or `prune` except for the operations whose job that is. */
export const runPodOperation = (
  operation: PodInternalOperation,
  context: PodOperationContext,
): Effect.Effect<PodOperationResult, PodStepError> => {
  switch (operation) {
    case "create":
      return bringUp(context, true);
    case "start":
      return verifyRecorded(context).pipe(
        Effect.andThen(context.checkDnsPin),
        Effect.andThen(bringUp(context, false, { checkStack: true })),
      );
    case "stop":
      return stop(context);
    case "freeze":
      return freeze(context);
    case "recreate":
      return removeAll(context).pipe(Effect.andThen(bringUp(context, true)));
    case "recreateAgentContainer":
      return podContainers(context).pipe(
        Effect.flatMap(({ agent }) =>
          agent === undefined
            ? Effect.void
            : context.host.removeContainer(agent.id).pipe(step("Removing the agent container")),
        ),
        Effect.andThen(bringUp(context, false)),
      );
    case "remove":
      return removeAll(context).pipe(Effect.as({ containerIds: [], volumeIds: [] }));
  }
};
