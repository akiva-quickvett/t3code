import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  NO_META_TAB_KEY,
  type OrchestrationStructure,
  type OrchestrationStructureRow,
  type OrchestrationStructureTree,
} from "@t3tools/client-runtime/state/orchestration-tree";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  foldOrchestrationDots,
  type OrchestrationClassification,
  type OrchestrationRollup,
  type OrchestrationRow,
} from "@t3tools/shared/orchestrationTree";

/** One environment's part of the selected tab: a meta's tree, or that environment's No meta. */
export interface OrchestrationSection {
  readonly environmentId: EnvironmentId;
  readonly tabKey: string;
  readonly tree: OrchestrationStructureTree;
}

interface TreeRowBase {
  readonly key: string;
  readonly parentKey: string | null;
  readonly environmentId: EnvironmentId;
  readonly depth: number;
  readonly guideMask: number;
  /** Null for leaves. */
  readonly expanded: boolean | null;
}

export type OrchestrationViewRow =
  | { readonly type: "banner"; readonly key: string; readonly environmentId: EnvironmentId }
  | (TreeRowBase & {
      readonly type: "project";
      readonly projectId: string;
      readonly setSize: number;
      readonly posInSet: number;
      /** The group's top-level row keys, joined by `joinRowKeys`, for its roll-up. */
      readonly rollupRowKeys: string;
    })
  | (TreeRowBase & {
      readonly type: "branch";
      readonly branch: string;
      /** Siblings include the project's branchless threads. */
      readonly setSize: number;
      readonly posInSet: number;
      readonly rollupRowKeys: string;
    })
  | (TreeRowBase & {
      readonly type: "thread";
      readonly kind: OrchestrationStructureRow["kind"];
      readonly threadId: ThreadId;
      /** The pod's own project id when it differs from its slice's. */
      readonly repoTag: string | null;
      readonly noSlice: boolean;
    });

export type OrchestrationTreeItem = Exclude<OrchestrationViewRow, { type: "banner" }>;

// Group keys must never parse as a scoped thread key, which is `<environment>:<thread>`.
const groupKey = (parts: ReadonlyArray<string>) => JSON.stringify(parts);

const ROW_KEY_SEPARATOR = "\u0000";
export const joinRowKeys = (keys: ReadonlyArray<string>) => keys.join(ROW_KEY_SEPARATOR);
export const splitRowKeys = (joined: string) =>
  joined === "" ? [] : joined.split(ROW_KEY_SEPARATOR);

/** Every ancestor level draws its guide, as in the mockup. */
const fullGuideMask = (depth: number) => (1 << depth) - 1;

export function orchestrationSections(input: {
  readonly tabKey: string | null;
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly structureOf: (environmentId: EnvironmentId) => OrchestrationStructure;
}): ReadonlyArray<OrchestrationSection> {
  const { tabKey, environmentIds, structureOf } = input;
  if (tabKey === null) return [];
  if (tabKey === NO_META_TAB_KEY) {
    return environmentIds.map((environmentId) => ({
      environmentId,
      tabKey,
      tree: structureOf(environmentId).noMeta,
    }));
  }
  const metaRef = parseScopedThreadKey(tabKey);
  if (metaRef === null || !environmentIds.includes(metaRef.environmentId)) return [];
  const tree = structureOf(metaRef.environmentId).trees[tabKey];
  return tree === undefined ? [] : [{ environmentId: metaRef.environmentId, tabKey, tree }];
}

export function sameSections(
  left: ReadonlyArray<OrchestrationSection>,
  right: ReadonlyArray<OrchestrationSection>,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (section, index) =>
        section.environmentId === right[index]!.environmentId &&
        section.tabKey === right[index]!.tabKey &&
        section.tree === right[index]!.tree,
    )
  );
}

