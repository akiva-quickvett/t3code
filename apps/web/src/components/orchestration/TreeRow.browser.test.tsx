import { RegistryContext } from "@effect/atom-react";
import type { OrchestrationRootRollup } from "@t3tools/client-runtime/state/orchestration-tree";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import "~/index.css";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { StaleBanner } from "./StaleBanner";
import { TreeRow, type TreeRowProps } from "./TreeRow";

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
    nullShellAtom: Atom.make(null),
    connectionAtom: Atom.family((_environmentId: string) =>
      Atom.make(AsyncResult.success<{ readonly phase: string }>({ phase: "connected" })),
    ),
    shellStatusAtom: Atom.family((_environmentId: string) =>
      Atom.make<EnvironmentShellStatus>("live"),
    ),
    rollupAtom: Atom.family((_rootKey: string) => Atom.make<OrchestrationRootRollup | null>(null)),
    renders: new Map<string, number>(),
    openMenu: vi.fn(),
    menuThreadRefs: [] as ScopedThreadRef[],
  };
});

vi.mock("../../state/entities", async () => {
  const { useAtomValue } = await import("@effect/atom-react");
  return {
    useQuietThreadShell: (ref: ScopedThreadRef | null) => {
      if (ref !== null) h.renders.set(ref.threadId, (h.renders.get(ref.threadId) ?? 0) + 1);
      return useAtomValue(ref === null ? h.nullShellAtom : h.threads.quietThreadShellAtom(ref));
    },
    useProject: () => null,
  };
});
vi.mock("../../state/orchestrationTree", () => ({
  orchestrationTree: { rollupAtom: (_environmentId: string, key: string) => h.rollupAtom(key) },
}));
vi.mock("../../connection/catalog", () => ({
  environmentCatalog: { stateAtom: h.connectionAtom },
}));
vi.mock("../../state/shell", () => ({
  environmentShell: { statusAtom: h.shellStatusAtom },
}));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({ label: "homelab" }),
}));
vi.mock("../../hooks/useThreadActionMenu", () => ({
  useThreadActionMenu: (input: { readonly threadRef: ScopedThreadRef }) => {
    h.menuThreadRefs.push(input.threadRef);
    return { openMenu: h.openMenu, closeMenu: () => undefined };
  },
}));

const environmentId = EnvironmentId.make("environment-tree");
const providerInstanceId = ProviderInstanceId.make("codex");
const createdAt = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");

