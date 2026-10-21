import type {
  ChatChannelCredentialName,
  ChatChannelKind,
  ChatNotifyTemplate,
  ChatOutboundContent,
  ChatTemplateStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

/**
 * The boundary between the channel service and one messaging provider. The
 * service owns config, secrets, the log and the outbox; an adapter only turns
 * a resolved request into the provider's wire calls and classifies failures.
 */

export const ChatAdapterOperation = Schema.Literals([
  "send",
  "upload-media",
  "read-media",
  "read-templates",
]);
export type ChatAdapterOperation = typeof ChatAdapterOperation.Type;

/** Drives the outbox: what to do with a message the provider refused. */
export const ChatRejectionReason = Schema.Literals([
  /** The 24-hour window closed: hold the message until the person writes again. */
  "window_closed",
  /** The provider will never deliver this to the person (for example a MARKETING template to a US number). */
  "undeliverable",
  /** Throttled: nothing was sent, try again later. */
  "rate_limited",
  /** The request itself is wrong; retrying cannot help. */
  "invalid",
]);
export type ChatRejectionReason = typeof ChatRejectionReason.Type;

/** The provider answered with an error, so nothing was sent. */
export class ChatProviderRejectedError extends Schema.TaggedError<ChatProviderRejectedError>()(
  "ChatProviderRejectedError",
  {
    operation: ChatAdapterOperation,
    reason: ChatRejectionReason,
    status: Schema.Number,
    code: Schema.NullOr(Schema.Number),
  },
) {
  override get message(): string {
    return `The messaging provider refused ${this.operation} (HTTP ${this.status}${this.code === null ? "" : `, code ${this.code}`}).`;
  }
}

const ChatNoAnswerReason = Schema.Literals([
  "timeout",
  "transport",
  "server_error",
  "malformed_response",
]);
/**
 * No usable answer: a send may or may not have reached the person. It keeps
 * no underlying cause: an HTTP client error names the request URL, which
 * carries the phone number ID or a signed media URL, and failed spans are
 * written to the trace file with their full cause.
 */
export class ChatProviderNoAnswerError extends Schema.TaggedError<ChatProviderNoAnswerError>()(
  "ChatProviderNoAnswerError",
  {
    operation: ChatAdapterOperation,
    reason: ChatNoAnswerReason,
  },
) {
  override get message(): string {
    return `The messaging provider gave no usable answer to ${this.operation} (${this.reason}).`;
  }
}

export type ChatProviderError = ChatProviderRejectedError | ChatProviderNoAnswerError;

export interface ChatChannelCredentials {
  readonly accessToken: Redacted.Redacted<string>;
  readonly phoneNumberId: string;
  readonly businessAccountId: string | null;
}

export interface ChatOutboundMedia {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly fileName: string;
}

/** A message ready to post; only the adapter that prepared it reads it. */
export interface ChatPreparedMessage {
  readonly body: Readonly<Record<string, unknown>>;
}

export class ChatChannelAdapter extends Context.Service<
  ChatChannelAdapter,
  {
    readonly kind: ChatChannelKind;
    /** Why a credential value is unusable, naming the setting and never the value; null when fine. */
    readonly credentialProblem: (name: ChatChannelCredentialName, value: string) => string | null;
    /**
     * Everything before the send itself, such as uploading media; nothing reaches
     * the person yet. `media` carries the bytes of a `media` content's attachment.
     */
    readonly prepare: (input: {
      readonly credentials: ChatChannelCredentials;
      readonly to: string;
      readonly content: ChatOutboundContent;
      readonly media?: ChatOutboundMedia;
    }) => Effect.Effect<ChatPreparedMessage, ChatProviderError>;
    /** The one call after which the person may have the message. */
    readonly post: (input: {
      readonly credentials: ChatChannelCredentials;
      readonly message: ChatPreparedMessage;
    }) => Effect.Effect<{ readonly providerMessageId: string }, ChatProviderError>;
    readonly readMedia: (input: {
      readonly credentials: ChatChannelCredentials;
      readonly providerMediaId: string;
    }) => Effect.Effect<
      { readonly bytes: Uint8Array; readonly mimeType: string },
      ChatProviderError
    >;
    readonly templateStatus: (input: {
      readonly credentials: ChatChannelCredentials;
      readonly template: ChatNotifyTemplate;
    }) => Effect.Effect<ChatTemplateStatus, ChatProviderError>;
  }
>()("t3/chat/ChatChannelAdapter") {}
