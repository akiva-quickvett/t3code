import { RegistryContext } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import {
  orchestrationSeedTree,
  seedMetaId,
  seedPodId,
  seedSliceId,
} from "@t3tools/shared/testing/orchestrationSeedTree";
import * as DateTime from "effect/DateTime";
import { AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import "~/index.css";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { useUiStateStore } from "../../uiStateStore";
import { OrchestrationSidebar } from "./OrchestrationSidebar";

const h = await vi.hoisted(async () => {
  const { Atom } = await import("effect/reactivity");
  const { createEnvironmentThreadShellAtoms } =
    await import("@t3tools/client-runtime/state/threads");
  const { createOrchestrationTreeAtoms } =
    await import("@t3tools/client-runtime/state/orchestration-tree");
  const snapshotAtom = Atom.family((_environmentId: string) =>
    Atom.make<{
      readonly schemaVersion: 1;
      readonly snapshotSequence: number;
      readonly projects: ReadonlyArray<never>;
      readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
      readonly archivedThreads: ReadonlyArray<never>;
    } | null>(null),
  );
  const threads = createEnvironmentThreadShellAtoms({
    catalogValueAtom: Atom.make({ isReady: true, entries: new Map() }),
    snapshotAtom,
  });
  const connectedAtom = Atom.family((_environmentId: string) => Atom.make(true));
  const shellStatusAtom = Atom.family((_environmentId: string) =>
    Atom.make<EnvironmentShellStatus>("live"),
  );
  return {
    snapshotAtom,
    threads,
    connectedAtom,
    shellStatusAtom,
    orchestrationTree: createOrchestrationTreeAtoms({
      environmentThreadsAtom: threads.environmentThreadsAtom,
      environmentShellStatusAtom: shellStatusAtom,
      environmentConnectedAtom: connectedAtom,
      now: () => "2026-10-03T00:00:00.000Z",
    }),
    routeAtom: Atom.make<ScopedThreadRef | null>(null),
    rowRenders: new Map<string, number>(),
    projectRenders: { count: 0 },
    navigate: vi.fn(),
  };
});

vi.mock("../../state/entities", async () => {
  const { useAtomValue } = await import("@effect/atom-react");
  const { Atom } = await import("effect/reactivity");
  const nullShellAtom = Atom.make(null);
  return {
    // Called once per TreeRow render, so it counts row commits.
    useQuietThreadShell: (ref: ScopedThreadRef | null) => {
      if (ref !== null) h.rowRenders.set(ref.threadId, (h.rowRenders.get(ref.threadId) ?? 0) + 1);
      return useAtomValue(ref === null ? nullShellAtom : h.threads.quietThreadShellAtom(ref));
    },
    // Called once per project, branch or repo-tagged row render.
    useProject: () => {
      h.projectRenders.count += 1;
      return null;
    },
  };
});
vi.mock("../../state/threads", () => ({ environmentThreadShells: h.threads }));
vi.mock("../../state/orchestrationTree", () => ({
  orchestrationTree: h.orchestrationTree,
  environmentConnectedAtom: h.connectedAtom,
}));
vi.mock("../../state/shell", () => ({ environmentShell: { statusAtom: h.shellStatusAtom } }));
vi.mock("../../state/environments", () => ({ useEnvironment: () => ({ label: "homelab" }) }));
vi.mock("../../hooks/useThreadActionMenu", () => ({
  useThreadActionMenu: () => ({ openMenu: () => undefined, closeMenu: () => undefined }),
}));
vi.mock("../../hooks/useThreadRouteTarget", async () => {
  const { useAtomValue } = await import("@effect/atom-react");
  return { useThreadRouteRef: () => useAtomValue(h.routeAtom) };
});
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => h.navigate }));
// Both have their own tests; this one is about the tree.
vi.mock("./MetaTabs", () => ({ MetaTabs: () => null }));
vi.mock("./StatsStrip", () => ({ StatsStrip: () => null }));

const environmentId = EnvironmentId.make("environment-seed");
const refOf = (threadId: ThreadId) => ({ environmentId, threadId });
const keyOf = (threadId: ThreadId) => scopedThreadKey(refOf(threadId));
const seedThreads = orchestrationSeedTree.threads;

let registry: AtomRegistry.AtomRegistry;
let root: Root;
let container: HTMLDivElement;

function setThreads(threads: ReadonlyArray<OrchestrationV2ThreadShell>) {
  registry.set(h.snapshotAtom(environmentId), {
    schemaVersion: 1,
    snapshotSequence: 0,
    projects: [],
    threads,
    archivedThreads: [],
  });
}

