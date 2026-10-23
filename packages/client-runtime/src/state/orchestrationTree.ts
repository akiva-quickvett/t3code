import type { EnvironmentId, OrchestrationV2ThreadShell } from "@t3tools/contracts";
import {
  classifyOrchestration,
  orchestrationParentThreadId,
  type OrchestrationClassification,
  type OrchestrationRollup,
  type OrchestrationRow,
  type OrchestrationThreadInput,
  type OrchestrationTree,
} from "@t3tools/shared/orchestrationTree";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { Atom } from "effect/reactivity";

import { scopedThreadKey } from "../environment/scoped.ts";
import { arrayElementsEqual } from "./entities.ts";
import { type EnvironmentThreadShell, presentThreadShell } from "./models.ts";
import type { EnvironmentShellStatus } from "./shell.ts";
import { effectiveSnoozed, threadWokeAt } from "./threadSettled.ts";

/** The tab key for threads outside every meta's tree. */
export const NO_META_TAB_KEY = "no-meta";

export interface OrchestrationThreadContext {
  readonly parentKey: string | null;
  /** What `threadWokeAt` returns for the thread. */
  readonly wokeAt: string | null;
  readonly now: string;
  readonly environmentConnected: boolean;
  readonly shellStatus: EnvironmentShellStatus;
}

/** Each status field follows the source the classifier's `OrchestrationDotInput` names. */
export function orchestrationThreadInput(
  shell: EnvironmentThreadShell,
  context: OrchestrationThreadContext,
): OrchestrationThreadInput {
  const source = shell.source;
  const runtimeStatus =
    source.latestRunId === null && source.activeProviderThreadId === null
      ? null
      : (source.activityRunStatus ?? source.status);
  return {
    key: scopedThreadKey({ environmentId: shell.environmentId, threadId: shell.id }),
    parentKey: context.parentKey,
    projectId: shell.projectId,
    branch: shell.branch,
    rolePresetId: shell.rolePreset?.id ?? null,
    metaAt: shell.metaAt ?? null,
    archived: shell.archivedAt !== null,
    createdAt: shell.createdAt,
    status: {
      hasPendingApprovals: shell.hasPendingApprovals,
      hasPendingUserInput: shell.hasPendingUserInput,
      hasActionableProposedPlan: shell.hasActionableProposedPlan,
      runtimeStatus,
      latestRun:
        shell.latestRun === null
          ? null
          : { status: shell.latestRun.status, completedAt: shell.latestRun.completedAt },
      lastErrorClass: source.lastErrorClass ?? null,
      wokeAt: context.wokeAt,
      backgroundWorkHoldsCompletion: backgroundWorkHoldsCompletion(shell.pendingBackgroundTasks),
      lastVisitedAt: shell.lastVisitedAt ?? null,
      settled: shell.settledOverride === "settled",
      snoozed: effectiveSnoozed(shell, { now: context.now }),
      limitParked: shell.limitRecovery?.snooze === true && shell.snoozedUntil !== null,
      environmentConnected: context.environmentConnected,
      shellStatus: context.shellStatus,
    },
  };
}

export interface OrchestrationStructureRow {
  readonly key: string;
  readonly kind: OrchestrationRow["kind"];
  readonly repoTag?: string;
  readonly pods: ReadonlyArray<OrchestrationStructureRow>;
}

export interface OrchestrationStructureTree {
  readonly projects: ReadonlyArray<{
    readonly projectId: string;
    readonly branches: ReadonlyArray<{
      readonly branch: string | null;
      readonly rows: ReadonlyArray<OrchestrationStructureRow>;
    }>;
  }>;
}

/** The classification without roll-ups, so a dot change keeps the shape's reference. */
export interface OrchestrationStructure {
  readonly metas: ReadonlyArray<string>;
  readonly trees: Readonly<Record<string, OrchestrationStructureTree>>;
  readonly noMeta: OrchestrationStructureTree;
  readonly treeKeyByThreadKey: Readonly<Record<string, string | null>>;
}

export interface OrchestrationRootRollup extends OrchestrationRollup {
  /** Set for tabs (a meta key or `NO_META_TAB_KEY`), absent for rows. */
  readonly unread?: number;
}

