// @effect-diagnostics nodeBuiltinImport:off - the main server and the pod listener are real Node servers.
import * as NodeHttp from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PodRuntimeId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerHttp from "../http.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ContainerDriver from "../pod/ContainerDriver.ts";
import * as PodRuntimeStore from "../pod/PodRuntimeStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { makeFakeContainerDriver } from "../pod/testkit/FakeContainerDriver.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { OrchestrationV2ServerCommand } from "@t3tools/contracts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";
import * as PodMcpListener from "./PodMcpListener.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const podId = PodRuntimeId.make("pod-pinning1");
const threadId = ThreadId.make("thread-pod-session");
const environmentId = EnvironmentId.make("env-pinning");

/** The main server, whose only door for the test is the pod listener. */
const mainServer = NodeHttp.createServer();
// Loopback stands in for the pod network.
const docker = makeFakeContainerDriver();
docker.setNetwork({ subnet: "127.0.0.0/8", gateway: "127.0.0.1" });

const layerRoutes = Layer.mergeAll(
  McpHttpServer.layerPreviewToolkit,
  McpHttpServer.layerAttachmentToolkit,
  McpHttpServer.layerThreadToolkit,
  ServerHttp.layerAttachmentUploadRoute,
).pipe(Layer.provideMerge(McpHttpServer.layerMcpTransport));

/** What the thread toolkit's writes asked the orchestrator to do. */
const dispatched: Array<OrchestrationV2ServerCommand> = [];
const layerThreads = Layer.mock(ThreadManagementService.ThreadManagementService)({
  getThreadShell: (id) => Effect.succeed(McpToolAccessTestkit.liveThreadShell(id)),
  getProjectThreadRecords: ({ threadId: id }) =>
    Effect.succeed(
      McpToolAccessTestkit.idleThreadProjection(McpToolAccessTestkit.liveThreadShell(id)),
    ),
  dispatch: (command) =>
    Effect.sync(() => {
      dispatched.push(command);
      return { sequence: dispatched.length, storedEvents: [] };
    }),
});

const layerServerEnvironment = Layer.mock(ServerEnvironment.ServerEnvironment)({
  getEnvironmentId: Effect.succeed(environmentId),
});

const layer = Layer.mergeAll(
  HttpRouter.serve(layerRoutes, { disableListenLog: true, disableLogger: true }),
  PodMcpListener.layerWithPort(0).pipe(
    Layer.provideMerge(PodRuntimeStore.layer),
    Layer.provide(Layer.succeed(ContainerDriver.ContainerDriver, docker.driver)),
    Layer.provide(
      Layer.succeed(PodMcpListener.McpRequestDispatch, {
        dispatch: (request, response) => mainServer.emit("request", request, response),
      }),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(environmentId),
      }),
    ),
  ),
).pipe(
  Layer.provideMerge(McpSessionRegistry.layer),
  Layer.provide(layerServerEnvironment),
  Layer.provide(layerThreads),
  Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
  Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
  Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
  Layer.provide(PreviewAutomationBroker.layer),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-pod-session-test-" })),
  Layer.provide(NodeHttpServer.layer(() => mainServer, { port: 0, host: "127.0.0.1" })),
  Layer.provideMerge(NodeServices.layer),
);

const send = (
  endpoint: string,
  input: {
    readonly method: string;
    readonly path: string;
    readonly headers: Record<string, string>;
    readonly body?: string | Uint8Array;
  },
) =>
  Effect.callback<
    {
      readonly status: number;
      readonly headers: NodeHttp.IncomingHttpHeaders;
      readonly body: string;
    },
    Error
  >((resume) => {
    const outgoing = NodeHttp.request(
      {
        host: "127.0.0.1",
        port: Number(new URL(endpoint).port),
        method: input.method,
        path: input.path,
        headers: input.headers,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () =>
          resume(
            Effect.succeed({ status: response.statusCode ?? 0, headers: response.headers, body }),
          ),
        );
      },
    );
    outgoing.once("error", (error) => resume(Effect.fail(error)));
    outgoing.end(input.body);
  });

