import { assert, describe, it } from "@effect/vitest";
import type { ChatOutboundContent } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";

import { ChatChannelAdapter, type ChatChannelCredentials } from "./ChatChannelAdapter.ts";
import * as FakeWhatsAppGraph from "./testkit/FakeWhatsAppGraph.ts";
import * as WhatsAppCloudAdapter from "./WhatsAppCloudAdapter.ts";

const credentials: ChatChannelCredentials = {
  accessToken: Redacted.make(FakeWhatsAppGraph.FAKE_TOKEN),
  phoneNumberId: FakeWhatsAppGraph.FAKE_PHONE_NUMBER_ID,
  businessAccountId: FakeWhatsAppGraph.FAKE_BUSINESS_ACCOUNT_ID,
};
const TO = "15550142";

/** Prepare then post, as the outbox does. */
const sendWith =
  (adapter: ChatChannelAdapter["Service"]) =>
  (input: Parameters<ChatChannelAdapter["Service"]["prepare"]>[0]) =>
    adapter
      .prepare(input)
      .pipe(Effect.flatMap((message) => adapter.post({ credentials: input.credentials, message })));

/** Runs `body` with an adapter pointed at a fresh fake; `version` overrides the version setting. */
const withAdapter = <A, E>(
  body: (input: {
    readonly adapter: ChatChannelAdapter["Service"];
    readonly send: ReturnType<typeof sendWith>;
    readonly fake: FakeWhatsAppGraph.FakeWhatsAppGraph;
  }) => Effect.Effect<A, E>,
  options: { readonly baseSuffix?: string; readonly version?: string | undefined } = {},
) =>
  Effect.gen(function* () {
    const fake = yield* FakeWhatsAppGraph.make;
    const api = FakeWhatsAppGraph.layerFor(
      { ...fake, base: `${fake.base}${options.baseSuffix ?? ""}` },
      "version" in options ? options.version : FakeWhatsAppGraph.FAKE_VERSION,
    );
    return yield* Effect.gen(function* () {
      const adapter = yield* ChatChannelAdapter;
      return yield* body({ adapter, send: sendWith(adapter), fake });
    }).pipe(Effect.provide(WhatsAppCloudAdapter.layer.pipe(Layer.provide(api))));
  }).pipe(Effect.scoped);

describe("whatsAppApiRoot", () => {
  it("appends the version unless the base already ends in one", () => {
    assert.equal(
      WhatsAppCloudAdapter.whatsAppApiRoot("https://graph.example/", "v26.0"),
      "https://graph.example/v26.0",
    );
    assert.equal(
      WhatsAppCloudAdapter.whatsAppApiRoot("https://graph.example/v26.0", "v26.0"),
      "https://graph.example/v26.0",
    );
    assert.equal(
      WhatsAppCloudAdapter.whatsAppApiRoot("https://graph.example/v26.0/"),
      "https://graph.example/v26.0",
    );
  });

  it("refuses a base that carries credentials or a malformed or misplaced version", () => {
    for (const base of [
      "https://user:pw@graph.example",
      "https://graph.example/v26",
      "https://graph.example/v26.0/extra",
      "https://graph.example?x=1",
      "ftp://graph.example",
    ]) {
      assert.throws(() => WhatsAppCloudAdapter.whatsAppApiRoot(base));
    }
    assert.throws(() => WhatsAppCloudAdapter.whatsAppApiRoot("https://graph.example", "26"));
  });
});

