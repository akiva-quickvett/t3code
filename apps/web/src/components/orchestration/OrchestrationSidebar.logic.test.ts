import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  createOrchestrationTreeAtoms,
  NO_META_TAB_KEY,
  type OrchestrationStructureRow,
  type OrchestrationStructureTree,
} from "@t3tools/client-runtime/state/orchestration-tree";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, type OrchestrationV2ThreadShell, type ThreadId } from "@t3tools/contracts";
import {
  orchestrationSeedTree,
  SEED_AD_HOC_CHAT_ID,
  SEED_CROSS_REPO_POD_ID,
  SEED_SLICELESS_POD_ID,
  seedMetaId,
  seedPodId,
  seedExpectedDots,
  seedSliceId,
} from "@t3tools/shared/testing/orchestrationSeedTree";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  buildOrchestrationRows,
  countThreadRows,
  expandKeys,
  foldRollups,
  hideableSettledKeys,
  type OrchestrationSection,
  orchestrationSections,
  type OrchestrationViewRow,
  revealPath,
  setCollapsed,
  splitRowKeys,
  treeKeyAction,
  withoutSettledRows,
} from "./OrchestrationSidebar.logic";

const environmentId = EnvironmentId.make("environment-seed");
const keyOf = (threadId: ThreadId) => scopedThreadKey({ environmentId, threadId });
const NONE: ReadonlySet<string> = new Set();

function makeHarness(threads: ReadonlyArray<OrchestrationV2ThreadShell>) {
  const threadsAtom = Atom.make(threads);
  const atoms = createOrchestrationTreeAtoms({
    environmentThreadsAtom: () => threadsAtom,
    environmentShellStatusAtom: () => Atom.make<EnvironmentShellStatus>("live"),
    environmentConnectedAtom: () => Atom.make(true),
    // After every seed run and wake, before the far-future snoozes end.
    now: () => "2026-10-03T00:00:00.000Z",
  });
  const registry = AtomRegistry.make();
  const sections = (tabKey: string) =>
    orchestrationSections({
      tabKey,
      environmentIds: [environmentId],
      structureOf: (id) => registry.get(atoms.structureAtom(id)),
    });
  const groupRollup = (row: OrchestrationViewRow) =>
    row.type === "project" || row.type === "branch"
      ? foldRollups(
          splitRowKeys(row.rollupRowKeys).map((key) =>
            registry.get(atoms.rollupAtom(environmentId, key)),
          ),
        )
      : null;
  const classification = () => registry.get(atoms.classificationAtom(environmentId));
  return { registry, threadsAtom, sections, groupRollup, classification };
}

/** A readable outline: `<depth><type or kind> <label>[ tags]`. */
function outline(rows: ReadonlyArray<OrchestrationViewRow>) {
  return rows.map((row) => {
    switch (row.type) {
      case "banner":
        return "banner";
      case "project":
        return `${row.depth} project ${row.projectId}${row.expanded ? "" : " (collapsed)"}`;
      case "branch":
        return `${row.depth} branch ${row.branch}${row.expanded ? "" : " (collapsed)"}`;
      case "thread":
        return [
          `${row.depth} ${row.kind} ${row.threadId}`,
          row.repoTag === null ? null : `repo:${row.repoTag}`,
          row.noSlice ? "no-slice" : null,
          row.expanded === false ? "(collapsed)" : null,
        ]
          .filter((part) => part !== null)
          .join(" ");
    }
  });
}

