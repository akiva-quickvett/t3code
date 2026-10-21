// @effect-diagnostics nodeBuiltinImport:off - Effect's HTTP server cannot start and stop per pod network or hand a request to another server.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import type { PodRuntimeId } from "@t3tools/contracts";
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
import { POD_HOST_ALIAS } from "../pod/PodContainerPlan.ts";
import * as PodRuntimeStore from "../pod/PodRuntimeStore.ts";
import type { PodExecutionTarget } from "../pod/WorkspaceExecutionTarget.ts";
import * as ServerSettings from "../serverSettings.ts";

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

/** Whether an MCP URL is a pod listener's rather than the server's own. */
export const isPodMcpEndpoint = (endpoint: string) =>
  URL.canParse(endpoint) && new URL(endpoint).hostname === POD_HOST_ALIAS;

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

/**
 * Provider-session tokens are bare base64url; a dotted bearer is an OAuth
 * client's, which belongs to a paired device and is not taken from a pod.
 */
const presentsClientToken = (authorization: string | undefined) =>
  authorization !== undefined && authorization.slice("Bearer ".length).includes(".");

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

export const makePodRequestHandler =
  (input: {
    readonly fromPodNetwork: (remoteAddress: string | undefined) => boolean;
    readonly dispatch: McpRequestDispatch["Service"]["dispatch"];
  }) =>
  (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
    if (!input.fromPodNetwork(request.socket.remoteAddress))
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

const listen = (gateway: string, handler: NodeHttp.RequestListener) =>
  Effect.callback<Listener, Error>((resume) => {
    const server = NodeHttp.createServer(handler);
    server.once("error", (error) => resume(Effect.fail(error)));
    server.listen(0, gateway, () => {
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

const make = Effect.gen(function* () {
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

  const keyOf = (podId: PodRuntimeId) =>
    Effect.gen(function* () {
      const record = yield* store.get(podId);
      if (record === undefined || record.snapshot.state === "removed") return undefined;
      const settings = yield* serverSettings.getSettings;
      const { network } = resolveProjectSettings(settings, record.snapshot.projectId).settings
        .podRuntime;
      return {
        key: listenerKey(record.dockerHost, network),
        dockerHost: record.dockerHost,
        network,
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
  // at its first session; the last removal stops it.
  const subscription = yield* store.subscribe;
  yield* Stream.fromSubscription(subscription).pipe(
    Stream.runForEach((record) =>
      (record.snapshot.state === "running"
        ? ensure(record.snapshot.id).pipe(
            Effect.catch((error) =>
              Effect.logWarning("pod MCP listener could not start", { detail: error.detail }),
            ),
            Effect.asVoid,
          )
        : stopUnused
      ).pipe(
        Effect.catchCause((cause) => Effect.logWarning("pod MCP listener reconcile failed", cause)),
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

export const layer = Layer.effect(PodMcpListener, make);