export interface OrchestrationOrderEntry {
  readonly threadKey: string;
  /** The meta key whose tab holds the thread, or `NO_META_TAB_KEY`. */
  readonly tabKey: string;
  readonly needsYou: boolean;
}

const structureRow = (row: OrchestrationRow): OrchestrationStructureRow => ({
  key: row.key,
  kind: row.kind,
  ...(row.repoTag === undefined ? {} : { repoTag: row.repoTag }),
  pods: row.pods.map(structureRow),
});

const structureTree = (tree: OrchestrationTree): OrchestrationStructureTree => ({
  projects: tree.projects.map((project) => ({
    projectId: project.projectId,
    branches: project.branches.map((branch) => ({
      branch: branch.branch,
      rows: branch.rows.map(structureRow),
    })),
  })),
});

export function orchestrationStructure(
  classification: OrchestrationClassification,
): OrchestrationStructure {
  return {
    metas: classification.metas,
    trees: Object.fromEntries(
      Object.entries(classification.trees).map(([key, tree]) => [key, structureTree(tree)]),
    ),
    noMeta: structureTree(classification.noMeta),
    treeKeyByThreadKey: classification.treeKeyByThreadKey,
  };
}

const rowsOf = (tree: OrchestrationTree) =>
  tree.projects.flatMap((project) => project.branches.flatMap((branch) => branch.rows));

const ownNeedsYou = (rollup: OrchestrationRollup, children: ReadonlyArray<OrchestrationRow>) =>
  rollup.needsYouCount > children.reduce((sum, child) => sum + child.rollup.needsYouCount, 0);

const compareThreads = (left: OrchestrationThreadInput, right: OrchestrationThreadInput) =>
  Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
  (left.key < right.key ? -1 : left.key > right.key ? 1 : 0);

/**
 * Tabs in order (each meta, then No meta), each depth first, every placed
 * thread once. Only rows and metas are targets: a cell's request shows on the
 * row or meta it rolls up into, so that entry needs you when the count it adds
 * is its own, and the cell is listed only so that "next" continues from it.
 */
export function orchestrationOrder(
  classification: OrchestrationClassification,
  threads: ReadonlyArray<OrchestrationThreadInput>,
): ReadonlyArray<OrchestrationOrderEntry> {
  const targetKeys = new Set<string>(classification.metas);
  const collectRows = (rows: ReadonlyArray<OrchestrationRow>) => {
    for (const row of rows) {
      targetKeys.add(row.key);
      collectRows(row.pods);
    }
  };
  for (const tree of [...Object.values(classification.trees), classification.noMeta]) {
    collectRows(rowsOf(tree));
  }
  const cellsByParentKey = new Map<string, OrchestrationThreadInput[]>();
  for (const thread of [...threads].sort(compareThreads)) {
    if (thread.parentKey === null || targetKeys.has(thread.key)) continue;
    if (!(thread.key in classification.treeKeyByThreadKey)) continue;
    const siblings = cellsByParentKey.get(thread.parentKey);
    if (siblings === undefined) cellsByParentKey.set(thread.parentKey, [thread]);
    else siblings.push(thread);
  }

  const entries: OrchestrationOrderEntry[] = [];
  const listed = new Set<string>();
  const pushCells = (parentKey: string, tabKey: string) => {
    for (const cell of cellsByParentKey.get(parentKey) ?? []) {
      if (listed.has(cell.key)) continue;
      listed.add(cell.key);
      entries.push({ threadKey: cell.key, tabKey, needsYou: false });
      pushCells(cell.key, tabKey);
    }
  };
  const pushRow = (row: OrchestrationRow, tabKey: string) => {
    entries.push({ threadKey: row.key, tabKey, needsYou: ownNeedsYou(row.rollup, row.pods) });
    pushCells(row.key, tabKey);
    for (const pod of row.pods) pushRow(pod, tabKey);
  };
  for (const metaKey of classification.metas) {
    const tree = classification.trees[metaKey]!;
    const rows = rowsOf(tree);
    entries.push({ threadKey: metaKey, tabKey: metaKey, needsYou: ownNeedsYou(tree.rollup, rows) });
    pushCells(metaKey, metaKey);
    for (const row of rows) pushRow(row, metaKey);
  }
  for (const row of rowsOf(classification.noMeta)) pushRow(row, NO_META_TAB_KEY);
  return entries;
}

