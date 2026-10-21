import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Chat channels let an environment message people over a messaging service
 * (WhatsApp Cloud today). Credentials and phone numbers live only in the
 * server's secret store; config holds secret refs, and everything a client
 * receives says only whether a credential is set and shows numbers masked.
 */

export const ChatChannelKind = Schema.Literals(["whatsapp"]);
export type ChatChannelKind = typeof ChatChannelKind.Type;

export const ChatChannelId = TrimmedNonEmptyString.check(Schema.isMaxLength(64)).pipe(
  Schema.brand("ChatChannelId"),
);
export type ChatChannelId = typeof ChatChannelId.Type;

export const ChatContactId = TrimmedNonEmptyString.check(Schema.isMaxLength(64)).pipe(
  Schema.brand("ChatContactId"),
);
export type ChatContactId = typeof ChatContactId.Type;

/** Names a value in the server's secret store; never the value itself. */
export const ChatSecretRef = Schema.String.check(
  Schema.isPattern(/^chat-secret:[0-9a-f]{32}$/),
).pipe(Schema.brand("ChatSecretRef"));
export type ChatSecretRef = typeof ChatSecretRef.Type;

export const ChatChannelCredentialName = Schema.Literals([
  "accessToken",
  "phoneNumberId",
  "appSecret",
  "verifyToken",
]);
export type ChatChannelCredentialName = typeof ChatChannelCredentialName.Type;

export const ChatChannelLabel = TrimmedNonEmptyString.check(Schema.isMaxLength(64));

/** A WhatsApp Business Account id: not a secret, but needed to read template status. */
export const WhatsAppBusinessAccountId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^\d{5,20}$/),
);

export const ChatTemplateName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(512),
  Schema.isPattern(/^[a-z0-9_]+$/),
).annotate({ description: "A WhatsApp template name: lowercase letters, digits and '_'." });

export const ChatTemplateLanguage = TrimmedNonEmptyString.check(
  Schema.isMaxLength(16),
  Schema.isPattern(/^[a-z]{2,3}(_[A-Z]{2})?$/),
);

/** The template sent when a message waits outside the 24-hour window; it takes one text parameter. */
export const ChatNotifyTemplate = Schema.Struct({
  name: ChatTemplateName,
  language: ChatTemplateLanguage,
});
export type ChatNotifyTemplate = typeof ChatNotifyTemplate.Type;

const ChatStoredCredential = Schema.Struct({
  ref: ChatSecretRef,
  updatedAt: IsoDateTime,
});

