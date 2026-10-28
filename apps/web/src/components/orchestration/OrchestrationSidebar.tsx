import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeProjectRef,
} from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ProjectId, type ScopedThreadRef } from "@t3tools/contracts";
import type { OrchestrationRollup } from "@t3tools/shared/orchestrationTree";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import { ChevronRightIcon, FolderIcon, GitBranchIcon } from "lucide-react";
import {
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  memo,
  useContext,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useThreadRouteRef } from "../../hooks/useThreadRouteTarget";
import { cn } from "../../lib/utils";
import { useProject } from "../../state/entities";
import { orchestrationTree } from "../../state/orchestrationTree";
import { environmentThreadShells } from "../../state/threads";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useUiStateStore } from "../../uiStateStore";
import { Button } from "../ui/button";
import { MetaTabs } from "./MetaTabs";
import {
  createMetaTabAtoms,
  joinEnvironmentIds,
  resolveSelectedTabKey,
  splitEnvironmentIds,
} from "./MetaTabs.logic";
import { OrchestrationDot } from "./OrchestrationDot";
import {
  buildOrchestrationRows,
  countThreadRows,
  expandKeys,
  foldRollups,
  hideableSettledKeys,
  orchestrationSections,
  type OrchestrationSection,
  type OrchestrationViewRow,
  revealPath,
  sameSections,
  setCollapsed,
  splitRowKeys,
  treeKeyAction,
  withoutSettledRows,
} from "./OrchestrationSidebar.logic";
import { StaleBanner, useEnvironmentStale } from "./StaleBanner";
import { StatsStrip, type StatsStripMeta } from "./StatsStrip";
import { TreeRow, type TreeRowProps } from "./TreeRow";

export interface OrchestrationSidebarProps {
  /**
   * Environments with metas, in the order that feeds `mergeOrchestrationOrders`,
   * so tabs and next-needs-you agree.
   */
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  /** A meta tab's Clear; the view has no compaction path of its own. */
  readonly onClearMeta: (metaThreadRef: ScopedThreadRef) => void;
  /** Rows have no inline editor, so the host decides how a rename is asked for. */
  readonly onRenameThread: (threadRef: ScopedThreadRef) => void;
  /** A thread row was opened, even the one already routed, e.g. to close a mobile sheet. */
  readonly onRowActivate?: (() => void) | undefined;
}

const metaTabAtoms = createMetaTabAtoms(orchestrationTree);

// Session-only (L15): it outlives a switch to the chat view but never reaches storage.
const collapsedKeysAtom = Atom.make<ReadonlySet<string>>(new Set<string>()).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-orchestration-collapsed-keys"),
);

// Keyed by `JSON.stringify([tabKey, environmentIdsKey])`. Structure atoms keep
// their reference while the shape is unchanged, so streaming ticks stop here.
const sectionsAtom = Atom.family((key: string) => {
  const [tabKey, environmentIdsKey] = JSON.parse(key) as [string | null, string];
  const environmentIds = splitEnvironmentIds(environmentIdsKey);
  let previous: ReadonlyArray<OrchestrationSection> = [];
  return Atom.make((get) => {
    const next = orchestrationSections({
      tabKey,
      environmentIds,
      structureOf: (environmentId) => get(orchestrationTree.structureAtom(environmentId)),
    });
    if (sameSections(previous, next)) return previous;
    previous = next;
    return next;
  }).pipe(Atom.withLabel(`web-orchestration-sections:${key}`));
});

const SHOW_SETTLED_KEY = "t3code:orchestration:show-settled";

