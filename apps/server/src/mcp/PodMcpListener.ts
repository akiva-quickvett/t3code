// @effect-diagnostics nodeBuiltinImport:off - Effect's HTTP server cannot start and stop per pod network or hand a request to another server.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import type { PodRuntimeId, ProjectId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { ATTACHMENT_UPLOAD_ROUTE_PREFIX } from "../assets/AttachmentUpload.ts";
import * as ContainerDriver from "../pod/ContainerDriver.ts";
import {
  POD_HOST_ALIAS,
  POD_LABEL,
  POD_NETWORK_LABEL,
  POD_ROLE_LABEL,
} from "../pod/PodContainerPlan.ts";
import { POD_MCP_LOOPBACK_ADDRESS, podMcpTransportFor } from "../pod/PodMcpTransport.ts";
import * as PodRuntimeStore from "../pod/PodRuntimeStore.ts";
import type { PodExecutionTarget } from "../pod/WorkspaceExecutionTarget.ts";
import * as ServerSettings from "../serverSettings.ts";
import { looksLikeProviderSessionToken } from "./McpSessionRegistry.ts";

/** Hands a request to the main HTTP server, so the pod listener serves exactly its routes. */
export class McpRequestDispatch extends Context.Service<
  McpRequestDispatch,
  {
    readonly dispatch: (
      request: NodeHttp.IncomingMessage,
      response: NodeHttp.ServerResponse,
    ) => void;
  }
>()("t3/mcp/PodMcpListener/McpRequestDispatch") {}

export class PodMcpListenerError extends Schema.TaggedError<PodMcpListenerError>()(
  "PodMcpListenerError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `T3's MCP server is not reachable from this pod: ${this.detail}`;
  }
}

export interface PodMcpListenerAddress {
  readonly network: string;
  readonly address: string;
  readonly port: number;
}

/** Where agents in pods reach T3, started while any pod uses the network it listens on. */
export class PodMcpListener extends Context.Service<
  PodMcpListener,
  {
    /** The MCP URL a session in the pod is given; starts the pod network's listener if needed. */
    readonly endpointFor: (
      target: PodExecutionTarget,
    ) => Effect.Effect<string, PodMcpListenerError>;
    /** The listeners open now, then after each start or stop. */
    readonly listening: Stream.Stream<ReadonlyArray<PodMcpListenerAddress>>;
  }
>()("t3/mcp/PodMcpListener") {}

const UPLOAD_PATH = new RegExp(
  `^${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$`,
);

/**
 * The only routes an agent calls: the MCP endpoint and the signed upload URL
 * `t3_attachment_prepare_upload` hands out. Raw paths are matched exactly, so
 * no encoding or dot segment reaches another route.
 */
export const isPodMcpRoute = (method: string | undefined, url: string | undefined): boolean => {
  if (url === undefined) return false;
  const query = url.indexOf("?");
  const pathname = query === -1 ? url : url.slice(0, query);
  if (pathname === "/mcp") return method === "POST" || method === "GET" || method === "DELETE";
  return method === "POST" && UPLOAD_PATH.test(pathname);
};

/** A paired device's OAuth token, which the pod listener never takes. */
const presentsClientToken = (authorization: string | undefined) => {
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  return token.length > 0 && !looksLikeProviderSessionToken(token);
};

export const makePodSubnetCheck = (subnet: string) => {
  const [network, prefix] = subnet.split("/");
  const allowed = new NodeNet.BlockList();
  allowed.addSubnet(network ?? "", Number(prefix ?? 32), "ipv4");
  // The listener binds an IPv4 address, so peers arrive as plain IPv4.
  return (remoteAddress: string | undefined) =>
    remoteAddress !== undefined &&
    NodeNet.isIPv4(remoteAddress) &&
    allowed.check(remoteAddress, "ipv4");
};

const reply = (response: NodeHttp.ServerResponse, status: number, text: string) => {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(text);
};

/**
 * A loopback listener is reachable from every process on this machine,
 * browsers included, so it takes only requests that name the pods' alias:
 * a page that rebinds its own name to 127.0.0.1 still sends that name.
 */
export const namesPodHostAlias = (host: string | undefined) =>
  host !== undefined &&
  URL.canParse(`http://${host}`) &&
  new URL(`http://${host}`).hostname === POD_HOST_ALIAS;

export const makePodRequestHandler =
  (input: {
    readonly fromPodNetwork: (remoteAddress: string | undefined) => boolean;
    readonly admitsHost?: (host: string | undefined) => boolean;
    readonly dispatch: McpRequestDispatch["Service"]["dispatch"];
  }) =>
  (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
    if (!input.fromPodNetwork(request.socket.remoteAddress))
      return reply(response, 403, "Forbidden");
    if (input.admitsHost !== undefined && !input.admitsHost(request.headers.host))
      return reply(response, 403, "Forbidden");
    if (!isPodMcpRoute(request.method, request.url)) return reply(response, 404, "Not Found");
    if (presentsClientToken(request.headers.authorization))
      return reply(response, 401, "Unauthorized");
    input.dispatch(request, response);
  };

