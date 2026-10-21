// @effect-diagnostics nodeBuiltinImport:off - a real local HTTP server stands in for Graph.
/**
 * A fake WhatsApp Cloud (Graph) API on 127.0.0.1, after orch's
 * tests/fake_whatsapp.py. Nothing here reaches Meta.
 *
 * It refuses what Graph or the edge in front of it would refuse, and lists
 * each refusal in `violations`, so drift in a payload fails a test instead of
 * passing a lenient fake: a missing or default User-Agent, a path with two
 * version segments, a wrong token, and payloads outside the documented limits.
 */
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpClient } from "effect/http";

import { WhatsAppGraphApi } from "../WhatsAppCloudAdapter.ts";

export const FAKE_VERSION = "v99.0";
export const FAKE_TOKEN = "fake-access-token";
export const FAKE_PHONE_NUMBER_ID = "100000000000001";
export const FAKE_BUSINESS_ACCOUNT_ID = "200000000000002";

const PHONE = /^\+?[1-9]\d{6,14}$/;
const TEMPLATE_PARAM_BAD = /[\n\t]| {4,}/;
const DEFAULT_AGENTS = /^(node|undici|python-urllib|node-fetch)/i;

export interface FakeRequest {
  readonly method: string;
  readonly path: string;
  readonly userAgent: string | undefined;
  readonly authorization: string | undefined;
  readonly body: string;
}

export interface FakeTemplate {
  readonly name: string;
  readonly language: string;
  readonly status: string;
  readonly category: string;
}

type Failure =
  | { readonly kind: "error"; readonly status: number; readonly code: number }
  | { readonly kind: "drop" }
  /** Sends 200 headers and the start of a body, then nothing. */
  | { readonly kind: "stall-body" };

export interface FakeWhatsAppGraph {
  readonly base: string;
  readonly requests: Array<FakeRequest>;
  readonly violations: Array<string>;
  readonly templates: Array<FakeTemplate>;
  /** Accepted message posts, parsed. */
  readonly sent: () => ReadonlyArray<Record<string, unknown>>;
  /** The next request whose path ends with `pathSuffix` gets this failure instead. */
  readonly failNext: (pathSuffix: string, failure: Failure) => void;
  /** Resolves once a stall-body failure has sent its headers. */
  readonly bodyStalled: Promise<void>;
  /** `downloadUrl` replaces the URL the lookup answers with, as a hostile or broken lookup would. */
  readonly addMedia: (bytes: Uint8Array, mimeType: string, downloadUrl?: string) => string;
}