describe("WhatsAppCloudAdapter", () => {
  it.effect("sends every content kind in the documented shape with an explicit User-Agent", () =>
    withAdapter(({ adapter, send, fake }) =>
      Effect.gen(function* () {
        const contents: ReadonlyArray<ChatOutboundContent> = [
          { type: "text", text: "Hello", replyTo: "wamid.in1" },
          {
            type: "buttons",
            text: "Pick one",
            buttons: [
              { id: "yes", title: "Yes" },
              { id: "no", title: "No" },
            ],
            footer: "Thanks",
          },
          {
            type: "list",
            text: "Pick a row",
            buttonLabel: "Options",
            rows: [{ id: "a", title: "First", description: "The first" }],
            sectionTitle: "Rows",
          },
          { type: "react", messageId: "wamid.in1", emoji: "👍" },
          {
            type: "template",
            name: "bugbot_notice",
            language: "en",
            params: ["line one\nline two\twith     spaces"],
          },
        ];
        for (const content of contents) {
          const sent = yield* send({ credentials, to: TO, content });
          assert.match(sent.providerMessageId, /^wamid\.fake/);
        }
        const media = yield* send({
          credentials,
          to: TO,
          content: {
            type: "media",
            mediaKind: "document",
            attachmentId: "unused",
            caption: "The log",
            filename: "log.txt",
          },
          media: {
            bytes: new TextEncoder().encode("log"),
            mimeType: "text/plain",
            fileName: "log.txt",
          },
        });
        assert.match(media.providerMessageId, /^wamid\.fake/);

        assert.deepEqual(fake.violations, []);
        assert.isTrue(
          fake.requests.every(
            (request) => request.userAgent === WhatsAppCloudAdapter.WHATSAPP_USER_AGENT,
          ),
        );
        const [text, buttons, list, reaction, template, document] = fake.sent();
        assert.deepEqual(text, {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: TO,
          type: "text",
          text: { body: "Hello", preview_url: false },
          context: { message_id: "wamid.in1" },
        });
        assert.deepEqual((buttons!.interactive as Record<string, unknown>).action, {
          buttons: [
            { type: "reply", reply: { id: "yes", title: "Yes" } },
            { type: "reply", reply: { id: "no", title: "No" } },
          ],
        });
        assert.deepEqual((list!.interactive as Record<string, unknown>).action, {
          button: "Options",
          sections: [
            { title: "Rows", rows: [{ id: "a", title: "First", description: "The first" }] },
          ],
        });
        assert.deepEqual(reaction!.reaction, { message_id: "wamid.in1", emoji: "👍" });
        assert.deepEqual(template!.template, {
          name: "bugbot_notice",
          language: { code: "en" },
          components: [
            {
              type: "body",
              parameters: [{ type: "text", text: "line one line two with   spaces" }],
            },
          ],
        });
        assert.deepEqual(document!.document, {
          id: "uploaded-6",
          caption: "The log",
          filename: "log.txt",
        });
        assert.isTrue(fake.requests.some((request) => request.path.endsWith("/media")));
      }),
    ),
  );

  it.effect("never doubles the version when the base already carries it", () =>
    withAdapter(
      ({ send, fake }) =>
        Effect.gen(function* () {
          yield* send({ credentials, to: TO, content: { type: "text", text: "Hi" } });
          assert.deepEqual(fake.violations, []);
          assert.equal(
            fake.requests[0]?.path,
            `/${FakeWhatsAppGraph.FAKE_VERSION}/${FakeWhatsAppGraph.FAKE_PHONE_NUMBER_ID}/messages`,
          );
        }),
      { baseSuffix: `/${FakeWhatsAppGraph.FAKE_VERSION}`, version: FakeWhatsAppGraph.FAKE_VERSION },
    ),
  );

  it.effect("classifies refusals so the outbox knows whether a resend is safe", () =>
    withAdapter(({ adapter, send, fake }) =>
      Effect.gen(function* () {
        const sendText = send({ credentials, to: TO, content: { type: "text", text: "Hi" } }).pipe(
          Effect.flip,
        );
        fake.failNext("/messages", { kind: "error", status: 400, code: 131047 });
        const windowClosed = yield* sendText;
        assert.equal(windowClosed._tag, "ChatProviderRejectedError");
        assert.equal(
          windowClosed._tag === "ChatProviderRejectedError" && windowClosed.reason,
          "window_closed",
        );

        fake.failNext("/messages", { kind: "error", status: 400, code: 131049 });
        const marketing = yield* sendText;
        assert.equal(
          marketing._tag === "ChatProviderRejectedError" && marketing.reason,
          "undeliverable",
        );

        fake.failNext("/messages", { kind: "error", status: 429, code: 130429 });
        const throttled = yield* sendText;
        assert.equal(
          throttled._tag === "ChatProviderRejectedError" && throttled.reason,
          "rate_limited",
        );

        // A server error or a dropped connection may already have delivered the message.
        fake.failNext("/messages", { kind: "error", status: 500, code: 1 });
        assert.equal((yield* sendText)._tag, "ChatProviderNoAnswerError");
        fake.failNext("/messages", { kind: "drop" });
        assert.equal((yield* sendText)._tag, "ChatProviderNoAnswerError");
      }),
    ),
  );

  it.effect("keeps the phone number ID and media URLs out of failure causes", () =>
    withAdapter(({ adapter, send, fake }) =>
      Effect.gen(function* () {
        // A failed span is written to the trace file with its full cause.
        const prettyFailure = <A, E>(effect: Effect.Effect<A, E>) =>
          Effect.exit(effect).pipe(
            Effect.map((exit) => {
              assert.isTrue(Exit.isFailure(exit));
              return Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "";
            }),
          );
        fake.failNext("/messages", { kind: "drop" });
        const dropped = yield* prettyFailure(
          send({ credentials, to: TO, content: { type: "text", text: "Hi" } }),
        );
        assert.include(dropped, "ChatProviderNoAnswerError");
        assert.notInclude(dropped, FakeWhatsAppGraph.FAKE_PHONE_NUMBER_ID);
        assert.notInclude(dropped, TO);

        const mediaId = fake.addMedia(new Uint8Array([1]), "image/png");
        fake.failNext(`/download/${mediaId}`, { kind: "drop" });
        const download = yield* prettyFailure(
          adapter.readMedia({ credentials, providerMediaId: mediaId }),
        );
        assert.notInclude(download, "/download/");
        assert.notInclude(download, fake.base);
      }),
    ),
  );

  it.effect("gives up on a response whose body stalls, as no answer", () =>
    withAdapter(({ send, fake }) =>
      Effect.gen(function* () {
        fake.failNext("/messages", { kind: "stall-body" });
        const fiber = yield* send({
          credentials,
          to: TO,
          content: { type: "text", text: "Hi" },
        }).pipe(Effect.flip, Effect.forkChild);
        yield* Effect.promise(() => fake.bodyStalled);
        yield* TestClock.adjust("31 seconds");
        const error = yield* Fiber.join(fiber);
        assert.equal(error._tag, "ChatProviderNoAnswerError");
        assert.equal(error._tag === "ChatProviderNoAnswerError" && error.reason, "timeout");
      }),
    ),
  );

  it.effect("sends the token for a media download only to the API or Meta's media hosts", () =>
    withAdapter(({ adapter, fake }) =>
      Effect.gen(function* () {
        // The test HTTP client dies on any other host, so a typed refusal proves no request left.
        for (const url of ["https://evil.example/media", "https://fbcdn.net.evil.example/x"]) {
          const mediaId = fake.addMedia(new Uint8Array([1]), "image/png", url);
          const refused = yield* adapter
            .readMedia({ credentials, providerMediaId: mediaId })
            .pipe(Effect.flip);
          assert.equal(refused._tag, "ChatProviderNoAnswerError");
        }
        assert.isFalse(fake.requests.some((request) => request.path.startsWith("/download")));
      }),
    ),
  );

  it.effect("reads media by id with the token and reports template status", () =>
    withAdapter(({ adapter, send, fake }) =>
      Effect.gen(function* () {
        const mediaId = fake.addMedia(new Uint8Array([1, 2, 3]), "image/png");
        const media = yield* adapter.readMedia({ credentials, providerMediaId: mediaId });
        assert.deepEqual([...media.bytes], [1, 2, 3]);
        assert.equal(media.mimeType, "image/png");

        const template = { name: "bugbot_notice", language: "en" };
        assert.deepEqual(yield* adapter.templateStatus({ credentials, template }), {
          name: "bugbot_notice",
          state: "missing",
          category: null,
          usable: false,
        });
        fake.templates.push({ ...template, status: "PENDING", category: "UTILITY" });
        assert.equal((yield* adapter.templateStatus({ credentials, template })).state, "pending");
        fake.templates.length = 0;
        fake.templates.push({ ...template, status: "APPROVED", category: "MARKETING" });
        const marketing = yield* adapter.templateStatus({ credentials, template });
        assert.equal(marketing.state, "approved");
        assert.isFalse(marketing.usable);
        fake.templates.length = 0;
        fake.templates.push({ ...template, status: "APPROVED", category: "UTILITY" });
        assert.isTrue((yield* adapter.templateStatus({ credentials, template })).usable);
        assert.deepEqual(fake.violations, []);
      }),
    ),
  );

  it.effect("accepts only a 32-hex app secret and reports problems without the value", () =>
    withAdapter(({ adapter }) =>
      Effect.sync(() => {
        assert.isNull(adapter.credentialProblem("appSecret", "0123456789abcdef0123456789ABCDEF"));
        const problem = adapter.credentialProblem("appSecret", "not-a-secret");
        assert.isString(problem);
        assert.notInclude(problem!, "not-a-secret");
        assert.isString(adapter.credentialProblem("appSecret", "0123456789abcdef0123456789abcde"));
        assert.isString(adapter.credentialProblem("phoneNumberId", "12ab"));
        assert.isNull(adapter.credentialProblem("phoneNumberId", "100000000000001"));
      }),
    ),
  );
});
