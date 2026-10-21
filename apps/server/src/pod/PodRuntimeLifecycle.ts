import {
  IsoDateTime,
  POD_RUNTIME_ERROR_MESSAGE_MAX_LENGTH,
  PodRuntimeError,
  PodRuntimeId,
  PodRuntimeOperation,
  POD_RUNTIME_REQUESTS,
  type PodRuntimeRequest,
  type PodRuntimeSnapshot,
  type PodRuntimeState,
  ProjectId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/** The projection row: the wire snapshot plus what only the server needs. */
export interface PodRuntimeRecord {
  readonly snapshot: PodRuntimeSnapshot;
  readonly dockerHost: string;
  /** The removed pod's worktree is gone too, so the path no longer belongs to it. */
  readonly worktreeReleased?: boolean;
  /** Host port per service; held from allocation until the pod is removed. */
  readonly hostPorts?: Readonly<Record<string, number>>;
  /** The tailnet address the services are also published on. */
  readonly tailnetAddress?: string;
  /** Hostname per service, chosen when the daemon was built in hostname mode. */
  readonly hostnames?: Readonly<Record<string, string>>;
  /** The hostname proxy's DNS server, which the daemon was built to resolve through. */
  readonly dnsAddress?: string;
  /** The pod's route file is in the proxy's directory, as far as this server knows. */
  readonly routed?: boolean;
}

/**
 * What the server runs: every client request, plus `freeze`, which only a pod
 * following its threads asks for. It never reaches the wire: a failed freeze
 * is recorded as a failed stop, whose Retry frees the memory a freeze holds.
 */
export const PodInternalOperation = Schema.Literals([...PodRuntimeOperation.literals, "freeze"]);
export type PodInternalOperation = typeof PodInternalOperation.Type;

const wireOperation = (operation: PodInternalOperation): PodRuntimeOperation =>
  operation === "freeze" ? "stop" : operation;

const PodServicePort = Schema.Struct({ name: TrimmedNonEmptyString, port: Schema.Int });
const PodServiceHostPort = Schema.Struct({
  name: TrimmedNonEmptyString,
  port: Schema.Int,
  hostPort: Schema.Int,
});

/** Persisted in `pod_runtime_events`; replaying them in order rebuilds `pod_runtimes`. */
export const PodRuntimeEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("pod.created"),
    podId: PodRuntimeId,
    occurredAt: IsoDateTime,
    projectId: ProjectId,
    worktreePath: TrimmedNonEmptyString,
    image: TrimmedNonEmptyString,
    dockerHost: Schema.String,
    services: Schema.Array(PodServicePort),
  }),
  Schema.Struct({
    type: Schema.Literal("pod.operation-requested"),
    podId: PodRuntimeId,
    occurredAt: IsoDateTime,
    operation: PodInternalOperation,
    /** Asked for because every thread on the worktree was parked; a wake starts it again. */
    parked: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("pod.operation-succeeded"),
    podId: PodRuntimeId,
    occurredAt: IsoDateTime,
    operation: PodInternalOperation,
    containerIds: Schema.Array(Schema.String),
    volumeIds: Schema.Array(Schema.String),
    /** "Remove anyway" recorded the removal although Docker refused it. */
    forced: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("pod.operation-failed"),
    podId: PodRuntimeId,
    occurredAt: IsoDateTime,
    operation: PodInternalOperation,
    message: Schema.String,
  }),
  /**
   * The services the pod's daemon publishes and their host ports, decided before
   * its containers are created. Replaces the service list.
   */
  Schema.Struct({
    type: Schema.Literal("pod.ports-allocated"),
    podId: PodRuntimeId,
    occurredAt: IsoDateTime,
    services: Schema.Array(PodServiceHostPort),
    tailnetAddress: Schema.NullOr(Schema.String),
    /** Absent when the daemon is built for ports only. */
    hostnames: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    dnsAddress: Schema.optional(Schema.String),
  }),
  /**
   * The pod's proxy route was put in place or taken away; `problem` says what
   * keeps a pod whose project asks for hostnames from being served on them.
   */
  Schema.Struct({
    type: Schema.Literal("pod.routes-updated"),
    podId: PodRuntimeId,
    occurredAt: IsoDateTime,
    routed: Schema.Boolean,
    problem: Schema.NullOr(Schema.String),
  }),
  /** A removed pod's worktree checkout was removed, freeing the path for a host worktree. */
  Schema.Struct({
    type: Schema.Literal("pod.worktree-released"),
    podId: PodRuntimeId,
    occurredAt: IsoDateTime,
  }),
  /** What reconcile found Docker doing, which wins over the recorded state. */
  Schema.Struct({
    type: Schema.Literal("pod.observed"),
    podId: PodRuntimeId,
    occurredAt: IsoDateTime,
    state: Schema.Literals([
      "running",
      "stopped",
      "frozen",
      "start_failed",
      "stop_failed",
      "removed",
    ]),
    failedOperation: Schema.NullOr(PodRuntimeOperation),
    message: Schema.NullOr(Schema.String),
    containerIds: Schema.Array(Schema.String),
    volumeIds: Schema.Array(Schema.String),
  }),
]);
export type PodRuntimeEvent = typeof PodRuntimeEvent.Type;

