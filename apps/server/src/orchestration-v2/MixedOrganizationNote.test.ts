import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, ProviderThreadId } from "@t3tools/contracts";

import { crossesOrganization, handoffSourceInstanceIds } from "./MixedOrganizationNote.ts";

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