/**
 * The settled rows that may hide: those with nothing live in their roll-up.
 * Cells and other non-row children feed only their row's roll-up, so hiding a
 * row whose child needs you or works would leave the tab's badge with nothing
 * to click. Finished children are usually not settled, so being unsettled alone
 * does not keep a row. The roll-up folds to its highest dot, so a working child
 * beside a failed, limited or woke one is not seen as working.
 */
export function hideableSettledKeys(
  classification: OrchestrationClassification,
  settledKeys: ReadonlySet<string>,
): ReadonlyArray<string> {
  const keys: string[] = [];
  if (settledKeys.size === 0) return keys;
  const visit = (rows: ReadonlyArray<OrchestrationRow>) => {
    for (const row of rows) {
      const live = row.rollup.needsYouCount > 0 || row.rollup.dot === "working";
      if (!live && settledKeys.has(row.key)) keys.push(row.key);
      visit(row.pods);
    }
  };
  for (const tree of [...Object.values(classification.trees), classification.noMeta]) {
    for (const project of tree.projects) {
      for (const branch of project.branches) visit(branch.rows);
    }
  }
  return keys;
}

function withoutHiddenRows(
  rows: ReadonlyArray<OrchestrationStructureRow>,
  hidden: (key: string) => boolean,
): ReadonlyArray<OrchestrationStructureRow> {
  let changed = false;
  const kept: OrchestrationStructureRow[] = [];
  for (const row of rows) {
    const pods = withoutHiddenRows(row.pods, hidden);
    // A row still shown below keeps its ancestors, so nothing shown is orphaned.
    if (pods.length === 0 && hidden(row.key)) {
      changed = true;
      continue;
    }
    if (pods !== row.pods) changed = true;
    kept.push(pods === row.pods ? row : { ...row, pods });
  }
  return changed ? kept : rows;
}

function withoutHiddenTree(
  tree: OrchestrationStructureTree,
  hidden: (key: string) => boolean,
): OrchestrationStructureTree {
  let changed = false;
  const projects: Array<OrchestrationStructureTree["projects"][number]> = [];
  for (const project of tree.projects) {
    const branches: Array<(typeof project.branches)[number]> = [];
    let projectChanged = false;
    for (const branch of project.branches) {
      const rows = withoutHiddenRows(branch.rows, hidden);
      if (rows !== branch.rows) projectChanged = true;
      if (rows.length > 0) branches.push(rows === branch.rows ? branch : { ...branch, rows });
    }
    if (projectChanged || branches.length === 0) changed = true;
    if (branches.length > 0) projects.push(projectChanged ? { ...project, branches } : project);
  }
  return changed ? { projects } : tree;
}

/**
 * Leaves out the rows in `settledKeys` (from `hideableSettledKeys`), as the
 * chat view files settled threads under its collapsed Settled shelf. Such a row
 * stays while a row below it shows, and `keepKey` (the routed thread) always
 * stays. Returns `sections` itself when nothing is hidden.
 */
export function withoutSettledRows(
  sections: ReadonlyArray<OrchestrationSection>,
  settledKeys: ReadonlySet<string>,
  keepKey: string | null,
): ReadonlyArray<OrchestrationSection> {
  if (settledKeys.size === 0) return sections;
  const hidden = (key: string) => key !== keepKey && settledKeys.has(key);
  const next = sections.map((section) => {
    const tree = withoutHiddenTree(section.tree, hidden);
    return tree === section.tree ? section : { ...section, tree };
  });
  return next.every((section, index) => section === sections[index]) ? sections : next;
}

/** Thread rows in the tab, collapsed or not; the drop from hiding is the hidden count. */
export function countThreadRows(sections: ReadonlyArray<OrchestrationSection>): number {
  const countRows = (rows: ReadonlyArray<OrchestrationStructureRow>): number =>
    rows.reduce((sum, row) => sum + 1 + countRows(row.pods), 0);
  let count = 0;
  for (const { tree } of sections) {
    for (const project of tree.projects) {
      for (const branch of project.branches) count += countRows(branch.rows);
    }
  }
  return count;
}

