import type {
  OrchestrationDot,
  OrchestrationV2AppThreadLineage,
  OrchestrationV2ProviderFailureClass,
  OrchestrationV2RunStatus,
  OrchestrationV2ShellThreadStatus,
  ThreadId,
} from "@t3tools/contracts";

export interface OrchestrationDotInput {
  /**
   * The thread's own requests only. A child's pending request (the chat view's
   * `pendingSubagentRequest`) reaches roll-ups through the child itself, so
   * counting it here would count it twice.
   */
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly hasActionableProposedPlan: boolean;
  /**
   * The shell's `activityRunStatus ?? status`; null when both `latestRunId` and
   * `activeProviderThreadId` are null. Unlike client-runtime's `shellRuntime`,
   * not rewritten to idle while background work holds the thread:
   * `backgroundWorkHoldsCompletion` covers that.
   */
  readonly runtimeStatus: OrchestrationV2ShellThreadStatus | null;
  /** The shell's `status` and `latestRunCompletedAt`. */
  readonly latestRun: {
    readonly status: OrchestrationV2RunStatus;
    readonly completedAt: string | null;
  } | null;
  readonly lastErrorClass: OrchestrationV2ProviderFailureClass | null;
  /** What client-runtime's `threadWokeAt` returns for the thread. */
  readonly wokeAt: string | null;
  readonly backgroundWorkHoldsCompletion: boolean;
  readonly lastVisitedAt: string | null;
  readonly settled: boolean;
  readonly snoozed: boolean;
  readonly limitParked: boolean;
  readonly environmentConnected: boolean;
  readonly shellStatus: "empty" | "cached" | "synchronizing" | "live";
}

export interface ResolvedOrchestrationDot {
  readonly dot: OrchestrationDot;
  readonly dim: boolean;
  readonly stale: boolean;
}

export interface OrchestrationThreadInput {
  /** Environment-scoped thread key; `parentKey` uses the same scheme. */
  readonly key: string;
  /** Key of `orchestrationParentThreadId`'s thread, null for a top-level thread. */
  readonly parentKey: string | null;
  readonly projectId: string;
  readonly branch: string | null;
  readonly rolePresetId: string | null;
  readonly metaAt: string | null;
  readonly archived: boolean;
  readonly createdAt: string;
  readonly status: OrchestrationDotInput;
}

export interface OrchestrationRollup {
  readonly dot: OrchestrationDot;
  readonly needsYouCount: number;
}

export interface OrchestrationRow {
  readonly key: string;
  readonly kind: "slice" | "pod" | "ad-hoc";
  /** A pod in another project than its slice: that project's id. */
  readonly repoTag?: string;
  readonly rollup: OrchestrationRollup;
  readonly pods: ReadonlyArray<OrchestrationRow>;
}

export interface OrchestrationTree {
  readonly projects: ReadonlyArray<{
    readonly projectId: string;
    readonly branches: ReadonlyArray<{
      readonly branch: string | null;
      readonly rows: ReadonlyArray<OrchestrationRow>;
    }>;
  }>;
  readonly rollup: OrchestrationRollup;
  readonly unread: number;
}

export interface OrchestrationClassification {
  /** Meta keys in tab order. */
  readonly metas: ReadonlyArray<string>;
  readonly trees: Readonly<Record<string, OrchestrationTree>>;
  readonly noMeta: OrchestrationTree;
  /** Every placed thread, rows or not, to the meta whose tree holds it; null for No meta. */
  readonly treeKeyByThreadKey: Readonly<Record<string, string | null>>;
}

/**
 * Supervisor first, as the server's tree-parent index does. The client's
 * `agentTreeParentThreadId` checks the subagent parent first; the two agree
 * only because a supervisor is set on top-level threads alone.
 */
export function orchestrationParentThreadId(
  lineage: Pick<
    OrchestrationV2AppThreadLineage,
    "relationshipToParent" | "parentThreadId" | "supervisorThreadId"
  >,
): ThreadId | null {
  return (
    lineage.supervisorThreadId ??
    (lineage.relationshipToParent === "subagent" ? lineage.parentThreadId : null)
  );
}

const DOT_RANK: Record<OrchestrationDot, number> = {
  "needs-you": 0,
  failed: 1,
  limited: 2,
  woke: 3,
  working: 4,
  waiting: 5,
  "done-unread": 6,
  idle: 7,
};

