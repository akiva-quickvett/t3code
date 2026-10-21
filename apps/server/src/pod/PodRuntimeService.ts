import {
  PodRuntimeError,
  PodRuntimeId,
  type PodRuntimeOpenShellInput,
  type PodRuntimeOpenShellResult,
  type PodRuntimeOperation,
  type PodRuntimeOrphan,
  type PodRuntimeRemoveInput,
  type PodRuntimeRequest,
  type PodRuntimeSnapshot,
  type PodRuntimeStats,
  type PodRuntimeStatus,
  type PodRuntimeStatusInput,
  type PodRuntimeStreamEvent,
  type PodRuntimeWarning,
  type ProjectId,
  type T3ProjectFilePod,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as TxRef from "effect/TxRef";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import * as ContainerDriver from "./ContainerDriver.ts";
import {
  parsePodPortsLabel,
  POD_ENVIRONMENT_LABEL,
  POD_LABEL,
  POD_PORTS_LABEL,
  planPod,
  podContainerNames,
  podEnvironmentStem,
  podNameStem,
} from "./PodContainerPlan.ts";
import { renderPodEnv, writePodDotEnv } from "./PodEnv.ts";
import * as PodHostnameRouter from "./PodHostnameRouter.ts";
import * as PodHostPorts from "./PodHostPorts.ts";
import {
  runPodOperation,
  type PodOperationContext,
  type PodOperationResult,
  PodStepError,
} from "./PodOperations.ts";
import { resolvePodProviderMounts } from "./PodProviderMounts.ts";
import {
  boundedPodMessage,
  isPodTransitional,
  POD_LOOPBACK_ADDRESS,
  POD_OPERATION_RULES,
  type PodObservation,
  planPodCompletion,
  podHostnameUrl,
  podServiceUrl,
  planPodObservation,
  planPodRequest,
  type PodRuntimeEvent,
  type PodRuntimeRecord,
} from "./PodRuntimeLifecycle.ts";
import * as PodRuntimeStore from "./PodRuntimeStore.ts";

export class PodRuntimeService extends Context.Service<
  PodRuntimeService,
  {
    /**
     * Records a pod for a new worktree and starts creating it. Returns once the
     * intent is committed; `awaitSettled` waits for the containers.
     */
    readonly create: (input: {
      readonly projectId: ProjectId;
      readonly worktreePath: string;
    }) => Effect.Effect<PodRuntimeSnapshot, PodRuntimeError>;
    readonly start: (podId: PodRuntimeId) => Effect.Effect<PodRuntimeSnapshot, PodRuntimeError>;
    readonly stop: (podId: PodRuntimeId) => Effect.Effect<PodRuntimeSnapshot, PodRuntimeError>;
    /** Removes the pod's containers and volume and creates them again: the stack's data is lost. */
    readonly recreate: (podId: PodRuntimeId) => Effect.Effect<PodRuntimeSnapshot, PodRuntimeError>;
    /** Replaces only the agent container; the daemon, its volume and the stack keep running. */
    readonly recreateAgentContainer: (
      podId: PodRuntimeId,
    ) => Effect.Effect<PodRuntimeSnapshot, PodRuntimeError>;
    /** Null when the id named an orphan, which is removed right away. */
    readonly remove: (
      input: PodRuntimeRemoveInput,
    ) => Effect.Effect<PodRuntimeSnapshot | null, PodRuntimeError>;
    readonly status: (
      input: PodRuntimeStatusInput,
    ) => Effect.Effect<PodRuntimeStatus, PodRuntimeError>;
    readonly subscribe: Stream.Stream<PodRuntimeStreamEvent, PodRuntimeError>;
    readonly openShell: (
      input: PodRuntimeOpenShellInput,
    ) => Effect.Effect<PodRuntimeOpenShellResult, PodRuntimeError>;
    /**
     * The pod, not yet removed, whose worktree is `path` or contains it; with
     * `includeRemoved`, the latest pod the path ever had.
     */
    readonly forPath: (
      path: string,
      options?: { readonly includeRemoved?: boolean },
    ) => Effect.Effect<PodRuntimeSnapshot | undefined>;
    /** Waits until the pod is in no transitional state; a removed pod counts as settled. */
    readonly awaitSettled: (
      podId: PodRuntimeId,
    ) => Effect.Effect<PodRuntimeSnapshot, PodRuntimeError>;
    /**
     * Starts the pod when it is stopped or failed and waits; fails unless it
     * ends up running. Refused with pods turned off, except for a teardown,
     * which is the way out.
     */
    readonly ensureRunning: (
      podId: PodRuntimeId,
      options?: { readonly forTeardown?: boolean },
    ) => Effect.Effect<PodRuntimeSnapshot, PodRuntimeError>;
    /**
     * Marks the worktree at `worktreePath` gone for every removed pod that had
     * it, so a host worktree made later at the same path runs its own teardown.
     */
    readonly releaseWorktree: (worktreePath: string) => Effect.Effect<void, PodRuntimeError>;
    /** Resolves once every queued Docker operation has finished. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/pod/PodRuntimeService") {}

const POD_SHELL_TERMINAL_ID = "pod-shell";
const OPERATION_CRASHED = "The pod operation stopped unexpectedly; see the server log.";
const isPodRuntimeId = Schema.is(PodRuntimeId);
const EMPTY_POD_CONFIG: T3ProjectFilePod = { services: {} };
const STARTS_CONTAINERS = new Set<PodRuntimeOperation>([
  "start",
  "recreate",
  "recreateAgentContainer",
]);
/** These create the pod's daemon afresh, so its ports and `.env` are decided again. */
const BUILDS_FRESH = new Set<PodRuntimeOperation>(["create", "recreate"]);

interface QueuedOperation {
  readonly podId: PodRuntimeId;
  readonly operation: PodRuntimeOperation;
  readonly force: boolean;
}

const make = Effect.gen(function* () {
  const store = yield* PodRuntimeStore.PodRuntimeStore;
  const driver = yield* ContainerDriver.ContainerDriver;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const projectFiles = yield* T3ProjectFileLoader.T3ProjectFileLoader;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const terminals = yield* TerminalManager.TerminalManager;
  const portDiscovery = yield* PortScanner.PortDiscovery;
  const hostNetwork = yield* PodHostPorts.PodHostNetwork;
  const router = yield* PodHostnameRouter.PodHostnameRouter;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironmentIdentity)
    .getEnvironmentId;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const uid = yield* HostProcess.UserId;
  const gid = yield* HostProcess.GroupId;
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

  // Commands read and commit a pod's record under its state lock; its Docker
  // operations run one at a time under the operation lock, so a Remove asked
  // for mid-start is recorded at once and runs when the start returns.
  const stateLocks = yield* KeyedLock.make<PodRuntimeId>();
  const operationLocks = yield* KeyedLock.make<PodRuntimeId>();
  // Host ports are shared by every pod: one allocation at a time, so two pods
  // starting together never pick the same port.
  const allocationLock = yield* Semaphore.make(1);
  const workerScope = yield* Effect.scope;
  const outstanding = yield* TxRef.make(0);
  // Kept per Docker host, so a host that cannot answer keeps its last known orphans.
  let orphans: ReadonlyArray<{ readonly host: string; readonly orphan: PodRuntimeOrphan }> = [];

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const unavailable = (podId?: PodRuntimeId) => (cause: unknown) =>
    Effect.logError("pod runtime state could not be read or recorded", cause).pipe(
      Effect.andThen(
        Effect.fail(
          new PodRuntimeError({ reason: "unavailable", ...(podId === undefined ? {} : { podId }) }),
        ),
      ),
    );

  /**
   * The preview's server list shows a pod's services exactly while their URLs
   * do. A hostname is probed at its loopback port: the server's own fetch does
   * not trust the proxy's CA.
   */
  const publishToDiscovery = (record: PodRuntimeRecord) => {
    const owner = `pod:${record.snapshot.id}`;
    const urls = record.snapshot.services.flatMap((service) => {
      const hostPort = record.hostPorts?.[service.name];
      if (service.url === null || hostPort === undefined) return [];
      const loopback = podServiceUrl(POD_LOOPBACK_ADDRESS, hostPort);
      return [service.url === loopback ? loopback : { url: service.url, probeUrl: loopback }];
    });
    return portDiscovery.registerConfiguredUrls({ owner, urls });
  };

  const commit = (podId: PodRuntimeId, events: ReadonlyArray<PodRuntimeEvent>) =>
    store.commit(podId, events).pipe(
      Effect.tap((record) => (record === undefined ? Effect.void : publishToDiscovery(record))),
      Effect.catch(unavailable(podId)),
    );

  const requireRecord = (podId: PodRuntimeId) =>
    store
      .get(podId)
      .pipe(
        Effect.flatMap((record) =>
          record === undefined || record.snapshot.state === "removed"
            ? Effect.fail(new PodRuntimeError({ reason: "not-found", podId }))
            : Effect.succeed(record),
        ),
      );

  const settingsFor = (projectId: ProjectId | null) =>
    serverSettings.getSettings.pipe(
      Effect.map((settings) => ({
        settings,
        podRuntime: resolveProjectSettings(settings, projectId).settings.podRuntime,
      })),
      Effect.catch(unavailable()),
    );

  const loadPodConfig = (...roots: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      for (const root of roots) {
        const file = yield* projectFiles.load(root);
        if (Option.isSome(file)) return file.value.pod;
      }
      return undefined;
    });

  const projectRoot = (projectId: ProjectId) =>
    projects
      .getById(projectId, { includeDeleted: true })
      .pipe(
        Effect.map(Option.map((project) => project.workspaceRoot)),
        Effect.map(Option.getOrUndefined),
        Effect.catch(unavailable()),
      );

  const existingPath = (candidate: string) =>
    fileSystem.exists(candidate).pipe(
      Effect.orElseSucceed(() => false),
      Effect.map((exists) => (exists ? candidate : null)),
    );

  const seedsFor = (root: string | undefined) => {
    if (root === undefined) return Effect.succeed(null);
    const name = path.basename(root);
    return existingPath(path.join(homeDirectory, "pods", "seeds", name)).pipe(
      Effect.map((dir) => (dir === null ? null : { dir, name })),
    );
  };

  /**
   * Ports other servers' pods, and orphans, hold on the same daemon, stopped
   * ones included, where a bind probe would see nothing.
   */
  const portsOnDaemon = (podId: PodRuntimeId, dockerHost: string) =>
    driver
      .forHost(dockerHost)
      .list(POD_LABEL)
      .pipe(
        Effect.map(({ containers }) =>
          containers.flatMap((container) =>
            container.labels[POD_LABEL] === podId &&
            container.labels[POD_ENVIRONMENT_LABEL] === environmentId
              ? []
              : parsePodPortsLabel(container.labels[POD_PORTS_LABEL]),
          ),
        ),
        Effect.catch((error) =>
          Effect.logWarning("could not list pod ports on the Docker host", {
            operation: error.operation,
          }).pipe(Effect.as([])),
        ),
      );

  /** The record's routing as `problem` and `routed` leave it; null when that is already so. */
  const routesUpdated = (
    record: PodRuntimeRecord,
    routed: boolean,
    problem: string | null,
    occurredAt: string,
  ): PodRuntimeEvent | null => {
    const bounded = problem === null ? undefined : boundedPodMessage(problem);
    if ((record.routed === true) === routed && record.snapshot.hostnameProblem === bounded)
      return null;
    return {
      type: "pod.routes-updated",
      podId: record.snapshot.id,
      occurredAt,
      routed,
      problem: bounded ?? null,
    };
  };

  /**
   * Whether a daemon about to be built serves hostnames: only when the project
   * asks for them and the host's proxy is there; otherwise ports, and why.
   */
  const decideHostnames = (podId: PodRuntimeId, dockerHost: string, config: T3ProjectFilePod) =>
    Effect.gen(function* () {
      if (config.hostnames !== true) return { type: "ports" as const, problem: null };
      const { podRuntime } = yield* settingsFor(null);
      const proxy = router.resolve(podRuntime.hostnameProxy);
      const prepared = yield* router.prepare(dockerHost, proxy);
      if (prepared.type === "unavailable")
        return {
          type: "ports" as const,
          problem: `Hostnames are off for this pod: ${prepared.reason}. Its services use ports; Recreate the pod once that is fixed.`,
        };
      const stem = podNameStem(podId, environmentId);
      return {
        type: "hostnames" as const,
        dnsAddress: prepared.dnsAddress,
        hostnames: Object.fromEntries(
          Object.keys(config.services).map((name) => [
            name,
            PodHostnameRouter.podServiceHostname(stem, name, proxy.domain),
          ]),
        ),
      };
    });

  /**
   * Hostnames are decided when the daemon is built, so a pod built for ports
   * says why it ignores a later `hostnames: true` until it is recreated, and
   * stops saying so once t3.json no longer asks.
   */
  const noteHostnamesSetting = (queued: PodRuntimeRecord, config: T3ProjectFilePod) =>
    Effect.gen(function* () {
      if (queued.hostnames !== undefined) return queued;
      const asks = config.hostnames === true;
      const noted = queued.snapshot.hostnameProblem !== undefined;
      if (asks === noted) return queued;
      const podId = queued.snapshot.id;
      return yield* stateLocks.withLock(
        podId,
        Effect.gen(function* () {
          const current = yield* requireRecord(podId);
          const event = routesUpdated(
            current,
            current.routed === true,
            asks
              ? "This pod was built for ports; Recreate it to serve its services on hostnames."
              : null,
            yield* nowIso,
          );
          return event === null ? current : ((yield* commit(podId, [event])) ?? current);
        }),
      );
    });

  /**
   * Keeps each service's host port and gives new services free ones, under the
   * allocation lock so the ports other pods hold are read and claimed in one step.
   */
  const allocatePorts = (podId: PodRuntimeId, config: T3ProjectFilePod) =>
    allocationLock.withPermits(1)(
      Effect.gen(function* () {
        const services = config.services;
        // Docker is asked outside the pod's state lock, so a slow daemon never
        // holds up this pod's Stop or Remove; the driver's own timeout bounds it.
        const dockerHost = (yield* requireRecord(podId)).dockerHost;
        const daemonTaken = yield* portsOnDaemon(podId, dockerHost);
        const hostnames = yield* decideHostnames(podId, dockerHost, config);
        return yield* stateLocks.withLock(
          podId,
          Effect.gen(function* () {
            const current = yield* requireRecord(podId);
            const taken = new Set<number>(daemonTaken);
            for (const other of yield* store.list)
              if (other.snapshot.id !== podId && other.snapshot.state !== "removed")
                for (const port of Object.values(other.hostPorts ?? {})) taken.add(port);
            const { podRuntime } = yield* settingsFor(current.snapshot.projectId);
            const tailnetAddress = podRuntime.publishOnTailnet
              ? yield* hostNetwork.tailnetAddress
              : null;
            if (podRuntime.publishOnTailnet && tailnetAddress === null)
              yield* Effect.logWarning(
                "no tailnet address; pod services are published on loopback only",
                {
                  podId,
                },
              );
            const allocated = yield* PodHostPorts.allocatePodHostPorts({
              services,
              previous: current.hostPorts ?? {},
              taken,
              addresses: [
                POD_LOOPBACK_ADDRESS,
                ...(tailnetAddress === null ? [] : [tailnetAddress]),
              ],
            }).pipe(Effect.provideService(PodHostPorts.PodHostNetwork, hostNetwork));
            const occurredAt = yield* nowIso;
            const problem = routesUpdated(
              current,
              current.routed === true,
              hostnames.type === "ports" ? hostnames.problem : null,
              occurredAt,
            );
            const next = yield* commit(podId, [
              {
                type: "pod.ports-allocated",
                podId,
                occurredAt,
                services: allocated,
                tailnetAddress,
                ...(hostnames.type === "hostnames"
                  ? { hostnames: hostnames.hostnames, dnsAddress: hostnames.dnsAddress }
                  : {}),
              },
              ...(problem === null ? [] : [problem]),
            ]);
            return next ?? current;
          }),
        );
      }),
    );

  /**
   * The services' side of an operation. A fresh daemon gets its ports and its
   * `.env` decided again; every operation gets the rendered env, what the
   * daemon publishes, and the check that its ports are still free.
   */
  const prepareServices = Effect.fn("PodRuntimeService.prepareServices")(function* (
    queued: PodRuntimeRecord,
    operation: PodRuntimeOperation,
    config: T3ProjectFilePod,
  ) {
    // Changes to the t3.json services take effect when the daemon is created
    // again. A retried create reuses a daemon its failed attempt left, with that
    // attempt's ports; Recreate applies service changes made in between.
    const record = BUILDS_FRESH.has(operation)
      ? yield* allocatePorts(queued.snapshot.id, config)
      : yield* noteHostnamesSetting(queued, config);
    const published = record.snapshot.services.flatMap(({ name, port }) => {
      const hostPort = record.hostPorts?.[name];
      return hostPort === undefined ? [] : [{ name, port, hostPort }];
    });
    const addresses = [
      POD_LOOPBACK_ADDRESS,
      ...(record.tailnetAddress === undefined ? [] : [record.tailnetAddress]),
    ];
    const rendered = renderPodEnv(
      config.env ?? {},
      published.map((service) => {
        const hostname = record.hostnames?.[service.name];
        return hostname === undefined
          ? {
              name: service.name,
              url: podServiceUrl(POD_LOOPBACK_ADDRESS, service.hostPort),
              port: service.hostPort,
            }
          : { name: service.name, url: podHostnameUrl(hostname), port: 443 };
      }),
      new Set(
        Object.keys(config.services).filter((name) => record.hostPorts?.[name] === undefined),
      ),
    );
    // Taking the stack down never waits on a t3.json edit: its compose runs
    // with the raw values when they no longer render.
    const env =
      operation === "stop" || operation === "remove"
        ? yield* rendered.pipe(Effect.orElseSucceed(() => config.env ?? {}))
        : yield* rendered;
    if (BUILDS_FRESH.has(operation))
      yield* writePodDotEnv(record.snapshot.worktreePath, env).pipe(
        Effect.provide(services),
        Effect.mapError(
          (cause) =>
            new PodStepError({
              step: "Writing the pod's .env",
              exitCode: null,
              timedOut: false,
              daemonMessage: cause._tag === "PodEnvError" ? cause.message : null,
              cause,
            }),
        ),
      );
    const checkHostPorts = PodHostPorts.findPodPortClash(published, addresses).pipe(
      Effect.provideService(PodHostPorts.PodHostNetwork, hostNetwork),
      Effect.flatMap((clash) =>
        clash === null
          ? Effect.void
          : Effect.fail(
              new PodStepError({
                step: "Publishing the pod's services",
                exitCode: null,
                timedOut: false,
                daemonMessage: clash,
              }),
            ),
      ),
    );
    return {
      record,
      env,
      publish: addresses.flatMap((hostIp) =>
        published.map((service) => ({
          hostIp,
          hostPort: service.hostPort,
          containerPort: service.port,
        })),
      ),
      checkHostPorts,
    };
  });

  const operationContext = Effect.fn("PodRuntimeService.operationContext")(function* (
    record: PodRuntimeRecord,
    operation: PodRuntimeOperation,
  ) {
    const { snapshot } = record;
    const root = yield* projectRoot(snapshot.projectId);
    const { settings, podRuntime } = yield* settingsFor(snapshot.projectId);
    const config =
      (yield* loadPodConfig(snapshot.worktreePath, ...(root === undefined ? [] : [root]))) ??
      EMPTY_POD_CONFIG;
    const podServices = yield* prepareServices(record, operation, config);
    const hostnameMode = podServices.record.hostnames !== undefined;
    const proxy = router.resolve(podRuntime.hostnameProxy);
    const gitCommonDir = yield* git
      .execute({
        operation: "PodRuntimeService.gitCommonDir",
        cwd: snapshot.worktreePath,
        args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      })
      .pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.orElseSucceed(() => path.join(root ?? snapshot.worktreePath, ".git")),
      );
    const providerMounts = yield* resolvePodProviderMounts(settings, snapshot.projectId).pipe(
      Effect.provide(services),
    );
    const plan = planPod({
      podId: snapshot.id,
      environmentId,
      image: snapshot.image,
      network: podRuntime.network,
      worktreePath: snapshot.worktreePath,
      gitCommonDir,
      homeDirectory,
      user: uid === undefined || gid === undefined ? null : { uid, gid },
      providerMounts,
      gitConfigPath: yield* existingPath(path.join(homeDirectory, ".gitconfig")),
      ghConfigDir: yield* existingPath(path.join(homeDirectory, ".config", "gh")),
      seeds: yield* seedsFor(root),
      podEnv: podServices.env,
      publish: podServices.publish,
      dns: [
        ...(podServices.record.dnsAddress === undefined ? [] : [podServices.record.dnsAddress]),
        ...podRuntime.dnsServers,
      ],
      proxyCaRoot: hostnameMode ? proxy.caRootPath : null,
    });
    return {
      podId: snapshot.id,
      environmentId,
      host: driver.forHost(record.dockerHost),
      plan,
      network: podRuntime.network,
      config: { ...config, env: podServices.env },
      worktreePath: snapshot.worktreePath,
      checkHostPorts: podServices.checkHostPorts,
      proxyNetwork: hostnameMode ? proxy.network : null,
    } satisfies PodOperationContext;
  });

  /**
   * Records how a queued operation ended. Retried, because a transitional
   * state left behind would have no way out until the next restart.
   */
  const complete = (
    item: QueuedOperation,
    failure: string | null,
    result?: PodOperationResult,
    routes: PodRuntimeEvent | null = null,
  ) =>
    stateLocks
      .withLock(
        item.podId,
        Effect.gen(function* () {
          const current = yield* store.get(item.podId);
          if (current === undefined) return;
          // "Remove anyway": forget the pod even though Docker refused.
          const forced = failure !== null && item.force && item.operation === "remove";
          const event = planPodCompletion(
            current,
            item.operation,
            failure === null
              ? { type: "succeeded", containerIds: [], volumeIds: [], ...result }
              : forced
                ? { type: "succeeded", containerIds: [], volumeIds: [], forced: true }
                : { type: "failed", message: failure },
            yield* nowIso,
          );
          if (event !== null)
            yield* commit(item.podId, routes === null ? [event] : [event, routes]);
        }),
      )
      .pipe(Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 5 }));

  const runQueued = Effect.fn("PodRuntimeService.runQueued")(function* (item: QueuedOperation) {
    const record = yield* store.get(item.podId);
    // A later request moved the pod on; this operation no longer applies.
    if (record === undefined || isStale(record, item.operation)) return;
    const outcome = yield* operationContext(record, item.operation).pipe(
      Effect.flatMap((context) => runPodOperation(item.operation, context)),
      Effect.result,
    );
    if (Result.isFailure(outcome)) {
      yield* Effect.logWarning("pod operation failed", {
        podId: item.podId,
        operation: item.operation,
        error: outcome.failure._tag,
      });
      const routes = yield* syncRoutes(item.podId, null);
      return yield* complete(item, outcome.failure.message, undefined, routes);
    }
    const routes = yield* syncRoutes(item.podId, item.operation);
    yield* complete(item, null, outcome.success, routes);
  });

  /**
   * Puts the pod's proxy route in place when `succeeded` leaves it running in
   * hostname mode, and takes it away otherwise, before the outcome commits, so
   * a link never names a hostname without a route or a route outlives its pod.
   * A pod of ports only has no route and costs nothing here.
   */
  const syncRoutes = (podId: PodRuntimeId, succeeded: PodRuntimeOperation | null) =>
    Effect.gen(function* () {
      const record = yield* store.get(podId);
      if (record === undefined) return null;
      if (succeeded !== null && isStale(record, succeeded)) return null;
      const serves = succeeded !== null && POD_OPERATION_RULES[succeeded].success === "running";
      return yield* routeRecord(record, serves);
    });

  const routeRecord = (record: PodRuntimeRecord, serves: boolean) =>
    Effect.gen(function* () {
      const hostnames = record.hostnames;
      if (hostnames === undefined && record.routed !== true) return null;
      const podId = record.snapshot.id;
      const { podRuntime } = yield* settingsFor(null);
      const proxy = router.resolve(podRuntime.hostnameProxy);
      const stem = podNameStem(podId, environmentId);
      const desired = serves && hostnames !== undefined;
      const dind = podContainerNames(podId, environmentId).dind;
      const failed = desired
        ? yield* router.install({
            dockerHost: record.dockerHost,
            proxy,
            stem,
            upstreamContainer: dind,
            routes: record.snapshot.services.flatMap((service) => {
              const hostname = hostnames[service.name];
              return hostname === undefined
                ? []
                : [{ hostname, upstream: `${dind}:${service.port}` }];
            }),
          })
        : yield* router.uninstall({
            dockerHost: record.dockerHost,
            proxy,
            stem,
            routed: record.routed === true,
          });
      if (failed !== null)
        yield* Effect.logWarning("pod proxy route not updated", { podId, desired, reason: failed });
      const problem =
        failed === null
          ? // A pod built for ports keeps saying why, though its old route is gone.
            hostnames === undefined
            ? (record.snapshot.hostnameProblem ?? null)
            : null
          : desired
            ? `Its proxy route is not in place: ${failed}. Links use ports until the pod starts again.`
            : `Its proxy route could not be taken away: ${failed}.`;
      return routesUpdated(
        record,
        desired ? failed === null : failed !== null,
        problem,
        yield* nowIso,
      );
    });

  const isStale = (record: PodRuntimeRecord, operation: PodRuntimeOperation) =>
    planPodCompletion(record, operation, { type: "failed", message: "" }, "") === null;

  /** Runs after the request's commit; a lost process leaves the transitional state for reconcile. */
  const enqueue = (item: QueuedOperation) =>
    TxRef.update(outstanding, (count) => count + 1).pipe(
      Effect.tx,
      Effect.andThen(
        operationLocks.withLock(item.podId, runQueued(item)).pipe(
          // A defect, or a completion that could not be recorded, still ends the
          // operation as failed so its Retry is offered.
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("pod operation crashed", cause).pipe(
                  Effect.andThen(complete(item, OPERATION_CRASHED)),
                  Effect.catchCause((recordCause) =>
                    Effect.logError("pod operation failure could not be recorded", recordCause),
                  ),
                ),
          ),
          Effect.ensuring(TxRef.update(outstanding, (count) => count - 1).pipe(Effect.tx)),
          Effect.forkIn(workerScope),
        ),
      ),
      Effect.asVoid,
    );

  const request = (
    podId: PodRuntimeId,
    operation: PodRuntimeRequest,
    options: { readonly force?: boolean; readonly allowWhenOff?: boolean } = {},
  ) =>
    stateLocks.withLock(
      podId,
      Effect.gen(function* () {
        const force = options.force === true;
        const record = yield* requireRecord(podId);
        // Turning pods off stops new containers, never the way out: Stop and
        // Remove still work, and so does a teardown's start.
        if (options.allowWhenOff !== true && STARTS_CONTAINERS.has(operation)) {
          const { podRuntime } = yield* settingsFor(record.snapshot.projectId);
          if (!podRuntime.enabled) return yield* new PodRuntimeError({ reason: "disabled", podId });
        }
        const planned = planPodRequest(record, operation, yield* nowIso);
        if (Result.isFailure(planned)) return yield* planned.failure;
        if (planned.success.type === "none") return record.snapshot;
        const { event } = planned.success;
        const next = yield* commit(podId, [event]);
        if (event.type === "pod.operation-requested")
          yield* enqueue({ podId, operation: event.operation, force });
        return next?.snapshot ?? record.snapshot;
      }),
    );

  const create: PodRuntimeService["Service"]["create"] = Effect.fn("PodRuntimeService.create")(
    function* (input) {
      const worktreePath = path.resolve(input.worktreePath);
      const { podRuntime } = yield* settingsFor(input.projectId);
      const root = yield* projectRoot(input.projectId);
      const config = yield* loadPodConfig(worktreePath, ...(root === undefined ? [] : [root]));
      const suffix = (yield* crypto.randomUUIDv4().pipe(Effect.orDie)).replaceAll("-", "");
      const podId = PodRuntimeId.make(`pod-${suffix.slice(0, 12)}`);
      // The lease makes the check and the record one step per worktree, so two
      // launches cannot record two pods, and storage cleanup, which holds it
      // while removing, cannot take the checkout from under a new pod.
      return yield* withWorkspaceLease(
        worktreePath,
        Effect.gen(function* () {
          const existing = yield* store.findByPath(worktreePath);
          if (existing !== undefined) return existing.snapshot;
          if (!podRuntime.enabled) return yield* new PodRuntimeError({ reason: "disabled" });
          if (config === undefined) return yield* new PodRuntimeError({ reason: "not-configured" });
          const created = yield* stateLocks.withLock(
            podId,
            commit(podId, [
              {
                type: "pod.created",
                podId,
                occurredAt: yield* nowIso,
                projectId: input.projectId,
                worktreePath,
                image: podRuntime.defaultImage,
                dockerHost: podRuntime.dockerHost,
                services: Object.entries(config.services).map(([name, port]) => ({ name, port })),
              },
            ]),
          );
          yield* enqueue({ podId, operation: "create", force: false });
          return created!.snapshot;
        }),
      );
    },
  );

  const dockerHosts = Effect.gen(function* () {
    const hosts = new Set<string>();
    const environment = yield* settingsFor(null).pipe(Effect.option);
    if (Option.isSome(environment)) hosts.add(environment.value.podRuntime.dockerHost);
    for (const record of yield* store.list)
      if (record.snapshot.state !== "removed") hosts.add(record.dockerHost);
    return hosts;
  });

  interface PodGroup {
    readonly host: string;
    readonly containers: Array<ContainerDriver.PodContainerInfo>;
    readonly volumes: Array<ContainerDriver.PodVolumeInfo>;
  }

  interface Owned {
    readonly groups: ReadonlyMap<PodRuntimeId, PodGroup>;
    readonly answered: ReadonlySet<string>;
  }

  /**
   * Only what carries this environment's label is ever looked at; other
   * servers' pods and anything unlabelled stay invisible. `answered` names the
   * hosts that listed: a host that could not tells nothing about its pods.
   */
  const listOwned: Effect.Effect<Owned> = Effect.gen(function* () {
    const groups = new Map<PodRuntimeId, PodGroup>();
    const answered = new Set<string>();
    for (const host of yield* dockerHosts) {
      const listed = yield* driver
        .forHost(host)
        .list(POD_LABEL)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("could not list pods on a Docker host", {
              operation: error.operation,
            }).pipe(Effect.as(undefined)),
          ),
        );
      if (listed === undefined) continue;
      answered.add(host);
      const group = (labels: Readonly<Record<string, string>>) => {
        const podId = labels[POD_LABEL];
        if (labels[POD_ENVIRONMENT_LABEL] !== environmentId || !isPodRuntimeId(podId))
          return undefined;
        const existing = groups.get(podId) ?? { host, containers: [], volumes: [] };
        groups.set(podId, existing);
        return existing;
      };
      for (const container of listed.containers)
        group(container.labels)?.containers.push(container);
      for (const volume of listed.volumes) group(volume.labels)?.volumes.push(volume);
    }
    return { groups, answered };
  });

  const observe = (group: PodGroup | undefined): PodObservation => {
    const containers = group?.containers ?? [];
    const byRole = (role: string) =>
      containers.find((container) => container.labels["t3.role"] === role);
    const dind = byRole("dind");
    const agent = byRole("agent");
    const both = dind !== undefined && agent !== undefined;
    return {
      containerIds: containers.map((container) => container.id),
      volumeIds: (group?.volumes ?? []).map((volume) => volume.name),
      running: both && dind.status === "running" && agent.status === "running",
      paused: both && dind.status === "paused" && agent.status === "paused",
      halted: containers.every(
        (container) => container.status !== "running" && container.status !== "paused",
      ),
    };
  };

  const refreshOrphans = (owned: Owned) =>
    Effect.gen(function* () {
      const found: Array<{ readonly host: string; readonly orphan: PodRuntimeOrphan }> = [];
      for (const [podId, group] of owned.groups) {
        const record = yield* store.get(podId);
        if (record !== undefined && record.snapshot.state !== "removed") continue;
        found.push({
          host: group.host,
          orphan: {
            podId,
            containerIds: group.containers.map((container) => container.id),
            volumeIds: group.volumes.map((volume) => volume.name),
            running: group.containers.some((container) => container.status === "running"),
          },
        });
      }
      orphans = [...orphans.filter((entry) => !owned.answered.has(entry.host)), ...found];
    });

  // What this process found on disk. Reconcile settles only these records,
  // and only while untouched: a pod a command changed since is this process's own.
  const startupRecords = (yield* store.list).filter(
    (record) => record.snapshot.state !== "removed",
  );

  /**
   * Startup only: settles each recorded pod against Docker and lists orphans.
   * Orphans are shown, never deleted; only an explicit Remove takes them.
   */
  const reconcile = Effect.gen(function* () {
    const enabled = (yield* settingsFor(null).pipe(Effect.option)).pipe(
      Option.map(({ podRuntime }) => podRuntime.enabled),
      Option.getOrElse(() => false),
    );
    // A server that never used pods does not even ask Docker.
    if (startupRecords.length === 0 && !enabled) return;
    const owned = yield* listOwned;
    for (const record of startupRecords) {
      const podId = record.snapshot.id;
      // Silence from a daemon that is down is not news that the pod is gone.
      if (!owned.answered.has(record.dockerHost)) continue;
      yield* stateLocks.withLock(
        podId,
        Effect.gen(function* () {
          const current = yield* store.get(podId);
          if (current === undefined || current.snapshot !== record.snapshot) return;
          const event = planPodObservation(
            current,
            observe(owned.groups.get(podId)),
            yield* nowIso,
          );
          if (event !== null) yield* commit(podId, [event]).pipe(Effect.ignore);
        }),
      );
    }
    yield* refreshOrphans(owned);
    yield* reconcileRoutes(owned);
  });

  /**
   * Startup only: every running pod in hostname mode gets its route back,
   * every other pod loses its own, and route files named for this environment
   * that no pod here owns are removed. A pod on a Docker host that did not
   * answer keeps whatever it had.
   */
  const reconcileRoutes = (owned: Owned) =>
    Effect.gen(function* () {
      for (const { snapshot } of startupRecords) {
        const podId = snapshot.id;
        // The proxy is asked outside the state lock, so a slow reload never holds up a Stop.
        yield* operationLocks.withLock(
          podId,
          Effect.gen(function* () {
            const current = yield* store.get(podId);
            if (current === undefined || !owned.answered.has(current.dockerHost)) return;
            const event = yield* routeRecord(current, current.snapshot.state === "running");
            if (event !== null)
              yield* stateLocks.withLock(podId, commit(podId, [event]).pipe(Effect.ignore));
          }),
        );
      }
      const { podRuntime } = yield* settingsFor(null);
      yield* router.prune({
        dockerHost: podRuntime.dockerHost,
        proxy: router.resolve(podRuntime.hostnameProxy),
        prefix: podEnvironmentStem(environmentId),
        // Read under the router's lock, so a pod that started meanwhile keeps its
        // route. A live pod's own file is routeRecord's to keep or take away.
        keep: store.list.pipe(
          Effect.map(
            (records) =>
              new Set(
                records
                  .filter((record) => record.snapshot.state !== "removed")
                  .map((record) => podNameStem(record.snapshot.id, environmentId)),
              ),
          ),
        ),
      });
    });

  const removeOrphan = (podId: PodRuntimeId) =>
    Effect.gen(function* () {
      const group = (yield* listOwned).groups.get(podId);
      if (group === undefined) return yield* new PodRuntimeError({ reason: "not-found", podId });
      const host = driver.forHost(group.host);
      const failure = (error: ContainerDriver.ContainerDriverError) =>
        Effect.logWarning("orphan pod removal failed", { podId, operation: error.operation }).pipe(
          Effect.andThen(Effect.fail(new PodRuntimeError({ reason: "unavailable", podId }))),
        );
      for (const container of group.containers)
        yield* host.removeContainer(container.id).pipe(Effect.catch(failure));
      for (const volume of group.volumes)
        yield* host.removeVolume(volume.name).pipe(Effect.catch(failure));
      orphans = orphans.filter((entry) => entry.orphan.podId !== podId);
      return null;
    });

  const remove: PodRuntimeService["Service"]["remove"] = (input) =>
    store
      .get(input.podId)
      .pipe(
        Effect.flatMap((record) =>
          record === undefined || record.snapshot.state === "removed"
            ? operationLocks.withLock(input.podId, removeOrphan(input.podId))
            : request(input.podId, "remove", { force: input.force === true }),
        ),
      );

  const liveSnapshots = store.list.pipe(
    Effect.map((records) =>
      records
        .filter((record) => record.snapshot.state !== "removed")
        .map((record) => record.snapshot),
    ),
  );

  /**
   * One `docker stats` per Docker host, with only the ids that host just
   * listed: an id removed outside T3 would fail the whole call.
   */
  const stats = (owned: Owned) =>
    Effect.gen(function* () {
      const live = (yield* store.list).filter((record) => record.snapshot.state !== "removed");
      const listedIds = (podId: PodRuntimeId) =>
        owned.groups.get(podId)?.containers.map((container) => container.id) ?? [];
      const usage = new Map<string, number>();
      for (const host of owned.answered) {
        const ids = live
          .filter((record) => record.dockerHost === host)
          .flatMap((record) => listedIds(record.snapshot.id));
        const measured = yield* driver
          .forHost(host)
          .memoryUsage(ids)
          .pipe(Effect.orElseSucceed(() => new Map<string, number>()));
        for (const [id, bytes] of measured) usage.set(id, bytes);
      }
      return live.map(({ snapshot }): PodRuntimeStats => {
        const bytes = listedIds(snapshot.id).flatMap((id) => {
          const value = usage.get(id);
          return value === undefined ? [] : [value];
        });
        return {
          podId: snapshot.id,
          memoryBytes: bytes.length === 0 ? null : bytes.reduce((sum, value) => sum + value, 0),
        };
      });
    });

  /**
   * Read on each status request, so it follows t3.json and settings edits.
   * The projects are read only when Tailscale Serve holds :443.
   */
  const podWarnings = Effect.gen(function* () {
    const none: ReadonlyArray<PodRuntimeWarning> = [];
    if (!router.tailscaleServeOnProxyPort) return none;
    const shells = yield* projects.listShells().pipe(Effect.orElseSucceed(() => []));
    const { settings } = yield* settingsFor(null);
    for (const shell of shells) {
      if (!resolveProjectSettings(settings, shell.id).settings.podRuntime.enabled) continue;
      if ((yield* loadPodConfig(shell.workspaceRoot))?.hostnames === true)
        return ["tailscale-serve-443"] satisfies ReadonlyArray<PodRuntimeWarning>;
    }
    return none;
  });

  const status: PodRuntimeService["Service"]["status"] = Effect.fn("PodRuntimeService.status")(
    function* (input) {
      const { podRuntime } = yield* settingsFor(input.projectId ?? null);
      let projectConfigured: boolean | undefined;
      if (input.projectId !== undefined) {
        const root = yield* projectRoot(input.projectId);
        projectConfigured = root !== undefined && (yield* loadPodConfig(root)) !== undefined;
      }
      // Docker is asked only when the Diagnostics screen polls.
      const owned = input.includeStats === true ? yield* listOwned : null;
      if (owned !== null) yield* refreshOrphans(owned);
      // A project's own status, which the composer reads, never warns: it is per environment.
      const warnings = input.projectId === undefined ? yield* podWarnings : [];
      return {
        enabled: podRuntime.enabled,
        pods: yield* liveSnapshots,
        orphans: orphans.map((entry) => entry.orphan),
        ...(projectConfigured === undefined ? {} : { projectConfigured }),
        ...(owned === null ? {} : { stats: yield* stats(owned) }),
        ...(warnings.length === 0 ? {} : { warnings }),
      };
    },
  );

  const subscribe: PodRuntimeService["Service"]["subscribe"] = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* store.subscribe;
      const { podRuntime } = yield* settingsFor(null);
      const snapshot: PodRuntimeStreamEvent = {
        type: "snapshot",
        enabled: podRuntime.enabled,
        pods: yield* liveSnapshots,
      };
      return Stream.concat(
        Stream.make(snapshot),
        Stream.fromSubscription(subscription).pipe(
          Stream.map((record): PodRuntimeStreamEvent => ({ type: "upsert", pod: record.snapshot })),
        ),
      );
    }),
  );

  const awaitSettled: PodRuntimeService["Service"]["awaitSettled"] = (podId) =>
    Effect.scoped(
      Effect.gen(function* () {
        const subscription = yield* store.subscribe;
        // A removed pod is settled too: teardown waits for exactly that.
        const current = yield* store.get(podId);
        if (current === undefined)
          return yield* new PodRuntimeError({ reason: "not-found", podId });
        if (!isPodTransitional(current.snapshot.state)) return current.snapshot;
        const settled = yield* Stream.fromSubscription(subscription).pipe(
          Stream.filter(
            (record) => record.snapshot.id === podId && !isPodTransitional(record.snapshot.state),
          ),
          Stream.runHead,
        );
        return Option.getOrElse(settled, () => current).snapshot;
      }),
    );

  const ensureRunning: PodRuntimeService["Service"]["ensureRunning"] = (podId, options) =>
    Effect.gen(function* () {
      const current = yield* requireRecord(podId);
      if (current.snapshot.state !== "running" && !isPodTransitional(current.snapshot.state))
        yield* request(podId, "start", { allowWhenOff: options?.forTeardown === true });
      const settled = yield* awaitSettled(podId);
      if (settled.state !== "running")
        return yield* new PodRuntimeError({
          reason: "invalid-state",
          podId,
          state: settled.state,
          ...(settled.lastError === null ? {} : { lastError: settled.lastError }),
        });
      return settled;
    });

  const openShell: PodRuntimeService["Service"]["openShell"] = (input) =>
    Effect.gen(function* () {
      const record = yield* requireRecord(input.podId);
      if (record.snapshot.state !== "running")
        return yield* new PodRuntimeError({
          reason: "invalid-state",
          podId: input.podId,
          state: record.snapshot.state,
        });
      // The terminal manager runs any terminal on a pod's worktree inside the pod.
      yield* terminals
        .open({
          threadId: input.threadId,
          terminalId: POD_SHELL_TERMINAL_ID,
          cwd: record.snapshot.worktreePath,
          worktreePath: record.snapshot.worktreePath,
        })
        .pipe(Effect.catch(unavailable(input.podId)));
      return { threadId: input.threadId, terminalId: POD_SHELL_TERMINAL_ID };
    });

  // What the last run recorded as running; reconcile corrects it through `commit`.
  yield* Effect.forEach(startupRecords, publishToDiscovery, { discard: true });

  yield* TxRef.update(outstanding, (count) => count + 1).pipe(Effect.tx);
  yield* reconcile.pipe(
    Effect.catchCause((cause) => Effect.logWarning("pod reconcile failed", cause)),
    Effect.ensuring(TxRef.update(outstanding, (count) => count - 1).pipe(Effect.tx)),
    Effect.forkIn(workerScope),
  );

  return PodRuntimeService.of({
    create,
    start: (podId) => request(podId, "start"),
    stop: (podId) => request(podId, "stop"),
    recreate: (podId) => request(podId, "recreate"),
    recreateAgentContainer: (podId) => request(podId, "recreateAgentContainer"),
    remove,
    status,
    subscribe,
    openShell,
    forPath: (target, options) =>
      store.findByPath(target, options).pipe(Effect.map((record) => record?.snapshot)),
    awaitSettled,
    ensureRunning,
    releaseWorktree: (worktreePath) =>
      Effect.gen(function* () {
        const target = path.resolve(worktreePath);
        for (const record of yield* store.list) {
          if (path.resolve(record.snapshot.worktreePath) !== target) continue;
          const podId = record.snapshot.id;
          yield* stateLocks.withLock(
            podId,
            Effect.gen(function* () {
              const current = yield* store.get(podId);
              if (current?.snapshot.state !== "removed" || current.worktreeReleased === true)
                return;
              yield* commit(podId, [
                { type: "pod.worktree-released", podId, occurredAt: yield* nowIso },
              ]);
            }),
          );
        }
      }),
    drain: TxRef.get(outstanding).pipe(
      Effect.flatMap((count) => (count > 0 ? Effect.txRetry : Effect.void)),
      Effect.tx,
    ),
  });
});

export const layer = Layer.effect(PodRuntimeService, make);