/** Streamable HTTP answers a request either as JSON or as one SSE event. */
const jsonRpcResult = (body: string) => {
  const data = body
    .split("\n")
    .find((line) => line.startsWith("data:"))
    ?.slice("data:".length);
  return JSON.parse(data ?? body) as {
    readonly result?: { readonly isError?: boolean; readonly structuredContent?: unknown };
    readonly error?: unknown;
  };
};

const mcpClient = (endpoint: string, authorization: string) => {
  let sessionId: string | undefined;
  let nextId = 1;
  const post = (method: string, params: unknown) =>
    send(endpoint, {
      method: "POST",
      path: "/mcp",
      headers: {
        authorization,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    });
  return {
    initialize: post("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "pod-agent", version: "1.0.0" },
    }).pipe(
      Effect.tap((response) =>
        Effect.sync(() => {
          sessionId = response.headers["mcp-session-id"] as string | undefined;
        }),
      ),
    ),
    callTool: (name: string, args: unknown) => post("tools/call", { name, arguments: args }),
  };
};

it.effect(
  "a pod session calls a read tool, a mutating tool and an upload through the pod listener, until it is released",
  () =>
    Effect.gen(function* () {
      const store = yield* PodRuntimeStore.PodRuntimeStore;
      yield* store.commit(podId, [
        {
          type: "pod.created",
          podId,
          occurredAt: "2026-10-21T00:00:00.000Z",
          projectId: ProjectId.make("project-1"),
          worktreePath: "/work/trees/pinning",
          image: "image",
          dockerHost: "",
          services: [],
        },
      ]);
      const listener = yield* PodMcpListener.PodMcpListener;
      const endpoint = yield* listener.endpointFor({
        type: "pod",
        podId,
        state: "running",
        worktreePath: "/work/trees/pinning",
        dockerHost: "",
      });
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const { config } = yield* registry.issue({
        threadId,
        // The live thread fixture runs on the Codex instance.
        providerInstanceId: ProviderInstanceId.make("codex"),
        endpoint,
      });
      // The credential names the pod listener; its scopes are the usual ones.
      expect(config.endpoint).toBe(endpoint);
      expect([...(config.capabilities ?? [])].sort()).toEqual(
        ["orchestration", "preview", "pull-requests", "worktree"].sort(),
      );

      const client = mcpClient(endpoint, config.authorizationHeader);
      expect((yield* client.initialize).status).toBe(200);

      const read = jsonRpcResult((yield* client.callTool("preview_status", {})).body);
      expect(read.error).toBeUndefined();
      expect(read.result).toBeDefined();

      const pinned = jsonRpcResult(
        (yield* client.callTool("t3_thread_organize", { action: "pin" })).body,
      );
      expect(pinned.result?.isError, JSON.stringify(pinned)).not.toBe(true);
      expect(dispatched).toMatchObject([{ type: "thread.pin", threadId }]);

      const bytes = new TextEncoder().encode("hello from the pod");
      const prepared = jsonRpcResult(
        (yield* client.callTool("t3_attachment_prepare_upload", {
          upload: {
            type: "file",
            name: "note.txt",
            mimeType: "text/plain",
            sizeBytes: bytes.byteLength,
          },
        })).body,
      );
      expect(prepared.result?.isError, JSON.stringify(prepared)).not.toBe(true);
      const structured = prepared.result?.structuredContent as { relativeUrl: string } | undefined;
      expect(structured, JSON.stringify(prepared)).toBeDefined();
      const relativeUrl = structured?.relativeUrl ?? "";

      const upload = yield* send(endpoint, {
        method: "POST",
        path: relativeUrl,
        headers: { "content-type": "text/plain", "content-length": String(bytes.byteLength) },
        body: bytes,
      });
      expect(upload.status).toBe(204);

      yield* registry.revokeProviderSession(config.providerSessionId);
      const afterRelease = yield* client.callTool("preview_status", {});
      expect(afterRelease.status).toBe(401);
    }).pipe(Effect.provide(layer)),
);
