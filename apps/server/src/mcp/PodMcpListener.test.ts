// @effect-diagnostics nodeBuiltinImport:off - raw paths must reach the listener unnormalized.
import * as NodeHttp from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, PodRuntimeId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ContainerDriver from "../pod/ContainerDriver.ts";
import * as PodRuntimeStore from "../pod/PodRuntimeStore.ts";
import { makeFakeContainerDriver } from "../pod/testkit/FakeContainerDriver.ts";
import type { PodExecutionTarget } from "../pod/WorkspaceExecutionTarget.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  isPodMcpEndpoint,
  isPodMcpRoute,
  makePodSubnetCheck,
  McpRequestDispatch,
  PodMcpListener,
  layer as podMcpListenerLayer,
} from "./PodMcpListener.ts";

const podId = PodRuntimeId.make("pod-listener1");
const target: PodExecutionTarget = {
  type: "pod",
  podId,
  state: "running",
  worktreePath: "/work/trees/listener",
  dockerHost: "",
};

const makeLayer = (network: { readonly subnet: string; readonly gateway: string }) => {
  const docker = makeFakeContainerDriver();
  docker.setNetwork(network);
  return podMcpListenerLayer.pipe(
    Layer.provideMerge(PodRuntimeStore.layer),
    Layer.provide(Layer.succeed(ContainerDriver.ContainerDriver, docker.driver)),
    // The main server's routes: everything the listener admits answers here.
    Layer.provide(
      Layer.succeed(McpRequestDispatch, {
        dispatch: (request, response) => {
          response.writeHead(200, { "content-type": "text/plain" });
          response.end(`main ${request.method} ${request.url}`);
        },
      }),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("env-test")),
      }),
    ),
    Layer.provide(NodeServices.layer),
  );
};

const observe = (state: "running" | "removed") =>
  Effect.gen(function* () {
    const store = yield* PodRuntimeStore.PodRuntimeStore;
    yield* store.commit(podId, [
      {
        type: "pod.observed",
        podId,
        occurredAt: "2026-10-21T00:00:01.000Z",
        state,
        failedOperation: null,
        message: null,
        containerIds: [],
        volumeIds: [],
      },
    ]);
  });

const recordPod = Effect.gen(function* () {
  const store = yield* PodRuntimeStore.PodRuntimeStore;
  yield* store.commit(podId, [
    {
      type: "pod.created",
      podId,
      occurredAt: "2026-10-21T00:00:00.000Z",
      projectId: ProjectId.make("project-1"),
      worktreePath: target.worktreePath,
      image: "image",
      dockerHost: "",
      services: [],
    },
  ]);
});

const request = (
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
) =>
  Effect.callback<{ readonly status: number; readonly body: string }, Error>((resume) => {
    const outgoing = NodeHttp.request(
      { host: "127.0.0.1", port, method, path, headers },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () =>
          resume(Effect.succeed({ status: response.statusCode ?? 0, body })),
        );
      },
    );
    outgoing.once("error", (error) => resume(Effect.fail(error)));
    outgoing.end();
  });

const portOf = (endpoint: string) => Number(new URL(endpoint).port);

describe("pod MCP route gate", () => {
  it("admits only the MCP endpoint and signed attachment uploads", () => {
    expect(isPodMcpRoute("POST", "/mcp")).toBe(true);
    expect(isPodMcpRoute("GET", "/mcp")).toBe(true);
    expect(isPodMcpRoute("DELETE", "/mcp?session=1")).toBe(true);
    expect(isPodMcpRoute("POST", "/api/attachments/upload/eyJ2IjoxfQ.c2ln")).toBe(true);
    for (const [method, url] of [
      ["PUT", "/mcp"],
      ["GET", "/api/attachments/upload/eyJ2IjoxfQ.c2ln"],
      ["POST", "/api/attachments/upload/.."],
      ["POST", "/api/attachments/upload/a.b/../../auth/session"],
      ["POST", "/api/attachments/upload/a%2Eb"],
      ["POST", "/mcp/../api/auth/session"],
      ["POST", "/MCP"],
      ["POST", "http://host.docker.internal/mcp"],
    ] as const) {
      expect(isPodMcpRoute(method, url), `${method} ${url}`).toBe(false);
    }
  });

  it("recognizes a pod listener's endpoint", () => {
    expect(isPodMcpEndpoint("http://host.docker.internal:40123/mcp")).toBe(true);
    expect(isPodMcpEndpoint("http://127.0.0.1:3773/mcp")).toBe(false);
    expect(isPodMcpEndpoint("not a url")).toBe(false);
  });

  it("admits only addresses on the pod network", () => {
    const fromPodNetwork = makePodSubnetCheck("172.18.0.0/16");
    expect(fromPodNetwork("172.18.0.2")).toBe(true);
    expect(fromPodNetwork("172.17.0.2")).toBe(false);
    expect(fromPodNetwork("127.0.0.1")).toBe(false);
    expect(fromPodNetwork("::1")).toBe(false);
    expect(fromPodNetwork(undefined)).toBe(false);
  });
});

