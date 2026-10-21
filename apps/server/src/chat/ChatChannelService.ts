/**
 * Chat channels: config, contacts, the message log, and a durable outbox that
 * respects WhatsApp's 24-hour customer-service window.
 *
 * Credentials and phone numbers live only in the server secret store; rows
 * hold refs, and everything a client gets carries "set" flags and masked numbers.
 *
 * Sends are at most once. A claimed row is `preparing` while nothing can reach
 * the person (template check, secrets, media upload), and is committed as
 * `posting` just before the provider's send call. After a restart a `preparing`
 * row is retried; a `posting` row may or may not have gone out, so it becomes
 * `unknown` and is never resent.
 */
import {
  ChatChannelConfig,
  type ChatChannelCredentialName,
  ChatChannelError,
  type ChatChannelId,
  type ChatChannelMutation,
  type ChatChannelMutationResult,
  type ChatChannelRemoveInput,
  type ChatChannelSetCredentialInput,
  type ChatChannelsSnapshot,
  type ChatChannelUpsertInput,
  ChatContactConfig,
  type ChatContactId,
  type ChatContactRemoveInput,
  type ChatContactUpsertInput,
  ChatInboundContent,
  type ChatInboundMessage,
  ChatOutboundContent,
  ChatProductionAccess,
  ChatSecretRef,
  type ChatSetProductionAccessInput,
  type ChatStoredPhoneNumber,
  type ChatTemplateStatus,
  type ChatTemplateStatusInput,
  ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac.
import * as NodeCrypto from "node:crypto";

import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import { createDeterministicAttachmentId, resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import {
  ChatChannelAdapter,
  type ChatChannelCredentials,
  type ChatProviderError,
} from "./ChatChannelAdapter.ts";

const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_SEND_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000];
const CREDENTIAL_NAMES: ReadonlyArray<ChatChannelCredentialName> = [
  "accessToken",
  "phoneNumberId",
  "appSecret",
  "verifyToken",
];
const SECRET_REF_PREFIX = "chat-secret:";
const PHONE_NUMBER = /^\+[1-9]\d{6,14}$/;
const PHONE_NUMBER_FORMATTING = /[\s().-]/g;
const MEDIA_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "video/mp4": "mp4",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
};

/** User input is strict: international format only, formatting characters allowed. */
function normalizePhoneNumber(input: string): string | null {
  const normalized = input.replace(PHONE_NUMBER_FORMATTING, "");
  return PHONE_NUMBER.test(normalized) ? normalized : null;
}

/** Shows the last two digits only, at a fixed length so the mask does not reveal the number's length. */
const maskPhoneNumber = (number: string) => `•••• ••${number.slice(-2)}`;

const secretStoreName = (ref: ChatSecretRef) =>
  `chat-secret-${ref.slice(SECRET_REF_PREFIX.length)}`;

const channelError = (message: string) => new ChatChannelError({ message });

export type ChatMessageStatus =
  | "received"
  | "queued"
  | "pending"
  | "preparing"
  | "posting"
  | "sent"
  | "failed"
  | "unknown"
  | "cancelled";

interface MessageRow {
  readonly message_id: string;
  readonly channel_id: string;
  readonly contact_id: string;
  readonly content_json: string;
  readonly status: string;
  readonly attempt_count: number;
}

interface ContactRow {
  readonly config_json: string;
  readonly thread_id: string | null;
  readonly last_inbound_at: string | null;
  readonly last_inbound_number_ref: string | null;
}

interface Contact {
  readonly config: ChatContactConfig;
  readonly threadId: ThreadId | null;
  readonly lastInboundAt: string | null;
  readonly lastInboundNumberRef: string | null;
}

const decodeChannel = Schema.decodeUnknownEffect(Schema.fromJsonString(ChatChannelConfig));
const encodeChannel = Schema.encodeEffect(Schema.fromJsonString(ChatChannelConfig));
const decodeContact = Schema.decodeUnknownEffect(Schema.fromJsonString(ChatContactConfig));
const encodeContact = Schema.encodeEffect(Schema.fromJsonString(ChatContactConfig));
const decodeOutbound = Schema.decodeUnknownEffect(Schema.fromJsonString(ChatOutboundContent));
const encodeOutbound = Schema.encodeEffect(Schema.fromJsonString(ChatOutboundContent));
const encodeInbound = Schema.encodeEffect(Schema.fromJsonString(ChatInboundContent));
const decodeProductionAccess = Schema.decodeUnknownOption(ChatProductionAccess);

export interface ChatSendInput {
  readonly contactId: ChatContactId;
  readonly content: ChatOutboundContent;
  /** Stable per message: sending again with the same key never sends twice. */
  readonly idempotencyKey: string;
  /** Outside the window, also send the channel's notify template with this text. */
  readonly notifyText?: string;
}

export interface ChatSendResult {
  readonly messageId: string;
  /** `queued` waits for the person to write again; `pending` goes out now. */
  readonly status: ChatMessageStatus;
  /**
   * A notify template was queued. It goes out only if the provider lists it as
   * an approved UTILITY template when it is sent, so this is not a delivery.
   */
  readonly notifyQueued: boolean;
}

export type ChatInboundResult =
  | { readonly _tag: "recorded"; readonly contactId: ChatContactId; readonly messageId: string }
  | { readonly _tag: "duplicate" }
  /** No contact has that number; the message is dropped without a trace. */
  | { readonly _tag: "unknown_sender" };

