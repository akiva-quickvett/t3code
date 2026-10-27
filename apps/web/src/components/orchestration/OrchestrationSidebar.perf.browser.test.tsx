import { RegistryContext } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { NO_META_TAB_KEY } from "@t3tools/client-runtime/state/orchestration-tree";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  type OrchestrationDot as OrchestrationDotKind,
  type OrchestrationStatsSnapshot,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  RuntimeRequestId,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import {
  orchestrationSeedTree,
  pad,
  SEED_THREAD_COUNT,
  seedExpectedDots,
  seedMetaId,
  seedPodId,
} from "@t3tools/shared/testing/orchestrationSeedTree";
import * as DateTime from "effect/DateTime";
import { type AsyncResult, AtomRegistry } from "effect/reactivity";
import { act, Profiler, type ProfilerOnRenderCallback } from "react";
import { createRoot, type Root } from "react-dom/client";
import "~/index.css";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { useUiStateStore } from "../../uiStateStore";
import { OrchestrationSidebar } from "./OrchestrationSidebar";

// Master acceptance (f3-perf-acceptance): a sidebar commit for one thread's
// status change stays under a frame at 300 threads.
const COMMIT_MEDIAN_BUDGET_MS = 16;
const COMMIT_MAX_BUDGET_MS = 32;
const THREAD_COUNT = 300;
const STATUS_UPDATES = 20;
const STREAMING_TICKS = 50;
// No herdr screenshot count has been supplied yet. Until it is, this is the
// signed mockup's geometry at 1440×900: 900 − 32 header − 24 tabs − 20 stats
// strip = 824px of 24px rows ≈ 34 rows.
const HERDR_VISIBLE_ROWS = 34;
const VIEWPORT = { width: 1440, height: 900 } as const;
const SIDEBAR_WIDTH_PX = 256;
const HEADER_HEIGHT_PX = 32;

const h = await vi.hoisted(async () => {
  const { Atom, AsyncResult, AtomRegistry } = await import("effect/reactivity");
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
  const streams = { push: null as ((snapshot: OrchestrationStatsSnapshot) => void) | null };
  const capabilities = { orchestrationStats: true, orchestrationMetas: true };
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
    // Stands in for the stats RPC subscription, as in StatsStrip.browser.test.tsx.
    streams,
    statsAtom: Atom.family((_environmentId: string) =>
      Atom.make((get) => {
        get.addFinalizer(() => {
          streams.push = null;
        });
        streams.push = (snapshot) => get.setSelf(AsyncResult.success(snapshot));
        return AsyncResult.initial<OrchestrationStatsSnapshot, never>(
          true,
        ) as AsyncResult.AsyncResult<OrchestrationStatsSnapshot, never>;
      }),
    ),
    serverConfigs: new Map<string, { readonly environment: { readonly capabilities: object } }>(),
    capabilities,
    sliceBurnRegistry: AtomRegistry.make(),
    routeAtom: Atom.make<ScopedThreadRef | null>(null),
    projectTitles: new Map<string, string>(),
    /** When set before mount, every TreeRow sits in its own `<Profiler id={rowKey}>`. */
    profileRows: { enabled: false },
    rowMounts: new Set<string>(),
    rowCommits: new Map<string, number>(),
    // GroupRow (project and branch rows) is private to OrchestrationSidebar,
    // so it gets no Profiler; it calls `useProject` once per render, keyed here
    // by project id. RepoTaggedTreeRow calls it too, under the tag's project id.
    groupRenders: new Map<string, number>(),
  };
});

vi.mock("./TreeRow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./TreeRow")>();
  const React = await import("react");
  const onRowRender: ProfilerOnRenderCallback = (id, phase) => {
    if (phase === "mount") h.rowMounts.add(id);
    else h.rowCommits.set(id, (h.rowCommits.get(id) ?? 0) + 1);
  };
  // Same shallow memo as TreeRow, so the wrapper bails exactly when the row
  // does; the Profiler then reports only commits inside the row itself.
  const ProfiledTreeRow = React.memo(function ProfiledTreeRow(props: TreeRowProps) {
    const row = React.createElement(actual.TreeRow, props);
    return h.profileRows.enabled
      ? React.createElement(React.Profiler, { id: props.rowKey, onRender: onRowRender }, row)
      : row;
  });
  return { ...actual, TreeRow: ProfiledTreeRow };
});
type TreeRowProps = import("./TreeRow").TreeRowProps;

