import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { ChatChannelId, ChatChannelsSnapshot, ChatContactId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ChatChannelService from "./ChatChannelService.ts";
import * as FakeWhatsAppGraph from "./testkit/FakeWhatsAppGraph.ts";
import * as WhatsAppCloudAdapter from "./WhatsAppCloudAdapter.ts";

const NUMBER = "+15550142";
const ACCESS_TOKEN = FakeWhatsAppGraph.FAKE_TOKEN;
const APP_SECRET = "0123456789abcdef0123456789abcdef";
const VERIFY_TOKEN = "verify-token-value";
const SECRET_VALUES = [ACCESS_TOKEN, APP_SECRET, VERIFY_TOKEN, "5550142", "5550143"];
const TEMPLATE = { name: "bugbot_notice", language: "en" };

/** A secret store in memory, so a test can see exactly what it holds. */
const makeSecretStore = () => {
  const values = new Map<string, Uint8Array>();
  /** Set to make the next chat secret read die, as a bug would. */
  const control = { dieOnNextChatSecretRead: false };
  const layer = Layer.succeed(ServerSecretStore.ServerSecretStore, {
    get: (name) =>
      Effect.suspend(() => {
        if (control.dieOnNextChatSecretRead && name.startsWith("chat-secret-")) {
          control.dieOnNextChatSecretRead = false;
          return Effect.die("secret store bug");
        }
        return Effect.succeed(Option.fromNullishOr(values.get(name)));
      }),
    set: (name, value) => Effect.sync(() => void values.set(name, value)),
    create: (name, value) => Effect.sync(() => void values.set(name, value)),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        const existing = values.get(name);
        if (existing !== undefined) return existing;
        const created = new Uint8Array(bytes).fill(7);
        values.set(name, created);
        return created;
      }),
    remove: (name) => Effect.sync(() => void values.delete(name)),
  });
  const stored = () => [...values.values()].map((bytes) => new TextDecoder().decode(bytes));
  return { values, layer, stored, control };
};

interface Harness {
  readonly fake: FakeWhatsAppGraph.FakeWhatsAppGraph;
  readonly secrets: ReturnType<typeof makeSecretStore>;
  readonly baseDir: string;
  readonly logs: Array<string>;
}

const makeHarness = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return {
    fake: yield* FakeWhatsAppGraph.make,
    secrets: makeSecretStore(),
    baseDir: yield* fs.makeTempDirectoryScoped({ prefix: "chat-service-" }),
    logs: [],
  } satisfies Harness;
});

/** One server run: the service on `sqlLayer`, with every log line kept for the leak checks. */
const runService = <A, E, LE>(
  harness: Harness,
  sqlLayer: Layer.Layer<SqlClient.SqlClient, LE>,
  body: (
    service: ChatChannelService.ChatChannelService["Service"],
  ) => Effect.Effect<A, E, SqlClient.SqlClient | ServerConfig.ServerConfig | FileSystem.FileSystem>,
) => {
  const logger = Logger.make(({ message, fiber }) => {
    harness.logs.push(
      JSON.stringify({ message, annotations: fiber.getRef(References.CurrentLogAnnotations) }),
    );
  });
  const service = ChatChannelService.layer.pipe(
    Layer.provide(
      WhatsAppCloudAdapter.layer.pipe(Layer.provide(FakeWhatsAppGraph.layerFor(harness.fake))),
    ),
    Layer.provide(harness.secrets.layer),
    Layer.provide(NodeCrypto.layer),
  );
  return Effect.gen(function* () {
    return yield* body(yield* ChatChannelService.ChatChannelService);
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        service,
        Layer.provideMerge(
          Layer.merge(sqlLayer, ServerConfig.layerTest(process.cwd(), harness.baseDir)),
          NodeServices.layer,
        ),
      ).pipe(Layer.provide(Logger.layer([logger], { mergeWithExisting: false }))),
    ),
  );
};