// Keyed by `joinEnvironmentIds`: the settled rows that may hide. Keeps its
// reference while the set is unchanged, so streaming ticks stop here.
const hideableSettledKeysAtom = Atom.family((environmentIdsKey: string) => {
  const environmentIds = splitEnvironmentIds(environmentIdsKey);
  let previous: ReadonlySet<string> = new Set<string>();
  return Atom.make((get) => {
    const next = new Set<string>();
    for (const environmentId of environmentIds) {
      const settledKeys = new Set<string>();
      for (const thread of get(environmentThreadShells.environmentThreadsAtom(environmentId))) {
        if (thread.settledOverride === "settled") {
          settledKeys.add(scopedThreadKey({ environmentId, threadId: thread.id }));
        }
      }
      const classification = get(orchestrationTree.classificationAtom(environmentId));
      for (const key of hideableSettledKeys(classification, settledKeys)) next.add(key);
    }
    if (next.size === previous.size && [...next].every((key) => previous.has(key))) {
      return previous;
    }
    previous = next;
    return next;
  }).pipe(Atom.withLabel(`web-orchestration-hideable-settled-keys:${environmentIdsKey}`));
});

// Keyed by `JSON.stringify([environmentId, rollupRowKeys])`; read only while collapsed.
const groupRollupAtom = Atom.family((key: string) => {
  const [environmentId, rowKeys] = JSON.parse(key) as [EnvironmentId, string];
  const keys = splitRowKeys(rowKeys);
  let previous: OrchestrationRollup | null = null;
  return Atom.make((get) => {
    const next = foldRollups(
      keys.map((rowKey) => get(orchestrationTree.rollupAtom(environmentId, rowKey))),
    );
    if (
      previous !== null &&
      next !== null &&
      previous.dot === next.dot &&
      previous.needsYouCount === next.needsYouCount
    ) {
      return previous;
    }
    previous = next;
    return next;
  }).pipe(Atom.withLabel(`web-orchestration-group-rollup:${key}`));
});

const NO_ROLLUP_ATOM = Atom.make<OrchestrationRollup | null>(null).pipe(
  Atom.withLabel("web-orchestration-group-rollup:none"),
);

const statsMetasAtom = Atom.family((environmentId: EnvironmentId) => {
  let previous: ReadonlyArray<StatsStripMeta> = [];
  return Atom.make((get) => {
    const next = get(orchestrationTree.metaKeysAtom(environmentId)).flatMap((key) => {
      const threadRef = parseScopedThreadKey(key);
      if (threadRef === null) return [];
      const title = get(environmentThreadShells.quietThreadShellAtom(threadRef))?.title ?? "Meta";
      return [{ threadId: threadRef.threadId, title }];
    });
    if (
      previous.length === next.length &&
      previous.every(
        (meta, index) =>
          meta.threadId === next[index]!.threadId && meta.title === next[index]!.title,
      )
    ) {
      return previous;
    }
    previous = next;
    return next;
  }).pipe(Atom.withLabel(`web-orchestration-stats-metas:${environmentId}`));
});

const THREAD_LABELS = { slice: "Slice", pod: "Pod", "ad-hoc": "Chat" } as const;

/**
 * Tabs, the selected tab's tree, then one stats strip per environment. The
 * container subscribes to the tab's shape and the expand state only; every row
 * reads its own shell, so a streaming tick on one thread commits only its row.
 */