describe("pod MCP listener", () => {
  it.effect("serves the MCP routes and nothing else of the server", () =>
    Effect.gen(function* () {
      yield* recordPod;
      const listener = yield* PodMcpListener;
      const endpoint = yield* listener.endpointFor(target);
      expect(endpoint).toMatch(/^http:\/\/host\.docker\.internal:\d+\/mcp$/);
      const port = portOf(endpoint);

      expect(yield* request(port, "POST", "/mcp")).toEqual({ status: 200, body: "main POST /mcp" });
      expect((yield* request(port, "POST", "/api/attachments/upload/eyJ2IjoxfQ.c2ln")).status).toBe(
        200,
      );
      // Pairing, the API, webhooks, OAuth, the preview stream, relay and the WebSocket.
      for (const [method, path] of [
        ["POST", "/api/auth/pairing-token"],
        ["GET", "/api/auth/session"],
        ["POST", "/api/auth/pairing-links"],
        ["GET", "/api/projects"],
        ["POST", "/api/hooks/scheduled-task"],
        ["GET", "/api/preview-stream"],
        ["GET", "/api/connect/relay-config"],
        ["GET", "/.well-known/oauth-protected-resource/mcp"],
        ["POST", "/oauth/mcp/token"],
        ["GET", "/ws"],
        ["GET", "/"],
        ["POST", "/mcp/../api/auth/session"],
      ] as const) {
        expect((yield* request(port, method, path)).status, `${method} ${path}`).toBe(404);
      }
    }).pipe(Effect.provide(makeLayer({ subnet: "127.0.0.0/8", gateway: "127.0.0.1" }))),
  );

  it.effect("refuses an OAuth client's token, which belongs to a paired device", () =>
    Effect.gen(function* () {
      yield* recordPod;
      const port = portOf(yield* (yield* PodMcpListener).endpointFor(target));
      expect(
        (yield* request(port, "POST", "/mcp", { authorization: "Bearer payload.signature" }))
          .status,
      ).toBe(401);
      expect(
        (yield* request(port, "POST", "/mcp", { authorization: "Bearer providerToken_-" })).status,
      ).toBe(200);
    }).pipe(Effect.provide(makeLayer({ subnet: "127.0.0.0/8", gateway: "127.0.0.1" }))),
  );

  it.effect("turns away peers outside the pod network", () =>
    Effect.gen(function* () {
      yield* recordPod;
      const port = portOf(yield* (yield* PodMcpListener).endpointFor(target));
      expect((yield* request(port, "POST", "/mcp")).status).toBe(403);
    }).pipe(Effect.provide(makeLayer({ subnet: "10.99.0.0/16", gateway: "127.0.0.1" }))),
  );

  it.effect("starts with a running pod and stops when the last pod is removed", () =>
    Effect.gen(function* () {
      const listener = yield* PodMcpListener;
      const listening = (count: number) =>
        listener.listening.pipe(
          Stream.filter((open) => open.length === count),
          Stream.runHead,
        );
      yield* recordPod;
      yield* observe("running");
      const open = Option.getOrThrow(yield* listening(1))[0];
      expect(open).toMatchObject({ network: "t3-pods", address: "127.0.0.1" });

      yield* observe("removed");
      yield* listening(0);
      const refused = yield* request(open!.port, "POST", "/mcp").pipe(Effect.flip);
      expect(refused.message).toMatch(/ECONNREFUSED/);
      const error = yield* listener.endpointFor(target).pipe(Effect.flip);
      expect(error.message).toContain("no longer exists");
    }).pipe(Effect.provide(makeLayer({ subnet: "127.0.0.0/8", gateway: "127.0.0.1" }))),
  );
});
