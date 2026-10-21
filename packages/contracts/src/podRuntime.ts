import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";

/** Also the container and volume name stem, so it stays short and Docker-safe. */
export const PodRuntimeId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(40),
  Schema.isPattern(/^pod-[a-z0-9]+$/),
).pipe(Schema.brand("PodRuntimeId"));
export type PodRuntimeId = typeof PodRuntimeId.Type;

export const PodRuntimeState = Schema.Literals([
  "creating",
  "running",
  "stopping",
  "stopped",
  "starting",
  "frozen",
  "stop_failed",
  "start_failed",
  "removing",
  "removed",
]);
export type PodRuntimeState = typeof PodRuntimeState.Type;

/** What a failure state's Retry repeats. */
export const PodRuntimeOperation = Schema.Literals([
  "create",
  "start",
  "stop",
  "recreate",
  "recreateAgentContainer",
  "remove",
]);
export type PodRuntimeOperation = typeof PodRuntimeOperation.Type;

/** What a client may ask for; pod creation happens with its worktree. */
export type PodRuntimeRequest = Exclude<PodRuntimeOperation, "create">;

const SETTLED_OR_FAILED = ["running", "stopped", "frozen", "start_failed", "stop_failed"] as const;

/**
 * Where each request starts from, and where asking again changes nothing. The
 * server enforces it; clients offer only these. Every failure state is a start
 * point for some request, so none is a one-way door.
 */
export const POD_RUNTIME_REQUESTS: Readonly<
  Record<
    PodRuntimeRequest,
    {
      readonly from: ReadonlyArray<PodRuntimeState>;
      readonly settled: ReadonlyArray<PodRuntimeState>;
    }
  >
> = {
  start: {
    from: ["stopped", "frozen", "start_failed", "stop_failed"],
    settled: ["running", "starting", "creating"],
  },
  stop: {
    from: ["running", "frozen", "start_failed", "stop_failed"],
    settled: ["stopped", "stopping"],
  },
  recreate: { from: SETTLED_OR_FAILED, settled: [] },
  recreateAgentContainer: { from: ["running", "stopped", "start_failed"], settled: [] },
  remove: {
    from: [...SETTLED_OR_FAILED, "creating", "starting", "stopping"],
    settled: ["removing", "removed"],
  },
};

export const POD_RUNTIME_ERROR_MESSAGE_MAX_LENGTH = 500;

export const PodRuntimeFailure = Schema.Struct({
  operation: PodRuntimeOperation,
  message: Schema.String.check(Schema.isMaxLength(POD_RUNTIME_ERROR_MESSAGE_MAX_LENGTH)),
  at: IsoDateTime,
});
export type PodRuntimeFailure = typeof PodRuntimeFailure.Type;

/** The request a failed pod's Retry repeats: a failed start of any kind retries as a start. */
export const podRuntimeRetryRequest = (failure: PodRuntimeFailure): PodRuntimeRequest =>
  failure.operation === "stop" || failure.operation === "remove" ? failure.operation : "start";

/**
 * `port` is the service's port inside the pod. `url` is where it opens while the
 * pod runs, null otherwise: its `https://` hostname once the pod's proxy route
 * is in place, else its loopback address on the server's host. `tailnetUrl` is
 * the same service on the host's tailnet address, when the environment
 * publishes there.
 */
export const PodRuntimeServiceEndpoint = Schema.Struct({
  name: TrimmedNonEmptyString,
  port: PositiveInt,
  url: Schema.NullOr(Schema.String),
  tailnetUrl: Schema.optionalKey(Schema.String),
});
export type PodRuntimeServiceEndpoint = typeof PodRuntimeServiceEndpoint.Type;

export const PodRuntimeSnapshot = Schema.Struct({
  id: PodRuntimeId,
  projectId: ProjectId,
  worktreePath: TrimmedNonEmptyString,
  state: PodRuntimeState,
  services: Schema.Array(PodRuntimeServiceEndpoint),
  image: TrimmedNonEmptyString,
  startedAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(PodRuntimeFailure),
  containerIds: Schema.Array(TrimmedNonEmptyString),
  volumeIds: Schema.Array(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
  /**
   * Why a pod whose project asks for hostnames is not served on them, or what
   * went wrong keeping its proxy route; its links then use ports.
   */
  hostnameProblem: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(POD_RUNTIME_ERROR_MESSAGE_MAX_LENGTH)),
  ),
});
export type PodRuntimeSnapshot = typeof PodRuntimeSnapshot.Type;

