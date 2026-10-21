import type {
  ChatChannelCredentialName,
  ChatNotifyTemplate,
  ChatOutboundContent,
  ChatTemplateState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";

import packageJson from "../../package.json" with { type: "json" };
import {
  ChatChannelAdapter,
  type ChatAdapterOperation,
  type ChatChannelCredentials,
  type ChatOutboundMedia,
  type ChatProviderError,
  ChatProviderNoAnswerError,
  ChatProviderRejectedError,
  type ChatRejectionReason,
} from "./ChatChannelAdapter.ts";

const DEFAULT_API_BASE = "https://graph.facebook.com";
const DEFAULT_API_VERSION = "v25.0";
const VERSION = /^v\d+\.\d+$/;
const VERSION_LIKE = /^[vV]\d*(\.\d+)?$/;
const APP_SECRET = /^[0-9a-fA-F]{32}$/;
/** Covers the whole call, body included: a stalled body would hold up the serial outbox. */
const REQUEST_TIMEOUT = Duration.seconds(30);
const DOWNLOAD_TIMEOUT = Duration.minutes(2);
/** The largest media WhatsApp accepts (documents). */
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const TEMPLATE_PARAM_MAX_LENGTH = 1024;
/** Sent on every request: some edges in front of these APIs refuse a missing or default agent. */
export const WHATSAPP_USER_AGENT = `T3Code/${packageJson.version} (chat-channel)`;
/** A send must not follow a redirect: the bearer token would go with it. */
const NO_REDIRECT: RequestInit = { redirect: "manual" };

/** Where the Graph API lives. Tests point it at a fake; nothing else should. */
export class WhatsAppGraphApi extends Context.Reference<{
  readonly base: string;
  readonly version?: string;
}>("t3/chat/WhatsAppGraphApi", {
  defaultValue: () => ({ base: DEFAULT_API_BASE }),
}) {}

/**
 * The API root every call is built on: the base with the version appended,
 * unless the base already ends in a version segment, which is then used as it
 * is. Appending a second version yields Graph's "Unknown path components".
 */
export function whatsAppApiRoot(base: string, version?: string): string {
  if (version !== undefined && !VERSION.test(version)) {
    throw new Error(`The Graph API version must look like ${DEFAULT_API_VERSION}.`);
  }
  const url = new URL(base.trim());
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("The Graph API base must be an http(s) URL.");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error("The Graph API base must not carry credentials, a query or a fragment.");
  }
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  const root = `${url.protocol}//${url.host}${segments.map((segment) => `/${segment}`).join("")}`;
  const versionAt = segments.findIndex((segment) => VERSION_LIKE.test(segment));
  if (versionAt === -1) return `${root}/${version ?? DEFAULT_API_VERSION}`;
  if (versionAt !== segments.length - 1 || !VERSION.test(segments[versionAt]!)) {
    throw new Error("The Graph API base must end at a well-formed version segment.");
  }
  return root;
}

const credentialProblem = (name: ChatChannelCredentialName, value: string): string | null => {
  switch (name) {
    case "appSecret":
      return APP_SECRET.test(value) ? null : "The app secret must be 32 hexadecimal characters.";
    case "phoneNumberId":
      return /^\d{5,20}$/.test(value) ? null : "The phone number ID must be digits only.";
    case "accessToken":
      return /\s/.test(value) ? "The access token must not contain spaces." : null;
    case "verifyToken":
      return value.length > 256 ? "The verify token must be at most 256 characters." : null;
  }
};

const WINDOW_CLOSED_CODES = new Set([131047]);
/** 131049: MARKETING to a US number; 130497: country not allowed; 131050: person opted out. */
const UNDELIVERABLE_CODES = new Set([131049, 130497, 131050]);
const RATE_LIMIT_CODES = new Set([4, 80007, 130429, 131056]);

const rejectionReason = (status: number, code: number | null): ChatRejectionReason => {
  if (code !== null && WINDOW_CLOSED_CODES.has(code)) return "window_closed";
  if (code !== null && UNDELIVERABLE_CODES.has(code)) return "undeliverable";
  if (status === 429 || (code !== null && RATE_LIMIT_CODES.has(code))) return "rate_limited";
  return "invalid";
};