const json = (response: NodeHttp.ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const graphError = (response: NodeHttp.ServerResponse, status: number, code: number) =>
  json(response, status, { error: { message: `fake error ${code}`, code } });

const messageProblem = (payload: Record<string, unknown>): string | null => {
  if (payload.messaging_product !== "whatsapp") return "messaging_product must be whatsapp";
  if (payload.type !== "reaction" && payload.recipient_type !== "individual") {
    return "recipient_type must be individual";
  }
  if (typeof payload.to !== "string" || !PHONE.test(payload.to)) return "bad recipient";
  const type = payload.type as string;
  const body = payload[type] as Record<string, unknown> | undefined;
  if (body === undefined) return `missing ${type} object`;
  switch (type) {
    case "text":
      return typeof body.body === "string" && body.body.length <= 4096 ? null : "bad text body";
    case "reaction":
      return typeof body.message_id === "string" && typeof body.emoji === "string"
        ? null
        : "bad reaction";
    case "template": {
      if (typeof body.name !== "string" || !/^[a-z0-9_]{1,512}$/.test(body.name)) {
        return "bad template name";
      }
      const components = (body.components ?? []) as ReadonlyArray<{
        readonly parameters?: ReadonlyArray<{ readonly text?: string }>;
      }>;
      const bad = components.some((component) =>
        (component.parameters ?? []).some((parameter) =>
          TEMPLATE_PARAM_BAD.test(parameter.text ?? ""),
        ),
      );
      return bad ? "template parameter has a newline, tab or four spaces" : null;
    }
    case "interactive": {
      const action = body.action as Record<string, unknown>;
      if (body.type === "button") {
        const buttons = action.buttons as ReadonlyArray<{
          readonly reply: { readonly title: string };
        }>;
        return buttons.length >= 1 &&
          buttons.length <= 3 &&
          buttons.every((b) => b.reply.title.length <= 20)
          ? null
          : "bad buttons";
      }
      if (body.type === "list") {
        const sections = action.sections as ReadonlyArray<{
          readonly rows: ReadonlyArray<unknown>;
        }>;
        return typeof action.button === "string" &&
          sections.length === 1 &&
          sections[0]!.rows.length <= 10
          ? null
          : "bad list";
      }
      return "unknown interactive type";
    }
    case "image":
    case "video":
    case "document":
      return typeof body.id === "string" ? null : "media needs an id";
    case "audio":
      return typeof body.id === "string" && body.caption === undefined
        ? null
        : "audio takes an id and no caption";
    default:
      return `unknown type ${type}`;
  }
};

/** Starts the fake for the current scope. */
export const make = Effect.acquireRelease(
  Effect.callback<{ readonly server: NodeHttp.Server; readonly fake: FakeWhatsAppGraph }>(
    (resume) => {
      const requests: Array<FakeRequest> = [];
      const violations: Array<string> = [];
      const templates: Array<FakeTemplate> = [];
      const failures: Array<{ readonly suffix: string; readonly failure: Failure }> = [];
      const media = new Map<
        string,
        { readonly bytes: Uint8Array; readonly mimeType: string; readonly downloadUrl?: string }
      >();
      let nextId = 0;
      let base = "";
      let markStalled = () => {};
      const bodyStalled = new Promise<void>((resolve) => {
        markStalled = resolve;
      });

      const server = NodeHttp.createServer((request, response) => {
        const chunks: Array<Buffer> = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const url = new URL(request.url ?? "/", base);
          const body = Buffer.concat(chunks).toString("utf8");
          const recorded: FakeRequest = {
            method: request.method ?? "GET",
            path: url.pathname,
            userAgent: request.headers["user-agent"],
            authorization: request.headers.authorization,
            body,
          };
          requests.push(recorded);

          if (recorded.userAgent === undefined || DEFAULT_AGENTS.test(recorded.userAgent)) {
            violations.push(`no explicit User-Agent on ${recorded.path}`);
            response.writeHead(403, { "content-type": "text/plain" });
            return response.end("error code: 1010");
          }
          if (recorded.authorization !== `Bearer ${FAKE_TOKEN}`) {
            return graphError(response, 401, 190);
          }
          const failureAt = failures.findIndex(({ suffix }) => url.pathname.endsWith(suffix));
          if (failureAt !== -1) {
            const { failure } = failures.splice(failureAt, 1)[0]!;
            if (failure.kind === "drop") return request.socket.destroy();
            if (failure.kind === "stall-body") {
              response.writeHead(200, { "content-type": "application/json" });
              response.write("{");
              return markStalled();
            }
            return graphError(response, failure.status, failure.code);
          }
          const segments = url.pathname.split("/").filter((segment) => segment !== "");
          if (segments[0] === "download") {
            const stored = media.get(segments[1] ?? "");
            if (stored === undefined) return graphError(response, 404, 100);
            response.writeHead(200, { "content-type": stored.mimeType });
            return response.end(Buffer.from(stored.bytes));
          }
          if (segments[0] !== FAKE_VERSION) {
            violations.push(`unversioned path ${url.pathname}`);
            return graphError(response, 400, 2500);
          }
          if (segments.filter((segment) => /^v\d+\.\d+$/.test(segment)).length > 1) {
            violations.push(`doubled version segment in ${url.pathname}`);
            return graphError(response, 400, 2500);
          }
          const rest = segments.slice(1);
          if (request.method === "POST" && rest[0] === FAKE_PHONE_NUMBER_ID) {
            if (rest[1] === "messages") {
              const payload = JSON.parse(body) as Record<string, unknown>;
              const problem = messageProblem(payload);
              if (problem !== null) {
                violations.push(problem);
                return graphError(response, 400, 100);
              }
              nextId += 1;
              return json(response, 200, {
                messaging_product: "whatsapp",
                messages: [{ id: `wamid.fake${nextId}` }],
              });
            }
            if (rest[1] === "media") {
              if (
                !request.headers["content-type"]?.startsWith("multipart/form-data") ||
                !body.includes('name="messaging_product"')
              ) {
                violations.push("media upload is not multipart with messaging_product");
                return graphError(response, 400, 100);
              }
              nextId += 1;
              return json(response, 200, { id: `uploaded-${nextId}` });
            }
          }
          if (
            request.method === "GET" &&
            rest[0] === FAKE_BUSINESS_ACCOUNT_ID &&
            rest[1] === "message_templates"
          ) {
            const name = url.searchParams.get("name");
            return json(response, 200, {
              data: templates.filter((template) => name === null || template.name === name),
            });
          }
          if (request.method === "GET" && rest.length === 1 && media.has(rest[0]!)) {
            const stored = media.get(rest[0]!)!;
            return json(response, 200, {
              url: stored.downloadUrl ?? `${base}/download/${rest[0]}`,
              mime_type: stored.mimeType,
              id: rest[0],
            });
          }
          violations.push(`unexpected ${request.method} ${url.pathname}`);
          return graphError(response, 400, 100);
        });
      });

      server.listen(0, "127.0.0.1", () => {
        base = `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`;
        resume(
          Effect.succeed({
            server,
            fake: {
              base,
              requests,
              violations,
              templates,
              sent: () =>
                requests
                  .filter(
                    (request) => request.method === "POST" && request.path.endsWith("/messages"),
                  )
                  .map((request) => JSON.parse(request.body) as Record<string, unknown>),
              failNext: (suffix, failure) => failures.push({ suffix, failure }),
              bodyStalled,
              addMedia: (bytes, mimeType, downloadUrl) => {
                nextId += 1;
                const id = `media-${nextId}`;
                media.set(id, {
                  bytes,
                  mimeType,
                  ...(downloadUrl === undefined ? {} : { downloadUrl }),
                });
                return id;
              },
            },
          }),
        );
      });
    },
  ),
  ({ server }) =>
    Effect.callback<void>((resume) => {
      server.closeAllConnections();
      server.close(() => resume(Effect.void));
    }),
).pipe(Effect.map(({ fake }) => fake));

/**
 * Points the adapter at the fake and refuses any request to another host, so
 * a test can never reach the real Graph API.
 */
export const layerFor = (fake: FakeWhatsAppGraph, version: string | undefined = FAKE_VERSION) =>
  Layer.mergeAll(
    Layer.succeed(WhatsAppGraphApi, {
      base: fake.base,
      ...(version === undefined ? {} : { version }),
    }),
    Layer.effect(
      HttpClient.HttpClient,
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        return HttpClient.mapRequestEffect(client, (request) =>
          new URL(request.url).hostname === "127.0.0.1"
            ? Effect.succeed(request)
            : Effect.die(`a test tried to reach ${new URL(request.url).hostname}`),
        );
      }),
    ).pipe(Layer.provide(FetchHttpClient.layer)),
  );