export function OrchestrationSidebar(props: OrchestrationSidebarProps) {
  const environmentIdsKey = joinEnvironmentIds(props.environmentIds);
  const tabKeys = useAtomValue(metaTabAtoms.tabKeysAtom(environmentIdsKey));
  const storedTabKey = useUiStateStore((state) => state.selectedMetaThreadKey);
  const tabKey = resolveSelectedTabKey(tabKeys, storedTabKey);
  const tabSections = useAtomValue(sectionsAtom(JSON.stringify([tabKey, environmentIdsKey])));
  const hideableKeys = useAtomValue(hideableSettledKeysAtom(environmentIdsKey));
  const [showSettled, setShowSettled] = useLocalStorage(SHOW_SETTLED_KEY, false, Schema.Boolean);
  const registry = useContext(RegistryContext);
  const collapsedKeys = useAtomValue(collapsedKeysAtom);
  const routeRef = useThreadRouteRef();
  const routeKey = routeRef === null ? null : scopedThreadKey(routeRef);
  // The routed row stays, so settling the thread you are on leaves it in place.
  const unsettledSections = withoutSettledRows(tabSections, hideableKeys, routeKey);
  // Counted against the hiding result whichever mode shows, so the toggle's
  // count holds steady when pressed.
  const hiddenCount = countThreadRows(tabSections) - countThreadRows(unsettledSections);
  const rows = buildOrchestrationRows(showSettled ? tabSections : unsettledSections, collapsedKeys);
  const navigate = useNavigate();
  const treeRef = useRef<HTMLDivElement>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [rowFocused, setRowFocused] = useState(false);
  const pendingScrollKey = useRef<string | null>(null);

  const updateCollapsed = (update: (keys: ReadonlySet<string>) => ReadonlySet<string>) =>
    registry.set(collapsedKeysAtom, update(registry.get(collapsedKeysAtom)));

  // Stable identities, so a container render with unchanged rows commits none of them.
  const toggle = useStableCallback((rowKey: string) =>
    updateCollapsed((keys) => setCollapsed(keys, rowKey, !keys.has(rowKey))),
  );
  const openThread = useStableCallback((rowKey: string) => {
    const threadRef = parseScopedThreadKey(rowKey);
    if (threadRef === null) return;
    setActiveKey(rowKey);
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
    props.onRowActivate?.();
  });
  const rename = useStableCallback((rowKey: string) => {
    const threadRef = parseScopedThreadKey(rowKey);
    if (threadRef !== null) props.onRenameThread(threadRef);
  });

  // Next-needs-you picks the tab and the route; the tree then shows the row,
  // once per route and tab, as soon as the tab's shape holds it (a cold start
  // routes before the shells arrive).
  const revealedFor = useRef<string | null>(null);
  const expandPath = useEffectEvent((threadKey: string, path: ReadonlyArray<string>) => {
    const keys = registry.get(collapsedKeysAtom);
    const next = expandKeys(keys, path);
    // Nothing to expand means no render follows, so a pending key would linger
    // and scroll on some later, unrelated render.
    if (next === keys) {
      rowElement(treeRef.current, threadKey)?.scrollIntoView({ block: "nearest" });
      return;
    }
    pendingScrollKey.current = threadKey;
    registry.set(collapsedKeysAtom, next);
  });
  useEffect(() => {
    if (routeKey === null || tabKey === null) return;
    const target = JSON.stringify([tabKey, routeKey]);
    if (revealedFor.current === target) return;
    // Hiding settled rows keeps the routed row and its ancestors, so the whole
    // tab gives the same path.
    const path = revealPath(tabSections, routeKey);
    if (path === null) return;
    revealedFor.current = target;
    expandPath(routeKey, path);
  }, [routeKey, tabKey, tabSections]);

  const visibleKey = (key: string | null) =>
    key !== null && rows.some((row) => row.key === key && row.type !== "banner") ? key : null;
  // A row left active after focus moved away must not outrank a newer route
  // (next-needs-you), so the active row counts only while the tree holds focus.
  const currentKey = (rowFocused ? visibleKey(activeKey) : null) ?? visibleKey(routeKey);
  const firstKey = rows.find((row) => row.type !== "banner")?.key ?? null;

  const focusRow = (key: string, scroll: boolean) => {
    setActiveKey(key);
    const element = rowElement(treeRef.current, key);
    if (element === null) return;
    // Rows are pointer-only components; the tree makes the active one focusable.
    element.tabIndex = -1;
    element.focus({ preventScroll: true });
    if (scroll) element.scrollIntoView({ block: "nearest" });
  };

  // The row that held focus, kept through a blur to nowhere: removing a focused
  // element drops focus to the body, and the tree must take it back.
  const focusedRowKey = useRef<string | null>(null);
  useLayoutEffect(() => {
    const tree = treeRef.current;
    const pendingKey = pendingScrollKey.current;
    const pending = pendingKey === null ? null : rowElement(tree, pendingKey);
    if (pending !== null) {
      pendingScrollKey.current = null;
      pending.scrollIntoView({ block: "nearest" });
    }
    const lostKey = focusedRowKey.current;
    if (lostKey === null || rowElement(tree, lostKey) !== null) return;
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    // Prefer the nearest ancestor still shown, as when its slice was collapsed.
    const fallback =
      revealPath(tabSections, lostKey)?.find((key) => visibleKey(key) !== null) ??
      currentKey ??
      firstKey;
    if (fallback !== null) {
      focusRow(fallback, false);
      return;
    }
    focusedRowKey.current = null;
    setRowFocused(false);
  });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Keys typed into a row's menu or button are theirs.
    if (!(event.target instanceof HTMLElement)) return;
    // The tree itself holds focus after a press on its padding or scrollbar.
    const focusedKey = event.target === event.currentTarget ? null : event.target.dataset.rowKey;
    if (focusedKey === undefined) return;
    const moved = treeKeyAction(rows, focusedKey, event.key);
    // From the tree itself, a movement key lands on the routed row first.
    const action =
      focusedKey === null && moved !== null && currentKey !== null
        ? ({ type: "focus", key: currentKey } as const)
        : moved;
    if (action === null) return;
    event.preventDefault();
    switch (action.type) {
      case "focus":
        focusRow(action.key, true);
        return;
      case "expand":
      case "collapse":
        updateCollapsed((keys) => setCollapsed(keys, action.key, action.type === "collapse"));
        return;
      case "activate": {
        const row = rows.find((candidate) => candidate.key === action.key);
        if (row?.type === "thread") openThread(action.key);
        else toggle(action.key);
        return;
      }
    }
  };

  // A pressed row takes focus itself, in place: letting the press focus the tree
  // would hand focus to the previous row and scroll the list under the pointer.
  const pointerDown = useRef(false);
  const onMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Element) || event.target.closest("button") !== null) return;
    const row = event.target.closest<HTMLElement>("[data-row-key]");
    if (row === null) {
      // Consumed by the focus this press is about to give the tree.
      pointerDown.current = document.activeElement !== event.currentTarget;
      return;
    }
    event.preventDefault();
    focusRow(row.dataset.rowKey!, false);
  };
  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) {
      focusedRowKey.current =
        event.target instanceof HTMLElement ? (event.target.dataset.rowKey ?? null) : null;
      setRowFocused(true);
      return;
    }
    // A focused tree holds no row, so a later blur must not leave one to reclaim.
    focusedRowKey.current = null;
    // A press on the tree's padding or scrollbar keeps focus on the tree.
    if (pointerDown.current) {
      pointerDown.current = false;
      return;
    }
    // Tabbing in lands on the tree; hand focus to the active row.
    const key = currentKey ?? firstKey;
    if (key !== null) focusRow(key, true);
  };
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    setRowFocused(false);
    if (event.relatedTarget !== null) {
      focusedRowKey.current = null;
      return;
    }
    // Focus went nowhere: a removed row (reclaimed by the layout effect, which
    // runs first) or a click on plain page text, which must not be pulled back.
    const target = event.target;
    queueMicrotask(() => {
      if (target.isConnected && focusedRowKey.current === target.dataset.rowKey) {
        focusedRowKey.current = null;
      }
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <MetaTabs environmentIds={props.environmentIds} onClear={props.onClearMeta} />
      {rows.length === 0 ? (
        <div className="min-h-0 flex-1 px-2.5 py-1 text-muted-foreground text-xs">
          {hiddenCount > 0 ? "Everything here is settled." : "No slices or pods here yet."}
        </div>
      ) : (
        <div
          ref={treeRef}
          role="tree"
          aria-label="Orchestration"
          // While a row holds focus the tree leaves the tab order, so Shift+Tab can leave it.
          tabIndex={rowFocused ? -1 : 0}
          onKeyDown={onKeyDown}
          onMouseDown={onMouseDown}
          onFocus={onFocus}
          onBlur={onBlur}
          className="min-h-0 flex-1 overflow-y-auto py-1 outline-none [&_[role=treeitem]:focus-visible]:outline-1 [&_[role=treeitem]:focus-visible]:-outline-offset-1 [&_[role=treeitem]:focus-visible]:outline-ring"
        >
          {rows.map((row) => (
            <OrchestrationRow
              key={row.key}
              row={row}
              selected={row.key === routeKey}
              onSelect={openThread}
              onToggle={toggle}
              onRename={rename}
            />
          ))}
        </div>
      )}
      {(hiddenCount > 0 || showSettled) && (
        <div className="flex shrink-0 px-1.5 py-1">
          <Button
            variant="ghost-muted"
            size="micro"
            aria-pressed={showSettled}
            onClick={() => setShowSettled((value) => !value)}
          >
            Show settled ({hiddenCount})
          </Button>
        </div>
      )}
      {props.environmentIds.map((environmentId) => (
        <EnvironmentStatsStrip key={environmentId} environmentId={environmentId} />
      ))}
    </div>
  );
}

