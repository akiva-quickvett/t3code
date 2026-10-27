import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  createOrchestrationTreeAtoms,
  NO_META_TAB_KEY,
} from "@t3tools/client-runtime/state/orchestration-tree";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import {
  AgentRolePresetId,
  AgentRolePresetLabel,
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { failureMessage } from "../settings/presetSettingsControls";
import {
  createMetaTabAtoms,
  joinEnvironmentIds,
  metaClearAvailability,
  metaTabKeys,
  metaTabStatus,
  resolveSelectedTabKey,
  setMetaFor,
} from "./MetaTabs.logic";

const now = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");
const later = (seconds: number) => DateTime.add(now, { seconds });

function shell(
  id: string,
  options: {
    readonly supervisor?: string;
    readonly role?: string;
    readonly metaSeconds?: number;
  } = {},
): OrchestrationV2ThreadShell {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    projectId: ProjectId.make("project"),
    title: id,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: threadId,
      parentThreadId: null,
      relationshipToParent: null,
      ...(options.supervisor === undefined
        ? {}
        : { supervisorThreadId: ThreadId.make(options.supervisor) }),
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...(options.role === undefined
      ? {}
      : {
          rolePreset: {
            id: AgentRolePresetId.make(options.role),
            label: AgentRolePresetLabel.make(options.role),
          },
        }),
    ...(options.metaSeconds === undefined ? {} : { metaAt: later(options.metaSeconds) }),
  };
}

const finished = (thread: OrchestrationV2ThreadShell): OrchestrationV2ThreadShell => ({
  ...thread,
  latestRunId: RunId.make(`run-${thread.id}`),
  status: "completed",
  latestRunCompletedAt: later(60),
});

const running = (thread: OrchestrationV2ThreadShell): OrchestrationV2ThreadShell => ({
  ...thread,
  latestRunId: RunId.make(`run-${thread.id}`),
  activeRunId: RunId.make(`run-${thread.id}`),
  status: "running",
});

const failed = (thread: OrchestrationV2ThreadShell): OrchestrationV2ThreadShell => ({
  ...thread,
  latestRunId: RunId.make(`run-${thread.id}`),
  status: "failed",
  latestRunCompletedAt: later(60),
});

const needsYou = (thread: OrchestrationV2ThreadShell): OrchestrationV2ThreadShell => ({
  ...thread,
  pendingRuntimeRequest: {
    id: RuntimeRequestId.make(`request-${thread.id}`),
    kind: "user_input",
    createdAt: now,
  },
});

/** The real tree atoms under the bar's atoms, over fixed per-environment shells. */
function harness(threadsByEnvironment: Record<string, ReadonlyArray<OrchestrationV2ThreadShell>>) {
  const threadAtoms = new Map(
    Object.entries(threadsByEnvironment).map(([id, threads]) => [id, Atom.make(threads)]),
  );
  const emptyAtom = Atom.make<ReadonlyArray<OrchestrationV2ThreadShell>>([]);
  const statusAtom = Atom.make<EnvironmentShellStatus>("live");
  const connectedAtom = Atom.make(true);
  const tree = createOrchestrationTreeAtoms({
    environmentThreadsAtom: (environmentId) => threadAtoms.get(environmentId) ?? emptyAtom,
    environmentShellStatusAtom: () => statusAtom,
    environmentConnectedAtom: () => connectedAtom,
    now: () => DateTime.formatIso(later(3600)),
  });
  const registry = AtomRegistry.make();
  const tabs = createMetaTabAtoms(tree);
  const read = <A>(atom: Atom.Atom<A>) => {
    const dispose = registry.mount(atom);
    try {
      return registry.get(atom);
    } finally {
      dispose();
    }
  };
  return {
    tabKeys: (environmentIds: ReadonlyArray<EnvironmentId>) =>
      read(tabs.tabKeysAtom(joinEnvironmentIds(environmentIds))),
    status: (environmentId: EnvironmentId, metaId: string) =>
      metaTabStatus(read(tree.rollupAtom(environmentId, keyOf(environmentId, metaId)))),
    noMetaUnread: (environmentIds: ReadonlyArray<EnvironmentId>) =>
      read(tabs.noMetaUnreadAtom(joinEnvironmentIds(environmentIds))),
  };
}

const left = EnvironmentId.make("environment-left");
const right = EnvironmentId.make("environment-right");
const keyOf = (environmentId: EnvironmentId, id: string) =>
  scopedThreadKey({ environmentId, threadId: ThreadId.make(id) });

describe("metaTabKeys", () => {
  it("keeps each environment's order, environments in the order given, No meta last", () => {
    expect(metaTabKeys([["l2", "l1"], [], ["r1"]])).toEqual(["l2", "l1", "r1", NO_META_TAB_KEY]);
  });

  it("is only No meta without metas", () => {
    expect(metaTabKeys([])).toEqual([NO_META_TAB_KEY]);
  });
});

