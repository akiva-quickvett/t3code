import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ProcessRunner from "../processRunner.ts";

export interface PodContainerMount {
  /** A host path for a bind, a volume name for a volume, unused for a tmpfs. */
  readonly source: string;
  readonly target: string;
  readonly type: "bind" | "volume" | "tmpfs";
  readonly readOnly: boolean;
}

export interface PodContainerSpec {
  readonly name: string;
  readonly image: string;
  readonly labels: Readonly<Record<string, string>>;
  /** Always on: a pod's processes are reaped by an init, never left as zombies. */
  readonly init: true;
  readonly privileged: boolean;
  readonly network:
    | { readonly mode: "bridge"; readonly name: string }
    | { readonly mode: "container"; readonly container: string };
  readonly mounts: ReadonlyArray<PodContainerMount>;
  readonly env: Readonly<Record<string, string>>;
  /** TCP ports published on the host, as `docker create -p`. */
  readonly publish?: ReadonlyArray<PodPublishedPort>;
  /** Resolvers in place of Docker's own, as `docker create --dns`. */
  readonly dns?: ReadonlyArray<string>;
  /** `uid:gid`; the image's user when absent. */
  readonly user?: string;
  readonly workdir?: string;
  readonly command: ReadonlyArray<string>;
  /**
   * A name that resolves, inside the container, to the host: its address on
   * the container's bridge network (`gateway`), or Docker's own `host-gateway`.
   * Containers that join this one's network share its hosts file.
   */
  readonly hostAlias?: { readonly name: string; readonly address: "gateway" | "host-gateway" };
}

export interface PodNetworkInfo {
  /** IPv4 CIDR, such as `172.18.0.0/16`. */
  readonly subnet: string;
  /** The host's address on the network. */
  readonly gateway: string;
}

export interface PodPublishedPort {
  /** An IPv4 address of the host; never a wildcard. */
  readonly hostIp: string;
  readonly hostPort: number;
  readonly containerPort: number;
}

export type PodContainerStatus =
  | "created"
  | "running"
  | "paused"
  | "restarting"
  | "removing"
  | "exited"
  | "dead";

export interface PodContainerInfo {
  readonly id: string;
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly status: PodContainerStatus;
}

export interface PodVolumeInfo {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
}

export interface PodExecSpec {
  readonly command: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly user?: string;
}

export interface PodExecResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** The command's last lines of output, stdout then stderr, on one line. */
  readonly outputTail: string;
}

/** What `docker container inspect` says of a container this server does not own, such as a proxy. */
export interface ContainerInspection {
  readonly status: PodContainerStatus;
  /** Its address on each network it is attached to. */
  readonly networks: Readonly<Record<string, string>>;
  readonly mounts: ReadonlyArray<{ readonly source: string; readonly destination: string }>;
}

/** A host command that runs `spec` in the container, for callers that own the process, like a PTY. */
export interface PodExecLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** The launcher's own environment additions; container variables travel by name only. */
  readonly env: Readonly<Record<string, string>>;
}

export const ContainerDriverOperation = Schema.Literals([
  "list",
  "network",
  "createVolume",
  "removeVolume",
  "createContainer",
  "start",
  "stop",
  "pause",
  "unpause",
  "removeContainer",
  "exec",
  "stats",
  "logs",
  "inspect",
  "connect",
  "image",
  "info",
]);
export type ContainerDriverOperation = typeof ContainerDriverOperation.Type;

const DAEMON_MESSAGE_MAX_LENGTH = 300;