interface Listener {
  readonly server: NodeHttp.Server;
  readonly port: number;
}

interface OpenListener extends Listener {
  readonly network: string;
  readonly address: string;
}

const listenerKey = (dockerHost: string, network: string) => `${dockerHost}\u0000${network}`;
const LOOPBACK_KEY = "loopback";

const isLoopback = (address: string) =>
  address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";

/**
 * The same port on every pod network, so one host firewall rule admits pods
 * across restarts; a default-deny INPUT policy drops them otherwise. Below
 * Linux\'s ephemeral range, so no outbound socket takes it first.
 */
export const DEFAULT_POD_MCP_PORT = 17773;

const listenOn = (gateway: string, port: number, handler: NodeHttp.RequestListener) =>
  Effect.callback<Listener, NodeJS.ErrnoException>((resume) => {
    const server = NodeHttp.createServer(handler);
    server.once("error", (error) => resume(Effect.fail(error)));
    server.listen(port, gateway, () => {
      const address = server.address();
      resume(
        Effect.succeed({
          server,
          port: typeof address === "object" && address !== null ? address.port : 0,
        }),
      );
    });
  });

const close = (listener: Listener) =>
  Effect.callback<void>((resume) => {
    // Streaming MCP responses would otherwise hold the port open.
    listener.server.closeAllConnections();
    listener.server.close(() => resume(Effect.void));
  });

/** The stable port, or any free one while something else holds it. */
const listen = (gateway: string, port: number, handler: NodeHttp.RequestListener) =>
  listenOn(gateway, port, handler).pipe(
    Effect.catchIf(
      (error) => error.code === "EADDRINUSE" && port !== 0,
      () =>
        Effect.logWarning(
          "the pod MCP port is taken; listening on another, which a host firewall rule for the usual port does not cover",
          { address: gateway, port },
        ).pipe(Effect.andThen(listenOn(gateway, 0, handler))),
    ),
  );