function replaceThread(
  id: ThreadId,
  update: (thread: OrchestrationV2ThreadShell) => OrchestrationV2ThreadShell,
) {
  const current = registry.get(h.threads.environmentThreadsAtom(environmentId));
  setThreads(current.map((thread) => (thread.id === id ? update(thread) : thread)));
}

const noop = () => undefined;

function render() {
  return act(() =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <OrchestrationSidebar
          environmentIds={[environmentId]}
          onClearMeta={noop}
          onRenameThread={noop}
        />
      </RegistryContext.Provider>,
    ),
  );
}

const rowElements = () => [...container.querySelectorAll<HTMLElement>("[data-row-key]")];
const rowElement = (key: string) => rowElements().find((element) => element.dataset.rowKey === key);
const rowDot = (key: string) =>
  rowElement(key)?.querySelector("[data-dot]")?.getAttribute("data-dot");

// TreeRow's chevron has no role or label; lucide names its icon.
const clickChevron = (key: string) =>
  rowElement(key)!
    .querySelector(".lucide-chevron-right")!
    .dispatchEvent(new MouseEvent("click", { bubbles: true }));
const treeElement = () => container.querySelector<HTMLElement>('[role="tree"]')!;
const activeRowKey = () => (document.activeElement as HTMLElement | null)?.dataset.rowKey;
const pressKey = (name: string) =>
  act(() =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }),
    ),
  );

