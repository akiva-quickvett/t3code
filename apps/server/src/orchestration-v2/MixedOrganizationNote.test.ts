import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
} from "@t3tools/contracts";

import {
  crossesOrganization,
  handoffSourceInstanceIds,
  handoffsSinceAcceptedTurn,
} from "./MixedOrganizationNote.ts";

const claudeWork = ProviderInstanceId.make("claude_work");
const claudePersonal = ProviderInstanceId.make("claude_personal");
const codex = ProviderInstanceId.make("codex");
const providerThreads = [
  { id: ProviderThreadId.make("provider-thread:work"), providerInstanceId: claudeWork },
  { id: ProviderThreadId.make("provider-thread:work-2"), providerInstanceId: claudeWork },
  { id: ProviderThreadId.make("provider-thread:personal"), providerInstanceId: claudePersonal },
  { id: ProviderThreadId.make("provider-thread:codex"), providerInstanceId: codex },
];

it("collects each source instance of the handoffs once", () => {
  assert.deepStrictEqual(
    handoffSourceInstanceIds({
      handoffs: [
        {
          fromProviderThreadIds: [
            ProviderThreadId.make("provider-thread:work"),
            ProviderThreadId.make("provider-thread:work-2"),
          ],
        },
        { fromProviderThreadIds: [ProviderThreadId.make("provider-thread:codex")] },
      ],
      providerThreads,
    }),
    [claudeWork, codex],
  );
});

it("ignores provider threads the projection does not know", () => {
  assert.deepStrictEqual(
    handoffSourceInstanceIds({
      handoffs: [{ fromProviderThreadIds: [ProviderThreadId.make("provider-thread:gone")] }],
      providerThreads,
    }),
    [],
  );
});

it("crosses organizations only when a known source key of the same driver differs", () => {
  const claude = (organizationKey: string | undefined) => ({
    driver: ProviderDriverKind.make("claudeAgent"),
    organizationKey,
  });
  const otherDriver = { driver: ProviderDriverKind.make("codex"), organizationKey: "org-b" };

  assert.isTrue(crossesOrganization(claude("org-a"), [claude("org-b")]));
  assert.isTrue(
    crossesOrganization(claude("org-a"), [undefined, claude("org-a"), claude("org-b")]),
  );
  assert.isFalse(crossesOrganization(claude("org-a"), [claude("org-a")]));
  assert.isFalse(crossesOrganization(claude("org-a"), [claude(undefined), undefined]));
  assert.isFalse(crossesOrganization(claude(undefined), [claude("org-b")]));
  assert.isFalse(crossesOrganization(undefined, [claude("org-b")]));
  assert.isFalse(crossesOrganization(claude("org-a"), [otherDriver]));
  assert.isFalse(crossesOrganization(claude("org-a"), []));
});

describe("handoffsSinceAcceptedTurn", () => {
  const workThread = ProviderThreadId.make("provider-thread:work");
  const personalThread = ProviderThreadId.make("provider-thread:personal");
  const run = (ordinal: number, providerThreadId: ProviderThreadId) => ({
    id: RunId.make(`run:${ordinal}`),
    ordinal,
    providerThreadId,
    activeAttemptId: RunAttemptId.make(`attempt:${ordinal}`),
  });
  const accepted = (...ordinals: ReadonlyArray<number>) =>
    ordinals.map((ordinal) => ({ runAttemptId: RunAttemptId.make(`attempt:${ordinal}`) }));
  const handoff = (ordinal: number, toProviderThreadId: ProviderThreadId) => ({
    targetRunId: RunId.make(`run:${ordinal}`),
    toProviderThreadId,
  });
  const intoPersonal = handoff(2, personalThread);

  it("keeps a handoff whose turn failed before the provider accepted it, for the retry", () => {
    assert.deepStrictEqual(
      handoffsSinceAcceptedTurn({
        providerThreadId: personalThread,
        handoffs: [intoPersonal],
        runs: [run(1, workThread), run(2, personalThread), run(3, personalThread)],
        providerTurns: accepted(1),
      }),
      [intoPersonal],
    );
  });

  it("drops the handoff once a later turn on the thread was accepted", () => {
    assert.deepStrictEqual(
      handoffsSinceAcceptedTurn({
        providerThreadId: personalThread,
        handoffs: [intoPersonal],
        runs: [
          run(1, workThread),
          run(2, personalThread),
          run(3, personalThread),
          run(4, personalThread),
        ],
        providerTurns: accepted(1, 3),
      }),
      [],
    );
  });

  it("announces a switch back to an earlier thread, but not the old handoff away from it", () => {
    const backToWork = handoff(3, workThread);
    const input = {
      handoffs: [intoPersonal, backToWork],
      runs: [run(1, workThread), run(2, personalThread), run(3, workThread)],
      providerTurns: accepted(1, 2),
    };

    assert.deepStrictEqual(handoffsSinceAcceptedTurn({ ...input, providerThreadId: workThread }), [
      backToWork,
    ]);
    assert.deepStrictEqual(
      handoffsSinceAcceptedTurn({ ...input, providerThreadId: personalThread }),
      [],
    );
  });
});