/** Containers or volumes labelled for this environment that no pod record owns. */
export const PodRuntimeOrphan = Schema.Struct({
  podId: PodRuntimeId,
  containerIds: Schema.Array(TrimmedNonEmptyString),
  volumeIds: Schema.Array(TrimmedNonEmptyString),
  running: Schema.Boolean,
});
export type PodRuntimeOrphan = typeof PodRuntimeOrphan.Type;

export const PodRuntimeStats = Schema.Struct({
  podId: PodRuntimeId,
  memoryBytes: Schema.NullOr(NonNegativeInt),
});
export type PodRuntimeStats = typeof PodRuntimeStats.Type;

export const PodRuntimeStatusInput = Schema.Struct({
  /** Also answers whether that project's t3.json has a `pod` block. */
  projectId: Schema.optional(ProjectId),
  /** Asks Docker for memory use; only the open Diagnostics screen sets it. */
  includeStats: Schema.optional(Schema.Boolean),
});
export type PodRuntimeStatusInput = typeof PodRuntimeStatusInput.Type;

/**
 * `tailscale-serve-443`: a project serves its pods on hostnames, whose proxy
 * owns :443 on the tailnet address, and this server was started with Tailscale
 * Serve on the same port, so tailscaled takes it and other devices cannot reach
 * the pods. A serve this server did not start is not seen.
 */
export const PodRuntimeWarning = Schema.Literals(["tailscale-serve-443"]);
export type PodRuntimeWarning = typeof PodRuntimeWarning.Type;

export const PodRuntimeStatus = Schema.Struct({
  enabled: Schema.Boolean,
  pods: Schema.Array(PodRuntimeSnapshot),
  orphans: Schema.Array(PodRuntimeOrphan),
  projectConfigured: Schema.optional(Schema.Boolean),
  stats: Schema.optional(Schema.Array(PodRuntimeStats)),
  /** Absent when there is nothing to warn about. */
  warnings: Schema.optionalKey(Schema.Array(PodRuntimeWarning)),
});
export type PodRuntimeStatus = typeof PodRuntimeStatus.Type;

export const PodRuntimeTarget = Schema.Struct({ podId: PodRuntimeId });
export type PodRuntimeTarget = typeof PodRuntimeTarget.Type;

export const PodRuntimeRemoveInput = Schema.Struct({
  podId: PodRuntimeId,
  /**
   * "Remove anyway": record the pod as removed even when Docker refuses, so its
   * worktree can go. Containers left behind are then listed as orphans.
   */
  force: Schema.optional(Schema.Boolean),
});
export type PodRuntimeRemoveInput = typeof PodRuntimeRemoveInput.Type;

export const PodRuntimeOpenShellInput = Schema.Struct({
  podId: PodRuntimeId,
  threadId: ThreadId,
});
export type PodRuntimeOpenShellInput = typeof PodRuntimeOpenShellInput.Type;

export const PodRuntimeOpenShellResult = Schema.Struct({
  threadId: ThreadId,
  terminalId: TrimmedNonEmptyString,
});
export type PodRuntimeOpenShellResult = typeof PodRuntimeOpenShellResult.Type;

/** A full list first, then one changed pod at a time; a removed pod is sent once, as removed. */
export const PodRuntimeStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    enabled: Schema.Boolean,
    pods: Schema.Array(PodRuntimeSnapshot),
  }),
  Schema.Struct({ type: Schema.Literal("upsert"), pod: PodRuntimeSnapshot }),
]);
export type PodRuntimeStreamEvent = typeof PodRuntimeStreamEvent.Type;

export const PodRuntimeErrorReason = Schema.Literals([
  "disabled",
  "not-configured",
  "not-found",
  "invalid-state",
  "unavailable",
]);
export type PodRuntimeErrorReason = typeof PodRuntimeErrorReason.Type;