function rowElement(tree: HTMLElement | null, key: string): HTMLElement | null {
  return tree?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(key)}"]`) ?? null;
}

/** Spreads the row model into primitives, so each row's memo compares by value. */
function OrchestrationRow(props: {
  readonly row: OrchestrationViewRow;
  readonly selected: boolean;
  readonly onSelect: (rowKey: string) => void;
  readonly onToggle: (rowKey: string) => void;
  readonly onRename: (rowKey: string) => void;
}) {
  const { row } = props;
  switch (row.type) {
    case "banner":
      // A status is no tree item; `none` keeps it out of the tree's structure.
      return (
        <div role="none">
          <StaleBanner environmentId={row.environmentId} />
        </div>
      );
    case "project":
    case "branch":
      return (
        <GroupRow
          rowKey={row.key}
          environmentId={row.environmentId}
          projectId={row.type === "project" ? row.projectId : null}
          branch={row.type === "branch" ? row.branch : null}
          depth={row.depth}
          guideMask={row.guideMask}
          expanded={row.expanded === true}
          setSize={row.setSize}
          posInSet={row.posInSet}
          rollupRowKeys={row.rollupRowKeys}
          onToggle={props.onToggle}
        />
      );
    case "thread": {
      const rowProps = {
        rowKey: row.key,
        environmentId: row.environmentId,
        threadId: row.threadId,
        label: THREAD_LABELS[row.kind],
        kind: row.kind,
        depth: row.depth,
        guideMask: row.guideMask,
        expanded: row.expanded,
        rollupKey: row.expanded === null ? null : row.key,
        repoTag: null,
        noSlice: row.noSlice,
        selected: props.selected,
        onSelect: props.onSelect,
        onToggle: props.onToggle,
        onRename: props.onRename,
      } satisfies TreeRowProps;
      return row.repoTag === null ? (
        <TreeRow {...rowProps} />
      ) : (
        <RepoTaggedTreeRow {...rowProps} repoProjectId={row.repoTag} />
      );
    }
  }
}