/**
 * Walks the tree in display order, descending only where `isExpanded`, so the
 * row list stops at collapsed rows while reveal walks everything.
 */
function walkSections(
  sections: ReadonlyArray<OrchestrationSection>,
  isExpanded: (key: string) => boolean,
  visit: (row: OrchestrationViewRow) => void,
) {
  // In No meta, every environment's projects are siblings at the top level.
  const projectCount = sections.reduce((sum, section) => sum + section.tree.projects.length, 0);
  let projectIndex = 0;
  for (const { environmentId, tabKey, tree } of sections) {
    if (tree.projects.length === 0) continue;
    visit({ type: "banner", key: groupKey(["banner", environmentId, tabKey]), environmentId });
    const visitRows = (
      rows: ReadonlyArray<OrchestrationStructureRow>,
      depth: number,
      parentKey: string,
      topLevel: boolean,
    ) => {
      for (const row of rows) {
        const threadRef = parseScopedThreadKey(row.key);
        if (threadRef === null) continue;
        const expanded = row.pods.length === 0 ? null : isExpanded(row.key);
        visit({
          type: "thread",
          key: row.key,
          parentKey,
          environmentId,
          depth,
          guideMask: fullGuideMask(depth),
          expanded,
          kind: row.kind,
          threadId: threadRef.threadId,
          repoTag: row.repoTag ?? null,
          // A pod at the top of a group has no slice above it.
          noSlice: topLevel && row.kind === "pod",
        });
        if (expanded === true) visitRows(row.pods, depth + 1, row.key, false);
      }
    };
    for (const project of tree.projects) {
      const projectKey = groupKey(["project", environmentId, tabKey, project.projectId]);
      const expanded = isExpanded(projectKey);
      projectIndex += 1;
      visit({
        type: "project",
        key: projectKey,
        parentKey: null,
        environmentId,
        depth: 0,
        guideMask: 0,
        expanded,
        projectId: project.projectId,
        setSize: projectCount,
        posInSet: projectIndex,
        rollupRowKeys: joinRowKeys(
          project.branches.flatMap((branch) => branch.rows.map((row) => row.key)),
        ),
      });
      if (!expanded) continue;
      const childCount = project.branches.reduce(
        (sum, branch) => sum + (branch.branch === null ? branch.rows.length : 1),
        0,
      );
      let childIndex = 0;
      for (const branch of project.branches) {
        // Threads without a branch (ad-hoc chats on the default checkout) sit under the project.
        if (branch.branch === null) {
          childIndex += branch.rows.length;
          visitRows(branch.rows, 1, projectKey, true);
          continue;
        }
        childIndex += 1;
        const branchKey = groupKey([
          "branch",
          environmentId,
          tabKey,
          project.projectId,
          branch.branch,
        ]);
        const branchExpanded = isExpanded(branchKey);
        visit({
          type: "branch",
          key: branchKey,
          parentKey: projectKey,
          environmentId,
          depth: 1,
          guideMask: fullGuideMask(1),
          expanded: branchExpanded,
          branch: branch.branch,
          setSize: childCount,
          posInSet: childIndex,
          rollupRowKeys: joinRowKeys(branch.rows.map((row) => row.key)),
        });
        if (branchExpanded) visitRows(branch.rows, 2, branchKey, true);
      }
    }
  }
}

/** The flat list the view renders: rows under a collapsed key are left out. */
export function buildOrchestrationRows(
  sections: ReadonlyArray<OrchestrationSection>,
  collapsedKeys: ReadonlySet<string>,
): ReadonlyArray<OrchestrationViewRow> {
  const rows: OrchestrationViewRow[] = [];
  walkSections(
    sections,
    (key) => !collapsedKeys.has(key),
    (row) => rows.push(row),
  );
  return rows;
}