export class ContainerDriverError extends Schema.TaggedError<ContainerDriverError>()(
  "ContainerDriverError",
  {
    operation: ContainerDriverOperation,
    exitCode: Schema.NullOr(Schema.Number),
    /** Docker's own one-line refusal, such as a missing image; never command output. */
    daemonMessage: Schema.NullOr(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.daemonMessage ?? `Docker ${this.operation} failed.`;
  }
}

export interface ContainerHost {
  /** Everything carrying `labelKey`, whatever its value. */
  readonly list: (labelKey: string) => Effect.Effect<
    {
      readonly containers: ReadonlyArray<PodContainerInfo>;
      readonly volumes: ReadonlyArray<PodVolumeInfo>;
    },
    ContainerDriverError
  >;
  readonly ensureNetwork: (name: string) => Effect.Effect<void, ContainerDriverError>;
  /** `docker info`'s OperatingSystem, read once; null while the daemon cannot be asked. */
  readonly engineOperatingSystem: Effect.Effect<string | null>;
  /** The same, waiting as long as any Docker command, for a decision that must not be a guess. */
  readonly requireEngineOperatingSystem: Effect.Effect<string, ContainerDriverError>;
  /** Builds the image from `dockerfile` unless the host has it; true when it built. */
  readonly ensureImage: (input: {
    readonly tag: string;
    readonly dockerfile: string;
    readonly labels: Readonly<Record<string, string>>;
  }) => Effect.Effect<boolean, ContainerDriverError>;
  /** The network's IPv4 subnet and gateway; fails when it has none. */
  readonly inspectNetwork: (name: string) => Effect.Effect<PodNetworkInfo, ContainerDriverError>;
  readonly createVolume: (input: {
    readonly name: string;
    readonly labels: Readonly<Record<string, string>>;
  }) => Effect.Effect<void, ContainerDriverError>;
  readonly removeVolume: (name: string) => Effect.Effect<void, ContainerDriverError>;
  readonly createContainer: (spec: PodContainerSpec) => Effect.Effect<string, ContainerDriverError>;
  readonly start: (id: string) => Effect.Effect<void, ContainerDriverError>;
  readonly stop: (id: string, timeoutSeconds: number) => Effect.Effect<void, ContainerDriverError>;
  readonly pause: (id: string) => Effect.Effect<void, ContainerDriverError>;
  readonly unpause: (id: string) => Effect.Effect<void, ContainerDriverError>;
  /** Forced; a container that is already gone is not an error. */
  readonly removeContainer: (id: string) => Effect.Effect<void, ContainerDriverError>;
  readonly exec: (
    id: string,
    spec: PodExecSpec & { readonly timeoutMs: number },
  ) => Effect.Effect<PodExecResult, ContainerDriverError>;
  readonly execLaunch: (id: string, spec: PodExecSpec & { readonly tty: boolean }) => PodExecLaunch;
  /** Null when no container has that name or id. */
  readonly inspect: (
    nameOrId: string,
  ) => Effect.Effect<ContainerInspection | null, ContainerDriverError>;
  /** Attaches the container to one more network; already attached is not an error. */
  readonly connectNetwork: (
    network: string,
    containerId: string,
  ) => Effect.Effect<void, ContainerDriverError>;
  /** The container's last `lines` lines of output, stdout then stderr. */
  readonly logs: (id: string, lines: number) => Effect.Effect<string, ContainerDriverError>;
  /** Memory in bytes per container id; ids Docker did not report are absent. */
  readonly memoryUsage: (
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, number>, ContainerDriverError>;
}

/** The only way the pod runtime touches containers; tests swap in a fake. */
export class ContainerDriver extends Context.Service<
  ContainerDriver,
  {
    /** `dockerHost` empty means Docker's own default endpoint. */
    readonly forHost: (dockerHost: string) => ContainerHost;
  }
>()("t3/pod/ContainerDriver") {}

const DOCKER_TIMEOUT_MS = 120_000;
/** A first build pulls its base images and installs the provider CLIs. */
const IMAGE_BUILD_TIMEOUT_MS = 20 * 60_000;
const ENGINE_INFO_TIMEOUT_MS = 5_000;
const EARLIER_BUILD_KEPT_MS = 7 * 24 * 60 * 60_000;
const ENGINE_INFO_RETRY_MS = 30_000;
const DOCKER_OUTPUT_BYTES = 4 * 1024 * 1024;

const firstLine = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
    ?.slice(0, DAEMON_MESSAGE_MAX_LENGTH) ?? null;

/** A build prints its progress on stderr too; its reason is the last `ERROR:` line. */
const buildFailureLine = (text: string) => {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const reason = lines.findLast((line) => /^(#\d+ )?ERROR\b/i.test(line)) ?? lines.at(-1);
  return reason?.slice(0, DAEMON_MESSAGE_MAX_LENGTH) ?? null;
};

const isMissingObject = (stderr: string) => /no such (container|volume|object)/i.test(stderr);

const OUTPUT_TAIL_LINES = 8;
const OUTPUT_TAIL_LENGTH = 300;

/** A failure message's worth of what a command printed last, on one line. */
export const outputTail = (output: string) =>
  output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-OUTPUT_TAIL_LINES)
    .join(" | ")
    .slice(-OUTPUT_TAIL_LENGTH);

const toContainerStatus = (status: string) =>
  (CONTAINER_STATUSES.has(status) ? status : "dead") as PodContainerStatus;

const MEMORY_UNITS: Record<string, number> = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
};

/** `docker stats` prints usage like "12.5MiB / 15.4GiB". */
export const parseDockerMemoryUsage = (usage: string): number | null => {
  const match = /^\s*([\d.]+)\s*([a-z]+)/i.exec(usage);
  const unit = match?.[2] === undefined ? undefined : MEMORY_UNITS[match[2].toLowerCase()];
  if (match === null || unit === undefined) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? Math.round(value * unit) : null;
};

const CONTAINER_STATUSES = new Set<string>([
  "created",
  "running",
  "paused",
  "restarting",
  "removing",
  "exited",
  "dead",
]);

const DockerInspectContainer = Schema.Struct({
  Id: Schema.String,
  Name: Schema.String,
  Config: Schema.Struct({ Labels: Schema.NullOr(Schema.Record(Schema.String, Schema.String)) }),
  State: Schema.Struct({ Status: Schema.String }),
});
const DockerInspectVolume = Schema.Struct({
  Name: Schema.String,
  Labels: Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
});
const DockerInspectNetwork = Schema.Struct({
  IPAM: Schema.Struct({
    Config: Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          Subnet: Schema.optional(Schema.String),
          Gateway: Schema.optional(Schema.String),
        }),
      ),
    ),
  }),
});
const decodeNetworks = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(DockerInspectNetwork)),
);
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const DockerInspectDetail = Schema.Struct({
  State: Schema.Struct({ Status: Schema.String }),
  NetworkSettings: Schema.Struct({
    Networks: Schema.NullOr(
      Schema.Record(Schema.String, Schema.Struct({ IPAddress: Schema.optional(Schema.String) })),
    ),
  }),
  Mounts: Schema.NullOr(
    Schema.Array(Schema.Struct({ Source: Schema.String, Destination: Schema.String })),
  ),
});
const decodeDetail = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(DockerInspectDetail)),
);
const decodeContainers = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(DockerInspectContainer)),
);
const decodeVolumes = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(DockerInspectVolume)),
);