/** Graph refuses newlines, tabs and runs of four spaces in a template parameter. */
const flattenTemplateParam = (value: string) =>
  value
    .replace(/[\n\r\t]+/g, " ")
    .replace(/ {4,}/g, "   ")
    .trim()
    .slice(0, TEMPLATE_PARAM_MAX_LENGTH);

const MEDIA_HOST = /^(lookaside\.fbsbx\.com|[a-z0-9.-]+\.fbcdn\.net)$/;

const isMediaDownloadUrl = (url: string, apiOrigin: string) => {
  if (!URL.canParse(url)) return false;
  const target = new URL(url);
  if (target.username !== "" || target.password !== "") return false;
  return (
    target.origin === apiOrigin ||
    (target.protocol === "https:" && MEDIA_HOST.test(target.hostname))
  );
};

const graphErrorCode = (body: unknown): number | null => {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as { readonly error?: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "number" ? code : null;
};

const stringField = (body: unknown, key: string): string | null => {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "" ? value : null;
};

const contextOf = (replyTo: string | undefined) =>
  replyTo === undefined ? {} : { context: { message_id: replyTo } };

const interactive = (
  kind: "button" | "list",
  content: { readonly text: string; readonly header?: string; readonly footer?: string },
  action: unknown,
) => ({
  type: kind,
  body: { text: content.text },
  action,
  ...(content.header === undefined ? {} : { header: { type: "text", text: content.header } }),
  ...(content.footer === undefined ? {} : { footer: { text: content.footer } }),
});

/** The `/messages` payload; media passes the id its upload returned. */
function whatsAppMessagePayload(
  to: string,
  content: ChatOutboundContent,
  uploadedMediaId?: string,
): Record<string, unknown> {
  const message = (type: string, body: unknown, replyTo?: string) => ({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    // Graph's recipient is the number's digits, without the plus.
    to: to.replace(/^\+/, ""),
    type,
    [type]: body,
    ...contextOf(replyTo),
  });
  switch (content.type) {
    case "text":
      return message("text", { body: content.text, preview_url: false }, content.replyTo);
    case "buttons":
      return message(
        "interactive",
        interactive("button", content, {
          buttons: content.buttons.map((button) => ({
            type: "reply",
            reply: { id: button.id, title: button.title },
          })),
        }),
        content.replyTo,
      );
    case "list":
      return message(
        "interactive",
        interactive("list", content, {
          button: content.buttonLabel,
          sections: [
            {
              ...(content.sectionTitle === undefined ? {} : { title: content.sectionTitle }),
              rows: content.rows.map((row) => ({
                id: row.id,
                title: row.title,
                ...(row.description === undefined ? {} : { description: row.description }),
              })),
            },
          ],
        }),
        content.replyTo,
      );
    case "react":
      return message("reaction", { message_id: content.messageId, emoji: content.emoji });
    case "media":
      return message(
        content.mediaKind,
        {
          id: uploadedMediaId,
          ...(content.caption === undefined || content.mediaKind === "audio"
            ? {}
            : { caption: content.caption }),
          ...(content.filename === undefined || content.mediaKind !== "document"
            ? {}
            : { filename: content.filename }),
        },
        content.replyTo,
      );
    case "template":
      return message("template", {
        name: content.name,
        language: { code: content.language },
        ...(content.params.length === 0
          ? {}
          : {
              components: [
                {
                  type: "body",
                  parameters: content.params.map((param) => ({
                    type: "text",
                    text: flattenTemplateParam(param),
                  })),
                },
              ],
            }),
      });
  }
}

const templateState = (status: string): ChatTemplateState => {
  switch (status) {
    case "APPROVED":
      return "approved";
    case "PENDING":
    case "IN_APPEAL":
    case "PENDING_DELETION":
      return "pending";
    default:
      return "rejected";
  }
};

const make = Effect.gen(function* () {
  const api = yield* WhatsAppGraphApi;
  const root = whatsAppApiRoot(api.base, api.version);
  const rootOrigin = new URL(root).origin;
  const httpClient = yield* HttpClient.HttpClient;

  const execute = (
    operation: ChatAdapterOperation,
    credentials: ChatChannelCredentials,
    request: HttpClientRequest.HttpClientRequest,
  ) =>
    httpClient
      .execute(
        request.pipe(
          HttpClientRequest.setHeaders({
            "user-agent": WHATSAPP_USER_AGENT,
            authorization: `Bearer ${Redacted.value(credentials.accessToken)}`,
          }),
        ),
      )
      .pipe(
        // A span would record the URL, which carries the phone number id.
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        Effect.provideService(FetchHttpClient.RequestInit, NO_REDIRECT),
        Effect.mapError(() => new ChatProviderNoAnswerError({ operation, reason: "transport" })),
      );

  const withDeadline =
    (operation: ChatAdapterOperation, duration: Duration.Duration) =>
    <A, R>(effect: Effect.Effect<A, ChatProviderError, R>) =>
      effect.pipe(
        Effect.timeoutOrElse({
          duration,
          orElse: () =>
            Effect.fail(new ChatProviderNoAnswerError({ operation, reason: "timeout" })),
        }),
      );

  const rejectedOrBody = (
    operation: ChatAdapterOperation,
    response: HttpClientResponse.HttpClientResponse,
  ): Effect.Effect<unknown, ChatProviderError> =>
    response.json.pipe(
      Effect.orElseSucceed((): unknown => null),
      Effect.flatMap((body): Effect.Effect<unknown, ChatProviderError> => {
        if (response.status >= 200 && response.status < 300) return Effect.succeed(body);
        // A server error may have sent the message before failing: never resend it.
        if (response.status >= 500) {
          return Effect.fail(new ChatProviderNoAnswerError({ operation, reason: "server_error" }));
        }
        const code = graphErrorCode(body);
        return Effect.fail(
          new ChatProviderRejectedError({
            operation,
            status: response.status,
            code,
            reason: rejectionReason(response.status, code),
          }),
        );
      }),
    );

  const callJson = (
    operation: ChatAdapterOperation,
    credentials: ChatChannelCredentials,
    request: HttpClientRequest.HttpClientRequest,
  ) =>
    execute(operation, credentials, request).pipe(
      Effect.flatMap((response) => rejectedOrBody(operation, response)),
      Effect.scoped,
      withDeadline(operation, REQUEST_TIMEOUT),
    );

  const upload = (credentials: ChatChannelCredentials, media: ChatOutboundMedia) => {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", media.mimeType);
    form.append("file", new Blob([media.bytes], { type: media.mimeType }), media.fileName);
    return callJson(
      "upload-media",
      credentials,
      HttpClientRequest.post(`${root}/${encodeURIComponent(credentials.phoneNumberId)}/media`).pipe(
        HttpClientRequest.setBody(HttpBody.formData(form)),
      ),
    ).pipe(
      Effect.flatMap((body) => {
        const id = stringField(body, "id");
        return id === null
          ? Effect.fail(
              new ChatProviderNoAnswerError({
                operation: "upload-media",
                reason: "malformed_response",
              }),
            )
          : Effect.succeed(id);
      }),
    );
  };

  const prepare: ChatChannelAdapter["Service"]["prepare"] = (input) =>
    Effect.gen(function* () {
      const mediaId =
        input.content.type === "media"
          ? input.media === undefined
            ? yield* new ChatProviderRejectedError({
                operation: "upload-media",
                status: 400,
                code: null,
                reason: "invalid",
              })
            : yield* upload(input.credentials, input.media)
          : undefined;
      return { body: whatsAppMessagePayload(input.to, input.content, mediaId) };
    }).pipe(Effect.withSpan("WhatsAppCloudAdapter.prepare"));

  const post: ChatChannelAdapter["Service"]["post"] = (input) =>
    Effect.gen(function* () {
      const body = yield* callJson(
        "send",
        input.credentials,
        HttpClientRequest.post(
          `${root}/${encodeURIComponent(input.credentials.phoneNumberId)}/messages`,
        ).pipe(HttpClientRequest.bodyJsonUnsafe(input.message.body)),
      );
      const messages =
        typeof body === "object" && body !== null
          ? (body as { readonly messages?: unknown }).messages
          : undefined;
      const providerMessageId = Array.isArray(messages) ? stringField(messages[0], "id") : null;
      if (providerMessageId === null) {
        return yield* new ChatProviderNoAnswerError({
          operation: "send",
          reason: "malformed_response",
        });
      }
      return { providerMessageId };
    }).pipe(Effect.withSpan("WhatsAppCloudAdapter.post"));

  const download = (credentials: ChatChannelCredentials, url: string) =>
    Effect.gen(function* () {
      // The token goes only to the API's own origin or Meta's media hosts.
      if (!isMediaDownloadUrl(url, rootOrigin)) {
        return yield* new ChatProviderNoAnswerError({
          operation: "read-media",
          reason: "malformed_response",
        });
      }
      const response = yield* execute("read-media", credentials, HttpClientRequest.get(url));
      if (response.status < 200 || response.status >= 300) {
        return yield* new ChatProviderRejectedError({
          operation: "read-media",
          status: response.status,
          code: null,
          reason: "invalid",
        });
      }
      const declared = Number(response.headers["content-length"] ?? "0");
      if (declared > MAX_MEDIA_BYTES) {
        return yield* new ChatProviderRejectedError({
          operation: "read-media",
          status: response.status,
          code: null,
          reason: "invalid",
        });
      }
      const bytes = new Uint8Array(
        yield* response.arrayBuffer.pipe(
          Effect.mapError(
            () => new ChatProviderNoAnswerError({ operation: "read-media", reason: "transport" }),
          ),
        ),
      );
      if (bytes.byteLength > MAX_MEDIA_BYTES) {
        return yield* new ChatProviderRejectedError({
          operation: "read-media",
          status: response.status,
          code: null,
          reason: "invalid",
        });
      }
      return bytes;
    }).pipe(Effect.scoped, withDeadline("read-media", DOWNLOAD_TIMEOUT));

  const lookupMedia = (credentials: ChatChannelCredentials, providerMediaId: string) =>
    callJson(
      "read-media",
      credentials,
      HttpClientRequest.get(`${root}/${encodeURIComponent(providerMediaId)}`),
    ).pipe(
      Effect.flatMap((body) => {
        const url = stringField(body, "url");
        return url === null
          ? Effect.fail(
              new ChatProviderNoAnswerError({
                operation: "read-media",
                reason: "malformed_response",
              }),
            )
          : Effect.succeed({
              url,
              mimeType: stringField(body, "mime_type") ?? "application/octet-stream",
            });
      }),
    );

  const readMedia: ChatChannelAdapter["Service"]["readMedia"] = (input) =>
    Effect.gen(function* () {
      const first = yield* lookupMedia(input.credentials, input.providerMediaId);
      const bytes = yield* download(input.credentials, first.url).pipe(
        // The lookup URL lives five minutes; an expired one is looked up again, once.
        Effect.catchTags({
          ChatProviderRejectedError: (error) =>
            error.status === 404
              ? lookupMedia(input.credentials, input.providerMediaId).pipe(
                  Effect.flatMap((again) => download(input.credentials, again.url)),
                )
              : Effect.fail(error),
        }),
      );
      return { bytes, mimeType: first.mimeType };
    }).pipe(Effect.withSpan("WhatsAppCloudAdapter.readMedia"));

  const templateStatus: ChatChannelAdapter["Service"]["templateStatus"] = (input) =>
    Effect.gen(function* () {
      const businessAccountId = input.credentials.businessAccountId;
      if (businessAccountId === null) {
        return yield* new ChatProviderRejectedError({
          operation: "read-templates",
          status: 400,
          code: null,
          reason: "invalid",
        });
      }
      const body = yield* callJson(
        "read-templates",
        input.credentials,
        HttpClientRequest.get(
          `${root}/${encodeURIComponent(businessAccountId)}/message_templates`,
        ).pipe(
          HttpClientRequest.setUrlParams({
            fields: "name,status,category,language",
            name: input.template.name,
            limit: "100",
          }),
        ),
      );
      const rows =
        typeof body === "object" && body !== null
          ? (body as { readonly data?: unknown }).data
          : undefined;
      const match = (Array.isArray(rows) ? rows : []).find(
        (row) =>
          stringField(row, "name") === input.template.name &&
          stringField(row, "language") === input.template.language,
      );
      if (match === undefined) {
        return {
          name: input.template.name,
          state: "missing" as const,
          category: null,
          usable: false,
        };
      }
      const state = templateState(stringField(match, "status") ?? "");
      const category = stringField(match, "category");
      return {
        name: input.template.name,
        state,
        category,
        usable: state === "approved" && category === "UTILITY",
      };
    }).pipe(Effect.withSpan("WhatsAppCloudAdapter.templateStatus"));

  return ChatChannelAdapter.of({
    kind: "whatsapp",
    credentialProblem,
    prepare,
    post,
    readMedia,
    templateStatus,
  });
});

export const layer = Layer.effect(ChatChannelAdapter, make);