const POD_RUNTIME_ERROR_MESSAGES: Record<PodRuntimeErrorReason, string> = {
  disabled: "The pod runtime is turned off for this project.",
  "not-configured": "This project's t3.json has no pod block.",
  "not-found": "No pod with that id exists.",
  "invalid-state": "The pod cannot do that in its current state.",
  unavailable: "The pod runtime could not read or record pod state.",
};

export class PodRuntimeError extends Schema.TaggedError<PodRuntimeError>()("PodRuntimeError", {
  reason: PodRuntimeErrorReason,
  podId: Schema.optional(PodRuntimeId),
  state: Schema.optional(PodRuntimeState),
  /** The pod's own recorded failure, when it is why the request could not finish. */
  lastError: Schema.optional(PodRuntimeFailure),
}) {
  override get message(): string {
    if (this.lastError !== undefined) return this.lastError.message;
    const base = POD_RUNTIME_ERROR_MESSAGES[this.reason];
    return this.state === undefined ? base : `${base} (${this.state})`;
  }
}

/**
 * A pod's worktree is never removed past a failed teardown: its stack may still
 * hold data, and the pod would be left without the checkout it runs in.
 * Removing again retries; `skipPodTeardown` removes it anyway.
 */
export class WorktreePodTeardownError extends Schema.TaggedError<WorktreePodTeardownError>()(
  "WorktreePodTeardownError",
  {
    podId: PodRuntimeId,
    step: Schema.Literals(["start", "script", "remove"]),
    state: Schema.optional(PodRuntimeState),
    exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.step) {
      case "start":
        return "The pod could not start to run its teardown script; the worktree was kept.";
      case "script":
        return this.exitCode === null || this.exitCode === undefined
          ? "The teardown script did not finish in the pod; the worktree was kept."
          : `The teardown script failed in the pod (exit ${this.exitCode}); the worktree was kept.`;
      case "remove":
        return "The pod could not be removed; the worktree was kept.";
    }
  }
}

export const PodRuntimeSnoozeAction = Schema.Literals(["stop", "freeze"]);
export type PodRuntimeSnoozeAction = typeof PodRuntimeSnoozeAction.Type;

/** The agent image needs the docker CLI with its compose plugin, which runs the stack. */
export const DEFAULT_POD_RUNTIME_IMAGE = "docker:27-cli";
export const DEFAULT_POD_RUNTIME_NETWORK = "t3-pods";

const DockerObjectName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
);
const HostPath = TrimmedNonEmptyString.check(Schema.isMaxLength(1024));
const DnsDomain = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/),
);

const HOSTNAME_PROXY_DEFAULTS = {
  routesDir: "~/.local/state/herdr-orch/routes",
  proxyContainer: "pods-proxy",
  caddyfile: "/etc/caddy/Caddyfile",
  dnsContainer: "pods-dns-int",
  network: "pods",
  domain: "pods.internal",
  caRootPath: "~/.local/state/herdr-orch/caddy/root.crt",
} as const;

/**
 * The host's existing hostname proxy that projects with `pod.hostnames` use:
 * a Caddy container importing one route file per pod from `routesDir`, and a
 * DNS server answering `domain` with the proxy's address, both on `network`.
 * The defaults are orch's, whose pods share the same proxy. `~/` is the home
 * directory of the user running T3 Code.
 */
export const PodHostnameProxySettings = Schema.Struct({
  routesDir: HostPath.pipe(
    Schema.withDecodingDefault(Effect.succeed(HOSTNAME_PROXY_DEFAULTS.routesDir)),
  ),
  proxyContainer: DockerObjectName.pipe(
    Schema.withDecodingDefault(Effect.succeed(HOSTNAME_PROXY_DEFAULTS.proxyContainer)),
  ),
  /** The proxy's Caddyfile, as a path inside its container. */
  caddyfile: HostPath.pipe(
    Schema.withDecodingDefault(Effect.succeed(HOSTNAME_PROXY_DEFAULTS.caddyfile)),
  ),
  dnsContainer: DockerObjectName.pipe(
    Schema.withDecodingDefault(Effect.succeed(HOSTNAME_PROXY_DEFAULTS.dnsContainer)),
  ),
  network: DockerObjectName.pipe(
    Schema.withDecodingDefault(Effect.succeed(HOSTNAME_PROXY_DEFAULTS.network)),
  ),
  domain: DnsDomain.pipe(
    Schema.withDecodingDefault(Effect.succeed(HOSTNAME_PROXY_DEFAULTS.domain)),
  ),
  /** The proxy CA's root certificate, which pods in hostname mode trust. */
  caRootPath: HostPath.pipe(
    Schema.withDecodingDefault(Effect.succeed(HOSTNAME_PROXY_DEFAULTS.caRootPath)),
  ),
});
export type PodHostnameProxySettings = typeof PodHostnameProxySettings.Type;