describe("buildOrchestrationRows on the seed tree (F1)", () => {
  const harness = makeHarness(orchestrationSeedTree.threads);
  const meta1 = harness.sections(keyOf(seedMetaId(1)));

  it("lays out a meta tab as project → branch → slice → pod, cross-repo pods under their slice", () => {
    const rows = buildOrchestrationRows(meta1, NONE);
    expect(outline(rows)).toEqual([
      "banner",
      "0 project seed-project-web",
      "1 branch seed/slice-1",
      "2 slice seed-slice-1",
      "3 pod seed-pod-1",
      "3 pod seed-pod-2",
      `3 pod ${SEED_CROSS_REPO_POD_ID} repo:seed-project-server`,
      "1 branch seed/slice-2",
      "2 slice seed-slice-2",
      "3 pod seed-pod-4",
      "3 pod seed-pod-5",
      "3 pod seed-pod-6",
      "0 project seed-project-server",
      "1 branch seed/slice-3",
      "2 slice seed-slice-3",
      "3 pod seed-pod-7",
      "3 pod seed-pod-8",
    ]);
    const position = (index: number) => {
      const row = rows[index]!;
      return row.type === "project" || row.type === "branch"
        ? `${row.posInSet}/${row.setSize}`
        : null;
    };
    expect([1, 2, 7, 12, 13].map(position)).toEqual(["1/2", "1/2", "2/2", "2/2", "1/1"]);
    // Every guide level is drawn; parents chain back to the project.
    const pod = rows.find((row) => row.key === keyOf(seedPodId(1)));
    expect(pod).toMatchObject({ guideMask: 0b111, parentKey: keyOf(seedSliceId(1)) });
    // Cells and metas are never rows.
    const threadIds = rows.flatMap((row) => (row.type === "thread" ? [row.threadId] : []));
    expect(threadIds.some((id) => id.startsWith("seed-cell-") || id.startsWith("seed-meta-"))).toBe(
      false,
    );
  });

  it("puts the slice-less pod and the ad-hoc chat in No meta", () => {
    const rows = buildOrchestrationRows(harness.sections(NO_META_TAB_KEY), NONE);
    expect(outline(rows)).toEqual([
      "banner",
      "0 project seed-project-web",
      "1 branch seed/pod-15",
      `2 pod ${SEED_SLICELESS_POD_ID} no-slice`,
      "0 project seed-project-home",
      `1 ad-hoc ${SEED_AD_HOC_CHAT_ID}`,
    ]);
  });

  it("hides a collapsed project's rows and keeps its subtree's needs-you count", () => {
    const meta2 = harness.sections(keyOf(seedMetaId(2)));
    const expanded = buildOrchestrationRows(meta2, NONE);
    const projectKeys = expanded.flatMap((row) => (row.type === "project" ? [row.key] : []));
    const collapsed = buildOrchestrationRows(meta2, new Set(projectKeys));
    expect(outline(collapsed)).toEqual([
      "banner",
      "0 project seed-project-server (collapsed)",
      "0 project seed-project-web (collapsed)",
    ]);
    // Server: pod 9 needs input and pod 10's plan is ready; web: a cell of pod 12 needs input.
    expect(collapsed.slice(1).map(harness.groupRollup)).toEqual([
      { dot: "needs-you", needsYouCount: 2 },
      { dot: "needs-you", needsYouCount: 1 },
    ]);
  });

  it("keeps expand state across a tree update, since keys are thread and group keys", () => {
    const collapsedKeys = setCollapsed(NONE, keyOf(seedSliceId(1)), true);
    expect(outline(buildOrchestrationRows(meta1, collapsedKeys)).slice(2, 5)).toEqual([
      "1 branch seed/slice-1",
      "2 slice seed-slice-1 (collapsed)",
      "1 branch seed/slice-2",
    ]);

    // A new pod under slice 2 changes the tab's shape.
    const pod4 = orchestrationSeedTree.threads.find((thread) => thread.id === seedPodId(4))!;
    const newPod = { ...pod4, id: "seed-pod-new" as ThreadId, title: "new" };
    harness.registry.set(harness.threadsAtom, [...orchestrationSeedTree.threads, newPod]);
    const updated = harness.sections(keyOf(seedMetaId(1)));
    expect(updated[0]!.tree).not.toBe(meta1[0]!.tree);
    const rows = outline(buildOrchestrationRows(updated, collapsedKeys));
    expect(rows.slice(2, 5)).toEqual([
      "1 branch seed/slice-1",
      "2 slice seed-slice-1 (collapsed)",
      "1 branch seed/slice-2",
    ]);
    expect(rows).toContain("3 pod seed-pod-new");
    harness.registry.set(harness.threadsAtom, orchestrationSeedTree.threads);
  });

  it("reveals a row by expanding exactly its ancestors", () => {
    const rows = buildOrchestrationRows(meta1, NONE);
    const projectKey = rows[1]!.key;
    const branchKey = rows[2]!.key;
    const path = revealPath(meta1, keyOf(seedPodId(2)))!;
    expect(path).toEqual([keyOf(seedSliceId(1)), branchKey, projectKey]);
    const unrelated = keyOf(seedSliceId(3));
    const collapsedKeys = new Set([projectKey, keyOf(seedSliceId(1)), unrelated]);
    expect([...expandKeys(collapsedKeys, path)]).toEqual([unrelated]);
    expect(expandKeys(new Set([unrelated]), path)).toEqual(new Set([unrelated]));
    // A cell is no row, and another tab's row is not in this one.
    expect(revealPath(meta1, keyOf("seed-cell-1-1" as ThreadId))).toBeNull();
    expect(revealPath(meta1, keyOf(seedPodId(9)))).toBeNull();
  });
});