const WORKING_RUNTIME_STATUSES = new Set<OrchestrationV2ShellThreadStatus>([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

const isAfter = (later: string, earlier: string) => Date.parse(later) > Date.parse(earlier);

function hasUnseenFailure(input: OrchestrationDotInput): boolean {
  if (input.latestRun?.status !== "failed") return false;
  if (input.lastVisitedAt === null) return true;
  const completedAt = Date.parse(input.latestRun.completedAt ?? "");
  const lastVisitedAt = Date.parse(input.lastVisitedAt);
  if (Number.isNaN(completedAt) || Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

function hasUnseenCompletion(input: OrchestrationDotInput, rowCreatedAt: string | null): boolean {
  const completedAt = input.latestRun?.completedAt;
  if (!completedAt || Number.isNaN(Date.parse(completedAt))) return false;
  // Agent-launched rows are never opened, so the chat view's rule (which needs
  // a visit) would hide every finished slice and pod.
  if (input.lastVisitedAt === null) {
    return rowCreatedAt !== null && isAfter(completedAt, rowCreatedAt);
  }
  return Number.isNaN(Date.parse(input.lastVisitedAt)) || isAfter(completedAt, input.lastVisitedAt);
}

function resolveDot(input: OrchestrationDotInput, rowCreatedAt: string | null): OrchestrationDot {
  if (input.hasPendingApprovals || input.hasPendingUserInput || input.hasActionableProposedPlan) {
    return "needs-you";
  }
  const failed = input.runtimeStatus === "failed" || hasUnseenFailure(input);
  // A usage-limit failure is the limited dot, never failed: agent rows are
  // never visited, so every limit hit would otherwise read as failed.
  if (failed && input.lastErrorClass !== "usage_limit") return "failed";
  if (failed) return "limited";
  if (
    input.wokeAt !== null &&
    !input.settled &&
    (input.lastVisitedAt === null || isAfter(input.wokeAt, input.lastVisitedAt))
  ) {
    return "woke";
  }
  if (input.runtimeStatus !== null && WORKING_RUNTIME_STATUSES.has(input.runtimeStatus)) {
    return "working";
  }
  if (input.runtimeStatus === "idle" || input.backgroundWorkHoldsCompletion) return "waiting";
  if (hasUnseenCompletion(input, rowCreatedAt)) return "done-unread";
  return "idle";
}

/**
 * `rowCreatedAt` is the thread's `createdAt` for orchestration rows (slices,
 * pods, ad-hoc roots), whose never-visited completions count as done-unread;
 * null for everything else, cells included.
 */
export function resolveOrchestrationDot(
  input: OrchestrationDotInput,
  rowCreatedAt: string | null,
): ResolvedOrchestrationDot {
  // A stale shell still holds the last state it saw, so the dot it resolves to
  // is the last dot; it is only marked as such.
  const stale =
    !input.environmentConnected ||
    input.shellStatus === "cached" ||
    input.shellStatus === "synchronizing";
  return {
    dot: resolveDot(input, rowCreatedAt),
    dim: stale || input.settled || input.snoozed || input.limitParked,
    stale,
  };
}

export function foldOrchestrationDots(dots: Iterable<OrchestrationDot>): OrchestrationRollup {
  let dot: OrchestrationDot = "idle";
  let needsYouCount = 0;
  for (const next of dots) {
    if (next === "needs-you") needsYouCount += 1;
    if (DOT_RANK[next] < DOT_RANK[dot]) dot = next;
  }
  return { dot, needsYouCount };
}

interface RowBuilder {
  readonly key: string;
  readonly kind: OrchestrationRow["kind"];
  readonly projectId: string;
  readonly repoTag?: string;
  readonly dots: OrchestrationDot[];
  readonly pods: RowBuilder[];
}

interface TreeBuilder {
  readonly metaKey: string | null;
  readonly projects: Map<string, Map<string | null, RowBuilder[]>>;
  readonly dots: OrchestrationDot[];
  unread: number;
}

const newTree = (metaKey: string | null): TreeBuilder => ({
  metaKey,
  projects: new Map(),
  dots: [],
  unread: 0,
});

function buildRow(row: RowBuilder): OrchestrationRow {
  const pods = row.pods.map(buildRow);
  return {
    key: row.key,
    kind: row.kind,
    ...(row.repoTag === undefined ? {} : { repoTag: row.repoTag }),
    rollup: foldOrchestrationDots([...row.dots, ...row.pods.flatMap((pod) => pod.dots)]),
    pods,
  };
}

function buildTree(tree: TreeBuilder): OrchestrationTree {
  return {
    projects: [...tree.projects].map(([projectId, branches]) => ({
      projectId,
      branches: [...branches].map(([branch, rows]) => ({ branch, rows: rows.map(buildRow) })),
    })),
    rollup: foldOrchestrationDots(tree.dots),
    unread: tree.unread,
  };
}

function compareThreads(left: OrchestrationThreadInput, right: OrchestrationThreadInput): number {
  const byCreatedAt = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (byCreatedAt !== 0) return byCreatedAt;
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

/**
 * Places every unarchived thread once: as a meta tab, inside one meta's tree,
 * or in "No meta". Slices and pods are rows; other descendants (cells, plain
 * subagents) are not, but their dots roll up into the nearest row, or the meta
 * tab. A slice's roll-up covers its pods and cells; a nested slice is its own
 * row.
 */
export function classifyOrchestration(
  threads: ReadonlyArray<OrchestrationThreadInput>,
): OrchestrationClassification {
  const byKey = new Map<string, OrchestrationThreadInput>();
  for (const thread of [...threads].sort(compareThreads)) {
    if (!thread.archived && !byKey.has(thread.key)) byKey.set(thread.key, thread);
  }

  // A missing parent makes an orphan root. A meta is always a root, so it never
  // shows as a row in another meta's tree.
  const parentKeyByKey = new Map<string, string>();
  const childrenByKey = new Map<string, OrchestrationThreadInput[]>();
  for (const [key, thread] of byKey) {
    const parentKey = thread.parentKey;
    if (thread.metaAt !== null || parentKey === null || parentKey === key) continue;
    if (!byKey.has(parentKey)) continue;
    parentKeyByKey.set(key, parentKey);
    const siblings = childrenByKey.get(parentKey);
    if (siblings === undefined) childrenByKey.set(parentKey, [thread]);
    else siblings.push(thread);
  }

  // Whatever no root reaches is on a cycle or hangs off one. Walking up finds a
  // thread on the cycle; cutting the edge into it makes it a root, as
  // client-runtime's `deriveAgentTree` does.
  const reached = new Set<string>();
  const reachFrom = (rootKey: string) => {
    const pending = [rootKey];
    for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
      reached.add(key);
      for (const child of childrenByKey.get(key) ?? []) pending.push(child.key);
    }
  };
  for (const key of byKey.keys()) if (!parentKeyByKey.has(key)) reachFrom(key);
  for (const key of byKey.keys()) {
    if (reached.has(key)) continue;
    const walked = new Set<string>();
    let onCycle = key;
    while (!walked.has(onCycle)) {
      walked.add(onCycle);
      onCycle = parentKeyByKey.get(onCycle)!;
    }
    const siblings = childrenByKey.get(parentKeyByKey.get(onCycle)!)!;
    siblings.splice(siblings.indexOf(byKey.get(onCycle)!), 1);
    parentKeyByKey.delete(onCycle);
    reachFrom(onCycle);
  }

  const metas: OrchestrationThreadInput[] = [];
  const treeByMeta = new Map<string, TreeBuilder>();
  const noMeta = newTree(null);
  const treeKeyByThreadKey: Record<string, string | null> = {};

  const placeRow = (tree: TreeBuilder, row: RowBuilder, branch: string | null) => {
    let branches = tree.projects.get(row.projectId);
    if (branches === undefined) tree.projects.set(row.projectId, (branches = new Map()));
    const rows = branches.get(branch);
    if (rows === undefined) branches.set(branch, [row]);
    else rows.push(row);
  };

  const visit = (
    thread: OrchestrationThreadInput,
    tree: TreeBuilder | null,
    slice: RowBuilder | null,
    row: RowBuilder | null,
  ) => {
    const isRoot = !parentKeyByKey.has(thread.key);
    let kind: OrchestrationRow["kind"] | null = null;
    if (thread.metaAt !== null) {
      metas.push(thread);
      tree = newTree(thread.key);
      treeByMeta.set(thread.key, tree);
      slice = null;
      row = null;
    } else if (thread.rolePresetId === "slice") {
      kind = "slice";
      tree ??= noMeta;
      row = slice = { key: thread.key, kind, projectId: thread.projectId, dots: [], pods: [] };
      placeRow(tree, row, thread.branch);
    } else if (thread.rolePresetId === "broker" && slice !== null) {
      kind = "pod";
      row = {
        key: thread.key,
        kind,
        projectId: slice.projectId,
        ...(thread.projectId === slice.projectId ? {} : { repoTag: thread.projectId }),
        dots: [],
        pods: [],
      };
      slice.pods.push(row);
    } else if (thread.rolePresetId === "broker" || isRoot) {
      // A pod without a slice belongs to no meta, even when a meta launched it.
      kind = thread.rolePresetId === "broker" ? "pod" : "ad-hoc";
      tree = noMeta;
      row = { key: thread.key, kind, projectId: thread.projectId, dots: [], pods: [] };
      placeRow(tree, row, thread.branch);
    }

    const { dot } = resolveOrchestrationDot(thread.status, kind === null ? null : thread.createdAt);
    row?.dots.push(dot);
    tree!.dots.push(dot);
    treeKeyByThreadKey[thread.key] = tree!.metaKey;
    // L21's "never cells" excludes cells from the never-visited rule only; a
    // cell that needs the user still counts.
    if (dot === "needs-you" || dot === "done-unread") tree!.unread += 1;

    for (const child of childrenByKey.get(thread.key) ?? []) visit(child, tree, slice, row);
  };
  for (const thread of byKey.values()) {
    if (!parentKeyByKey.has(thread.key)) visit(thread, null, null, null);
  }

  metas.sort((left, right) => Date.parse(left.metaAt!) - Date.parse(right.metaAt!));
  return {
    metas: metas.map((meta) => meta.key),
    trees: Object.fromEntries([...treeByMeta].map(([key, tree]) => [key, buildTree(tree)])),
    noMeta: buildTree(noMeta),
    treeKeyByThreadKey,
  };
}