const PodHostnameProxySettingsPatch = Schema.Struct({
  routesDir: Schema.optionalKey(HostPath),
  proxyContainer: Schema.optionalKey(DockerObjectName),
  caddyfile: Schema.optionalKey(HostPath),
  dnsContainer: Schema.optionalKey(DockerObjectName),
  network: Schema.optionalKey(DockerObjectName),
  domain: Schema.optionalKey(DnsDomain),
  caRootPath: Schema.optionalKey(HostPath),
});

const IpAddress = TrimmedNonEmptyString.check(
  Schema.isMaxLength(45),
  Schema.isPattern(/^(\d{1,3}(\.\d{1,3}){3}|[0-9A-Fa-f:]+)$/),
);
const DnsServers = Schema.Array(IpAddress).check(Schema.isMaxLength(4));

/** Off by default, so stock and dev servers never start containers. */
export const PodRuntimeSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** A Docker endpoint such as `unix:///run/user/1000/docker.sock`; empty uses Docker's default. */
  dockerHost: TrimmedString.check(Schema.isMaxLength(512)).pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
  ),
  /** Must bring the docker CLI and its compose plugin; pod creation checks and says so. */
  defaultImage: TrimmedNonEmptyString.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_POD_RUNTIME_IMAGE)),
  ),
  network: TrimmedNonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/)).pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_POD_RUNTIME_NETWORK)),
  ),
  snoozeAction: PodRuntimeSnoozeAction.pipe(
    Schema.withDecodingDefault(Effect.succeed("stop" as const)),
  ),
  /**
   * Also publish pod services on this host's tailnet address, so other tailnet
   * devices reach them directly. Applies to pods created or recreated after.
   */
  publishOnTailnet: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /**
   * Resolvers for each pod's Docker daemon and its stack. Empty: a pod of
   * ports on a local Docker daemon asks the host's own upstream resolvers,
   * since Docker's DNS on the pods network can fail; a remote one keeps Docker's. Pods in hostname mode ask the proxy's DNS server
   * first. Applies to pods created or recreated after.
   */
  dnsServers: DnsServers.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Host infrastructure only: it is the environment's, never a project's. */
  hostnameProxy: PodHostnameProxySettings.pipe(
    Schema.withDecodingDefault(Effect.succeed(Schema.decodeSync(PodHostnameProxySettings)({}))),
  ),
});
export type PodRuntimeSettings = typeof PodRuntimeSettings.Type;

/** What a project may override; the environment's Docker host stays live beneath it. */
export const PodRuntimeProjectSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  dockerHost: Schema.optionalKey(PodRuntimeSettings.fields.dockerHost),
  defaultImage: Schema.optionalKey(TrimmedNonEmptyString),
  network: Schema.optionalKey(PodRuntimeSettings.fields.network),
  snoozeAction: Schema.optionalKey(PodRuntimeSnoozeAction),
  publishOnTailnet: Schema.optionalKey(Schema.Boolean),
});

export const PodRuntimeSettingsPatch = Schema.Struct({
  ...PodRuntimeProjectSettingsPatch.fields,
  dnsServers: Schema.optionalKey(DnsServers),
  hostnameProxy: Schema.optionalKey(PodHostnameProxySettingsPatch),
});

/** Where a new thread's worktree runs its agents, terminals and scripts. */
export const ThreadWorktreeRuntime = Schema.Literals(["host", "container"]);
export type ThreadWorktreeRuntime = typeof ThreadWorktreeRuntime.Type;