vi.mock("../../state/entities", async () => {
  const { useAtomValue } = await import("@effect/atom-react");
  const { Atom } = await import("effect/reactivity");
  const nullShellAtom = Atom.make(null);
  return {
    useQuietThreadShell: (ref: ScopedThreadRef | null) =>
      useAtomValue(ref === null ? nullShellAtom : h.threads.quietThreadShellAtom(ref)),
    useProject: (ref: ScopedProjectRef | null) => {
      const key = ref?.projectId ?? "branch";
      h.groupRenders.set(key, (h.groupRenders.get(key) ?? 0) + 1);
      const title = ref === null ? undefined : h.projectTitles.get(ref.projectId);
      return title === undefined ? null : { title };
    },
    useServerConfigs: () => h.serverConfigs,
    useThreadHistory: () => ({ hasMoreHistory: false }),
    useThreadProjection: () => null,
  };
});
vi.mock("../../state/threads", () => ({
  environmentThreadShells: h.threads,
  threadEnvironment: { setMeta: null },
}));
vi.mock("../../state/orchestrationTree", () => ({
  orchestrationTree: h.orchestrationTree,
  environmentConnectedAtom: h.connectedAtom,
}));
vi.mock("../../state/shell", () => ({ environmentShell: { statusAtom: h.shellStatusAtom } }));
vi.mock("../../state/environments", () => ({ useEnvironment: () => ({ label: "homelab" }) }));
vi.mock("../../state/presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentPresentations: {
      serverConfigsAtom: Atom.make(h.serverConfigs),
      providersByEnvironmentAtom: Atom.make(new Map()),
    },
  };
});
vi.mock("../../state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: {
    orchestrationStatsLive: (target: { readonly environmentId: string }) =>
      h.statsAtom(target.environmentId),
  },
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => async () => ({ _tag: "Success" }),
}));
vi.mock("../../rpc/atomRegistry", () => ({ appAtomRegistry: h.sliceBurnRegistry }));
vi.mock("../settings/OrganPresetsSettings", () => ({ PromotePickerDialog: () => null }));
vi.mock("../settings/presetSettingsControls", () => ({ reportFailure: () => undefined }));
vi.mock("../../hooks/useThreadActionMenu", () => ({
  useThreadActionMenu: () => ({ openMenu: () => undefined, closeMenu: () => undefined }),
}));
vi.mock("../../hooks/useThreadRouteTarget", async () => {
  const { useAtomValue } = await import("@effect/atom-react");
  return { useThreadRouteRef: () => useAtomValue(h.routeAtom) };
});
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => undefined }));

const environmentId = EnvironmentId.make("environment-seed");
const keyOf = (threadId: ThreadId) => scopedThreadKey({ environmentId, threadId });
const seed = pad(orchestrationSeedTree, THREAD_COUNT);
const padIds = seed.threads.map((thread) => thread.id).filter((id) => id.startsWith("seed-pad-"));

// ── Expected roll-ups, from the fixture's own data and the lock rules (L19–L21,
// L29), not from the classifier. A slice belongs to the meta that supervises it;
// pods and cells belong to their slice's row and project. A pod or root with no
// slice above it is a No meta row in its own project.

type Placement = {
  readonly tabKey: string;
  readonly projectId: ProjectId | null;
  readonly isRow: boolean;
};

const shellById = new Map(seed.threads.map((thread) => [thread.id, thread]));
const parentOf = (thread: OrchestrationV2ThreadShell) => {
  const parentId = thread.lineage.supervisorThreadId ?? thread.lineage.parentThreadId ?? null;
  return parentId === null ? null : (shellById.get(parentId) ?? null);
};
const roleOf = (thread: OrchestrationV2ThreadShell) => thread.rolePreset?.id ?? null;

function placementOf(thread: OrchestrationV2ThreadShell): Placement | null {
  if (thread.metaAt != null) return null;
  const chain: OrchestrationV2ThreadShell[] = [];
  for (let next: OrchestrationV2ThreadShell | null = thread; next !== null; next = parentOf(next)) {
    chain.push(next);
  }
  const slice = chain.find((link) => roleOf(link) === "slice");
  if (slice !== undefined) {
    const meta = parentOf(slice);
    return {
      tabKey: meta?.metaAt != null ? keyOf(meta.id) : NO_META_TAB_KEY,
      projectId: slice.projectId,
      isRow: roleOf(thread) === "slice" || roleOf(thread) === "broker",
    };
  }
  const pod = chain.find((link) => roleOf(link) === "broker");
  if (pod !== undefined) {
    return { tabKey: NO_META_TAB_KEY, projectId: pod.projectId, isRow: pod === thread };
  }
  const root = chain.at(-1)!;
  if (root.metaAt != null) return { tabKey: keyOf(root.id), projectId: null, isRow: false };
  return { tabKey: NO_META_TAB_KEY, projectId: root.projectId, isRow: root === thread };
}