// Docker splits `--mount` on commas and `-e` on the first '='; neither may appear where it would.
const assertMountPath = (value: string) =>
  /[,\n\r]/.test(value)
    ? Effect.fail(
        new ContainerDriverError({
          operation: "createContainer",
          exitCode: null,
          daemonMessage: "A pod path contains a comma or a line break, which Docker cannot mount.",
        }),
      )
    : Effect.void;

const mountArgument = (mount: PodContainerMount) =>
  [
    `type=${mount.type}`,
    // A tmpfs is writable by the container's own user, whoever that is.
    ...(mount.type === "tmpfs" ? ["tmpfs-mode=1777"] : [`src=${mount.source}`]),
    `dst=${mount.target}`,
    ...(mount.readOnly ? ["readonly"] : []),
  ].join(",");

const DOCKER_CLI_NAMES = new Set([
  "PATH",
  "HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "SSH_AUTH_SOCK",
]);

/**
 * Names the docker CLI, or the loader that starts it, reads from its own
 * environment to find and reach a daemon. Their container values go inline,
 * so they show in the host's process list; t3.json refuses a proxy URL with
 * credentials for that reason.
 */
const readByDockerCli = (name: string) =>
  DOCKER_CLI_NAMES.has(name) ||
  /^(DOCKER_|XDG_|LD_|DYLD_)/.test(name) ||
  /^(https?|no|all)_proxy$/i.test(name);