/** The server's stored channel config. It never leaves the server. */
export const ChatChannelConfig = Schema.Struct({
  id: ChatChannelId,
  kind: ChatChannelKind,
  label: ChatChannelLabel,
  businessAccountId: Schema.NullOr(WhatsAppBusinessAccountId),
  notifyTemplate: Schema.NullOr(ChatNotifyTemplate),
  credentials: Schema.Struct({
    accessToken: Schema.optionalKey(ChatStoredCredential),
    phoneNumberId: Schema.optionalKey(ChatStoredCredential),
    appSecret: Schema.optionalKey(ChatStoredCredential),
    verifyToken: Schema.optionalKey(ChatStoredCredential),
  }),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ChatChannelConfig = typeof ChatChannelConfig.Type;

export const ChatContactSlug = TrimmedNonEmptyString.check(
  Schema.isMaxLength(32),
  Schema.isPattern(/^[a-z][a-z0-9-]*$/),
).annotate({ description: "Lowercase contact slug: a letter, then letters, digits or '-'." });

export const ChatContactDisplayName = TrimmedNonEmptyString.check(Schema.isMaxLength(64));

/** A contact's number as the server stores it: the value is in the secret store. */
export const ChatStoredPhoneNumber = Schema.Struct({
  ref: ChatSecretRef,
  masked: Schema.String,
  /** A keyed hash of the number, so an inbound message finds its contact without reading secrets. */
  lookup: Schema.String,
});
export type ChatStoredPhoneNumber = typeof ChatStoredPhoneNumber.Type;

/** The server's stored contact. It never leaves the server. */
export const ChatContactConfig = Schema.Struct({
  id: ChatContactId,
  channelId: ChatChannelId,
  slug: ChatContactSlug,
  displayName: ChatContactDisplayName,
  phoneNumbers: Schema.Array(ChatStoredPhoneNumber),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ChatContactConfig = typeof ChatContactConfig.Type;

/** A contact's bot thread. The shape is fixed now; creating one arrives with inbound messaging. */
export const ChatContactThreadBinding = Schema.Struct({
  contactId: ChatContactId,
  threadId: ThreadId,
  boundAt: IsoDateTime,
});
export type ChatContactThreadBinding = typeof ChatContactThreadBinding.Type;

export const ChatChannelCredentialStatus = Schema.Struct({
  name: ChatChannelCredentialName,
  set: Schema.Boolean,
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type ChatChannelCredentialStatus = typeof ChatChannelCredentialStatus.Type;

export const ChatChannel = Schema.Struct({
  id: ChatChannelId,
  kind: ChatChannelKind,
  label: ChatChannelLabel,
  businessAccountId: Schema.NullOr(WhatsAppBusinessAccountId),
  notifyTemplate: Schema.NullOr(ChatNotifyTemplate),
  credentials: Schema.Array(ChatChannelCredentialStatus),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ChatChannel = typeof ChatChannel.Type;

export const ChatContact = Schema.Struct({
  id: ChatContactId,
  channelId: ChatChannelId,
  slug: ChatContactSlug,
  displayName: ChatContactDisplayName,
  /** Masked; the numbers themselves never reach a client. */
  phoneNumbers: Schema.Array(Schema.String),
  threadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ChatContact = typeof ChatContact.Type;

/**
 * Where investigation pods may reach production. Stored here; investigation
 * pods read it. `railway` is write-capable; the read-only URL is not available yet.
 */
export const ChatProductionAccess = Schema.Literals(["off", "railway", "readOnlyDatabaseUrl"]);
export type ChatProductionAccess = typeof ChatProductionAccess.Type;

export const ChatChannelsSnapshot = Schema.Struct({
  channels: Schema.Array(ChatChannel),
  contacts: Schema.Array(ChatContact),
  productionAccess: ChatProductionAccess,
});
export type ChatChannelsSnapshot = typeof ChatChannelsSnapshot.Type;

const ProviderMessageId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));

const ChatMediaKind = Schema.Literals(["image", "document", "audio", "video"]);

export const ChatInboundContent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  /** A tap on a button or list row the bot sent. */
  Schema.Struct({
    type: Schema.Literal("reply"),
    replyId: Schema.String,
    title: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("media"),
    mediaKind: Schema.Literals(["image", "document", "audio", "video", "sticker"]),
    providerMediaId: Schema.String,
    mimeType: Schema.optionalKey(Schema.String),
    caption: Schema.optionalKey(Schema.String),
    filename: Schema.optionalKey(Schema.String),
    /** Set once the media is in the attachment store. */
    attachmentId: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("reaction"),
    messageId: ProviderMessageId,
    emoji: Schema.String,
  }),
]);
export type ChatInboundContent = typeof ChatInboundContent.Type;

/**
 * One message a person sent, as the ingress hands it to the channel service.
 * `from` is the sender's number: the service resolves it to a contact and
 * keeps only the contact id.
 */
export const ChatInboundMessage = Schema.Struct({
  channelId: ChatChannelId,
  from: Schema.String,
  providerMessageId: ProviderMessageId,
  receivedAt: IsoDateTime,
  contextMessageId: Schema.optionalKey(ProviderMessageId),
  content: ChatInboundContent,
});
export type ChatInboundMessage = typeof ChatInboundMessage.Type;

const ReplyTo = Schema.optionalKey(ProviderMessageId);
const HeaderText = Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(60)));
const FooterText = Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(60)));

const ChatButton = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(20)),
});

const ChatListRow = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(24)),
  description: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(72))),
});

/** What a channel can send. Limits are WhatsApp Cloud's. */
export const ChatOutboundContent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("text"),
    text: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
    replyTo: ReplyTo,
  }),
  Schema.Struct({
    type: Schema.Literal("buttons"),
    text: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
    buttons: Schema.Array(ChatButton).check(Schema.isMinLength(1), Schema.isMaxLength(3)),
    header: HeaderText,
    footer: FooterText,
    replyTo: ReplyTo,
  }),
  Schema.Struct({
    type: Schema.Literal("list"),
    text: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
    buttonLabel: TrimmedNonEmptyString.check(Schema.isMaxLength(20)),
    rows: Schema.Array(ChatListRow).check(Schema.isMinLength(1), Schema.isMaxLength(10)),
    sectionTitle: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(24))),
    header: HeaderText,
    footer: FooterText,
    replyTo: ReplyTo,
  }),
  Schema.Struct({
    type: Schema.Literal("react"),
    messageId: ProviderMessageId,
    emoji: TrimmedNonEmptyString.check(Schema.isMaxLength(16)),
  }),
  Schema.Struct({
    type: Schema.Literal("media"),
    mediaKind: ChatMediaKind,
    attachmentId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
    caption: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(1024))),
    filename: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(240))),
    replyTo: ReplyTo,
  }),
  Schema.Struct({
    type: Schema.Literal("template"),
    name: ChatTemplateName,
    language: ChatTemplateLanguage,
    params: Schema.Array(Schema.String).check(Schema.isMaxLength(10)),
  }),
]);
export type ChatOutboundContent = typeof ChatOutboundContent.Type;