describe("withoutSettledRows", () => {
  const row = (
    id: string,
    kind: OrchestrationStructureRow["kind"],
    pods: ReadonlyArray<OrchestrationStructureRow> = [],
  ): OrchestrationStructureRow => ({ key: keyOf(id as ThreadId), kind, pods });
  const tab = (projects: OrchestrationStructureTree["projects"]) => [
    { environmentId, tabKey: "tab", tree: { projects } } satisfies OrchestrationSection,
  ];
  const settled = (...ids: ReadonlyArray<string>) =>
    new Set(ids.map((id) => keyOf(id as ThreadId)));
  const hide = (
    sections: ReadonlyArray<OrchestrationSection>,
    settledKeys: ReadonlySet<string>,
    keepKey: string | null = null,
  ) => withoutSettledRows(sections, settledKeys, keepKey);

  const sections = tab([
    {
      projectId: "web",
      branches: [
        {
          branch: "slice-a",
          rows: [row("slice-a", "slice", [row("pod-a1", "pod"), row("pod-a2", "pod")])],
        },
        { branch: "slice-b", rows: [row("slice-b", "slice", [row("pod-b1", "pod")])] },
        { branch: null, rows: [row("chat", "ad-hoc")] },
      ],
    },
    {
      projectId: "server",
      branches: [{ branch: "slice-c", rows: [row("slice-c", "slice", [row("pod-c1", "pod")])] }],
    },
  ]);

  it("hides settled rows and keeps a settled row that holds an unsettled one", () => {
    const visible = hide(sections, settled("slice-a", "pod-a2", "slice-b", "pod-b1"));
    expect(outline(buildOrchestrationRows(visible, NONE))).toEqual([
      "banner",
      "0 project web",
      "1 branch slice-a",
      "2 slice slice-a",
      "3 pod pod-a1",
      "1 ad-hoc chat",
      "0 project server",
      "1 branch slice-c",
      "2 slice slice-c",
      "3 pod pod-c1",
    ]);
  });

  it("drops groups left empty and recounts positions and roll-up keys from what shows", () => {
    const visible = hide(sections, settled("slice-b", "pod-b1", "chat", "slice-c", "pod-c1"));
    const rows = buildOrchestrationRows(visible, NONE);
    expect(outline(rows)).toEqual([
      "banner",
      "0 project web",
      "1 branch slice-a",
      "2 slice slice-a",
      "3 pod pod-a1",
      "3 pod pod-a2",
    ]);
    expect(rows[1]).toMatchObject({ setSize: 1, posInSet: 1 });
    expect(rows[2]).toMatchObject({ setSize: 1, posInSet: 1 });
    expect(
      rows.flatMap((r) => (r.type === "project" ? splitRowKeys(r.rollupRowKeys) : [])),
    ).toEqual([keyOf("slice-a" as ThreadId)]);
    // A tab with nothing left shows no banner either.
    const all = settled(
      "slice-a",
      "pod-a1",
      "pod-a2",
      "slice-b",
      "pod-b1",
      "chat",
      "slice-c",
      "pod-c1",
    );
    expect(buildOrchestrationRows(hide(sections, all), NONE)).toEqual([]);
  });

  it("keeps the routed thread and its ancestors, settled or not", () => {
    const keep = keyOf("pod-c1" as ThreadId);
    const visible = hide(sections, settled("slice-c", "pod-c1"), keep);
    expect(outline(buildOrchestrationRows(visible, NONE)).slice(-4)).toEqual([
      "0 project server",
      "1 branch slice-c",
      "2 slice slice-c",
      "3 pod pod-c1",
    ]);
    expect(revealPath(visible, keep)).not.toBeNull();
  });

  it("returns the tab itself when nothing hides, and only rebuilds what changed", () => {
    expect(hide(sections, NONE)).toBe(sections);
    expect(hide(sections, settled("elsewhere"))).toBe(sections);
    // The routed thread alone is settled: nothing hides.
    expect(hide(sections, settled("chat"), keyOf("chat" as ThreadId))).toBe(sections);
    // Only an untouched branch, project and section keep their references.
    const visible = hide(sections, settled("pod-c1"));
    expect(visible).not.toBe(sections);
    expect(visible[0]!.tree.projects[0]).toBe(sections[0]!.tree.projects[0]);
    expect(visible[0]!.tree.projects[1]).not.toBe(sections[0]!.tree.projects[1]);
  });

  it("counts as hidden only the settled rows that actually leave the tree", () => {
    const hiddenCount = (settledKeys: ReadonlySet<string>, keepKey: string | null = null) =>
      countThreadRows(sections) - countThreadRows(hide(sections, settledKeys, keepKey));
    expect(countThreadRows(sections)).toBe(8);
    // A settled ancestor of an unsettled pod stays, so it is not hidden.
    expect(hiddenCount(settled("slice-a", "pod-a2"))).toBe(1);
    expect(hiddenCount(settled("slice-a"))).toBe(0);
    // Nor is the routed thread, nor its settled slice.
    expect(hiddenCount(settled("slice-c", "pod-c1"), keyOf("pod-c1" as ThreadId))).toBe(0);
    expect(hiddenCount(settled("slice-b", "pod-b1", "elsewhere"))).toBe(2);
    expect(hiddenCount(NONE)).toBe(0);
  });

  it("keeps a settled slice while a cell under it needs you or works, and hides it after", () => {
    const threads = orchestrationSeedTree.threads;
    const slice = threads.find(
      (thread) => thread.settledOverride === "settled" && thread.rolePreset?.id === "slice",
    )!;
    const pod = threads.find(
      (thread) => thread.settledOverride === "settled" && thread.rolePreset?.id === "broker",
    )!;
    const settledKeys = new Set([keyOf(slice.id), keyOf(pod.id)]);
    const cellLike = (dot: string) =>
      threads.find(
        (thread) => thread.id.startsWith("seed-cell-") && seedExpectedDots[thread.id]?.dot === dot,
      )!;
    // A cell is no row: its dot reaches only the slice's roll-up.
    const cellUnderSlice = (cell: OrchestrationV2ThreadShell) => ({
      ...cell,
      id: "seed-cell-under-settled" as ThreadId,
      lineage: { ...cell.lineage, parentThreadId: slice.id },
    });
    const harness = makeHarness(threads);
    const visibleKeys = () => {
      const hideable = new Set(hideableSettledKeys(harness.classification(), settledKeys));
      const meta2 = harness.sections(keyOf(seedMetaId(2)));
      return buildOrchestrationRows(withoutSettledRows(meta2, hideable, null), NONE).map(
        (row) => row.key,
      );
    };

    const idle = cellLike("idle");
    for (const live of [cellLike("working"), { ...idle, hasActionableProposedPlan: true }]) {
      harness.registry.set(harness.threadsAtom, [...threads, cellUnderSlice(live)]);
      expect(visibleKeys()).toContain(keyOf(slice.id));
      // The settled pod has nothing live of its own, so it still hides.
      expect(visibleKeys()).not.toContain(keyOf(pod.id));
    }
    harness.registry.set(harness.threadsAtom, [...threads, cellUnderSlice(idle)]);
    expect(visibleKeys()).not.toContain(keyOf(slice.id));
  });

  it("hides the seed's settled slice and pod from meta 2 and keeps its other rows", () => {
    const harness = makeHarness(orchestrationSeedTree.threads);
    const meta2 = harness.sections(keyOf(seedMetaId(2)));
    const settledKeys = new Set(
      orchestrationSeedTree.threads
        .filter((thread) => thread.settledOverride === "settled")
        .map((thread) => keyOf(thread.id)),
    );
    const shown = buildOrchestrationRows(meta2, NONE);
    const visible = buildOrchestrationRows(hide(meta2, settledKeys), NONE);
    const hidden = shown.filter((r) => !visible.some((v) => v.key === r.key)).map((r) => r.key);
    // The settled slice, its settled pod, and the branch they leave empty.
    expect(countThreadRows(meta2) - countThreadRows(hide(meta2, settledKeys))).toBe(2);
    expect(hidden.filter((key) => settledKeys.has(key))).toHaveLength(2);
    expect(hidden.filter((key) => !settledKeys.has(key)).map((key) => JSON.parse(key)[0])).toEqual([
      "branch",
    ]);
    expect(visible.some((r) => r.type === "thread" && settledKeys.has(r.key))).toBe(false);
    expect(visible.filter((r) => r.type === "project")).toHaveLength(2);
  });
});