/**
 * A container's values ride in the CLI's environment and are named with
 * `-e KEY`, so they stay out of the process list. Values the CLI itself reads
 * would redirect it (the agent's DOCKER_HOST is the pod's inner daemon), so
 * those go inline instead and the CLI keeps the host's own.
 */
const containerEnv = (env: Readonly<Record<string, string>>) => {
  const args: Array<string> = [];
  const cliEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (readByDockerCli(name)) {
      args.push("-e", `${name}=${value}`);
    } else {
      args.push("-e", name);
      cliEnv[name] = value;
    }
  }
  return { args, cliEnv };
};

const makeDockerHost = (runner: ProcessRunner.ProcessRunner["Service"], dockerHost: string) => {
  const hostEnv: Record<string, string> = dockerHost.length > 0 ? { DOCKER_HOST: dockerHost } : {};

  const run = (
    operation: ContainerDriverOperation,
    args: ReadonlyArray<string>,
    options?: {
      readonly env?: Readonly<Record<string, string>>;
      readonly timeoutMs?: number;
      readonly allowMissing?: boolean;
      readonly stdin?: string;
    },
  ) =>
    runner
      .run({
        command: "docker",
        args,
        ...(options?.stdin === undefined ? {} : { stdin: options.stdin }),
        env: { ...options?.env, ...hostEnv },
        timeout: options?.timeoutMs ?? DOCKER_TIMEOUT_MS,
        maxOutputBytes: DOCKER_OUTPUT_BYTES,
        outputMode: "truncate",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ContainerDriverError({ operation, exitCode: null, daemonMessage: null, cause }),
        ),
        Effect.flatMap((output) => {
          if (output.timedOut)
            return Effect.fail(
              new ContainerDriverError({
                operation,
                exitCode: null,
                daemonMessage: `Docker ${operation} timed out.`,
              }),
            );
          if (output.code === 0) return Effect.succeed(output.stdout);
          // `docker inspect a b` still prints what it found when one is gone.
          if (options?.allowMissing && isMissingObject(output.stderr))
            return Effect.succeed(output.stdout);
          return Effect.fail(
            new ContainerDriverError({
              operation,
              exitCode: output.code,
              daemonMessage:
                operation === "image" ? buildFailureLine(output.stderr) : firstLine(output.stderr),
            }),
          );
        }),
      );

  const lines = (stdout: string) =>
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

  const decodeFailure = (operation: ContainerDriverOperation) => (cause: unknown) =>
    new ContainerDriverError({ operation, exitCode: null, daemonMessage: null, cause });

  const list: ContainerHost["list"] = (labelKey) =>
    Effect.gen(function* () {
      const filter = `label=${labelKey}`;
      const ids = lines(yield* run("list", ["ps", "-aq", "--no-trunc", "--filter", filter]));
      const containers =
        ids.length === 0
          ? []
          : yield* run("list", ["container", "inspect", ...ids], { allowMissing: true }).pipe(
              Effect.flatMap((json) =>
                json.length === 0 ? Effect.succeed([]) : decodeContainers(json),
              ),
              Effect.mapError(decodeFailure("list")),
            );
      const names = lines(yield* run("list", ["volume", "ls", "-q", "--filter", filter]));
      const volumes =
        names.length === 0
          ? []
          : yield* run("list", ["volume", "inspect", ...names], { allowMissing: true }).pipe(
              Effect.flatMap((json) =>
                json.length === 0 ? Effect.succeed([]) : decodeVolumes(json),
              ),
              Effect.mapError(decodeFailure("list")),
            );
      return {
        containers: containers.map((container) => ({
          id: container.Id,
          name: container.Name.replace(/^\//, ""),
          labels: container.Config.Labels ?? {},
          status: toContainerStatus(container.State.Status),
        })),
        volumes: volumes.map((volume) => ({ name: volume.Name, labels: volume.Labels ?? {} })),
      };
    });

  const ensureNetwork: ContainerHost["ensureNetwork"] = (name) =>
    Effect.gen(function* () {
      const inspect = run("network", ["network", "inspect", name]);
      if (
        yield* inspect.pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        )
      )
        return;
      yield* run("network", ["network", "create", "--label", "t3.managed=true", name]).pipe(
        // Another pod may have created it first.
        Effect.catch((error) => inspect.pipe(Effect.mapError(() => error))),
      );
    });

  const inspectNetwork: ContainerHost["inspectNetwork"] = (name) =>
    run("network", ["network", "inspect", name]).pipe(
      Effect.flatMap((json) =>
        decodeNetworks(json).pipe(Effect.mapError(decodeFailure("network"))),
      ),
      Effect.flatMap((networks) => {
        const config = networks[0]?.IPAM.Config?.find(
          (entry) =>
            entry.Gateway !== undefined &&
            IPV4.test(entry.Gateway) &&
            entry.Subnet !== undefined &&
            IPV4.test(entry.Subnet.split("/")[0] ?? ""),
        );
        return config?.Gateway === undefined || config.Subnet === undefined
          ? Effect.fail(
              new ContainerDriverError({
                operation: "network",
                exitCode: null,
                daemonMessage: `The Docker network ${name} has no IPv4 gateway.`,
              }),
            )
          : Effect.succeed({ subnet: config.Subnet, gateway: config.Gateway });
      }),
    );

  const labelArguments = (labels: Readonly<Record<string, string>>) =>
    Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]);

  const createContainer: ContainerHost["createContainer"] = (spec) =>
    Effect.gen(function* () {
      for (const mount of spec.mounts) {
        yield* assertMountPath(mount.source);
        yield* assertMountPath(mount.target);
      }
      const env = containerEnv(spec.env);
      const hostAlias =
        spec.hostAlias === undefined || spec.network.mode !== "bridge"
          ? []
          : [
              "--add-host",
              `${spec.hostAlias.name}:${
                spec.hostAlias.address === "host-gateway"
                  ? "host-gateway"
                  : (yield* inspectNetwork(spec.network.name).pipe(
                      Effect.mapError(
                        (error) =>
                          new ContainerDriverError({ ...error, operation: "createContainer" }),
                      ),
                    )).gateway
              }`,
            ];
      const args = [
        "create",
        "--name",
        spec.name,
        ...(spec.init ? ["--init"] : []),
        ...(spec.privileged ? ["--privileged"] : []),
        ...labelArguments(spec.labels),
        "--network",
        spec.network.mode === "bridge" ? spec.network.name : `container:${spec.network.container}`,
        ...spec.mounts.flatMap((mount) => ["--mount", mountArgument(mount)]),
        ...(spec.publish ?? []).flatMap((port) => [
          "--publish",
          `${port.hostIp}:${port.hostPort}:${port.containerPort}/tcp`,
        ]),
        ...(spec.dns ?? []).flatMap((server) => ["--dns", server]),
        ...hostAlias,
        ...env.args,
        ...(spec.user === undefined ? [] : ["--user", spec.user]),
        ...(spec.workdir === undefined ? [] : ["--workdir", spec.workdir]),
        spec.image,
        ...spec.command,
      ];
      // A missing image is pulled here, which can take minutes.
      const stdout = yield* run("createContainer", args, { env: env.cliEnv, timeoutMs: 1_800_000 });
      const id = lines(stdout).at(-1);
      if (id === undefined)
        return yield* new ContainerDriverError({
          operation: "createContainer",
          exitCode: 0,
          daemonMessage: "Docker created no container.",
        });
      return id;
    });

  const execArguments = (spec: PodExecSpec) => {
    const env = containerEnv(spec.env ?? {});
    return {
      args: [
        ...(spec.user === undefined ? [] : ["--user", spec.user]),
        ...(spec.cwd === undefined ? [] : ["--workdir", spec.cwd]),
        ...env.args,
      ],
      cliEnv: env.cliEnv,
    };
  };

  // A daemon that cannot answer is asked again only after a while: the
  // listener asks for every pod on every pod event. Its guess meanwhile is
  // never built into a container: the plan asks with `require…`, and a known
  // answer is kept for good, so the listener cannot flip once it has one.
  let operatingSystem: string | undefined;
  let unreadableUntil = 0;
  const readOperatingSystem = (timeoutMs?: number) =>
    run(
      "info",
      ["info", "--format", "{{.OperatingSystem}}"],
      timeoutMs === undefined ? {} : { timeoutMs },
    ).pipe(
      Effect.map((stdout) => {
        operatingSystem = stdout.trim();
        return operatingSystem;
      }),
    );
  const engineOperatingSystem: ContainerHost["engineOperatingSystem"] = Effect.gen(function* () {
    if (operatingSystem !== undefined) return operatingSystem;
    const now = yield* Clock.currentTimeMillis;
    if (now < unreadableUntil) return null;
    return yield* readOperatingSystem(ENGINE_INFO_TIMEOUT_MS).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          unreadableUntil = now + ENGINE_INFO_RETRY_MS;
          return null;
        }),
      ),
    );
  });
  const requireEngineOperatingSystem: ContainerHost["requireEngineOperatingSystem"] =
    Effect.suspend(() =>
      operatingSystem !== undefined ? Effect.succeed(operatingSystem) : readOperatingSystem(),
    );

  /**
   * Earlier builds of the same image, each as large as this one. Docker
   * refuses to remove one a container still uses, even a stopped one, so a pod
   * keeps its image until it is recreated. Only builds a week old go: another
   * T3 server on this daemon, at another version, may build its own and would
   * otherwise rebuild it each time this one removed it.
   */
  const removeEarlierBuilds = (tag: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const others = lines(
        yield* run("image", [
          "image",
          "ls",
          "--filter",
          `reference=${tag.slice(0, tag.lastIndexOf(":"))}`,
          "--format",
          "{{.Repository}}:{{.Tag}}",
        ]),
      ).filter((other) => other !== tag);
      yield* Effect.forEach(
        others,
        (other) =>
          run("image", ["image", "inspect", "--format", "{{.Created}}", other]).pipe(
            Effect.flatMap((created) =>
              now - Date.parse(created.trim()) > EARLIER_BUILD_KEPT_MS
                ? run("image", ["image", "rm", other])
                : Effect.void,
            ),
            Effect.ignore,
          ),
        { discard: true },
      );
    }).pipe(Effect.ignore);

  // Pods starting together build once: the next one finds the image.
  const imageBuilds = Semaphore.makeUnsafe(1);
  const ensureImage: ContainerHost["ensureImage"] = ({ tag, dockerfile, labels }) =>
    run("image", ["image", "inspect", "--format", "{{.Id}}", tag]).pipe(
      Effect.as(false),
      Effect.catch(() =>
        run("image", ["build", "--tag", tag, ...labelArguments(labels), "-"], {
          stdin: dockerfile,
          timeoutMs: IMAGE_BUILD_TIMEOUT_MS,
        }).pipe(Effect.andThen(removeEarlierBuilds(tag)), Effect.as(true)),
      ),
      imageBuilds.withPermits(1),
    );

  return {
    list,
    ensureNetwork,
    engineOperatingSystem,
    requireEngineOperatingSystem,
    ensureImage,
    inspectNetwork,
    createVolume: ({ name, labels }) =>
      run("createVolume", ["volume", "create", ...labelArguments(labels), name]).pipe(
        Effect.asVoid,
      ),
    removeVolume: (name) =>
      run("removeVolume", ["volume", "rm", name], { allowMissing: true }).pipe(Effect.asVoid),
    createContainer,
    start: (id) => run("start", ["start", id]).pipe(Effect.asVoid),
    stop: (id, timeoutSeconds) =>
      run("stop", ["stop", "-t", String(timeoutSeconds), id], {
        allowMissing: true,
        timeoutMs: (timeoutSeconds + 30) * 1000,
      }).pipe(Effect.asVoid),
    pause: (id) => run("pause", ["pause", id]).pipe(Effect.asVoid),
    unpause: (id) => run("unpause", ["unpause", id]).pipe(Effect.asVoid),
    removeContainer: (id) =>
      run("removeContainer", ["rm", "-f", id], { allowMissing: true }).pipe(Effect.asVoid),
    exec: (id, spec) => {
      const exec = execArguments(spec);
      return runner
        .run({
          command: "docker",
          args: ["exec", ...exec.args, id, ...spec.command],
          env: { ...exec.cliEnv, ...hostEnv },
          timeout: spec.timeoutMs,
          maxOutputBytes: DOCKER_OUTPUT_BYTES,
          outputMode: "truncate",
          timeoutBehavior: "timedOutResult",
        })
        .pipe(
          Effect.map((output) => ({
            exitCode: output.timedOut ? null : output.code,
            timedOut: output.timedOut,
            outputTail: outputTail(`${output.stdout}\n${output.stderr}`),
          })),
          Effect.mapError(
            (cause) =>
              new ContainerDriverError({
                operation: "exec",
                exitCode: null,
                daemonMessage: null,
                cause,
              }),
          ),
        );
    },
    inspect: (nameOrId) =>
      run("inspect", ["container", "inspect", nameOrId], { allowMissing: true }).pipe(
        Effect.flatMap((json) =>
          json.trim().length === 0 ? Effect.succeed([]) : decodeDetail(json),
        ),
        Effect.mapError((error) =>
          error._tag === "ContainerDriverError" ? error : decodeFailure("inspect")(error),
        ),
        Effect.map((found) => {
          const detail = found[0];
          if (detail === undefined) return null;
          return {
            status: toContainerStatus(detail.State.Status),
            networks: Object.fromEntries(
              Object.entries(detail.NetworkSettings.Networks ?? {}).map(([name, network]) => [
                name,
                network.IPAddress ?? "",
              ]),
            ),
            mounts: (detail.Mounts ?? []).map((mount) => ({
              source: mount.Source,
              destination: mount.Destination,
            })),
          } satisfies ContainerInspection;
        }),
      ),
    connectNetwork: (network, containerId) =>
      run("connect", ["network", "connect", network, containerId]).pipe(
        Effect.asVoid,
        Effect.catch((error) =>
          /already exists|already attached/i.test(error.daemonMessage ?? "")
            ? Effect.void
            : Effect.fail(error),
        ),
      ),
    logs: (id, count) =>
      runner
        .run({
          command: "docker",
          args: ["logs", "--tail", String(count), id],
          env: hostEnv,
          timeout: DOCKER_TIMEOUT_MS,
          maxOutputBytes: DOCKER_OUTPUT_BYTES,
          outputMode: "truncate",
          timeoutBehavior: "timedOutResult",
        })
        .pipe(
          Effect.map((output) => `${output.stdout}\n${output.stderr}`),
          Effect.mapError(
            (cause) =>
              new ContainerDriverError({
                operation: "logs",
                exitCode: null,
                daemonMessage: null,
                cause,
              }),
          ),
        ),
    execLaunch: (id, spec) => {
      const exec = execArguments(spec);
      return {
        command: "docker",
        args: ["exec", "-i", ...(spec.tty ? ["-t"] : []), ...exec.args, id, ...spec.command],
        env: { ...exec.cliEnv, ...hostEnv },
      };
    },
    memoryUsage: (ids) =>
      ids.length === 0
        ? Effect.succeed(new Map<string, number>())
        : run("stats", ["stats", "--no-stream", "--format", "{{.ID}}\t{{.MemUsage}}", ...ids]).pipe(
            Effect.map((stdout) => {
              const usage = new Map<string, number>();
              for (const line of lines(stdout)) {
                const [shortId, memory] = line.split("\t");
                const id = ids.find((candidate) => shortId && candidate.startsWith(shortId));
                const bytes = memory === undefined ? null : parseDockerMemoryUsage(memory);
                if (id !== undefined && bytes !== null) usage.set(id, bytes);
              }
              return usage;
            }),
          ),
  } satisfies ContainerHost;
};

const makeDocker = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const hosts = new Map<string, ContainerHost>();
  return ContainerDriver.of({
    forHost: (dockerHost) => {
      const existing = hosts.get(dockerHost);
      if (existing !== undefined) return existing;
      const host = makeDockerHost(runner, dockerHost);
      hosts.set(dockerHost, host);
      return host;
    },
  });
});

export const layerDocker = Layer.effect(ContainerDriver, makeDocker);