interface OperationRule {
  /** States the operation starts from. */
  readonly from: ReadonlyArray<PodRuntimeState>;
  /** States where asking again changes nothing. */
  readonly settled: ReadonlyArray<PodRuntimeState>;
  readonly pending: PodRuntimeState;
  readonly success: PodRuntimeState;
  readonly failure: PodRuntimeState;
}

/**
 * `create` is never asked for directly; pod creation records it, and Start
 * retries it after it failed.
 */
export const POD_OPERATION_RULES: Readonly<Record<PodInternalOperation, OperationRule>> = {
  create: {
    from: [],
    settled: [],
    pending: "creating",
    success: "running",
    failure: "start_failed",
  },
  start: {
    ...POD_RUNTIME_REQUESTS.start,
    pending: "starting",
    success: "running",
    failure: "start_failed",
  },
  stop: {
    ...POD_RUNTIME_REQUESTS.stop,
    pending: "stopping",
    success: "stopped",
    failure: "stop_failed",
  },
  freeze: {
    from: ["running"],
    settled: ["frozen", "stopping"],
    pending: "stopping",
    success: "frozen",
    failure: "stop_failed",
  },
  recreate: {
    ...POD_RUNTIME_REQUESTS.recreate,
    pending: "creating",
    success: "running",
    failure: "start_failed",
  },
  recreateAgentContainer: {
    ...POD_RUNTIME_REQUESTS.recreateAgentContainer,
    pending: "starting",
    success: "running",
    failure: "start_failed",
  },
  remove: {
    ...POD_RUNTIME_REQUESTS.remove,
    pending: "removing",
    success: "removed",
    failure: "stop_failed",
  },
};

const TRANSITIONAL_STATES = new Set<PodRuntimeState>([
  "creating",
  "starting",
  "stopping",
  "removing",
]);
export const isPodTransitional = (state: PodRuntimeState) => TRANSITIONAL_STATES.has(state);

/**
 * Any state but a clean stop or a removal may have containers running, so the
 * worktree stays: storage cleanup tears down only a pod stopped on purpose.
 */
export const podHoldsWorktree = (state: PodRuntimeState) =>
  state !== "stopped" && state !== "removed";

export const boundedPodMessage = (message: string) =>
  message.length <= POD_RUNTIME_ERROR_MESSAGE_MAX_LENGTH
    ? message
    : `${message.slice(0, POD_RUNTIME_ERROR_MESSAGE_MAX_LENGTH - 1)}…`;

/**
 * Start after a failed creation creates again: the stack's `up` and seed
 * commands never finished, and a plain start would skip them.
 */
const effectiveOperation = (
  record: PodRuntimeRecord,
  operation: PodInternalOperation,
): PodInternalOperation => {
  const failed = record.snapshot.lastError?.operation;
  return operation === "start" &&
    record.snapshot.state === "start_failed" &&
    (failed === "create" || failed === "recreate")
    ? "create"
    : operation;
};

/**
 * `none` when the pod already is where the request leads; the caller answers
 * with the current snapshot and runs nothing.
 */
export const planPodRequest = (
  record: PodRuntimeRecord,
  operation: PodRuntimeRequest | "freeze",
  occurredAt: string,
  options: { readonly parked?: boolean } = {},
): Result.Result<
  { readonly type: "none" } | { readonly type: "request"; readonly event: PodRuntimeEvent },
  PodRuntimeError
> => {
  const state = record.snapshot.state;
  const rule = POD_OPERATION_RULES[operation];
  if (rule.settled.includes(state)) return Result.succeed({ type: "none" });
  if (!rule.from.includes(state))
    return Result.fail(
      new PodRuntimeError({ reason: "invalid-state", podId: record.snapshot.id, state }),
    );
  return Result.succeed({
    type: "request",
    event: {
      type: "pod.operation-requested",
      podId: record.snapshot.id,
      occurredAt,
      operation: effectiveOperation(record, operation),
      ...(options.parked === true ? { parked: true } : {}),
    },
  });
};