function thread(
  id: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    projectId: ProjectId.make("project-tree"),
    title: id,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
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

const running = (id: string) =>
  thread(id, {
    latestRunId: RunId.make(`run-${id}`),
    activeRunId: RunId.make(`run-${id}`),
    status: "running",
  });

function setThreads(threads: ReadonlyArray<OrchestrationV2ThreadShell>) {
  h.registry.set(h.snapshotAtom(environmentId), {
    schemaVersion: 1,
    snapshotSequence: 0,
    projects: [],
    threads,
    archivedThreads: [],
  });
}

const noop = () => undefined;

function rowProps(id: string, overrides: Partial<TreeRowProps> = {}): TreeRowProps {
  return {
    rowKey: id,
    environmentId,
    threadId: ThreadId.make(id),
    label: id,
    kind: "pod",
    depth: 1,
    guideMask: 1,
    expanded: null,
    rollupKey: null,
    repoTag: null,
    noSlice: false,
    selected: false,
    onSelect: noop,
    onToggle: noop,
    onRename: noop,
    ...overrides,
  };
}

let root: Root;
let container: HTMLDivElement;

// Fresh, equal props objects on every call: only `memo` keeps rows from rendering.
function render(rows: ReadonlyArray<TreeRowProps>) {
  return act(() =>
    root.render(
      <RegistryContext.Provider value={h.registry}>
        <StaleBanner environmentId={environmentId} />
        {rows.map((row) => (
          <TreeRow key={row.rowKey} {...row} />
        ))}
      </RegistryContext.Provider>,
    ),
  );
}

const rowElement = (id: string) => container.querySelector<HTMLElement>(`[data-row-key="${id}"]`)!;
const rowDot = (id: string) => rowElement(id).querySelector("[data-dot]")?.getAttribute("data-dot");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  h.renders.clear();
  h.openMenu.mockReset();
  h.menuThreadRefs.length = 0;
  setThreads([]);
  h.registry.set(h.connectionAtom(environmentId), AsyncResult.success({ phase: "connected" }));
  h.registry.set(h.shellStatusAtom(environmentId), "live");
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("TreeRow", () => {
  it("commits only the row whose thread changed, and none for streaming ticks", async () => {
    const threads = [running("a"), running("b"), thread("c")];
    setThreads(threads);
    const rows = () => ["a", "b", "c"].map((id) => rowProps(id));
    await render(rows());
    expect(rowDot("b")).toBe("working");
    h.renders.clear();

    await render(rows());
    expect([...h.renders]).toEqual([]);

    // Streaming: item counts and timestamps move while b runs.
    const streamed = {
      ...threads[1]!,
      itemCount: 9,
      visibleItemCount: 9,
      updatedAt: DateTime.makeUnsafe("2026-10-01T00:01:00.000Z"),
    };
    await act(() => setThreads([threads[0]!, streamed, threads[2]!]));
    expect([...h.renders]).toEqual([]);

    await act(() =>
      setThreads([threads[0]!, { ...streamed, hasActionableProposedPlan: true }, threads[2]!]),
    );
    expect([...h.renders]).toEqual([["b", 1]]);
    expect(rowDot("b")).toBe("needs-you");
  });

  it("dims a stale environment's rows under one banner, keeping their dots", async () => {
    setThreads([running("a"), thread("b")]);
    await render([rowProps("a"), rowProps("b")]);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(0);

    await act(() =>
      h.registry.set(h.connectionAtom(environmentId), AsyncResult.success({ phase: "backoff" })),
    );
    const banners = container.querySelectorAll('[role="status"]');
    expect(banners).toHaveLength(1);
    expect(banners[0]!.textContent).toBe("Reconnecting to homelab…");
    expect(banners[0]!.getBoundingClientRect().height).toBe(24);
    expect(rowElement("a").dataset.stale).toBe("true");
    expect(rowElement("b").dataset.stale).toBe("true");
    expect(getComputedStyle(rowElement("a")).opacity).toBe("0.45");
    expect(rowDot("a")).toBe("working");

    await act(() =>
      h.registry.set(h.connectionAtom(environmentId), AsyncResult.success({ phase: "connected" })),
    );
    await act(() => h.registry.set(h.shellStatusAtom(environmentId), "synchronizing"));
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(rowElement("a").dataset.stale).toBe("true");

    await act(() => h.registry.set(h.shellStatusAtom(environmentId), "live"));
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(0);
    expect(rowElement("a").dataset.stale).toBeUndefined();
  });

  it("shows the roll-up dot and needs-you count only while collapsed", async () => {
    setThreads([thread("slice")]);
    h.registry.set(h.rollupAtom("slice"), { dot: "needs-you", needsYouCount: 1 });
    const props = rowProps("slice", { kind: "slice", depth: 0, rollupKey: "slice" });
    await render([{ ...props, expanded: false }]);
    expect(rowDot("slice")).toBe("needs-you");
    expect(rowElement("slice").querySelector('[aria-label="1 need you"]')).not.toBeNull();

    await render([{ ...props, expanded: true }]);
    expect(rowDot("slice")).toBe("idle");
    expect(rowElement("slice").querySelector('[aria-label="1 need you"]')).toBeNull();
  });

  it("fades a settled row's title but not its dot", async () => {
    setThreads([thread("a", { settledOverride: "settled" })]);
    await render([rowProps("a")]);
    expect(rowElement("a").dataset.dim).toBe("true");
    expect(getComputedStyle(rowElement("a")).opacity).toBe("1");
    const dot = rowElement("a").querySelector<HTMLElement>("[data-dot]")!;
    expect(getComputedStyle(dot.parentElement!).opacity).toBe("1");
    expect(getComputedStyle(rowElement("a").querySelector(".truncate")!).opacity).toBe("0.55");
  });

  it("opens the shared thread action menu for its own thread", async () => {
    setThreads([thread("a"), thread("b")]);
    await render([rowProps("a"), rowProps("b")]);
    expect(h.menuThreadRefs).toEqual([]);
    await act(() =>
      rowElement("b").querySelector<HTMLButtonElement>('[aria-label="Thread actions"]')!.click(),
    );
    expect(h.menuThreadRefs.at(-1)).toEqual({ environmentId, threadId: "b" });
    expect(h.openMenu).toHaveBeenCalledTimes(1);
  });
});