export class ChatChannelService extends Context.Service<
  ChatChannelService,
  {
    readonly subscribe: () => Stream.Stream<ChatChannelsSnapshot, ChatChannelError>;
    readonly upsertChannel: (
      input: ChatChannelUpsertInput,
    ) => Effect.Effect<{ readonly channelId: ChatChannelId }, ChatChannelError>;
    readonly removeChannel: (
      input: ChatChannelRemoveInput,
    ) => Effect.Effect<void, ChatChannelError>;
    readonly setCredential: (
      input: ChatChannelSetCredentialInput,
    ) => Effect.Effect<void, ChatChannelError>;
    readonly upsertContact: (
      input: ChatContactUpsertInput,
    ) => Effect.Effect<{ readonly contactId: ChatContactId }, ChatChannelError>;
    readonly removeContact: (
      input: ChatContactRemoveInput,
    ) => Effect.Effect<void, ChatChannelError>;
    readonly templateStatus: (
      input: ChatTemplateStatusInput,
    ) => Effect.Effect<ChatTemplateStatus, ChatChannelError>;
    readonly setProductionAccess: (
      input: ChatSetProductionAccessInput,
    ) => Effect.Effect<void, ChatChannelError>;
    /** Any one settings change, as clients send it. */
    readonly mutate: (
      mutation: ChatChannelMutation,
    ) => Effect.Effect<ChatChannelMutationResult, ChatChannelError>;
    readonly send: (input: ChatSendInput) => Effect.Effect<ChatSendResult, ChatChannelError>;
    /** Records a person's message, reopens their window and releases what waited for it. */
    readonly recordInbound: (
      message: ChatInboundMessage,
    ) => Effect.Effect<ChatInboundResult, ChatChannelError>;
    /** Resolves once every send that is due has settled. */
    readonly drainOutbox: Effect.Effect<void>;
  }