export const ChatTemplateState = Schema.Literals(["approved", "pending", "rejected", "missing"]);
export type ChatTemplateState = typeof ChatTemplateState.Type;

export const ChatTemplateStatus = Schema.Struct({
  /** Null when the channel has no notify template configured. */
  name: Schema.NullOr(ChatTemplateName),
  state: ChatTemplateState,
  category: Schema.NullOr(Schema.String),
  /** Only an approved UTILITY template is sent: Meta does not deliver MARKETING templates to US numbers. */
  usable: Schema.Boolean,
});
export type ChatTemplateStatus = typeof ChatTemplateStatus.Type;

export class ChatChannelError extends Schema.TaggedError<ChatChannelError>()("ChatChannelError", {
  message: Schema.String,
}) {}

export const ChatChannelUpsertInput = Schema.Struct({
  /** Absent to add a channel. */
  id: Schema.optionalKey(ChatChannelId),
  kind: ChatChannelKind,
  label: ChatChannelLabel,
  businessAccountId: Schema.NullOr(WhatsAppBusinessAccountId),
  notifyTemplate: Schema.NullOr(ChatNotifyTemplate),
});
export type ChatChannelUpsertInput = typeof ChatChannelUpsertInput.Type;

export const ChatChannelRemoveInput = Schema.Struct({ channelId: ChatChannelId });
export type ChatChannelRemoveInput = typeof ChatChannelRemoveInput.Type;

/** Write-only: the value goes to the secret store and is never sent back. */
export const ChatChannelSetCredentialInput = Schema.Struct({
  channelId: ChatChannelId,
  name: ChatChannelCredentialName,
  value: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
});
export type ChatChannelSetCredentialInput = typeof ChatChannelSetCredentialInput.Type;

export const ChatContactUpsertInput = Schema.Struct({
  channelId: ChatChannelId,
  /** Absent to add a contact. */
  id: Schema.optionalKey(ChatContactId),
  slug: ChatContactSlug,
  displayName: ChatContactDisplayName,
  /** Write-only, in international format. Absent on an edit keeps the stored numbers. */
  phoneNumbers: Schema.optionalKey(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(32))).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(5),
    ),
  ),
});
export type ChatContactUpsertInput = typeof ChatContactUpsertInput.Type;

export const ChatContactRemoveInput = Schema.Struct({ contactId: ChatContactId });
export type ChatContactRemoveInput = typeof ChatContactRemoveInput.Type;

export const ChatTemplateStatusInput = Schema.Struct({ channelId: ChatChannelId });
export type ChatTemplateStatusInput = typeof ChatTemplateStatusInput.Type;

export const ChatSetProductionAccessInput = Schema.Struct({ value: ChatProductionAccess });
export type ChatSetProductionAccessInput = typeof ChatSetProductionAccessInput.Type;

/** Every Messaging settings change goes through one RPC; the server dispatches on `type`. */
export const ChatChannelMutation = Schema.Union([
  Schema.Struct({ type: Schema.Literal("channel.upsert"), ...ChatChannelUpsertInput.fields }),
  Schema.Struct({ type: Schema.Literal("channel.remove"), ...ChatChannelRemoveInput.fields }),
  Schema.Struct({
    type: Schema.Literal("channel.setCredential"),
    ...ChatChannelSetCredentialInput.fields,
  }),
  Schema.Struct({ type: Schema.Literal("contact.upsert"), ...ChatContactUpsertInput.fields }),
  Schema.Struct({ type: Schema.Literal("contact.remove"), ...ChatContactRemoveInput.fields }),
  Schema.Struct({
    type: Schema.Literal("productionAccess.set"),
    ...ChatSetProductionAccessInput.fields,
  }),
]);
export type ChatChannelMutation = typeof ChatChannelMutation.Type;

/** The id an upsert created or kept; other mutations return neither. */
export const ChatChannelMutationResult = Schema.Struct({
  channelId: Schema.optionalKey(ChatChannelId),
  contactId: Schema.optionalKey(ChatContactId),
});
export type ChatChannelMutationResult = typeof ChatChannelMutationResult.Type;