/** One order across environments: every meta tab first, then every No meta tab. */
export function mergeOrchestrationOrders(
  perEnvironment: ReadonlyArray<ReadonlyArray<OrchestrationOrderEntry>>,
): ReadonlyArray<OrchestrationOrderEntry> {
  const metaTabs: OrchestrationOrderEntry[] = [];
  const noMetaTabs: OrchestrationOrderEntry[] = [];
  for (const entries of perEnvironment) {
    for (const entry of entries) {
      (entry.tabKey === NO_META_TAB_KEY ? noMetaTabs : metaTabs).push(entry);
    }
  }
  return [...metaTabs, ...noMetaTabs];
}

/**
 * The first key after `currentKey` that needs you, wrapping; from the start when
 * `currentKey` is not listed. Returns `currentKey` when it alone needs you.
 */
export function nextNeedsYouThreadKey(
  orderedKeys: ReadonlyArray<string>,
  needsYou: ReadonlySet<string>,
  currentKey: string | null,
): string | null {
  const start = currentKey === null ? -1 : orderedKeys.indexOf(currentKey);
  for (let offset = 1; offset <= orderedKeys.length; offset += 1) {
    const key = orderedKeys[(start + offset) % orderedKeys.length]!;
    if (needsYou.has(key)) return key;
  }
  return null;
}

export function nextNeedsYouTarget(
  entries: ReadonlyArray<OrchestrationOrderEntry>,
  currentKey: string | null,
): OrchestrationOrderEntry | null {
  const threadKey = nextNeedsYouThreadKey(
    entries.map((entry) => entry.threadKey),
    new Set(entries.flatMap((entry) => (entry.needsYou ? [entry.threadKey] : []))),
    currentKey,
  );
  return threadKey === null ? null : entries.find((entry) => entry.threadKey === threadKey)!;
}

function rootRollups(
  classification: OrchestrationClassification,
): ReadonlyMap<string, OrchestrationRootRollup> {
  const rollups = new Map<string, OrchestrationRootRollup>();
  const addTree = (tabKey: string, tree: OrchestrationTree) => {
    rollups.set(tabKey, { ...tree.rollup, unread: tree.unread });
    const addRows = (rows: ReadonlyArray<OrchestrationRow>) => {
      for (const row of rows) {
        rollups.set(row.key, row.rollup);
        addRows(row.pods);
      }
    };
    addRows(rowsOf(tree));
  };
  for (const metaKey of classification.metas) addTree(metaKey, classification.trees[metaKey]!);
  addTree(NO_META_TAB_KEY, classification.noMeta);
  return rollups;
}

/** Plain-data deep equality; the classifier's inputs and outputs are JSON-shaped. */
function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left)) {
    return (
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameValue(value, right[index]))
    );
  }
  if (Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(right, key) &&
        sameValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
    )
  );
}

function reusingEqual<A>(compute: (get: Atom.AtomContext) => A) {
  let previous: { readonly value: A } | null = null;
  return (get: Atom.AtomContext): A => {
    const next = compute(get);
    if (previous !== null && sameValue(previous.value, next)) return previous.value;
    previous = { value: next };
    return next;
  };
}

/**
 * The view's shape and roll-ups without subscribing it to every shell: each
 * atom keeps its previous value while the content is equal, so streaming ticks
 * (which change no classifier input) re-render nothing. `now` is read when the
 * shells change, never on a timer: a snooze ending with no shell change shows
 * on the next one.
 */