>()("t3/chat/ChatChannelService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* ServerSecretStore.ServerSecretStore;
  const adapter = yield* ChatChannelAdapter;
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const { attachmentsDir } = yield* ServerConfig.ServerConfig;
  const layerScope = yield* Effect.scope;
  const changes = yield* PubSub.sliding<void>(1);
  const notifyChanged = PubSub.publish(changes, undefined).pipe(Effect.asVoid);
  const lookupKey = yield* store.getOrCreateRandom("chat-number-lookup-key", 32).pipe(Effect.orDie);

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const newId = (prefix: string) =>
    crypto.randomUUIDv4().pipe(
      Effect.orDie,
      Effect.map((uuid) => `${prefix}${uuid.replaceAll("-", "")}`),
    );
  const numberLookup = (channelId: ChatChannelId, number: string) =>
    NodeCrypto.createHmac("sha256", lookupKey).update(`${channelId}\u0000${number}`).digest("hex");

  const writeSecret = (value: string) =>
    Effect.gen(function* () {
      const ref = ChatSecretRef.make(yield* newId(SECRET_REF_PREFIX));
      yield* store
        .set(secretStoreName(ref), new TextEncoder().encode(value))
        .pipe(Effect.mapError(() => channelError("Could not store the secret.")));
      return ref;
    });
  const readSecret = (ref: ChatSecretRef) =>
    store.get(secretStoreName(ref)).pipe(
      Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
      Effect.mapError(() => channelError("Could not read a stored secret.")),
    );
  // An orphaned value is harmless; a failure to delete one must not undo the edit that replaced it.
  const removeSecrets = (refs: ReadonlyArray<ChatSecretRef>) =>
    Effect.forEach(
      refs,
      (ref) =>
        store
          .remove(secretStoreName(ref))
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not delete a chat channel secret", { errorTag: error._tag }),
            ),
          ),
      { discard: true },
    );

  const persistenceError = (message: string) => () => channelError(message);

  const loadChannels = sql<{ readonly config_json: string }>`
    SELECT config_json FROM chat_channels ORDER BY created_at, channel_id
  `.pipe(Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeChannel(row.config_json))));

  const loadChannel = (channelId: ChatChannelId) =>
    sql<{ readonly config_json: string }>`
      SELECT config_json FROM chat_channels WHERE channel_id = ${channelId}
    `.pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.succeed(Option.none())
          : decodeChannel(rows[0].config_json).pipe(Effect.map(Option.some)),
      ),
      Effect.mapError(persistenceError("Could not read the channel.")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(channelError("That channel no longer exists.")),
          onSome: Effect.succeed,
        }),
      ),
    );

  const toContact = (row: ContactRow) =>
    decodeContact(row.config_json).pipe(
      Effect.map((config): Contact => ({
        config,
        threadId: row.thread_id === null ? null : ThreadId.make(row.thread_id),
        lastInboundAt: row.last_inbound_at,
        lastInboundNumberRef: row.last_inbound_number_ref,
      })),
    );

  const loadContacts = (channelId?: ChatChannelId) =>
    sql<ContactRow>`
      SELECT config_json, thread_id, last_inbound_at, last_inbound_number_ref
      FROM chat_contacts
      WHERE ${channelId === undefined ? sql`1 = 1` : sql`channel_id = ${channelId}`}
      ORDER BY created_at, contact_id
    `.pipe(Effect.flatMap((rows) => Effect.forEach(rows, toContact)));

  const loadContact = (contactId: ChatContactId) =>
    sql<ContactRow>`
      SELECT config_json, thread_id, last_inbound_at, last_inbound_number_ref
      FROM chat_contacts WHERE contact_id = ${contactId}
    `.pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.succeed(Option.none<Contact>())
          : toContact(rows[0]).pipe(Effect.map(Option.some)),
      ),
      Effect.mapError(persistenceError("Could not read the contact.")),
    );

  const requireContact = (contactId: ChatContactId) =>
    loadContact(contactId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(channelError("That contact no longer exists.")),
          onSome: Effect.succeed,
        }),
      ),
    );

  const saveChannel = (channel: ChatChannelConfig) =>
    encodeChannel(channel).pipe(
      Effect.flatMap(
        (json) => sql`
          INSERT INTO chat_channels (channel_id, config_json, created_at)
          VALUES (${channel.id}, ${json}, ${channel.createdAt})
          ON CONFLICT(channel_id) DO UPDATE SET config_json = excluded.config_json
        `,
      ),
      Effect.mapError(persistenceError("Could not save the channel.")),
    );

  const saveContact = (contact: ChatContactConfig) =>
    encodeContact(contact).pipe(
      Effect.flatMap(
        (json) => sql`
          INSERT INTO chat_contacts (contact_id, channel_id, slug, config_json, created_at)
          VALUES (${contact.id}, ${contact.channelId}, ${contact.slug}, ${json}, ${contact.createdAt})
          ON CONFLICT(contact_id) DO UPDATE SET
            slug = excluded.slug,
            config_json = excluded.config_json
        `,
      ),
      Effect.mapError(persistenceError("Could not save the contact.")),
    );

  const loadProductionAccess = sql<{ readonly production_access: string }>`
    SELECT production_access FROM chat_settings WHERE id = 1
  `.pipe(
    Effect.map((rows) =>
      Option.getOrElse(
        Option.flatMap(Option.fromNullishOr(rows[0]?.production_access), decodeProductionAccess),
        () => "off" as const,
      ),
    ),
  );

  const snapshot: Effect.Effect<ChatChannelsSnapshot, ChatChannelError> = Effect.gen(function* () {
    const channels = yield* loadChannels;
    const contacts = yield* loadContacts();
    return {
      channels: channels.map((channel) => ({
        id: channel.id,
        kind: channel.kind,
        label: channel.label,
        businessAccountId: channel.businessAccountId,
        notifyTemplate: channel.notifyTemplate,
        credentials: CREDENTIAL_NAMES.map((name) => ({
          name,
          set: channel.credentials[name] !== undefined,
          updatedAt: channel.credentials[name]?.updatedAt ?? null,
        })),
        createdAt: channel.createdAt,
        updatedAt: channel.updatedAt,
      })),
      contacts: contacts.map(({ config, threadId }) => ({
        id: config.id,
        channelId: config.channelId,
        slug: config.slug,
        displayName: config.displayName,
        phoneNumbers: config.phoneNumbers.map((number) => number.masked),
        threadId,
        createdAt: config.createdAt,
        updatedAt: config.updatedAt,
      })),
      productionAccess: yield* loadProductionAccess,
    };
  }).pipe(Effect.mapError(persistenceError("Could not read messaging settings.")));

  const subscribe: ChatChannelService["Service"]["subscribe"] = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribed before the first read so an edit landing in between is not lost.
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(snapshot),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => snapshot)),
        );
      }),
    );

  const upsertChannel: ChatChannelService["Service"]["upsertChannel"] = (input) =>
    Effect.gen(function* () {
      if (input.kind !== adapter.kind) {
        return yield* channelError(`This server cannot run ${input.kind} channels.`);
      }
      if (input.notifyTemplate !== null && input.businessAccountId === null) {
        return yield* channelError(
          "A notify template needs the WhatsApp Business Account ID, to check that it is approved.",
        );
      }
      const now = yield* nowIso;
      const existing = input.id === undefined ? null : yield* loadChannel(input.id);
      const channel: ChatChannelConfig = {
        id: existing?.id ?? ((yield* newId("chat-channel-")) as ChatChannelId),
        kind: input.kind,
        label: input.label,
        businessAccountId: input.businessAccountId,
        notifyTemplate: input.notifyTemplate,
        credentials: existing?.credentials ?? {},
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      yield* saveChannel(channel);
      yield* notifyChanged;
      return { channelId: channel.id };
    }).pipe(Effect.withSpan("ChatChannelService.upsertChannel"));

  const setCredential: ChatChannelService["Service"]["setCredential"] = (input) =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({
        "chat.channel_id": input.channelId,
        "chat.credential": input.name,
      });
      const problem = adapter.credentialProblem(input.name, input.value);
      if (problem !== null) return yield* channelError(problem);
      const channel = yield* loadChannel(input.channelId);
      const ref = yield* writeSecret(input.value);
      const replaced = channel.credentials[input.name]?.ref;
      const now = yield* nowIso;
      yield* saveChannel({
        ...channel,
        credentials: { ...channel.credentials, [input.name]: { ref, updatedAt: now } },
        updatedAt: now,
      }).pipe(Effect.tapError(() => removeSecrets([ref])));
      if (replaced !== undefined) yield* removeSecrets([replaced]);
      yield* notifyChanged;
    }).pipe(Effect.withSpan("ChatChannelService.setCredential"));

  const attachmentIdsOf = (contactIds: ReadonlyArray<string>) =>
    contactIds.length === 0
      ? Effect.succeed([])
      : sql<{ readonly attachment_id: string | null }>`
          SELECT json_extract(content_json, '$.attachmentId') AS attachment_id
          FROM chat_messages
          WHERE contact_id IN ${sql.in(contactIds)} AND direction = 'inbound'
        `.pipe(
          Effect.map((rows) =>
            rows.flatMap((row) => (row.attachment_id === null ? [] : [row.attachment_id])),
          ),
        );

  const removeAttachments = (attachmentIds: ReadonlyArray<string>) =>
    Effect.forEach(
      attachmentIds,
      (attachmentId) => {
        const path = resolveAttachmentPathById({ attachmentsDir, attachmentId });
        return path === null
          ? Effect.void
          : fileSystem
              .remove(path)
              .pipe(
                Effect.catch(() => Effect.logWarning("Could not delete a chat media attachment")),
              );
      },
      { discard: true },
    );

  /** Deletes contacts with their log, then their secrets and media, which cannot be rolled back. */
  const deleteContacts = (contacts: ReadonlyArray<Contact>) =>
    Effect.gen(function* () {
      const ids = contacts.map(({ config }) => config.id);
      if (ids.length === 0) return;
      const attachmentIds = yield* attachmentIdsOf(ids);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM chat_messages WHERE contact_id IN ${sql.in(ids)}`;
          yield* sql`DELETE FROM chat_contacts WHERE contact_id IN ${sql.in(ids)}`;
        }),
      );
      yield* removeSecrets(contacts.flatMap(({ config }) => config.phoneNumbers.map((n) => n.ref)));
      yield* removeAttachments(attachmentIds);
    });

  const removeChannel: ChatChannelService["Service"]["removeChannel"] = (input) =>
    Effect.gen(function* () {
      const channel = yield* loadChannel(input.channelId);
      const contacts = yield* loadContacts(channel.id).pipe(
        Effect.mapError(persistenceError("Could not read the channel's contacts.")),
      );
      yield* deleteContacts(contacts).pipe(
        Effect.mapError(persistenceError("Could not remove the channel's contacts.")),
      );
      yield* sql`DELETE FROM chat_channels WHERE channel_id = ${channel.id}`.pipe(
        Effect.mapError(persistenceError("Could not remove the channel.")),
      );
      yield* removeSecrets(
        CREDENTIAL_NAMES.flatMap((name) => {
          const ref = channel.credentials[name]?.ref;
          return ref === undefined ? [] : [ref];
        }),
      );
      yield* notifyChanged;
    }).pipe(Effect.withSpan("ChatChannelService.removeChannel"));

  const upsertContact: ChatChannelService["Service"]["upsertContact"] = (input) =>
    Effect.gen(function* () {
      const channel = yield* loadChannel(input.channelId);
      const siblings = yield* loadContacts(channel.id).pipe(
        Effect.mapError(persistenceError("Could not read the channel's contacts.")),
      );
      const existing =
        input.id === undefined
          ? null
          : (siblings.find(({ config }) => config.id === input.id)?.config ??
            (yield* channelError("That contact no longer exists.")));
      const others = siblings.filter(({ config }) => config.id !== existing?.id);
      if (others.some(({ config }) => config.slug === input.slug)) {
        return yield* channelError(`Another contact already uses the slug ${input.slug}.`);
      }
      if (existing === null && input.phoneNumbers === undefined) {
        return yield* channelError("A contact needs at least one phone number.");
      }
      const normalized = (input.phoneNumbers ?? []).map(normalizePhoneNumber);
      if (normalized.some((number) => number === null)) {
        return yield* channelError(
          "Enter phone numbers in international format, starting with + and the country code.",
        );
      }
      const numbers = [...new Set(normalized as ReadonlyArray<string>)];
      const takenLookups = new Set(
        others.flatMap(({ config }) => config.phoneNumbers.map((number) => number.lookup)),
      );
      if (numbers.some((number) => takenLookups.has(numberLookup(channel.id, number)))) {
        return yield* channelError("One of those numbers already belongs to another contact.");
      }
      const kept = existing?.phoneNumbers ?? [];
      const phoneNumbers: ReadonlyArray<ChatStoredPhoneNumber> =
        input.phoneNumbers === undefined
          ? kept
          : yield* Effect.forEach(numbers, (number) => {
              const lookup = numberLookup(channel.id, number);
              const unchanged = kept.find((stored) => stored.lookup === lookup);
              return unchanged !== undefined
                ? Effect.succeed(unchanged)
                : writeSecret(number).pipe(
                    Effect.map((ref) => ({ ref, masked: maskPhoneNumber(number), lookup })),
                  );
            });
      const written = phoneNumbers.filter((number) => !kept.includes(number));
      const now = yield* nowIso;
      const contact: ChatContactConfig = {
        id: existing?.id ?? ((yield* newId("chat-contact-")) as ChatContactId),
        channelId: channel.id,
        slug: input.slug,
        displayName: input.displayName,
        phoneNumbers,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      yield* saveContact(contact).pipe(
        Effect.tapError(() => removeSecrets(written.map((number) => number.ref))),
      );
      yield* removeSecrets(
        kept.filter((number) => !phoneNumbers.includes(number)).map((number) => number.ref),
      );
      yield* notifyChanged;
      return { contactId: contact.id };
    }).pipe(Effect.withSpan("ChatChannelService.upsertContact"));

  const removeContact: ChatChannelService["Service"]["removeContact"] = (input) =>
    Effect.gen(function* () {
      const contact = yield* requireContact(input.contactId);
      yield* deleteContacts([contact]).pipe(
        Effect.mapError(persistenceError("Could not remove the contact.")),
      );
      yield* notifyChanged;
    }).pipe(Effect.withSpan("ChatChannelService.removeContact"));

  const resolveCredentials = (channel: ChatChannelConfig) =>
    Effect.gen(function* () {
      const tokenRef = channel.credentials.accessToken?.ref;
      const phoneRef = channel.credentials.phoneNumberId?.ref;
      const accessToken = tokenRef === undefined ? Option.none() : yield* readSecret(tokenRef);
      const phoneNumberId = phoneRef === undefined ? Option.none() : yield* readSecret(phoneRef);
      if (Option.isNone(accessToken) || Option.isNone(phoneNumberId)) {
        return yield* channelError("Set the channel's access token and phone number ID first.");
      }
      return {
        accessToken: Redacted.make(accessToken.value),
        phoneNumberId: phoneNumberId.value,
        businessAccountId: channel.businessAccountId,
      } satisfies ChatChannelCredentials;
    });

  const providerFailure = (action: string) => (error: ChatProviderError) =>
    channelError(`Could not ${action}: ${error.message}`);

  const templateStatus: ChatChannelService["Service"]["templateStatus"] = (input) =>
    Effect.gen(function* () {
      const channel = yield* loadChannel(input.channelId);
      if (channel.notifyTemplate === null) {
        return { name: null, state: "missing", category: null, usable: false } as const;
      }
      if (channel.businessAccountId === null) {
        return yield* channelError(
          "Add the WhatsApp Business Account ID to read the template's status.",
        );
      }
      const credentials = yield* resolveCredentials(channel);
      return yield* adapter
        .templateStatus({ credentials, template: channel.notifyTemplate })
        .pipe(Effect.mapError(providerFailure("read the template status")));
    }).pipe(Effect.withSpan("ChatChannelService.templateStatus"));

  const setProductionAccess: ChatChannelService["Service"]["setProductionAccess"] = (input) =>
    Effect.gen(function* () {
      if (input.value === "readOnlyDatabaseUrl") {
        return yield* channelError("Read-only database access is not available yet.");
      }
      yield* sql`
        INSERT INTO chat_settings (id, production_access) VALUES (1, ${input.value})
        ON CONFLICT(id) DO UPDATE SET production_access = excluded.production_access
      `.pipe(Effect.mapError(persistenceError("Could not save production access.")));
      yield* notifyChanged;
    });

  const mutate: ChatChannelService["Service"]["mutate"] = (mutation) => {
    switch (mutation.type) {
      case "channel.upsert":
        return upsertChannel(mutation);
      case "channel.remove":
        return removeChannel(mutation).pipe(Effect.as({}));
      case "channel.setCredential":
        return setCredential(mutation).pipe(Effect.as({}));
      case "contact.upsert":
        return upsertContact(mutation);
      case "contact.remove":
        return removeContact(mutation).pipe(Effect.as({}));
      case "productionAccess.set":
        return setProductionAccess(mutation).pipe(Effect.as({}));
    }
  };

  const windowOpen = (contact: Contact, now: DateTime.Utc) =>
    contact.lastInboundAt !== null &&
    DateTime.toEpochMillis(now) - Date.parse(contact.lastInboundAt) < WINDOW_MS;

  const insertOutbound = (input: {
    readonly channelId: ChatChannelId;
    readonly contactId: ChatContactId;
    readonly content: ChatOutboundContent;
    /** Null for a notify template: it is inserted only with the message it stands for. */
    readonly idempotencyKey: string | null;
    readonly status: "queued" | "pending";
    readonly now: string;
  }) =>
    Effect.gen(function* () {
      const messageId = yield* newId("chat-message-");
      const contentJson = yield* encodeOutbound(input.content);
      yield* sql`
        INSERT INTO chat_messages (
          message_id, channel_id, contact_id, direction, content_json, status,
          idempotency_key, available_at, created_at, updated_at
        )
        VALUES (
          ${messageId}, ${input.channelId}, ${input.contactId}, 'outbound', ${contentJson},
          ${input.status}, ${input.idempotencyKey}, ${input.now}, ${input.now}, ${input.now}
        )
        ON CONFLICT(channel_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
      `;
      if (input.idempotencyKey === null) return null;
      const rows = yield* sql<{
        readonly message_id: string;
        readonly status: string;
        readonly contact_id: string;
      }>`
        SELECT message_id, status, contact_id FROM chat_messages
        WHERE channel_id = ${input.channelId} AND idempotency_key = ${input.idempotencyKey}
      `;
      return { ...rows[0]!, inserted: rows[0]!.message_id === messageId };
    });

  const send: ChatChannelService["Service"]["send"] = (input) =>
    Effect.gen(function* () {
      const contact = yield* requireContact(input.contactId);
      const channel = yield* loadChannel(contact.config.channelId);
      if (
        input.content.type === "media" &&
        resolveAttachmentPathById({ attachmentsDir, attachmentId: input.content.attachmentId }) ===
          null
      ) {
        return yield* channelError("That attachment no longer exists.");
      }
      const now = yield* DateTime.now;
      const open = input.content.type === "template" || windowOpen(contact, now);
      const notifyTemplate = open ? null : channel.notifyTemplate;
      const base = {
        channelId: channel.id,
        contactId: contact.config.id,
        now: DateTime.formatIso(now),
      };
      const row = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const message = yield* insertOutbound({
              ...base,
              content: input.content,
              idempotencyKey: input.idempotencyKey,
              status: open ? "pending" : "queued",
            });
            // The key already names another contact's message: that one is not this send.
            if (message === null || message.contact_id !== contact.config.id) return null;
            // A retry of a send already recorded must not add a notice the first call did not.
            const notifyQueued =
              message.inserted && notifyTemplate !== null && input.notifyText !== undefined;
            if (notifyQueued) {
              yield* insertOutbound({
                ...base,
                content: {
                  type: "template",
                  name: notifyTemplate.name,
                  language: notifyTemplate.language,
                  params: [input.notifyText],
                },
                idempotencyKey: null,
                status: "pending",
              });
            }
            return { ...message, notifyQueued };
          }),
        )
        .pipe(Effect.mapError(persistenceError("Could not queue the message.")));
      if (row === null) {
        return yield* channelError("That idempotency key was already used for another contact.");
      }
      yield* wakeWorker;
      return {
        messageId: row.message_id,
        status: row.status as ChatMessageStatus,
        notifyQueued: row.notifyQueued,
      };
    }).pipe(Effect.withSpan("ChatChannelService.send"));

  const storeInboundMedia = (input: {
    readonly channel: ChatChannelConfig;
    readonly contactId: ChatContactId;
    readonly providerMediaId: string;
  }) =>
    Effect.gen(function* () {
      const credentials = yield* resolveCredentials(input.channel);
      const media = yield* adapter
        .readMedia({ credentials, providerMediaId: input.providerMediaId })
        .pipe(Effect.mapError(providerFailure("download the media")));
      const extension = MEDIA_EXTENSIONS[media.mimeType.split(";", 1)[0]!.trim()] ?? "bin";
      const baseId = createDeterministicAttachmentId(input.contactId, input.providerMediaId);
      const attachmentId = `${baseId}-${extension}`;
      const path =
        baseId === null
          ? null
          : resolveAttachmentRelativePath({
              attachmentsDir,
              relativePath: `${attachmentId}.${extension}`,
            });
      if (path === null) return yield* channelError("Could not store the media.");
      yield* fileSystem
        .writeFile(path, media.bytes)
        .pipe(Effect.mapError(() => channelError("Could not store the media.")));
      return { attachmentId, mimeType: media.mimeType };
    });

  const recordInbound: ChatChannelService["Service"]["recordInbound"] = (message) =>
    Effect.gen(function* () {
      const channel = yield* loadChannel(message.channelId);
      const number = normalizePhoneNumber(
        message.from.startsWith("+") ? message.from : `+${message.from}`,
      );
      if (number === null) return { _tag: "unknown_sender" } as const;
      const lookup = numberLookup(channel.id, number);
      const contacts = yield* loadContacts(channel.id).pipe(
        Effect.mapError(persistenceError("Could not read the channel's contacts.")),
      );
      const contact = contacts.find(({ config }) =>
        config.phoneNumbers.some((stored) => stored.lookup === lookup),
      );
      if (contact === undefined) return { _tag: "unknown_sender" } as const;
      const numberRef = contact.config.phoneNumbers.find((stored) => stored.lookup === lookup)!.ref;
      // Stored in one format, so the window's string comparisons hold.
      const received = DateTime.make(message.receivedAt);
      if (Option.isNone(received)) return yield* channelError("The message time is not valid.");
      const receivedAt = DateTime.formatIso(received.value);
      const messageId = yield* newId("chat-message-");
      const nowUtc = yield* DateTime.now;
      const now = DateTime.formatIso(nowUtc);
      const windowStart = DateTime.formatIso(
        DateTime.subtract(nowUtc, { milliseconds: WINDOW_MS }),
      );
      const inserted = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{ readonly message_id: string }>`
              INSERT INTO chat_messages (
                message_id, channel_id, contact_id, direction, content_json, status,
                provider_message_id, available_at, created_at, updated_at
              )
              VALUES (
                ${messageId}, ${channel.id}, ${contact.config.id}, 'inbound',
                ${yield* encodeInbound(message.content)}, 'received',
                ${message.providerMessageId}, ${now}, ${receivedAt}, ${now}
              )
              ON CONFLICT(channel_id, provider_message_id) WHERE direction = 'inbound' DO NOTHING
              RETURNING message_id
            `;
            if (rows.length === 0) return false;
            // A late replay must not move the window back, nor reopen one that has since closed.
            yield* sql`
              UPDATE chat_contacts
              SET
                last_inbound_at = ${receivedAt},
                last_inbound_number_ref = ${numberRef}
              WHERE contact_id = ${contact.config.id}
                AND (last_inbound_at IS NULL OR last_inbound_at < ${receivedAt})
            `;
            // Released in the same commit, so an open window never leaves messages held.
            yield* sql`
              UPDATE chat_messages
              SET status = 'pending', available_at = ${now}, updated_at = ${now}
              WHERE contact_id = ${contact.config.id}
                AND status = 'queued'
                AND EXISTS (
                  SELECT 1 FROM chat_contacts
                  WHERE contact_id = ${contact.config.id} AND last_inbound_at > ${windowStart}
                )
            `;
            return true;
          }),
        )
        .pipe(Effect.mapError(persistenceError("Could not record the message.")));
      if (!inserted) return { _tag: "duplicate" } as const;
      yield* wakeWorker;
      if (message.content.type === "media") {
        const content = message.content;
        yield* storeInboundMedia({
          channel,
          contactId: contact.config.id,
          providerMediaId: content.providerMediaId,
        }).pipe(
          Effect.flatMap((stored) =>
            encodeInbound({ ...content, attachmentId: stored.attachmentId }).pipe(
              Effect.flatMap(
                (json) =>
                  sql`UPDATE chat_messages SET content_json = ${json} WHERE message_id = ${messageId}`,
              ),
            ),
          ),
          // The message is kept without its media; WhatsApp media ids expire, so nothing refetches it.
          Effect.catch((error) =>
            Effect.logWarning("Could not store inbound chat media", {
              messageId,
              errorTag: error._tag,
            }),
          ),
        );
      }
      return { _tag: "recorded", contactId: contact.config.id, messageId } as const;
    }).pipe(Effect.withSpan("ChatChannelService.recordInbound"));

  // --- outbox worker ---------------------------------------------------------

  // A contact's messages go out in order: one waiting out a retry holds back the ones after it.
  const firstPendingOfContact = sql`
    candidate.status = 'pending'
    AND NOT EXISTS (
      SELECT 1 FROM chat_messages AS earlier
      WHERE earlier.contact_id = candidate.contact_id
        AND earlier.status = 'pending'
        AND earlier.rowid < candidate.rowid
    )
  `;

  const claimNext = Effect.gen(function* () {
    const now = yield* nowIso;
    const rows = yield* sql<MessageRow>`
      UPDATE chat_messages
      SET status = 'preparing', attempt_count = attempt_count + 1, updated_at = ${now}
      WHERE message_id = (
        SELECT candidate.message_id
        FROM chat_messages AS candidate
        WHERE candidate.available_at <= ${now} AND ${firstPendingOfContact}
        ORDER BY candidate.rowid
        LIMIT 1
      )
      RETURNING message_id, channel_id, contact_id, content_json, status, attempt_count
    `;
    return Option.fromNullishOr(rows[0]);
  });

  /** Moves a claimed row on from `from`; a row no longer in that state is left alone. */
  const settle = (
    messageId: string,
    from: "preparing" | "posting",
    status: ChatMessageStatus,
    fields: {
      readonly providerMessageId?: string;
      readonly error?: string;
      readonly delayMs?: number;
    },
  ) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const availableAt = DateTime.formatIso(
        DateTime.add(now, { milliseconds: fields.delayMs ?? 0 }),
      );
      yield* sql`
        UPDATE chat_messages
        SET
          status = ${status},
          provider_message_id = COALESCE(${fields.providerMessageId ?? null}, provider_message_id),
          last_error = ${fields.error ?? null},
          available_at = ${availableAt},
          updated_at = ${DateTime.formatIso(now)}
        WHERE message_id = ${messageId} AND status = ${from}
      `;
    });

  const recipient = (contact: Contact) =>
    Effect.gen(function* () {
      const numbers = contact.config.phoneNumbers;
      // Reply to the number the person last wrote from; its window is the open one.
      const ref =
        numbers.find((number) => number.ref === contact.lastInboundNumberRef)?.ref ??
        numbers[0]?.ref;
      const value = ref === undefined ? Option.none() : yield* readSecret(ref);
      return Option.isNone(value)
        ? yield* channelError("The contact has no phone number.")
        : value.value;
    });

  const attachmentMedia = (content: ChatOutboundContent) =>
    Effect.gen(function* () {
      if (content.type !== "media") return undefined;
      const path = resolveAttachmentPathById({
        attachmentsDir,
        attachmentId: content.attachmentId,
      });
      if (path === null) return yield* channelError("The attachment no longer exists.");
      const bytes = yield* fileSystem
        .readFile(path)
        .pipe(Effect.mapError(() => channelError("Could not read the attachment.")));
      const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
      const mimeType =
        Object.entries(MEDIA_EXTENSIONS).find(([, ext]) => ext === extension)?.[0] ??
        "application/octet-stream";
      return { bytes, mimeType, fileName: content.filename ?? `attachment.${extension}` };
    });

  const deliver = (row: MessageRow) =>
    Effect.gen(function* () {
      const contact = yield* loadContact(row.contact_id as ChatContactId);
      if (Option.isNone(contact)) {
        return yield* settle(row.message_id, "preparing", "cancelled", {
          error: "The contact was removed.",
        });
      }
      const decoded = yield* decodeOutbound(row.content_json).pipe(Effect.option);
      if (Option.isNone(decoded)) {
        return yield* settle(row.message_id, "preparing", "failed", {
          error: "The stored message could not be read.",
        });
      }
      const content = decoded.value;
      if (content.type !== "template" && !windowOpen(contact.value, yield* DateTime.now)) {
        return yield* settle(row.message_id, "preparing", "queued", {});
      }
      const channel = yield* loadChannel(row.channel_id as ChatChannelId);
      const credentials = yield* resolveCredentials(channel);
      if (content.type === "template") {
        const checked = yield* adapter
          .templateStatus({ credentials, template: content })
          .pipe(Effect.result);
        if (checked._tag === "Failure") return yield* prepareFailed(row, checked.failure);
        if (!checked.success.usable) {
          return yield* settle(row.message_id, "preparing", "failed", {
            error: `Template ${content.name} is not an approved UTILITY template.`,
          });
        }
      }
      const to = yield* recipient(contact.value);
      const media = yield* attachmentMedia(content);
      const prepared = yield* adapter
        .prepare({ credentials, to, content, ...(media === undefined ? {} : { media }) })
        .pipe(Effect.result);
      if (prepared._tag === "Failure") return yield* prepareFailed(row, prepared.failure);

      const now = yield* nowIso;
      const posting = yield* sql<{ readonly message_id: string }>`
        UPDATE chat_messages SET status = 'posting', updated_at = ${now}
        WHERE message_id = ${row.message_id} AND status = 'preparing'
        RETURNING message_id
      `;
      if (posting.length === 0) return;
      const sent = yield* adapter
        .post({ credentials, message: prepared.success })
        .pipe(Effect.result);
      if (sent._tag === "Success") {
        return yield* settle(row.message_id, "posting", "sent", {
          providerMessageId: sent.success.providerMessageId,
        });
      }
      const error = sent.failure;
      if (error._tag === "ChatProviderNoAnswerError") {
        return yield* settle(row.message_id, "posting", "unknown", { error: error.message });
      }
      switch (error.reason) {
        case "window_closed":
          return content.type === "template"
            ? yield* settle(row.message_id, "posting", "failed", { error: error.message })
            : yield* settle(row.message_id, "posting", "queued", {});
        case "rate_limited":
          return yield* retryOrFail(row, "posting", error.message);
        case "undeliverable":
        case "invalid":
          return yield* settle(row.message_id, "posting", "failed", { error: error.message });
      }
    }).pipe(
      // Every ChatChannelError comes before the post, so nothing was sent: retry it later.
      Effect.catchTags({
        ChatChannelError: (error) => retryOrFail(row, "preparing", error.message),
      }),
      // Any other failure or defect: a posting row may have gone out and is never
      // resent; a preparing one is retried, so it keeps its place ahead of later messages.
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logError("Chat outbox delivery failed", {
              messageId: row.message_id,
              defect: Cause.hasDies(cause),
            }).pipe(
              Effect.andThen(
                settle(row.message_id, "posting", "unknown", {
                  error: "Delivery stopped unexpectedly.",
                }),
              ),
              Effect.andThen(retryOrFail(row, "preparing", "Delivery stopped unexpectedly.")),
              Effect.ignore,
            ),
      ),
      Effect.withSpan("ChatChannelService.deliver", {
        attributes: { "chat.message_id": row.message_id },
      }),
    );

  /** Nothing was sent yet: a refusal other than throttling fails now, anything else retries. */
  const prepareFailed = (row: MessageRow, error: ChatProviderError) =>
    error._tag === "ChatProviderRejectedError" && error.reason !== "rate_limited"
      ? settle(row.message_id, "preparing", "failed", { error: error.message })
      : retryOrFail(row, "preparing", error.message);

  const retryOrFail = (row: MessageRow, from: "preparing" | "posting", error: string) =>
    row.attempt_count >= MAX_SEND_ATTEMPTS
      ? settle(row.message_id, from, "failed", { error })
      : settle(row.message_id, from, "pending", {
          error,
          delayMs: RETRY_DELAYS_MS[Math.min(row.attempt_count, RETRY_DELAYS_MS.length) - 1]!,
        });

  const processDue: Effect.Effect<void> = Effect.gen(function* () {
    while (true) {
      const row = yield* claimNext;
      if (Option.isNone(row)) break;
      yield* deliver(row.value);
    }
    yield* scheduleNextWake;
  }).pipe(Effect.catch((cause) => Effect.logError("Chat outbox pass failed", { cause })));

  const worker = yield* makeDrainableWorker(() => processDue);
  const wakeWorker = worker.enqueue(undefined);

  const pendingWake = yield* Ref.make<Option.Option<Fiber.Fiber<void>>>(Option.none());
  /** One timer for the earliest retry, replaced on every pass. */
  const scheduleNextWake = Effect.gen(function* () {
    const previous = yield* Ref.getAndSet(pendingWake, Option.none());
    if (Option.isSome(previous)) yield* Fiber.interrupt(previous.value);
    // Only rows the next pass could claim: a held-back row's past due time would spin the timer.
    const rows = yield* sql<{ readonly available_at: string | null }>`
      SELECT MIN(candidate.available_at) AS available_at
      FROM chat_messages AS candidate
      WHERE ${firstPendingOfContact}
    `;
    const next = rows[0]?.available_at;
    if (next == null) return;
    const delayMs = Math.max(0, Date.parse(next) - DateTime.toEpochMillis(yield* DateTime.now));
    const fiber = yield* wakeWorker.pipe(Effect.delay(delayMs), Effect.forkIn(layerScope));
    yield* Ref.set(pendingWake, Option.some(fiber));
  });

  // Rows a stopped server had claimed: one still preparing never reached the
  // provider and is retried; one posting may have gone out and is never resent.
  yield* sql`
    UPDATE chat_messages SET status = 'pending' WHERE status = 'preparing'
  `.pipe(Effect.orDie);
  const recovered = yield* sql<{ readonly message_id: string }>`
    UPDATE chat_messages
    SET status = 'unknown',
        last_error = 'The server stopped while sending this message, so it was not sent again.'
    WHERE status = 'posting'
    RETURNING message_id
  `.pipe(Effect.orDie);
  if (recovered.length > 0) {
    yield* Effect.logWarning("Chat messages interrupted mid-send were not resent", {
      count: recovered.length,
    });
  }

  // Settings reject an invalid app secret; one stored by older code or edited on disk is reported.
  yield* Effect.forEach(
    yield* loadChannels.pipe(Effect.orElseSucceed(() => [])),
    (channel) => {
      const ref = channel.credentials.appSecret?.ref;
      return ref === undefined
        ? Effect.void
        : readSecret(ref).pipe(
            Effect.flatMap((value) =>
              Option.isSome(value) && adapter.credentialProblem("appSecret", value.value) !== null
                ? Effect.logWarning(
                    "A chat channel's app secret is not 32 hexadecimal characters",
                    {
                      channelId: channel.id,
                    },
                  )
                : Effect.void,
            ),
            Effect.ignore,
          );
    },
    { discard: true },
  );
  yield* wakeWorker;

  return ChatChannelService.of({
    subscribe,
    upsertChannel,
    removeChannel,
    setCredential,
    upsertContact,
    removeContact,
    templateStatus,
    setProductionAccess,
    mutate,
    send,
    recordInbound,
    drainOutbox: worker.drain,
  });
});

export const layer = Layer.effect(ChatChannelService, make);