/** The keys to expand so `threadKey`'s row shows, or null when no row of the tab is it. */
export function revealPath(
  sections: ReadonlyArray<OrchestrationSection>,
  threadKey: string,
): ReadonlyArray<string> | null {
  const parentByKey = new Map<string, string | null>();
  walkSections(
    sections,
    () => true,
    (row) => {
      if (row.type !== "banner") parentByKey.set(row.key, row.parentKey);
    },
  );
  if (!parentByKey.has(threadKey)) return null;
  const path: string[] = [];
  for (let key = parentByKey.get(threadKey); key != null; key = parentByKey.get(key)) {
    path.push(key);
  }
  return path;
}

/** Returns `collapsedKeys` itself when nothing changes, so the setter is a no-op. */
export function expandKeys(
  collapsedKeys: ReadonlySet<string>,
  keys: ReadonlyArray<string>,
): ReadonlySet<string> {
  if (!keys.some((key) => collapsedKeys.has(key))) return collapsedKeys;
  const next = new Set(collapsedKeys);
  for (const key of keys) next.delete(key);
  return next;
}

export function setCollapsed(
  collapsedKeys: ReadonlySet<string>,
  key: string,
  collapsed: boolean,
): ReadonlySet<string> {
  if (collapsedKeys.has(key) === collapsed) return collapsedKeys;
  const next = new Set(collapsedKeys);
  if (collapsed) next.add(key);
  else next.delete(key);
  return next;
}

/** A group's roll-up: the highest dot of its rows and their needs-you total. */
export function foldRollups(
  rollups: ReadonlyArray<OrchestrationRollup | null>,
): OrchestrationRollup | null {
  const present = rollups.filter((rollup) => rollup !== null);
  if (present.length === 0) return null;
  return {
    dot: foldOrchestrationDots(present.map((rollup) => rollup.dot)).dot,
    needsYouCount: present.reduce((sum, rollup) => sum + rollup.needsYouCount, 0),
  };
}

export type TreeKeyAction =
  | { readonly type: "focus"; readonly key: string }
  | { readonly type: "expand"; readonly key: string }
  | { readonly type: "collapse"; readonly key: string }
  | { readonly type: "activate"; readonly key: string };

/** The WAI-ARIA tree pattern over the visible rows; banners are skipped. */
export function treeKeyAction(
  rows: ReadonlyArray<OrchestrationViewRow>,
  activeKey: string | null,
  key: string,
): TreeKeyAction | null {
  const items = rows.filter((row): row is OrchestrationTreeItem => row.type !== "banner");
  if (items.length === 0) return null;
  const index = activeKey === null ? -1 : items.findIndex((row) => row.key === activeKey);
  const focus = (target: OrchestrationTreeItem | undefined) =>
    target === undefined ? null : ({ type: "focus", key: target.key } as const);
  if (index === -1) {
    // Only movement keys may claim focus; Tab, Escape and typing stay with the browser.
    if (key === "ArrowDown" || key === "Home") return focus(items[0]);
    if (key === "ArrowUp" || key === "End") return focus(items.at(-1));
    return null;
  }
  const active = items[index]!;
  switch (key) {
    case "ArrowDown":
      return focus(items[index + 1]);
    case "ArrowUp":
      return focus(items[index - 1]);
    case "Home":
      return focus(items[0]);
    case "End":
      return focus(items.at(-1));
    case "ArrowRight":
      if (active.expanded === false) return { type: "expand", key: active.key };
      if (active.expanded === true && items[index + 1]?.parentKey === active.key) {
        return focus(items[index + 1]);
      }
      return null;
    case "ArrowLeft":
      if (active.expanded === true) return { type: "collapse", key: active.key };
      return active.parentKey === null ? null : { type: "focus", key: active.parentKey };
    case "Enter":
    case " ":
      return { type: "activate", key: active.key };
    default:
      return null;
  }
}