/**
 * A completion counts only while the pod still waits for it. A Remove asked
 * for mid-start moves the pod on, and the start's late result is dropped.
 */
export const planPodCompletion = (
  record: PodRuntimeRecord,
  operation: PodInternalOperation,
  outcome:
    | {
        readonly type: "succeeded";
        readonly containerIds: ReadonlyArray<string>;
        readonly volumeIds: ReadonlyArray<string>;
        readonly forced?: boolean;
      }
    | { readonly type: "failed"; readonly message: string },
  occurredAt: string,
): PodRuntimeEvent | null => {
  if (record.snapshot.state !== POD_OPERATION_RULES[operation].pending) return null;
  const base = { podId: record.snapshot.id, occurredAt, operation };
  return outcome.type === "succeeded"
    ? {
        ...base,
        type: "pod.operation-succeeded",
        containerIds: [...outcome.containerIds],
        volumeIds: [...outcome.volumeIds],
        ...(outcome.forced ? { forced: true } : {}),
      }
    : { ...base, type: "pod.operation-failed", message: boundedPodMessage(outcome.message) };
};

export interface PodObservation {
  /** Containers Docker lists for this pod. */
  readonly containerIds: ReadonlyArray<string>;
  readonly volumeIds: ReadonlyArray<string>;
  /** Both containers exist and run. */
  readonly running: boolean;
  /** Both containers exist and are paused. */
  readonly paused: boolean;
  /** No container of the pod runs or is paused. */
  readonly halted: boolean;
}

const INTERRUPTED = "Interrupted by a server restart.";
const CONTAINERS_GONE = "Its containers are gone; Start creates them again.";
const PARTLY_RUNNING = "Only part of the pod is running.";

/**
 * Settles a pod against what Docker reports at startup. A transitional state
 * means its operation was cut off with the process; the pod lands in the state
 * Docker shows, or in the failure state whose Retry finishes the job. A pod
 * only partly running lands in a failure state, which keeps its worktree. A
 * failure state is the user's to resolve and is left as it is.
 */
export const planPodObservation = (
  record: PodRuntimeRecord,
  observed: PodObservation,
  occurredAt: string,
): PodRuntimeEvent | null => {
  const { state } = record.snapshot;
  const settle = (
    next: "running" | "stopped" | "frozen" | "start_failed" | "stop_failed" | "removed",
    failedOperation: PodRuntimeOperation | null = null,
    message: string = INTERRUPTED,
  ): PodRuntimeEvent | null =>
    next === state && failedOperation === null
      ? null
      : {
          type: "pod.observed",
          podId: record.snapshot.id,
          occurredAt,
          state: next,
          failedOperation,
          message: failedOperation === null ? null : message,
          containerIds: [...observed.containerIds],
          volumeIds: [...observed.volumeIds],
        };
  const empty = observed.containerIds.length === 0 && observed.volumeIds.length === 0;
  switch (state) {
    case "creating":
      return settle("start_failed", "create");
    case "starting":
      return observed.running ? settle("running") : settle("start_failed", "start");
    case "stopping":
      return observed.halted ? settle("stopped") : settle("stop_failed", "stop");
    case "removing":
      return empty ? settle("removed") : settle("stop_failed", "remove");
    case "running":
    case "stopped":
    case "frozen":
      if (observed.containerIds.length === 0)
        return settle("start_failed", "create", CONTAINERS_GONE);
      if (observed.running) return settle("running");
      if (observed.paused) return settle("frozen");
      if (observed.halted) return settle("stopped");
      return state === "stopped"
        ? settle("stop_failed", "stop", PARTLY_RUNNING)
        : settle("start_failed", "start", PARTLY_RUNNING);
    case "start_failed":
    case "stop_failed":
    case "removed":
      return null;
  }
};

const settledState = (event: Extract<PodRuntimeEvent, { type: "pod.operation-succeeded" }>) =>
  POD_OPERATION_RULES[event.operation].success;

export const POD_LOOPBACK_ADDRESS = "127.0.0.1";

export const podServiceUrl = (address: string, hostPort: number) => `http://${address}:${hostPort}`;

export const podHostnameUrl = (hostname: string) => `https://${hostname}`;

/**
 * A removed pod holds no ports or hostnames; a pod's services are reachable
 * only while it runs. A pod built for hostnames links them even while its
 * route is not in place: its stack was configured for them, so a port link
 * would not work either, and its hostname problem says why.
 */