const make = (port: number) =>
  Effect.gen(function* () {
    const store = yield* PodRuntimeStore.PodRuntimeStore;
    const driver = yield* ContainerDriver.ContainerDriver;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const { dispatch } = yield* McpRequestDispatch;
    const listeners = new Map<string, OpenListener>();
    const lock = yield* Semaphore.make(1);
    const listening = yield* SubscriptionRef.make<ReadonlyArray<PodMcpListenerAddress>>([]);
    const publish = Effect.suspend(() =>
      SubscriptionRef.set(
        listening,
        [...listeners.values()].map(({ network, address, port }) => ({ network, address, port })),
      ),
    );

    const createdOn = new Map<PodRuntimeId, string>();

    /**
     * The network the pod's daemon joined when it was made, which is where its
     * host alias points. Pods made before the label existed follow settings.
     */
    const networkOf = (
      podId: PodRuntimeId,
      dockerHost: string,
      projectId: ProjectId,
      remember: boolean,
    ) =>
      Effect.gen(function* () {
        const known = createdOn.get(podId);
        if (known !== undefined) return known;
        const labelled = yield* driver
          .forHost(dockerHost)
          .list(POD_LABEL)
          .pipe(
            Effect.map(
              ({ containers }) =>
                containers.find(
                  (container) =>
                    container.labels[POD_LABEL] === podId &&
                    container.labels[POD_ROLE_LABEL] === "dind",
                )?.labels[POD_NETWORK_LABEL],
            ),
            Effect.orElseSucceed(() => undefined),
          );
        if (labelled !== undefined) {
          if (remember) createdOn.set(podId, labelled);
          return labelled;
        }
        const settings = yield* serverSettings.getSettings;
        return resolveProjectSettings(settings, projectId).settings.podRuntime.network;
      });

    const keyOf = (podId: PodRuntimeId) =>
      Effect.gen(function* () {
        const record = yield* store.get(podId);
        if (record === undefined || record.snapshot.state === "removed") {
          createdOn.delete(podId);
          return undefined;
        }
        const transport = yield* podMcpTransportFor(driver.forHost(record.dockerHost));
        // One loopback listener serves every pod of engines in a VM.
        if (transport === "loopback")
          return { key: LOOPBACK_KEY, dockerHost: record.dockerHost, network: "", transport };
        // Only a running pod's daemon is the one its agents use.
        const network = yield* networkOf(
          podId,
          record.dockerHost,
          record.snapshot.projectId,
          record.snapshot.state === "running",
        );
        return {
          key: listenerKey(record.dockerHost, network),
          dockerHost: record.dockerHost,
          network,
          transport,
        };
      });

    const ensure = (podId: PodRuntimeId) =>
      lock.withPermit(
        Effect.gen(function* () {
          const owner = yield* keyOf(podId).pipe(
            Effect.mapError(
              (cause) =>
                new PodMcpListenerError({ detail: "Pod settings could not be read.", cause }),
            ),
          );
          if (owner === undefined)
            return yield* new PodMcpListenerError({ detail: "The pod no longer exists." });
          const existing = listeners.get(owner.key);
          if (existing !== undefined) return existing;
          if (owner.transport === "loopback") {
            const listener = yield* listen(
              POD_MCP_LOOPBACK_ADDRESS,
              port,
              makePodRequestHandler({
                // Every peer is loopback; the bearer token tells sessions apart.
                fromPodNetwork: (remoteAddress) =>
                  remoteAddress !== undefined && isLoopback(remoteAddress),
                admitsHost: namesPodHostAlias,
                dispatch,
              }),
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new PodMcpListenerError({
                    detail: `Could not listen on ${POD_MCP_LOOPBACK_ADDRESS}: ${cause.message}`,
                    cause,
                  }),
              ),
            );
            listeners.set(owner.key, {
              ...listener,
              network: owner.network,
              address: POD_MCP_LOOPBACK_ADDRESS,
            });
            yield* publish;
            yield* Effect.logInfo("pod MCP listener started on loopback for an engine in a VM", {
              port: listener.port,
            });
            return listener;
          }
          const network = yield* driver
            .forHost(owner.dockerHost)
            .inspectNetwork(owner.network)
            .pipe(
              Effect.mapError((cause) => new PodMcpListenerError({ detail: cause.message, cause })),
            );
          // Only the pod network's gateway: the address is local to this host,
          // and nothing outside the network routes to it.
          const listener = yield* listen(
            network.gateway,
            port,
            makePodRequestHandler({ fromPodNetwork: makePodSubnetCheck(network.subnet), dispatch }),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new PodMcpListenerError({
                  detail: `Could not listen on ${network.gateway}: ${cause.message}`,
                  cause,
                }),
            ),
          );
          listeners.set(owner.key, {
            ...listener,
            network: owner.network,
            address: network.gateway,
          });
          yield* publish;
          yield* Effect.logInfo("pod MCP listener started", {
            network: owner.network,
            address: network.gateway,
            port: listener.port,
          });
          return listener;
        }),
      );

    /** Stops each listener whose network no pod uses any more. */
    const stopUnused = lock.withPermit(
      Effect.gen(function* () {
        if (listeners.size === 0) return;
        const used = new Set<string>();
        for (const record of yield* store.list) {
          if (record.snapshot.state === "removed") continue;
          const owner = yield* keyOf(record.snapshot.id);
          if (owner !== undefined) used.add(owner.key);
        }
        for (const [key, listener] of listeners) {
          if (used.has(key)) continue;
          listeners.delete(key);
          yield* close(listener);
          yield* publish;
          yield* Effect.logInfo("pod MCP listener stopped", { port: listener.port });
        }
      }),
    );

    // A running pod's network exists, so its listener starts then rather than
    // at its first session; the last removal stops it. A recreated pod may
    // run on another network, leaving its old one unused.
    const subscription = yield* store.subscribe;
    yield* Stream.fromSubscription(subscription).pipe(
      Stream.runForEach((record) =>
        (record.snapshot.state === "running"
          ? ensure(record.snapshot.id).pipe(
              Effect.catch((error) =>
                Effect.logWarning("pod MCP listener could not start", { detail: error.detail }),
              ),
              Effect.andThen(stopUnused),
            )
          : // A recreate makes a new daemon, on the network settings name then.
            Effect.sync(() => createdOn.delete(record.snapshot.id)).pipe(Effect.andThen(stopUnused))
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("pod MCP listener reconcile failed", cause),
          ),
        ),
      ),
      Effect.forkScoped,
    );
    yield* Effect.addFinalizer(() =>
      lock.withPermit(Effect.forEach([...listeners.values()], close, { discard: true })),
    );

    return PodMcpListener.of({
      endpointFor: (target) =>
        ensure(target.podId).pipe(
          Effect.map((listener) => `http://${POD_HOST_ALIAS}:${listener.port}/mcp`),
        ),
      listening: SubscriptionRef.changes(listening),
    });
  });

export const layer = Layer.effect(PodMcpListener, make(DEFAULT_POD_MCP_PORT));

/** On another port; tests pass 0 so parallel runs never meet. */
export const layerWithPort = (port: number) => Layer.effect(PodMcpListener, make(port));