function clearCounts() {
  h.rowRenders.clear();
  h.projectRenders.count = 0;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  registry = AtomRegistry.make();
  setThreads(seedThreads);
  useUiStateStore.getState().setSelectedMetaThreadKey(keyOf(seedMetaId(1)));
  container = document.createElement("div");
  container.style.height = "2000px";
  container.style.display = "flex";
  document.body.append(container);
  root = createRoot(container);
  clearCounts();
  h.navigate.mockReset();
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("OrchestrationSidebar", () => {
  it("commits only the streaming thread's row", async () => {
    await render();
    expect(rowDot(keyOf(seedPodId(2)))).toBe("working");
    clearCounts();

    // Streaming deltas move counts and timestamps only: nothing commits.
    replaceThread(seedPodId(2), (thread) => ({
      ...thread,
      itemCount: thread.itemCount + 5,
      visibleItemCount: thread.visibleItemCount + 5,
      updatedAt: DateTime.add(thread.updatedAt, { seconds: 30 }),
    }));
    await act(async () => undefined);
    expect([...h.rowRenders]).toEqual([]);

    // A change the dot shows re-renders that row alone, not its slice, siblings or groups.
    await act(() =>
      replaceThread(seedPodId(2), (thread) => ({ ...thread, hasActionableProposedPlan: true })),
    );
    expect([...h.rowRenders]).toEqual([[seedPodId(2), 1]]);
    expect(h.projectRenders.count).toBe(0);
    expect(rowDot(keyOf(seedPodId(2)))).toBe("needs-you");

    // The container re-renders on a collapse; equal row props keep every other row still.
    clearCounts();
    await act(() => clickChevron(keyOf(seedSliceId(2))));
    expect(rowElement(keyOf(seedPodId(4)))).toBeUndefined();
    expect([...h.rowRenders]).toEqual([[seedSliceId(2), 1]]);
    expect(h.projectRenders.count).toBe(0);
  });

  it("adds one banner row for a stale environment and leaves the other rows in place", async () => {
    await render();
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(0);
    const before = rowElements();
    const tops = before.map((element) => element.getBoundingClientRect().top);

    await act(() => registry.set(h.connectedAtom(environmentId), false));
    const banners = container.querySelectorAll('[role="status"]');
    expect(banners).toHaveLength(1);
    expect(banners[0]!.textContent).toBe("Reconnecting to homelab…");
    const after = rowElements();
    // Same nodes in the same order, each moved down by the banner's one row.
    expect(after).toHaveLength(before.length);
    after.forEach((element, index) => expect(element).toBe(before[index]));
    expect(
      after.map((element, index) => element.getBoundingClientRect().top - tops[index]!),
    ).toEqual(after.map(() => 24));
    expect(rowElement(keyOf(seedPodId(2)))!.dataset.stale).toBe("true");
    expect(rowDot(keyOf(seedPodId(2)))).toBe("working");

    await act(() => registry.set(h.connectedAtom(environmentId), true));
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(0);
  });

  it("shows a collapsed project's needs-you badge and keeps collapse across tree updates", async () => {
    await render();
    const project = rowElements()[0]!;
    await act(() => project.click());
    // The web project folds away; the server project's five rows stay.
    expect(rowElements()).toHaveLength(6);
    expect(project.querySelector("[data-dot]")?.getAttribute("data-dot")).toBe("needs-you");
    expect(project.querySelector('[aria-label="1 need you"]')).not.toBeNull();

    await act(() =>
      replaceThread(seedPodId(5), (thread) => ({ ...thread, hasActionableProposedPlan: true })),
    );
    expect(rowElements()).toHaveLength(6);
    expect(project.querySelector('[aria-label="2 need you"]')).not.toBeNull();
  });

  it("opens a row's thread and reveals the routed row under collapsed ancestors", async () => {
    await render();
    await act(() => clickChevron(keyOf(seedSliceId(1))));
    expect(rowElement(keyOf(seedPodId(1)))).toBeUndefined();
    expect(h.navigate).not.toHaveBeenCalled();

    await act(() => rowElement(keyOf(seedSliceId(1)))!.click());
    expect(h.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: refOf(seedSliceId(1)),
    });

    await act(() => registry.set(h.routeAtom, refOf(seedPodId(3))));
    expect(rowElement(keyOf(seedPodId(3)))).toBeDefined();
    expect(rowElement(keyOf(seedPodId(3)))!.getAttribute("aria-selected")).toBe("true");
  });

  it("moves focus with the arrow keys and opens the focused row with Enter", async () => {
    await render();
    const tree = treeElement();
    await act(() => tree.focus());
    expect(activeRowKey()).toBe(rowElements()[0]!.dataset.rowKey);
    expect(tree.tabIndex).toBe(-1);

    await pressKey("ArrowDown");
    await pressKey("ArrowRight");
    expect(activeRowKey()).toBe(keyOf(seedSliceId(1)));
    await pressKey("ArrowLeft");
    expect(rowElement(keyOf(seedPodId(1)))).toBeUndefined();
    await pressKey("Enter");
    expect(h.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: refOf(seedSliceId(1)),
    });

    // Tab and Escape belong to the browser.
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
  });

  it("focuses a pressed row in place, without scrolling the list or losing the click", async () => {
    container.style.height = "200px";
    await render();
    const tree = treeElement();
    await act(() => tree.focus());
    expect(activeRowKey()).toBe(rowElements()[0]!.dataset.rowKey);
    tree.scrollTop = tree.scrollHeight;
    const scrollTop = tree.scrollTop;
    expect(scrollTop).toBeGreaterThan(0);

    const lastPod = keyOf(seedPodId(8));
    await userEvent.click(rowElement(lastPod)!);
    await act(async () => undefined);
    expect(activeRowKey()).toBe(lastPod);
    expect(tree.scrollTop).toBe(scrollTop);
    expect(h.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: refOf(seedPodId(8)),
    });
    await pressKey("ArrowUp");
    expect(activeRowKey()).toBe(keyOf(seedPodId(7)));
  });

  it("keeps focus in the tree when the focused row is collapsed away", async () => {
    await render();
    const tree = treeElement();
    await act(() => tree.focus());
    await pressKey("ArrowDown");
    await pressKey("ArrowDown");
    await pressKey("ArrowDown");
    expect(activeRowKey()).toBe(keyOf(seedPodId(1)));

    await act(() => clickChevron(keyOf(seedSliceId(1))));
    expect(rowElement(keyOf(seedPodId(1)))).toBeUndefined();
    expect(activeRowKey()).toBe(keyOf(seedSliceId(1)));
    expect(tree.tabIndex).toBe(-1);
    await pressKey("ArrowDown");
    expect(activeRowKey()).toBe(rowElements()[3]!.dataset.rowKey);
  });

  it("tabs back in on a newer route rather than the row the keyboard left", async () => {
    await render();
    const tree = treeElement();
    await act(() => tree.focus());
    await pressKey("ArrowDown");
    const outside = document.createElement("button");
    document.body.append(outside);
    await act(() => outside.focus());
    expect(tree.tabIndex).toBe(0);

    await act(() => registry.set(h.routeAtom, refOf(seedPodId(7))));
    await act(() => tree.focus());
    expect(activeRowKey()).toBe(keyOf(seedPodId(7)));
    outside.remove();
  });

  it("reveals the routed row once its tab's shape arrives", async () => {
    setThreads([]);
    await render();
    await act(() => registry.set(h.routeAtom, refOf(seedPodId(2))));
    expect(rowElement(keyOf(seedPodId(2)))).toBeUndefined();

    // Collapsed before the shells land; the late reveal opens it.
    const sliceKey = keyOf(seedSliceId(1));
    await act(() => setThreads(seedThreads));
    expect(rowElement(keyOf(seedPodId(2)))).toBeDefined();
    await act(() => clickChevron(sliceKey));
    // Once revealed, a later shape change leaves the user's collapse alone.
    await act(() => replaceThread(seedPodId(4), (thread) => ({ ...thread, title: "renamed" })));
    expect(rowElement(keyOf(seedPodId(2)))).toBeUndefined();
  });
});