const publishServices = (record: PodRuntimeRecord): PodRuntimeRecord => {
  const { hostPorts, tailnetAddress, hostnames, dnsAddress: _dns, ...unallocated } = record;
  const { state } = record.snapshot;
  const kept = state === "removed" ? unallocated : record;
  const services = record.snapshot.services.map(({ name, port }) => {
    const hostPort = state === "running" ? hostPorts?.[name] : undefined;
    if (hostPort === undefined) return { name, port, url: null };
    const hostname = hostnames?.[name];
    return {
      name,
      port,
      url:
        hostname === undefined
          ? podServiceUrl(POD_LOOPBACK_ADDRESS, hostPort)
          : podHostnameUrl(hostname),
      ...(tailnetAddress === undefined
        ? {}
        : { tailnetUrl: podServiceUrl(tailnetAddress, hostPort) }),
    };
  });
  return { ...kept, snapshot: { ...record.snapshot, services } };
};

/** The projection reducer; `pod.created` is the only event that may start a record. */
export const applyPodEvent = (
  record: PodRuntimeRecord | undefined,
  event: PodRuntimeEvent,
): PodRuntimeRecord | undefined => {
  const next = reducePodEvent(record, event);
  return next === undefined ? undefined : publishServices(next);
};

const reducePodEvent = (
  record: PodRuntimeRecord | undefined,
  event: PodRuntimeEvent,
): PodRuntimeRecord | undefined => {
  if (event.type === "pod.created") {
    return {
      dockerHost: event.dockerHost,
      snapshot: {
        id: event.podId,
        projectId: event.projectId,
        worktreePath: event.worktreePath,
        state: "creating",
        services: event.services.map((service) => ({ ...service, url: null })),
        image: event.image,
        startedAt: null,
        lastError: null,
        containerIds: [],
        volumeIds: [],
        updatedAt: event.occurredAt,
      },
    };
  }
  if (record === undefined) return undefined;
  const snapshot = record.snapshot;
  const updatedAt = event.occurredAt;
  switch (event.type) {
    case "pod.worktree-released":
      return { ...record, worktreeReleased: true };
    case "pod.ports-allocated": {
      const { tailnetAddress: _tailnet, hostnames: _hostnames, dnsAddress: _dns, ...rest } = record;
      return {
        ...rest,
        hostPorts: Object.fromEntries(
          event.services.map((service) => [service.name, service.hostPort]),
        ),
        ...(event.tailnetAddress === null ? {} : { tailnetAddress: event.tailnetAddress }),
        ...(event.hostnames === undefined ? {} : { hostnames: event.hostnames }),
        ...(event.dnsAddress === undefined ? {} : { dnsAddress: event.dnsAddress }),
        snapshot: {
          ...snapshot,
          services: event.services.map(({ name, port }) => ({ name, port, url: null })),
          updatedAt,
        },
      };
    }
    case "pod.routes-updated": {
      const { hostnameProblem: _previous, ...unflagged } = snapshot;
      return {
        ...record,
        routed: event.routed,
        snapshot: {
          ...unflagged,
          ...(event.problem === null ? {} : { hostnameProblem: boundedPodMessage(event.problem) }),
          updatedAt,
        },
      };
    }
    case "pod.operation-requested": {
      // Any other request is someone's own decision, which a wake must not undo.
      const { parked: _parked, ...unparked } = snapshot;
      return {
        ...record,
        snapshot: {
          ...unparked,
          ...(event.parked === true ? { parked: true as const } : {}),
          state: POD_OPERATION_RULES[event.operation].pending,
          updatedAt,
        },
      };
    }
    case "pod.operation-succeeded": {
      const state = settledState(event);
      return {
        ...record,
        snapshot: {
          ...snapshot,
          state,
          lastError: null,
          containerIds: event.containerIds,
          volumeIds: event.volumeIds,
          startedAt:
            state === "running"
              ? event.operation === "recreateAgentContainer"
                ? (snapshot.startedAt ?? updatedAt)
                : updatedAt
              : null,
          updatedAt,
        },
      };
    }
    case "pod.operation-failed":
      return {
        ...record,
        snapshot: {
          ...snapshot,
          state: POD_OPERATION_RULES[event.operation].failure,
          lastError: {
            operation: wireOperation(event.operation),
            message: event.message,
            at: updatedAt,
          },
          startedAt: null,
          updatedAt,
        },
      };
    case "pod.observed":
      return {
        ...record,
        snapshot: {
          ...snapshot,
          state: event.state,
          lastError:
            event.failedOperation === null
              ? null
              : {
                  operation: event.failedOperation,
                  message: event.message ?? INTERRUPTED,
                  at: updatedAt,
                },
          startedAt: event.state === "running" ? (snapshot.startedAt ?? updatedAt) : null,
          containerIds: event.containerIds,
          volumeIds: event.volumeIds,
          updatedAt,
        },
      };
  }
};