function expectedDot(thread: OrchestrationV2ThreadShell): OrchestrationDotKind {
  const dot = seedExpectedDots[thread.id]?.dot;
  if (dot !== undefined) return dot;
  // `pad` adds idle ad-hoc chats only.
  if (!thread.id.startsWith("seed-pad-")) throw new Error(`No expected dot for ${thread.id}`);
  return "idle";
}

const placements = seed.threads.flatMap((thread) => {
  const placement = placementOf(thread);
  return placement === null ? [] : [{ thread, ...placement, dot: expectedDot(thread) }];
});
const metaTabKeys = seed.threads.filter((thread) => thread.metaAt != null).map((t) => keyOf(t.id));
const tabKeys = [...metaTabKeys, NO_META_TAB_KEY];

function expectedNeedsYou(tabKey: string): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const placement of placements) {
    if (placement.tabKey !== tabKey || placement.projectId === null) continue;
    const count = counts.get(placement.projectId) ?? 0;
    counts.set(placement.projectId, count + (placement.dot === "needs-you" ? 1 : 0));
  }
  return counts;
}

function expectedUnread(tabKey: string): number {
  const meta = tabKey === NO_META_TAB_KEY ? [] : [shellById.get(seedIdOfKey(tabKey))!];
  return [
    ...meta.map(expectedDot),
    ...placements.filter((p) => p.tabKey === tabKey).map((p) => p.dot),
  ].filter((dot) => dot === "needs-you" || dot === "done-unread").length;
}

function seedIdOfKey(key: string): ThreadId {
  return seed.threads.find((thread) => keyOf(thread.id) === key)!.id;
}

const expectedRowCount = (tabKey: string) =>
  placements.filter((p) => p.tabKey === tabKey && p.isRow).length;

// ── Harness

let registry: AtomRegistry.AtomRegistry;
let root: Root;
let container: HTMLDivElement;
let sidebarCommits: Array<{ readonly phase: string; readonly actualDuration: number }> = [];

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

const toApproval = (thread: OrchestrationV2ThreadShell): OrchestrationV2ThreadShell => ({
  ...thread,
  activityRunStatus: "waiting",
  pendingRuntimeRequest: {
    id: RuntimeRequestId.make(`perf-request-${thread.id}`),
    kind: "command",
    createdAt: DateTime.add(thread.updatedAt, { seconds: 1 }),
  },
});

const noop = () => undefined;
const onSidebarRender: ProfilerOnRenderCallback = (_id, phase, actualDuration) => {
  sidebarCommits.push({ phase, actualDuration });
};

function render() {
  return act(() =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <Profiler id="orchestration-sidebar" onRender={onSidebarRender}>
          <OrchestrationSidebar
            environmentIds={[environmentId]}
            onClearMeta={noop}
            onRenameThread={noop}
          />
        </Profiler>
      </RegistryContext.Provider>,
    ),
  );
}

const selectTab = (tabKey: string) =>
  act(() => useUiStateStore.getState().setSelectedMetaThreadKey(tabKey));

const treeElement = () => {
  const tree = container.querySelector<HTMLElement>('[role="tree"]');
  if (tree === null) throw new Error("The orchestration tree did not render.");
  return tree;
};
const treeItems = () => {
  const items = [...treeElement().querySelectorAll<HTMLElement>('[role="treeitem"]')];
  if (items.length === 0) throw new Error("No tree rows rendered.");
  return items;
};
const rowElement = (key: string) =>
  treeItems().find((element) => element.dataset.rowKey === key) ?? null;
const rowDot = (key: string) =>
  rowElement(key)?.querySelector("[data-dot]")?.getAttribute("data-dot");
const projectRows = () =>
  treeItems().filter((element) => element.dataset.rowKey!.startsWith('["project"'));
const projectIdOf = (element: HTMLElement) =>
  (JSON.parse(element.dataset.rowKey!) as [string, string, string, string])[3];