describe("meta tab model", () => {
  it("orders by metaAt within an environment and by the given environment order across them", () => {
    const { tabKeys } = harness({
      [left]: [shell("late", { metaSeconds: 20 }), shell("early", { metaSeconds: 10 })],
      [right]: [shell("first", { metaSeconds: 1 })],
    });
    expect(tabKeys([left, right])).toEqual([
      keyOf(left, "early"),
      keyOf(left, "late"),
      keyOf(right, "first"),
      NO_META_TAB_KEY,
    ]);
  });

  it("counts a never-visited finished slice and needs-you threads as unread", () => {
    const { status } = harness({
      [left]: [
        shell("meta", { metaSeconds: 0 }),
        finished(shell("done", { supervisor: "meta", role: "slice" })),
        needsYou(shell("asking", { supervisor: "meta", role: "slice" })),
        shell("quiet", { supervisor: "meta", role: "slice" }),
      ],
    });
    expect(status(left, "meta").unread).toBe(2);
  });

  it("shows the highest dot in the meta's tree, the meta included", () => {
    const { status } = harness({
      [left]: [
        running(shell("a", { metaSeconds: 0 })),
        finished(shell("a-slice", { supervisor: "a", role: "slice" })),
        running(shell("b", { metaSeconds: 1 })),
        failed(shell("b-slice", { supervisor: "b", role: "slice" })),
      ],
    });
    expect(status(left, "a").dot).toBe("working");
    expect(status(left, "b").dot).toBe("failed");
  });

  it("sums No meta's unread across environments", () => {
    const { noMetaUnread } = harness({
      [left]: [finished(shell("ad-hoc"))],
      [right]: [needsYou(shell("orphan-slice", { role: "slice" }))],
    });
    expect(noMetaUnread([left, right])).toBe(2);
  });

  it("falls back to the first tab when the stored key no longer resolves", () => {
    const tabKeys = ["meta-a", "meta-b", NO_META_TAB_KEY];
    expect(resolveSelectedTabKey(tabKeys, "meta-b")).toBe("meta-b");
    expect(resolveSelectedTabKey(tabKeys, "demoted")).toBe("meta-a");
    expect(resolveSelectedTabKey(tabKeys, null)).toBe("meta-a");
    expect(resolveSelectedTabKey([NO_META_TAB_KEY], "demoted")).toBe(NO_META_TAB_KEY);
  });
});

function provider(slashCommands: ServerProvider["slashCommands"]) {
  return deriveProviderInstanceEntries([
    {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-10-01T00:00:00.000Z",
      models: [],
      slashCommands,
      skills: [],
    },
  ])[0]!;
}

const message = (text: string, attachments: ReadonlyArray<unknown> = []) =>
  ({ role: "user", text, attachments }) as const;

describe("metaClearAvailability", () => {
  const compacting = provider([{ name: "compact", description: "" }]);
  const whole = (messages: ReadonlyArray<ReturnType<typeof message>>) => ({
    messages,
    hasMoreHistory: false,
  });

  it("is disabled when the provider does not advertise compact", () => {
    expect(
      metaClearAvailability({
        canOperate: true,
        provider: provider([]),
        hasUserMessage: true,
        loaded: whole([message("hello")]),
      }).enabled,
    ).toBe(false);
  });

  it("is disabled when the meta has no user message, or only /compact ones", () => {
    expect(
      metaClearAvailability({
        canOperate: true,
        provider: compacting,
        hasUserMessage: false,
        loaded: null,
      }).enabled,
    ).toBe(false);
    expect(
      metaClearAvailability({
        canOperate: true,
        provider: compacting,
        hasUserMessage: true,
        loaded: whole([message(" /Compact ")]),
      }).enabled,
    ).toBe(false);
  });

  it("is enabled once the meta has another user message", () => {
    expect(
      metaClearAvailability({
        canOperate: true,
        provider: compacting,
        hasUserMessage: true,
        loaded: whole([message("/compact"), message("plan the week")]),
      }),
    ).toEqual({ enabled: true });
    expect(
      metaClearAvailability({
        canOperate: true,
        provider: compacting,
        hasUserMessage: true,
        loaded: whole([message("/compact", [{ type: "image" }])]),
      }),
    ).toEqual({ enabled: true });
  });

  it("leaves unloaded or paged history to the server instead of waiting", () => {
    expect(
      metaClearAvailability({
        canOperate: true,
        provider: compacting,
        hasUserMessage: true,
        loaded: null,
      }),
    ).toEqual({ enabled: true });
    expect(
      metaClearAvailability({
        canOperate: true,
        provider: compacting,
        hasUserMessage: true,
        loaded: { messages: [message("/compact")], hasMoreHistory: true },
      }),
    ).toEqual({ enabled: true });
  });

  it("is disabled without permission", () => {
    expect(
      metaClearAvailability({
        canOperate: false,
        provider: compacting,
        hasUserMessage: true,
        loaded: whole([message("hi")]),
      }).enabled,
    ).toBe(false);
  });
});

describe("setMetaFor", () => {
  const threadRef = { environmentId: left, threadId: ThreadId.make("meta") };

  it("demotes with thread.meta.set enabled false", async () => {
    const setThreadMeta = vi.fn(async () => AsyncResult.success<unknown>(undefined));
    await setMetaFor(setThreadMeta, threadRef, false);
    expect(setThreadMeta).toHaveBeenCalledWith({
      environmentId: left,
      input: { threadId: threadRef.threadId, enabled: false },
    });
  });

  it("returns the rejection so its cause reaches the toast", async () => {
    const setThreadMeta = vi.fn(async () =>
      AsyncResult.failure<unknown, unknown>(
        Cause.fail(new Error("The thread is archived; unarchive it first.")),
      ),
    );
    expect(failureMessage(await setMetaFor(setThreadMeta, threadRef, true))).toBe(
      "The thread is archived; unarchive it first.",
    );
  });
});