/** The classifier tags a cross-repo pod with a project id; the row shows its title. */
const RepoTaggedTreeRow = memo(function RepoTaggedTreeRow({
  repoProjectId,
  ...props
}: TreeRowProps & { readonly repoProjectId: string }) {
  const project = useProject(scopeProjectRef(props.environmentId, ProjectId.make(repoProjectId)));
  return <TreeRow {...props} repoTag={project?.title ?? repoProjectId} />;
});

const GUIDE_STEP_PX = 12;

function guideStyle(depth: number, guideMask: number) {
  const offsets: string[] = [];
  for (let level = 0; level < depth; level += 1) {
    if (guideMask & (1 << level)) offsets.push(`${level * GUIDE_STEP_PX + 5}px 0`);
  }
  return {
    width: depth * GUIDE_STEP_PX,
    backgroundImage: offsets
      .map(() => "linear-gradient(var(--color-border),var(--color-border))")
      .join(","),
    backgroundSize: "1px 100%",
    backgroundRepeat: "no-repeat",
    backgroundPosition: offsets.join(","),
  };
}

/**
 * Projects and branches are not threads, so `TreeRow` has no roll-up for
 * them; this row folds its threads' roll-ups while collapsed.
 */
const GroupRow = memo(function GroupRow(props: {
  readonly rowKey: string;
  readonly environmentId: EnvironmentId;
  /** Set for project rows. */
  readonly projectId: string | null;
  /** Set for branch rows. */
  readonly branch: string | null;
  readonly depth: number;
  readonly guideMask: number;
  readonly expanded: boolean;
  readonly setSize: number;
  readonly posInSet: number;
  readonly rollupRowKeys: string;
  readonly onToggle: (rowKey: string) => void;
}) {
  const { rowKey, environmentId, projectId, depth, expanded } = props;
  const project = useProject(
    projectId === null ? null : scopeProjectRef(environmentId, ProjectId.make(projectId)),
  );
  const stale = useEnvironmentStale(environmentId);
  const rollup = useAtomValue(
    expanded
      ? NO_ROLLUP_ATOM
      : groupRollupAtom(JSON.stringify([environmentId, props.rollupRowKeys])),
  );
  const label = props.branch ?? project?.title ?? "Project";
  const Icon = props.branch === null ? FolderIcon : GitBranchIcon;
  const needsYouCount = rollup?.needsYouCount ?? 0;

  return (
    <div
      role="treeitem"
      aria-selected={false}
      aria-expanded={expanded}
      aria-level={depth + 1}
      aria-setsize={props.setSize}
      aria-posinset={props.posInSet}
      data-row-key={rowKey}
      data-stale={stale || undefined}
      onClick={() => props.onToggle(rowKey)}
      className={cn(
        "relative flex h-6 cursor-pointer select-none items-center whitespace-nowrap pr-1.5 text-xs hover:bg-accent",
        stale && "opacity-45",
      )}
    >
      <span className="flex w-5 shrink-0 items-center pl-2">
        {rollup !== null && <OrchestrationDot dot={rollup.dot} />}
      </span>
      {depth > 0 && <span className="h-6 shrink-0" style={guideStyle(depth, props.guideMask)} />}
      <span className="flex w-3 shrink-0 items-center justify-center text-muted-foreground">
        <ChevronRightIcon className={cn("size-2.5", expanded && "rotate-90")} aria-hidden />
      </span>
      <span className="mr-1 flex w-3.5 shrink-0 items-center justify-center text-muted-foreground">
        <Icon className="size-3" aria-hidden />
      </span>
      <span
        className={cn("min-w-0 flex-1 truncate", props.branch !== null && "text-muted-foreground")}
      >
        {label}
      </span>
      <span className="flex w-7 shrink-0 items-center justify-end">
        {needsYouCount > 0 && (
          <span
            aria-label={`${needsYouCount} need you`}
            className="h-3.5 min-w-3.5 rounded-full bg-warning px-1 text-center font-semibold text-3xs text-black/90 tabular-nums leading-3.5"
          >
            {needsYouCount}
          </span>
        )}
      </span>
    </div>
  );
});

function EnvironmentStatsStrip({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const metas = useAtomValue(statsMetasAtom(environmentId));
  return <StatsStrip environmentId={environmentId} metas={metas} />;
}