const threadRows = () => treeItems().filter((element) => !element.dataset.rowKey!.startsWith("["));
const projectRowKey = (tabKey: string, projectId: string) =>
  JSON.stringify(["project", environmentId, tabKey, projectId]);

function clearCounters() {
  h.rowMounts.clear();
  h.rowCommits.clear();
  h.groupRenders.clear();
  sidebarCommits = [];
}

const median = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
};
const ms = (value: number) => Number(value.toFixed(2));

beforeAll(async () => {
  await page.viewport(VIEWPORT.width, VIEWPORT.height);
  for (const project of seed.projects) h.projectTitles.set(project.id, project.title);
  h.serverConfigs.set(environmentId, { environment: { capabilities: h.capabilities } });
});

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  registry = AtomRegistry.make();
  setThreads(seed.threads);
  useUiStateStore.getState().setSelectedMetaThreadKey(NO_META_TAB_KEY);
  h.profileRows.enabled = false;
  // The app's sidebar column: a 32px header above the view, the view filling the rest.
  container = document.createElement("div");
  Object.assign(container.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: `${SIDEBAR_WIDTH_PX}px`,
    height: `${VIEWPORT.height}px`,
    display: "flex",
    flexDirection: "column",
  });
  const header = document.createElement("div");
  header.style.height = `${HEADER_HEIGHT_PX}px`;
  header.style.flexShrink = "0";
  const host = document.createElement("div");
  Object.assign(host.style, {
    flex: "1",
    minHeight: "0",
    display: "flex",
    flexDirection: "column",
  });
  container.append(header, host);
  document.body.append(container);
  root = createRoot(host);
  clearCounters();
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function mountSeeded() {
  await render();
  await act(() =>
    h.streams.push?.({
      activeAgents: { runningTurns: 4, liveSessions: 7, idleSessions: 3 },
      burn: {
        state: "ready",
        tokensPerMinute: 18_000,
        usdPerHour: 4.2,
        approximate: false,
        perMeta: {},
        perSlice: {},
      },
      host: { verdict: "ok", cpu: 0.2, ram: 0.5, swap: 0.1, load: 0.4 },
    }),
  );
  expect(registry.get(h.threads.environmentThreadsAtom(environmentId))).toHaveLength(THREAD_COUNT);
  expect(container.querySelector('button[aria-expanded][aria-label*="active"]')).not.toBeNull();
}