const snapshotOf = (service: ChatChannelService.ChatChannelService["Service"]) =>
  service.subscribe().pipe(Stream.runHead, Effect.map(Option.getOrThrow));

/** A WhatsApp channel with every credential set and the notify template configured. */
const setUpChannel = (service: ChatChannelService.ChatChannelService["Service"]) =>
  Effect.gen(function* () {
    const { channelId } = yield* service.upsertChannel({
      kind: "whatsapp",
      label: "BugBot",
      businessAccountId: FakeWhatsAppGraph.FAKE_BUSINESS_ACCOUNT_ID,
      notifyTemplate: TEMPLATE,
    });
    for (const [name, value] of [
      ["accessToken", ACCESS_TOKEN],
      ["phoneNumberId", FakeWhatsAppGraph.FAKE_PHONE_NUMBER_ID],
      ["appSecret", APP_SECRET],
      ["verifyToken", VERIFY_TOKEN],
    ] as const) {
      yield* service.setCredential({ channelId, name, value });
    }
    const { contactId } = yield* service.upsertContact({
      channelId,
      slug: "akiva",
      displayName: "Akiva",
      phoneNumbers: ["+1 (555) 01-42"],
    });
    return { channelId, contactId };
  });

const inbound = (
  service: ChatChannelService.ChatChannelService["Service"],
  channelId: ChatChannelId,
  input: { readonly id: string; readonly from?: string; readonly hoursAgo?: number },
) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    return yield* service.recordInbound({
      channelId,
      // Webhooks carry the number without its plus.
      from: (input.from ?? NUMBER).slice(1),
      providerMessageId: input.id,
      receivedAt: DateTime.formatIso(DateTime.subtract(now, { hours: input.hoursAgo ?? 0 })),
      content: { type: "text", text: "It broke again" },
    });
  });

const statusOf = (messageId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly status: string }>`
      SELECT status FROM chat_messages WHERE message_id = ${messageId}
    `;
    return rows[0]?.status;
  });

const messagePosts = (fake: FakeWhatsAppGraph.FakeWhatsAppGraph) =>
  fake.requests.filter((request) => request.path.endsWith("/messages"));

const assertNoSecrets = (label: string, text: string) => {
  for (const value of SECRET_VALUES) {
    assert.notInclude(text, value, `${label} leaks a secret or number`);
  }
};

