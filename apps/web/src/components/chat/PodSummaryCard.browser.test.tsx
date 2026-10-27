import { RegistryContext } from "@effect/atom-react";
import type { OrchestrationRootRollup } from "@t3tools/client-runtime/state/orchestration-tree";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  type OrganId,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { PodSummaryCard } from "./PodSummaryCard";

const h = await vi.hoisted(async () => {
  const { Atom, AtomRegistry } = await import("effect/reactivity");
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
    nullShellAtom: Atom.make(null),
    connectedAtom: Atom.family((_environmentId: string) => Atom.make(true)),
    shellStatusAtom: Atom.family((_environmentId: string) =>
      Atom.make<EnvironmentShellStatus>("live"),
    ),
    rollupAtom: Atom.family((_rootKey: string) => Atom.make<OrchestrationRootRollup | null>(null)),
    navigate: vi.fn(),
    // Stands in for the real projection atom, which opens `subscribeThread`
    // when first mounted and closes it when the last reader unmounts.
    subscriptions: { opened: 0, active: 0, threadIds: [] as string[] },
    projection: null as unknown,
    organRenders: 0,
  };
});

vi.mock("../../state/entities", async () => {
  const { useAtomValue } = await import("@effect/atom-react");
  return {
    useQuietThreadShell: (ref: ScopedThreadRef | null) =>
      useAtomValue(ref === null ? h.nullShellAtom : h.threads.quietThreadShellAtom(ref)),
    useThreadProjection: (ref: ScopedThreadRef | null) => {
      const threadId = ref?.threadId ?? null;
      if (threadId !== null) h.organRenders += 1;
      useEffect(() => {
        if (threadId === null) return;
        h.subscriptions.opened += 1;
        h.subscriptions.active += 1;
        h.subscriptions.threadIds.push(threadId);
        return () => {
          h.subscriptions.active -= 1;
        };
      }, [threadId]);
      return threadId === null ? null : h.projection;
    },
  };
});
vi.mock("../../state/threads", () => ({ environmentThreadShells: h.threads }));
vi.mock("../../state/orchestrationTree", () => ({
  orchestrationTree: { rollupAtom: (_environmentId: string, key: string) => h.rollupAtom(key) },
  environmentConnectedAtom: h.connectedAtom,
}));
vi.mock("../../state/shell", () => ({ environmentShell: { statusAtom: h.shellStatusAtom } }));
vi.mock("../../state/environments", () => ({ useEnvironment: () => ({ label: "homelab" }) }));
vi.mock("../../state/podRuntime", () => ({
  useEnvironmentSupportsPodRuntime: () => true,
  useMountPodRuntime: () => undefined,
  useWorktreePod: () => undefined,
}));
vi.mock("../pods/usePodActions", () => ({
  usePodActions: () => ({ run: vi.fn(), allowed: () => true }),
}));
vi.mock("../pods/useThreadPodServiceMenu", () => ({
  useThreadPodServiceMenu: () => ({ read: () => undefined, run: vi.fn() }),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useNavigate: () => h.navigate,
}));

const environmentId = EnvironmentId.make("environment-slice");
const providerInstanceId = ProviderInstanceId.make("claudeAgent");
const createdAt = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");
const PODS = ["pod-c2", "pod-w1", "pod-w4"] as const;

function thread(
  id: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    projectId: ProjectId.make("project-slice"),
    title: id,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "claude-opus-5-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: `pod/${id}`,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
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
    ...overrides,
  };
}

const organLabel = (podId: string) => ({
  id: `organ_${podId}_impl` as OrganId,
  presetId: "implementation",
  goal: "build it",
  round: 1,
});

function organCell(
  id: string,
  podId: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  return thread(id, {
    ...overrides,
    lineage: {
      rootThreadId: ThreadId.make(podId),
      parentThreadId: ThreadId.make(podId),
      relationshipToParent: "subagent",
      organ: organLabel(podId),
    },
  });
}