describe("OrchestrationSidebar at 300 threads", () => {
  it("commits one thread's status change within the frame budget", async () => {
    await mountSeeded();
    // No meta holds every padding chat, so it is the largest tab.
    const rows = threadRows();
    expect(rows).toHaveLength(expectedRowCount(NO_META_TAB_KEY));
    expect(rows.length).toBeGreaterThan(THREAD_COUNT - SEED_THREAD_COUNT);
    expect(sidebarCommits.some((commit) => commit.phase === "mount")).toBe(true);

    const targets = padIds.slice(0, STATUS_UPDATES + 1);
    const toPlanReady = (thread: OrchestrationV2ThreadShell) => ({
      ...thread,
      hasActionableProposedPlan: true,
    });
    // Warm-up: the first update pays one-off atom and module costs.
    await act(() => replaceThread(targets[0]!, toPlanReady));
    expect(rowDot(keyOf(targets[0]!))).toBe("needs-you");

    const durations: number[] = [];
    // Includes the atom recompute over all 300 threads, which the Profiler does not time.
    const endToEnd: number[] = [];
    for (const id of targets.slice(1)) {
      sidebarCommits = [];
      expect(rowDot(keyOf(id))).toBe("idle");
      const started = performance.now();
      await act(() => replaceThread(id, toPlanReady));
      endToEnd.push(performance.now() - started);
      expect(rowDot(keyOf(id))).toBe("needs-you");
      expect(sidebarCommits.length).toBeGreaterThan(0);
      durations.push(sidebarCommits.reduce((sum, commit) => sum + commit.actualDuration, 0));
    }
    const result = {
      threads: THREAD_COUNT,
      renderedThreadRows: rows.length,
      updates: durations.length,
      medianMs: ms(median(durations)),
      maxMs: ms(Math.max(...durations)),
      durationsMs: durations.map(ms),
      endToEndMedianMs: ms(median(endToEnd)),
      endToEndMaxMs: ms(Math.max(...endToEnd)),
    };
    console.info("[perf] commit budget", JSON.stringify(result));
    expect(durations).toHaveLength(STATUS_UPDATES);
    expect(Math.max(...durations)).toBeGreaterThan(0);
    expect(result.medianMs).toBeLessThan(COMMIT_MEDIAN_BUDGET_MS);
    expect(result.maxMs).toBeLessThan(COMMIT_MAX_BUDGET_MS);
  });

  it("commits no row while a thread streams, and only the changed rows on a status change", async () => {
    h.profileRows.enabled = true;
    const metaOne = keyOf(seedMetaId(1));
    const metaTwo = keyOf(seedMetaId(2));
    useUiStateStore.getState().setSelectedMetaThreadKey(metaOne);
    await mountSeeded();
    const streamingKey = keyOf(seedPodId(2));
    expect(rowDot(streamingKey)).toBe("working");
    // Every thread row mounted inside its own Profiler, and the group rows counted.
    const mountedRows = threadRows().map((row) => row.dataset.rowKey);
    expect(mountedRows).toHaveLength(expectedRowCount(metaOne));
    expect([...h.rowMounts].toSorted()).toEqual(mountedRows.toSorted());
    const mountedProjects = projectRows().map(projectIdOf);
    expect(mountedProjects.length).toBeGreaterThan(0);
    for (const projectId of mountedProjects) expect(h.groupRenders.has(projectId)).toBe(true);
    clearCounters();

    for (let tick = 1; tick <= STREAMING_TICKS; tick += 1) {
      await act(() =>
        replaceThread(seedPodId(2), (thread) => ({
          ...thread,
          itemCount: thread.itemCount + 1,
          visibleItemCount: thread.visibleItemCount + 1,
          updatedAt: DateTime.add(thread.updatedAt, { seconds: 1 }),
        })),
      );
    }
    const streamed = registry
      .get(h.threads.environmentThreadsAtom(environmentId))
      .find((thread) => thread.id === seedPodId(2))!;
    expect(streamed.itemCount).toBe(6 + STREAMING_TICKS);
    const streaming = {
      ticks: STREAMING_TICKS,
      treeRowCommits: Object.fromEntries(h.rowCommits),
      groupRowRenders: Object.fromEntries(h.groupRenders),
      sidebarCommits: sidebarCommits.length,
    };
    console.info("[perf] streaming isolation", JSON.stringify(streaming));
    expect([...h.rowCommits]).toEqual([]);
    expect([...h.groupRenders]).toEqual([]);

    // Expanded: the status change commits that pod's row and nothing else in the tree.
    clearCounters();
    await act(() => replaceThread(seedPodId(2), toApproval));
    expect(rowDot(streamingKey)).toBe("needs-you");
    const expandedChange = {
      treeRowCommits: Object.fromEntries(h.rowCommits),
      groupRowRenders: Object.fromEntries(h.groupRenders),
    };
    console.info("[perf] status change, project expanded", JSON.stringify(expandedChange));
    expect([...h.rowCommits]).toEqual([[streamingKey, 1]]);
    expect([...h.groupRenders]).toEqual([]);

    // Collapsed: pod 12 (working, meta 2's web project) is hidden under its
    // project, so the project row is the only row left to show the change.
    await selectTab(metaTwo);
    const podTwelve = seedPodId(12);
    expect(rowDot(keyOf(podTwelve))).toBe("working");
    const webProjectId = shellById.get(podTwelve)!.projectId;
    const webKey = projectRowKey(metaTwo, webProjectId);
    await act(() => rowElement(webKey)!.click());
    expect(rowElement(keyOf(podTwelve))).toBeNull();
    const badge = () => rowElement(webKey)!.querySelector('[aria-label$=" need you"]');
    const before = expectedNeedsYou(metaTwo).get(webProjectId)!;
    expect(badge()?.getAttribute("aria-label")).toBe(`${before} need you`);
    clearCounters();
    await act(() => replaceThread(podTwelve, toApproval));
    const collapsedChange = {
      treeRowCommits: Object.fromEntries(h.rowCommits),
      groupRowRenders: Object.fromEntries(h.groupRenders),
    };
    console.info("[perf] status change, project collapsed", JSON.stringify(collapsedChange));
    expect(badge()?.getAttribute("aria-label")).toBe(`${before + 1} need you`);
    expect([...h.rowCommits]).toEqual([]);
    expect([...h.groupRenders]).toEqual([[webProjectId, 1]]);
  });

  it("keeps every needs-you count visible with every project collapsed", async () => {
    await mountSeeded();
    const seen: Record<string, unknown> = {};
    for (const tabKey of tabKeys) {
      await selectTab(tabKey);
      const expected = expectedNeedsYou(tabKey);
      expect(projectRows().map(projectIdOf).toSorted()).toEqual([...expected.keys()].toSorted());
      for (const row of projectRows()) {
        await act(() => row.click());
      }
      // Collapsed: only the project rows remain.
      expect(treeItems()).toHaveLength(expected.size);
      expect(treeItems().every((row) => row.getAttribute("aria-expanded") === "false")).toBe(true);
      const shown: Record<string, number> = {};
      for (const row of projectRows()) {
        const projectId = projectIdOf(row);
        const count = expected.get(projectId)!;
        const badge = row.querySelector('[aria-label$=" need you"]');
        shown[projectId] = badge === null ? 0 : Number(badge.textContent);
        if (count > 0) {
          expect(row.querySelector("[data-dot]")?.getAttribute("data-dot")).toBe("needs-you");
          expect(badge?.getAttribute("aria-label")).toBe(`${count} need you`);
        } else {
          expect(row.querySelector("[data-dot]")?.getAttribute("data-dot")).not.toBe("needs-you");
          expect(badge).toBeNull();
        }
      }
      seen[tabKey] = { expected: Object.fromEntries(expected), shown };
    }
    console.info("[perf] collapsed needs-you", JSON.stringify(seen));
    // The fixture has needs-you threads in both metas' trees.
    const totalNeedsYou = tabKeys.reduce(
      (sum, tabKey) => sum + [...expectedNeedsYou(tabKey).values()].reduce((a, b) => a + b, 0),
      0,
    );
    expect(totalNeedsYou).toBeGreaterThan(0);

    const tabs = [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(tabs).toHaveLength(tabKeys.length);
    const unread = tabs.map((tab) =>
      Number(tab.querySelector('[aria-label$=" unread"]')?.textContent ?? 0),
    );
    const expectedUnreads = tabKeys.map(expectedUnread);
    console.info("[perf] tab unread", JSON.stringify({ shown: unread, expected: expectedUnreads }));
    expect(expectedUnreads.some((count) => count > 0)).toBe(true);
    expect(unread).toEqual(expectedUnreads);
  });

  it("runs no animation on rows or dots", async () => {
    await mountSeeded();
    const assertStatic = () => {
      expect(document.getAnimations()).toEqual([]);
      const dots = [...container.querySelectorAll<HTMLElement>("[data-dot]")];
      const rows = treeItems();
      expect(dots.length).toBeGreaterThan(0);
      for (const element of [...dots, ...rows]) {
        expect(getComputedStyle(element).animationName).toBe("none");
      }
      return { dots: dots.length, rows: rows.length };
    };
    const afterRender = assertStatic();
    // A working thread is present, the case a pulse would animate.
    expect(rowDot(keyOf(seedPodId(15)))).toBe("working");
    await act(() => replaceThread(seedPodId(15), toApproval));
    expect(rowDot(keyOf(seedPodId(15)))).toBe("needs-you");
    const afterChange = assertStatic();
    console.info("[perf] no animation", JSON.stringify({ afterRender, afterChange }));
  });

  it("shows at least the herdr screenshot's row count at 1440×900", async () => {
    await mountSeeded();
    expect([window.innerWidth, window.innerHeight]).toEqual([VIEWPORT.width, VIEWPORT.height]);
    const tree = treeElement().getBoundingClientRect();
    const rows = treeItems();
    // Every row is one 24px line, whatever it holds.
    expect(new Set(rows.map((row) => row.getBoundingClientRect().height))).toEqual(new Set([24]));
    const visible = rows.filter((row) => {
      const rect = row.getBoundingClientRect();
      return rect.top >= tree.top && rect.bottom <= Math.min(tree.bottom, window.innerHeight);
    }).length;
    console.info(
      "[perf] density",
      JSON.stringify({
        visibleRows: visible,
        renderedRows: rows.length,
        sidebarWidth: SIDEBAR_WIDTH_PX,
        tabsHeight: container.querySelector('[role="tablist"]')!.getBoundingClientRect().height,
        treeHeight: tree.height,
      }),
    );
    expect(rows.length).toBeGreaterThan(visible);
    expect(visible).toBeGreaterThanOrEqual(HERDR_VISIBLE_ROWS);
  });
});
