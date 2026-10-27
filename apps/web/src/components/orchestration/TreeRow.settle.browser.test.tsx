import { RegistryContext } from "@effect/atom-react";
import {
  type ContextMenuItem,
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import "~/index.css";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ThreadActionMenuId } from "../threadActionMenu.logic";

// The real shared thread action menu behind a tree row; only its data and the
// native menu are stubbed, so the items are the ones a user would see.
const h = await vi.hoisted(async () => {
  const { Atom, AsyncResult, AtomRegistry } = await import("effect/reactivity");
  const { createEnvironmentThreadShellAtoms } =
    await import("@t3tools/client-runtime/state/threads");
  const snapshotAtom = Atom.family((_environmentId: string) =>
    Atom.make<{
      readonly schemaVersion: 1;
      readonly snapshotSequence: number;
      readonly projects: ReadonlyArray<never>;
      readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
      readonly archivedThreads: ReadonlyArray<never>;
    } | null>(null),
  );
  return {
    registry: AtomRegistry.make(),
    snapshotAtom,
    threads: createEnvironmentThreadShellAtoms({
      catalogValueAtom: Atom.make({ isReady: true, entries: new Map() }),
      snapshotAtom,
    }),
    threadIds: [] as string[],
    show: vi.fn<
      (
        items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>>,
        position: { x: number; y: number },
      ) => Promise<ThreadActionMenuId | null>
    >(async () => null),
    nullAtom: Atom.make(null),
    connectedAtom: Atom.make(true),
    connectionAtom: Atom.make(AsyncResult.success({ phase: "connected" })),
    shellStatusAtom: Atom.make("live"),
  };
});

const environmentId = EnvironmentId.make("environment-settle");
const providerInstanceId = ProviderInstanceId.make("codex");
const createdAt = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");

function thread(id: string, parentId: string | null): OrchestrationV2ThreadShell {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    projectId: ProjectId.make("project-settle"),
    title: id,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage:
      parentId === null
        ? { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null }
        : {
            rootThreadId: ThreadId.make(parentId),
            parentThreadId: ThreadId.make(parentId),
            relationshipToParent: "subagent",
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
    itemCount: 1,
    visibleItemCount: 1,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function setThreads(threads: ReadonlyArray<OrchestrationV2ThreadShell>) {
  h.threadIds = threads.map((candidate) => candidate.id);
  h.registry.set(h.snapshotAtom(environmentId), {
    schemaVersion: 1,
    snapshotSequence: 0,
    projects: [],
    threads,
    archivedThreads: [],
  });
}

const readShell = (ref: ScopedThreadRef) => h.registry.get(h.threads.threadShellAtom(ref));

vi.mock("../../state/entities", async () => {
  const { useAtomValue } = await import("@effect/atom-react");
  return {
    useQuietThreadShell: (ref: ScopedThreadRef | null) =>
      useAtomValue(ref === null ? h.nullAtom : h.threads.quietThreadShellAtom(ref)),
    useProject: () => ({ workspaceRoot: "/project" }),
    useProjects: () => [],
    readThreadShell: (ref: ScopedThreadRef) => readShell(ref),
    readThreadShells: () =>
      h.threadIds.flatMap((threadId) => {
        const shell = readShell({ environmentId, threadId: ThreadId.make(threadId) });
        return shell === null ? [] : [shell];
      }),
    readEnvironmentSupportsAutoSettleOptOut: () => true,
    readEnvironmentSupportsPinning: () => true,
    readEnvironmentSupportsSettlement: () => true,
    readEnvironmentSupportsSnooze: () => true,
    readEnvironmentSupportsSettleTree: () => true,
    readEnvironmentSupportsSnoozeTree: () => false,
    readEnvironmentSupportsTitleRegeneration: () => false,
    readEnvironmentSupportsThreadUsage: () => false,
  };
});
vi.mock("../../state/orchestrationTree", () => ({
  orchestrationTree: { rollupAtom: () => h.nullAtom },
  environmentConnectedAtom: () => h.connectedAtom,
  readEnvironmentSupportsOrchestrationMetas: () => true,
}));
vi.mock("../../state/shell", () => ({
  environmentShell: { statusAtom: () => h.shellStatusAtom },
}));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({ label: "homelab" }),
  usePrimaryEnvironmentId: () => environmentId,
}));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => true,
}));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { updateMetadata: "update-metadata", setMeta: "set-meta" },
}));
vi.mock("../../state/threadUsage", () => ({
  canReadThreadUsage: () => false,
  openThreadUsageDialog: () => undefined,
}));
vi.mock("../../state/agentRoles", () => ({ readEnvironmentSupportsRolePresets: () => false }));
vi.mock("../../state/podRuntime", () => ({ useMountPodRuntime: () => undefined }));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => async () => undefined,
}));
vi.mock("../pods/useThreadPodServiceMenu", () => ({
  useThreadPodServiceMenu: () => ({ read: () => undefined, run: () => undefined }),
}));
vi.mock("../../hooks/useThreadActions", () => ({ useThreadActions: () => ({}) }));
vi.mock("../../hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => async () => {} }));
vi.mock("../../hooks/useStartTicketThread", () => ({ useStartTicketThread: () => async () => {} }));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: unknown) => unknown) =>
    select({ confirmThreadDelete: true, confirmThreadArchive: true, timestampFormat: "12-hour" }),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useRouter: () => ({ navigate: async () => {} }),
}));
vi.mock("../../localApi", () => ({
  readLocalApi: () => ({ contextMenu: { show: h.show, close: () => {} } }),
}));
vi.mock("./StatsStrip", () => ({ sliceBurn: () => null }));

import { TreeRow } from "./TreeRow";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  h.show.mockClear();
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function openRowMenu(id: string) {
  await act(() =>
    root.render(
      <RegistryContext.Provider value={h.registry}>
        <TreeRow
          rowKey={id}
          environmentId={environmentId}
          threadId={ThreadId.make(id)}
          label={id}
          kind="pod"
          depth={0}
          guideMask={0}
          expanded={true}
          rollupKey={null}
          repoTag={null}
          noSlice={false}
          selected={false}
          onSelect={() => undefined}
          onToggle={() => undefined}
          onRename={() => undefined}
        />
      </RegistryContext.Provider>,
    ),
  );
  const button = container.querySelector<HTMLButtonElement>('[aria-label="Thread actions"]')!;
  await act(async () => button.click());
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(1));
  return h.show.mock.calls[0]![0].map((item) => item.id);
}

describe("TreeRow thread menu", () => {
  it("offers #22's tree settle on a row with a subtree", async () => {
    setThreads([thread("pod", null), thread("cell", "pod")]);
    expect(await openRowMenu("pod")).toContain("settle-tree");
  });

  it("offers no tree settle on a leaf", async () => {
    setThreads([thread("pod", null)]);
    const ids = await openRowMenu("pod");
    expect(ids).toContain("settle");
    expect(ids).not.toContain("settle-tree");
  });
});