export function createOrchestrationTreeAtoms(input: {
  readonly environmentThreadsAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<ReadonlyArray<OrchestrationV2ThreadShell>>;
  readonly environmentShellStatusAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<EnvironmentShellStatus>;
  readonly environmentConnectedAtom: (environmentId: EnvironmentId) => Atom.Atom<boolean>;
  readonly now: () => string;
}) {
  // An unchanged source only re-reads the fields that depend on the clock and
  // the connection. A replaced one (every streaming tick) is presented again
  // and, when its input is unchanged, keeps the previous input object, so the
  // list compares by identity.
  const cachedBySource = new WeakMap<
    OrchestrationV2ThreadShell,
    { readonly shell: EnvironmentThreadShell; readonly input: OrchestrationThreadInput }
  >();

  const inputsAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous: ReadonlyArray<OrchestrationThreadInput> = [];
    let previousByKey: ReadonlyMap<string, OrchestrationThreadInput> = new Map();
    return Atom.make((get): ReadonlyArray<OrchestrationThreadInput> => {
      const threads = get(input.environmentThreadsAtom(environmentId));
      const shellStatus = get(input.environmentShellStatusAtom(environmentId));
      const environmentConnected = get(input.environmentConnectedAtom(environmentId));
      const now = input.now();
      const byKey = new Map<string, OrchestrationThreadInput>();
      const next = threads.map((source) => {
        const cached = cachedBySource.get(source);
        const shell = cached?.shell ?? presentThreadShell(environmentId, source);
        const wokeAt = threadWokeAt(shell, { now });
        let value: OrchestrationThreadInput;
        if (
          cached !== undefined &&
          cached.input.status.wokeAt === wokeAt &&
          cached.input.status.snoozed === effectiveSnoozed(shell, { now }) &&
          cached.input.status.environmentConnected === environmentConnected &&
          cached.input.status.shellStatus === shellStatus
        ) {
          value = cached.input;
        } else {
          const parentThreadId = orchestrationParentThreadId(source.lineage);
          const built = orchestrationThreadInput(shell, {
            parentKey:
              parentThreadId === null
                ? null
                : scopedThreadKey({ environmentId, threadId: parentThreadId }),
            wokeAt,
            now,
            environmentConnected,
            shellStatus,
          });
          const prior = previousByKey.get(built.key);
          value = prior !== undefined && sameValue(prior, built) ? prior : built;
        }
        cachedBySource.set(source, { shell, input: value });
        byKey.set(value.key, value);
        return value;
      });
      previousByKey = byKey;
      if (arrayElementsEqual(previous, next)) return previous;
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`orchestration-inputs:${environmentId}`));
  });

  const classificationAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => classifyOrchestration(get(inputsAtom(environmentId)))).pipe(
      Atom.withLabel(`orchestration-classification:${environmentId}`),
    ),
  );

  const structureAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      reusingEqual((get) => orchestrationStructure(get(classificationAtom(environmentId)))),
    ).pipe(Atom.withLabel(`orchestration-structure:${environmentId}`)),
  );

  const metaKeysAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous: ReadonlyArray<string> = [];
    return Atom.make((get) => {
      const next = get(structureAtom(environmentId)).metas;
      if (arrayElementsEqual(previous, next)) return previous;
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`orchestration-meta-keys:${environmentId}`));
  });

  const rollupsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => rootRollups(get(classificationAtom(environmentId)))).pipe(
      Atom.withLabel(`orchestration-rollups:${environmentId}`),
    ),
  );

  const rollupAtomFamily = Atom.family((key: string) => {
    const separator = key.indexOf("\u0000");
    const environmentId = key.slice(0, separator) as EnvironmentId;
    const rootKey = key.slice(separator + 1);
    return Atom.make(
      reusingEqual((get) => get(rollupsAtom(environmentId)).get(rootKey) ?? null),
    ).pipe(Atom.withLabel(`orchestration-rollup:${key}`));
  });

  const orderAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      reusingEqual((get) =>
        orchestrationOrder(get(classificationAtom(environmentId)), get(inputsAtom(environmentId))),
      ),
    ).pipe(Atom.withLabel(`orchestration-order:${environmentId}`)),
  );

  return {
    classificationAtom,
    structureAtom,
    metaKeysAtom,
    orderAtom,
    /** `rootKey` is a meta key, `NO_META_TAB_KEY`, or a row's thread key. */
    rollupAtom: (environmentId: EnvironmentId, rootKey: string) =>
      rollupAtomFamily(`${environmentId}\u0000${rootKey}`),
  };
}