const provideBase = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("ChatChannelService", () => {
  it.effect("keeps credentials and numbers out of snapshots, rows, refs and logs", () =>
    provideBase(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* runService(harness, SqlitePersistence.layerMemory, (service) =>
          Effect.gen(function* () {
            const { channelId, contactId } = yield* setUpChannel(service);
            yield* inbound(service, channelId, { id: "wamid.in1" });
            yield* service.send({
              contactId,
              content: { type: "text", text: "On it" },
              idempotencyKey: "reply-1",
            });
            yield* service.drainOutbox;

            const snapshot: ChatChannelsSnapshot = yield* snapshotOf(service);
            const snapshotText = JSON.stringify(snapshot);
            assertNoSecrets("snapshot", snapshotText);
            assert.notInclude(snapshotText, "chat-secret:");
            assert.deepEqual(
              snapshot.channels[0]?.credentials.map(({ name, set }) => [name, set]),
              [
                ["accessToken", true],
                ["phoneNumberId", true],
                ["appSecret", true],
                ["verifyToken", true],
              ],
            );
            assert.deepEqual(snapshot.contacts[0]?.phoneNumbers, ["•••• ••42"]);

            const sql = yield* SqlClient.SqlClient;
            for (const table of [
              "chat_channels",
              "chat_contacts",
              "chat_messages",
              "chat_settings",
            ]) {
              const rows = yield* sql.unsafe(`SELECT * FROM ${table}`);
              assertNoSecrets(table, JSON.stringify(rows));
            }
            assert.notInclude(harness.logs.join("\n"), "5550142");
            assertNoSecrets("logs", harness.logs.join("\n"));
            // The values are in the secret store, and only there.
            assert.includeMembers(harness.secrets.stored(), [ACCESS_TOKEN, APP_SECRET, NUMBER]);
            assert.equal(messagePosts(harness.fake).length, 1);
            assert.deepEqual(harness.fake.violations, []);
          }),
        );
      }),
    ),
  );

  it.effect("rejects an app secret that is not 32 hex characters when it is entered", () =>
    provideBase(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* runService(harness, SqlitePersistence.layerMemory, (service) =>
          Effect.gen(function* () {
            const { channelId } = yield* service.upsertChannel({
              kind: "whatsapp",
              label: "BugBot",
              businessAccountId: null,
              notifyTemplate: null,
            });
            const error = yield* service
              .setCredential({ channelId, name: "appSecret", value: "not-a-meta-app-secret" })
              .pipe(Effect.flip);
            assert.include(error.message, "32 hexadecimal");
            assert.notInclude(error.message, "not-a-meta-app-secret");
            const snapshot = yield* snapshotOf(service);
            assert.isFalse(
              snapshot.channels[0]!.credentials.find(({ name }) => name === "appSecret")!.set,
            );
            assert.lengthOf(harness.secrets.stored(), 1); // only the number lookup key
          }),
        );
      }),
    ),
  );

  it.effect(
    "queues outside the window, notifies with a UTILITY template, and flushes on the next message",
    () =>
      provideBase(
        Effect.gen(function* () {
          const harness = yield* makeHarness;
          harness.fake.templates.push({ ...TEMPLATE, status: "APPROVED", category: "UTILITY" });
          yield* runService(harness, SqlitePersistence.layerMemory, (service) =>
            Effect.gen(function* () {
              const { channelId, contactId } = yield* setUpChannel(service);
              const queued = yield* service.send({
                contactId,
                content: { type: "text", text: "Your fix is ready" },
                idempotencyKey: "notice-1",
                notifyText: "There is an update on your bug report",
              });
              assert.equal(queued.status, "queued");
              assert.isTrue(queued.notifyQueued);
              yield* service.drainOutbox;
              assert.deepEqual(
                harness.fake.sent().map((payload) => payload.type),
                ["template"],
              );
              assert.equal(yield* statusOf(queued.messageId), "queued");

              assert.equal(
                (yield* inbound(service, channelId, { id: "wamid.in1" }))._tag,
                "recorded",
              );
              yield* service.drainOutbox;
              assert.equal(yield* statusOf(queued.messageId), "sent");
              const sent = harness.fake.sent();
              assert.deepEqual(
                sent.map((payload) => payload.type),
                ["template", "text"],
              );
              assert.equal(sent[1]!.to, NUMBER.slice(1));

              // Inside the window a message goes straight out.
              const direct = yield* service.send({
                contactId,
                content: { type: "text", text: "Anything else?" },
                idempotencyKey: "reply-2",
              });
              assert.equal(direct.status, "pending");
              yield* service.drainOutbox;
              assert.equal(yield* statusOf(direct.messageId), "sent");
              assert.deepEqual(harness.fake.violations, []);
            }),
          );
        }),
      ),
  );

  it.effect("never sends a notify template that is not an approved UTILITY template", () =>
    provideBase(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        harness.fake.templates.push({ ...TEMPLATE, status: "APPROVED", category: "MARKETING" });
        yield* runService(harness, SqlitePersistence.layerMemory, (service) =>
          Effect.gen(function* () {
            const { contactId } = yield* setUpChannel(service);
            const queued = yield* service.send({
              contactId,
              content: { type: "text", text: "Your fix is ready" },
              idempotencyKey: "notice-1",
              notifyText: "There is an update",
            });
            yield* service.drainOutbox;
            assert.lengthOf(messagePosts(harness.fake), 0);
            assert.equal(yield* statusOf(queued.messageId), "queued");
            const sql = yield* SqlClient.SqlClient;
            const notify = yield* sql<{ readonly status: string; readonly last_error: string }>`
              SELECT status, last_error FROM chat_messages
              WHERE json_extract(content_json, '$.type') = 'template'
            `;
            assert.equal(notify[0]?.status, "failed");
            assert.include(notify[0]!.last_error, "UTILITY");
          }),
        );
      }),
    ),
  );

  it.effect("refuses a notify template without the business account ID to check it", () =>
    provideBase(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* runService(harness, SqlitePersistence.layerMemory, (service) =>
          Effect.gen(function* () {
            const error = yield* service
              .upsertChannel({
                kind: "whatsapp",
                label: "BugBot",
                businessAccountId: null,
                notifyTemplate: TEMPLATE,
              })
              .pipe(Effect.flip);
            assert.include(error.message, "Business Account ID");
            assert.lengthOf((yield* snapshotOf(service)).channels, 0);
          }),
        );
      }),
    ),
  );

  it.effect("fails a template the provider refuses to look up without retrying", () =>
    provideBase(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* runService(harness, SqlitePersistence.layerMemory, (service) =>
          Effect.gen(function* () {
            const { contactId } = yield* setUpChannel(service);
            harness.fake.failNext("/message_templates", { kind: "error", status: 400, code: 100 });
            const { messageId } = yield* service.send({
              contactId,
              content: { type: "template", name: TEMPLATE.name, language: "en", params: [] },
              idempotencyKey: "template-1",
            });
            yield* service.drainOutbox;
            assert.equal(yield* statusOf(messageId), "failed");
            assert.lengthOf(
              harness.fake.requests.filter((request) =>
                request.path.endsWith("/message_templates"),
              ),
              1,
            );
            assert.lengthOf(messagePosts(harness.fake), 0);
          }),
        );
      }),
    ),
  );

  it.effect("refuses an idempotency key already used for another contact", () =>
    provideBase(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* runService(harness, SqlitePersistence.layerMemory, (service) =>
          Effect.gen(function* () {
            const { channelId, contactId } = yield* setUpChannel(service);
            const other = yield* service.upsertContact({
              channelId,
              slug: "julius",
              displayName: "Julius",
              phoneNumbers: ["+15550143"],
            });
            yield* service.send({
              contactId,
              content: { type: "text", text: "For Akiva" },
              idempotencyKey: "shared",
              notifyText: "Update",
            });
            const error = yield* service
              .send({
                contactId: other.contactId,
                content: { type: "text", text: "For Julius" },
                idempotencyKey: "shared",
                notifyText: "Update",
              })
              .pipe(Effect.flip);
            assert.include(error.message, "another contact");
            const sql = yield* SqlClient.SqlClient;
            const rows = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM chat_messages WHERE contact_id = ${other.contactId}
            `;
            assert.equal(rows[0]?.count, 0);
          }),
        );
      }),
    ),
  );

  it.effect("a retried send never adds a notice the first send did not queue", () =>
    provideBase(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        harness.fake.templates.push({ ...TEMPLATE, status: "APPROVED", category: "UTILITY" });
        yield* runService(harness, SqlitePersistence.layerMemory, (service) =>
          Effect.gen(function* () {
            const { channelId, contactId } = yield* setUpChannel(service);
            yield* inbound(service, channelId, { id: "wamid.in1" });
            const send = service.send({
              contactId,
              content: { type: "text", text: "Your fix is ready" },
              idempotencyKey: "fix-ready",
              notifyText: "There is an update",
            });
            const first = yield* send;
            assert.isFalse(first.notifyQueued);
            yield* service.drainOutbox;
            yield* TestClock.adjust("25 hours");
            const retried = yield* send;
            yield* service.drainOutbox;
            assert.equal(retried.messageId, first.messageId);
            assert.isFalse(retried.notifyQueued);
            assert.deepEqual(
              harness.fake.sent().map((payload) => payload.type),
              ["text"],
            );
          }),
        );
      }),
    ),
  );

  it.effect("sends once per idempotency key", () =>
    provideBase(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* runService(harness, SqlitePersistence.layerMemory, (service) =>
          Effect.gen(function* () {
            const { channelId, contactId } = yield* setUpChannel(service);
            yield* inbound(service, channelId, { id: "wamid.in1" });
            const send = service.send({
              contactId,
              content: { type: "text", text: "Once" },
              idempotencyKey: "same-key",
            });
            const first = yield* send;
            yield* service.drainOutbox;
            const second = yield* send;
            yield* service.drainOutbox;
            assert.equal(second.messageId, first.messageId);
            assert.equal(second.status, "sent");
            assert.lengthOf(messagePosts(harness.fake), 1);
          }),
        );
      }),
    ),
  );

  it.effect("retries a throttled send after its backoff and sends it once", () =>
    provideBase(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* runService(harness, SqlitePersistence.layerMemory, (service) =>
          Effect.gen(function* () {
            const { channelId, contactId } = yield* setUpChannel(service);
            yield* inbound(service, channelId, { id: "wamid.in1" });
            harness.fake.failNext("/messages", { kind: "error", status: 429, code: 130429 });
            const { messageId } = yield* service.send({
              contactId,
              content: { type: "text", text: "Hello" },
              idempotencyKey: "throttled",
            });
            yield* service.drainOutbox;
            assert.equal(yield* statusOf(messageId), "pending");
            // A later message waits behind the throttled one instead of overtaking it.
            const later = yield* service.send({
              contactId,
              content: { type: "text", text: "Second" },
              idempotencyKey: "later",
            });
            yield* service.drainOutbox;
            assert.equal(yield* statusOf(later.messageId), "pending");
            assert.lengthOf(messagePosts(harness.fake), 1);

            yield* TestClock.adjust("10 seconds");
            yield* Effect.yieldNow;
            yield* service.drainOutbox;
            assert.equal(yield* statusOf(messageId), "sent");
            assert.equal(yield* statusOf(later.messageId), "sent");
            assert.deepEqual(
              harness.fake.sent().map((payload) => (payload.text as { body: string }).body),
              ["Hello", "Hello", "Second"],
            );
          }),
        );
      }),
    ),
  );

  it.effect("retries a message whose preparation died, keeping it ahead of later ones", () =>
    provideBase(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* runService(harness, SqlitePersistence.layerMemory, (service) =>
          Effect.gen(function* () {
            const { channelId, contactId } = yield* setUpChannel(service);
            yield* inbound(service, channelId, { id: "wamid.in1" });
            harness.secrets.control.dieOnNextChatSecretRead = true;
            const first = yield* service.send({
              contactId,
              content: { type: "text", text: "First" },
              idempotencyKey: "first",
            });
            yield* service.drainOutbox;
            assert.equal(yield* statusOf(first.messageId), "pending");
            const second = yield* service.send({
              contactId,
              content: { type: "text", text: "Second" },
              idempotencyKey: "second",
            });
            yield* service.drainOutbox;
            assert.equal(yield* statusOf(second.messageId), "pending");
            assert.lengthOf(messagePosts(harness.fake), 0);

            yield* TestClock.adjust("10 seconds");
            yield* Effect.yieldNow;
            yield* service.drainOutbox;
            assert.deepEqual(
              harness.fake.sent().map((payload) => (payload.text as { body: string }).body),
              ["First", "Second"],
            );
          }),
        );
      }),
    ),
  );

  it.effect("never resends a message whose send got no answer", () =>
    provideBase(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* runService(harness, SqlitePersistence.layerMemory, (service) =>
          Effect.gen(function* () {
            const { channelId, contactId } = yield* setUpChannel(service);
            yield* inbound(service, channelId, { id: "wamid.in1" });
            harness.fake.failNext("/messages", { kind: "drop" });
            const { messageId } = yield* service.send({
              contactId,
              content: { type: "text", text: "Hello" },
              idempotencyKey: "dropped",
            });
            yield* service.drainOutbox;
            yield* TestClock.adjust("1 hour");
            yield* service.drainOutbox;
            assert.equal(yield* statusOf(messageId), "unknown");
            assert.lengthOf(messagePosts(harness.fake), 1);
          }),
        );
      }),
    ),
  );

  it.effect("keeps the outbox across a restart without sending anything twice", () =>
    provideBase(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "chat-outbox-" });
        const database = SqlitePersistence.layerFromPath(`${dir}/state.sqlite`).pipe(
          Layer.provide(NodeServices.layer),
        );
        const harness = yield* makeHarness;
        const ids = yield* runService(harness, database, (service) =>
          Effect.gen(function* () {
            const { channelId, contactId } = yield* setUpChannel(service);
            // Held outside the window.
            const held = yield* service.send({
              contactId,
              content: { type: "text", text: "Held" },
              idempotencyKey: "held",
            });
            const sql = yield* SqlClient.SqlClient;
            // A server that stopped after committing `posting`, before recording the result.
            const cut = yield* service.send({
              contactId,
              content: { type: "text", text: "Cut off" },
              idempotencyKey: "cut",
            });
            yield* sql`UPDATE chat_messages SET status = 'posting' WHERE message_id = ${cut.messageId}`;
            // And one that stopped while still preparing, before any provider call.
            const prepping = yield* service.send({
              contactId,
              content: { type: "text", text: "Prepared" },
              idempotencyKey: "prepping",
            });
            yield* sql`UPDATE chat_messages SET status = 'preparing' WHERE message_id = ${prepping.messageId}`;
            return {
              channelId,
              contactId,
              held: held.messageId,
              cut: cut.messageId,
              prepping: prepping.messageId,
            };
          }),
        );
        assert.lengthOf(messagePosts(harness.fake), 0);

        yield* runService(harness, database, (service) =>
          Effect.gen(function* () {
            yield* service.drainOutbox;
            assert.equal(yield* statusOf(ids.cut), "unknown");
            assert.equal(yield* statusOf(ids.held), "queued");
            // Back to pending, then held for the window like any other message.
            assert.equal(yield* statusOf(ids.prepping), "queued");
            assert.lengthOf(messagePosts(harness.fake), 0);

            yield* inbound(service, ids.channelId, { id: "wamid.in1" });
            yield* service.drainOutbox;
            assert.equal(yield* statusOf(ids.held), "sent");
            assert.equal(yield* statusOf(ids.prepping), "sent");
            assert.equal(yield* statusOf(ids.cut), "unknown");
            assert.deepEqual(
              harness.fake.sent().map((payload) => (payload.text as { body: string }).body),
              ["Held", "Prepared"],
            );
          }),
        );
      }),
    ),
  );

  it.effect("records each inbound message once, drops unknown senders, and stores media", () =>
    provideBase(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* runService(harness, SqlitePersistence.layerMemory, (service) =>
          Effect.gen(function* () {
            const { channelId, contactId } = yield* setUpChannel(service);
            assert.equal(
              (yield* inbound(service, channelId, { id: "wamid.in1" }))._tag,
              "recorded",
            );
            assert.equal(
              (yield* inbound(service, channelId, { id: "wamid.in1" }))._tag,
              "duplicate",
            );
            assert.equal(
              (yield* inbound(service, channelId, { id: "wamid.in2", from: "+15550199" }))._tag,
              "unknown_sender",
            );

            const mediaId = harness.fake.addMedia(new Uint8Array([9, 8, 7]), "image/png");
            const now = yield* DateTime.now;
            const recorded = yield* service.recordInbound({
              channelId,
              from: NUMBER.slice(1),
              providerMessageId: "wamid.media",
              receivedAt: DateTime.formatIso(now),
              content: { type: "media", mediaKind: "image", providerMediaId: mediaId },
            });
            assert.equal(recorded._tag, "recorded");
            const sql = yield* SqlClient.SqlClient;
            const rows = yield* sql<{ readonly attachment_id: string | null }>`
              SELECT json_extract(content_json, '$.attachmentId') AS attachment_id
              FROM chat_messages WHERE provider_message_id = 'wamid.media'
            `;
            const attachmentId = rows[0]!.attachment_id!;
            const fs = yield* FileSystem.FileSystem;
            const { attachmentsDir } = yield* ServerConfig.ServerConfig;
            assert.deepEqual(
              [...(yield* fs.readFile(`${attachmentsDir}/${attachmentId}.png`))],
              [9, 8, 7],
            );
            const counts = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM chat_messages WHERE contact_id = ${contactId}
            `;
            assert.equal(counts[0]?.count, 2);
          }),
        );
      }),
    ),
  );

  it.effect("does not reopen the window for a message older than 24 hours", () =>
    provideBase(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* runService(harness, SqlitePersistence.layerMemory, (service) =>
          Effect.gen(function* () {
            yield* TestClock.adjust("3 days");
            const { channelId, contactId } = yield* setUpChannel(service);
            yield* inbound(service, channelId, { id: "wamid.late", hoursAgo: 25 });
            const late = yield* service.send({
              contactId,
              content: { type: "text", text: "Hello" },
              idempotencyKey: "late",
            });
            assert.equal(late.status, "queued");
          }),
        );
      }),
    ),
  );

  it.effect("removing a contact or channel deletes its secrets, log and waiting sends", () =>
    provideBase(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* runService(harness, SqlitePersistence.layerMemory, (service) =>
          Effect.gen(function* () {
            const { channelId, contactId } = yield* setUpChannel(service);
            yield* service.send({
              contactId,
              content: { type: "text", text: "Held" },
              idempotencyKey: "held",
            });
            yield* service.removeContact({ contactId });
            assert.notInclude(harness.secrets.stored(), NUMBER);
            const sql = yield* SqlClient.SqlClient;
            const left = yield* sql`SELECT * FROM chat_messages`;
            assert.lengthOf(left, 0);
            assert.lengthOf((yield* snapshotOf(service)).contacts, 0);

            yield* service.removeChannel({ channelId });
            assert.notIncludeMembers(harness.secrets.stored(), [ACCESS_TOKEN, APP_SECRET]);
            assert.lengthOf((yield* snapshotOf(service)).channels, 0);
            const missing = yield* service
              .removeContact({ contactId: contactId as ChatContactId })
              .pipe(Effect.flip);
            assert.equal(missing._tag, "ChatChannelError");
          }),
        );
      }),
    ),
  );

  it.effect(
    "stores production access, defaulting to off, and refuses the read-only URL for now",
    () =>
      provideBase(
        Effect.gen(function* () {
          const harness = yield* makeHarness;
          yield* runService(harness, SqlitePersistence.layerMemory, (service) =>
            Effect.gen(function* () {
              assert.equal((yield* snapshotOf(service)).productionAccess, "off");
              // Clients send this through the single mutation RPC.
              yield* service.mutate({ type: "productionAccess.set", value: "railway" });
              assert.equal((yield* snapshotOf(service)).productionAccess, "railway");
              const refused = yield* service
                .mutate({ type: "productionAccess.set", value: "readOnlyDatabaseUrl" })
                .pipe(Effect.flip);
              assert.equal(refused._tag, "ChatChannelError");
              yield* service.setProductionAccess({ value: "off" });
              assert.equal((yield* snapshotOf(service)).productionAccess, "off");
            }),
          );
        }),
      ),
  );
});