describe("treeKeyAction", () => {
  const harness = makeHarness(orchestrationSeedTree.threads);
  const meta1 = harness.sections(keyOf(seedMetaId(1)));
  const rows = buildOrchestrationRows(meta1, NONE);
  const [, project, branch, slice, pod1, pod2] = rows.map((row) => row.key);
  const lastPod = keyOf(seedPodId(8));

  it("moves up and down over rows, skipping the banner, and jumps with Home and End", () => {
    expect(treeKeyAction(rows, slice!, "ArrowDown")).toEqual({ type: "focus", key: pod1 });
    expect(treeKeyAction(rows, project!, "ArrowUp")).toBeNull();
    expect(treeKeyAction(rows, pod1!, "ArrowUp")).toEqual({ type: "focus", key: slice });
    expect(treeKeyAction(rows, pod2!, "Home")).toEqual({ type: "focus", key: project });
    expect(treeKeyAction(rows, project!, "End")).toEqual({ type: "focus", key: lastPod });
    expect(treeKeyAction(rows, lastPod, "ArrowDown")).toBeNull();
    // Nothing active yet: the first key lands on the first or last row.
    expect(treeKeyAction(rows, null, "ArrowDown")).toEqual({ type: "focus", key: project });
    expect(treeKeyAction(rows, null, "End")).toEqual({ type: "focus", key: lastPod });
    for (const key of ["Tab", "Escape", "Enter", "a"]) {
      expect(treeKeyAction(rows, null, key)).toBeNull();
    }
  });

  it("expands or enters with Right and collapses or climbs with Left", () => {
    expect(treeKeyAction(rows, slice!, "ArrowRight")).toEqual({ type: "focus", key: pod1 });
    expect(treeKeyAction(rows, pod1!, "ArrowRight")).toBeNull();
    expect(treeKeyAction(rows, pod1!, "ArrowLeft")).toEqual({ type: "focus", key: slice });
    expect(treeKeyAction(rows, slice!, "ArrowLeft")).toEqual({ type: "collapse", key: slice });
    expect(treeKeyAction(rows, project!, "ArrowLeft")).toEqual({ type: "collapse", key: project });

    const collapsed = buildOrchestrationRows(meta1, new Set([slice!]));
    expect(treeKeyAction(collapsed, slice!, "ArrowRight")).toEqual({ type: "expand", key: slice });
    expect(treeKeyAction(collapsed, slice!, "ArrowLeft")).toEqual({ type: "focus", key: branch });
    expect(treeKeyAction(collapsed, slice!, "ArrowDown")).toEqual({
      type: "focus",
      key: collapsed[4]!.key,
    });
  });

  it("activates with Enter and Space and ignores other keys", () => {
    expect(treeKeyAction(rows, pod2!, "Enter")).toEqual({ type: "activate", key: pod2 });
    expect(treeKeyAction(rows, branch!, " ")).toEqual({ type: "activate", key: branch });
    expect(treeKeyAction(rows, pod2!, "a")).toBeNull();
  });
});