const SLICE_THREADS = [
  ...PODS.map((id) => thread(id)),
  // A plan waiting on the user: only the cell's shell knows it needs you.
  ...PODS.map((id) => organCell(`${id}-cell`, id, { hasActionableProposedPlan: id === "pod-w1" })),
];

// A streaming tick elsewhere in the environment: a new threads array that keeps
// every unchanged shell object, as the snapshot stream does.
function seedSnapshot(tick = 0) {
  h.registry.set(h.snapshotAtom(environmentId), {
    schemaVersion: 1,
    snapshotSequence: tick,
    projects: [],
    threads: [...SLICE_THREADS, thread("busy-elsewhere", { itemCount: tick + 1 })],
    archivedThreads: [],
  });
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  h.subscriptions.opened = 0;
  h.subscriptions.active = 0;
  h.subscriptions.threadIds = [];
  h.projection = null;
  h.navigate.mockClear();
  h.organRenders = 0;
  seedSnapshot();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <RegistryContext.Provider value={h.registry}>
        {PODS.map((id) => (
          <PodSummaryCard key={id} environmentId={environmentId} threadId={ThreadId.make(id)} />
        ))}
      </RegistryContext.Provider>,
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const chevron = (index: number) =>
  container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")[index]!;
const header = (index: number) =>
  container.querySelectorAll<HTMLElement>('[role="button"][aria-label="Open pod chat"]')[index]!;

const cards = () => Array.from(container.children);

it("opens no pod subscription while every card is collapsed", () => {
  expect(h.subscriptions.opened).toBe(0);
});

it("counts each pod's organs from shells while collapsed", () => {
  expect(cards().map((card) => card.textContent)).toEqual(
    PODS.map((id) => expect.stringContaining(`${id}1 organ`)),
  );
});

const W1_PROJECTION = {
  environmentId,
  projection: {
    subagents: [
      {
        id: "subagent-w1",
        childThreadId: ThreadId.make("pod-w1-cell"),
        organ: organLabel("pod-w1"),
        status: "running",
        model: "claude-opus-5-5",
        title: "cell",
        updatedAt: createdAt,
      },
    ],
  },
};

it("does not re-render an expanded card's organs on a streaming tick", () => {
  h.projection = W1_PROJECTION;
  act(() => chevron(1).click());
  const rendersBeforeTick = h.organRenders;

  act(() => seedSnapshot(1));
  expect(h.organRenders).toBe(rendersBeforeTick);
});

it("lists organs from the pod's records, with dots from the cells' shells", () => {
  h.projection = W1_PROJECTION;
  act(() => chevron(1).click());
  // The record alone says running; needs-you can only come from the cell's shell.
  const lines = Array.from(cards()[1]!.querySelectorAll("button:not([aria-label])"), (line) => ({
    dot: line.querySelector("[data-dot]")?.getAttribute("data-dot"),
    text: line.textContent,
  }));
  expect(lines).toEqual([{ dot: "needs-you", text: "Implementationr1 · 1 needs you" }]);
});

it("opens one subscription on expand and closes it on collapse", () => {
  act(() => chevron(1).click());
  expect(h.subscriptions).toEqual({ opened: 1, active: 1, threadIds: ["pod-w1"] });

  act(() => chevron(1).click());
  expect(h.subscriptions.active).toBe(0);
  expect(h.subscriptions.opened).toBe(1);
});

it("closes an expanded card's subscription when the card unmounts", () => {
  act(() => chevron(0).click());
  expect(h.subscriptions.active).toBe(1);
  act(() => root.render(null));
  expect(h.subscriptions.active).toBe(0);
});

it("opens the broker chat from the header, not from the chevron", () => {
  act(() => chevron(2).click());
  expect(h.navigate).not.toHaveBeenCalled();

  act(() => header(2).click());
  expect(h.navigate).toHaveBeenCalledTimes(1);
  expect(h.navigate.mock.calls[0]?.[0]).toMatchObject({
    to: "/$environmentId/$threadId",
    params: { environmentId, threadId: "pod-w4" },
  });
});
