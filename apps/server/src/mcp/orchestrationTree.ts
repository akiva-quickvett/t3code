/**
 * The server's side of `t3_orchestration_tree`: thread shells to the shared
 * classifier's input, and its classification plus pod subagent records to the
 * L14 payload. The shell-to-input mapping mirrors client-runtime's
 * `orchestrationThreadInput` (over `presentThreadShell`, `threadWokeAt` and
 * `effectiveSnoozed`) so the tree matches the sidebar; the server cannot
 * import client-runtime, so the two are kept in step by hand.
 *
 * @module mcp/orchestrationTree
 */
import type {
  OrchestrationDot,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadShell,
  OrchestratorMcpDelegatedTaskStatus,
  OrchestratorMcpOrchestrationTree,
  OrchestratorMcpOrchestrationTreeResult,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import {
  classifyOrchestration,
  orchestrationParentThreadId,
  resolveOrchestrationDot,
  type OrchestrationClassification,
  type OrchestrationRow,
  type OrchestrationThreadInput,
  type OrchestrationTree,
} from "@t3tools/shared/orchestrationTree";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";

type Tree = OrchestratorMcpOrchestrationTree;
type Slice = Tree["projects"][number]["branches"][number]["slices"][number];
type Pod = Slice["pods"][number];
type Organ = Pod["organs"][number];
type Cell = Organ["cells"][number];

const iso = (value: DateTime.Utc | null | undefined) =>
  value == null ? null : DateTime.formatIso(value);
const millis = (value: DateTime.Utc | null | undefined) =>
  value == null ? null : DateTime.toEpochMillis(value);

const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

type DotStatus = OrchestrationThreadInput["status"];

/**
 * client-runtime's `threadRaisedHandWhileSnoozed`, over the fields its
 * `presentThreadShell` derives. The sidebar presents shells without a child's
 * pending request, so neither does this.
 */
function raisedHandWhileSnoozed(
  shell: OrchestrationV2ThreadShell,
  status: Pick<
    DotStatus,
    "hasPendingApprovals" | "hasPendingUserInput" | "runtimeStatus" | "latestRun"
  >,
): "failure" | "completion" | "request" | null {
  if (status.hasPendingApprovals || status.hasPendingUserInput) return "request";
  const snoozedAt = millis(shell.snoozedAt);
  if (
    status.runtimeStatus === "failed" &&
    (snoozedAt === null || millis(shell.updatedAt)! > snoozedAt)
  ) {
    return "failure";
  }
  const completedAt = status.latestRun?.completedAt ?? null;
  if (
    snoozedAt !== null &&
    status.latestRun?.status === "completed" &&
    completedAt !== null &&
    Date.parse(completedAt) > snoozedAt
  ) {
    return "completion";
  }
  return null;
}

/** The server always reads live shells, so nothing it resolves is stale. */
export function orchestrationThreadInputFromShell(
  shell: OrchestrationV2ThreadShell,
  nowMs: number,
): OrchestrationThreadInput {
  const completedAt =
    shell.latestRunCompletedAt === undefined
      ? shell.status === "idle" || TERMINAL_RUN_STATUSES.has(shell.status)
        ? iso(shell.updatedAt)
        : null
      : iso(shell.latestRunCompletedAt);
  const holdsCompletion = backgroundWorkHoldsCompletion(shell.pendingBackgroundTasks ?? []);
  // client-runtime's `shellRuntime` exists for a background hold too, parked at idle.
  const hasRuntime =
    shell.latestRunId !== null ||
    shell.activeProviderThreadId !== null ||
    (holdsCompletion && shell.status !== "failed");
  const handStatus = {
    hasPendingApprovals:
      shell.pendingRuntimeRequest !== null &&
      shell.pendingRuntimeRequest.kind !== "user_input" &&
      shell.pendingRuntimeRequest.kind !== "auth_refresh",
    hasPendingUserInput: shell.pendingRuntimeRequest?.kind === "user_input",
    runtimeStatus:
      shell.latestRunId === null && shell.activeProviderThreadId === null
        ? null
        : (shell.activityRunStatus ?? shell.status),
    latestRun:
      shell.latestRunId === null
        ? null
        : { status: shell.status === "idle" ? "completed" : shell.status, completedAt },
  } satisfies Partial<DotStatus>;
  const snoozedUntil = millis(shell.snoozedUntil);
  const raised = snoozedUntil === null ? null : raisedHandWhileSnoozed(shell, handStatus);
  // client-runtime's `threadWokeAt` and `effectiveSnoozed`.
  const wokeAt =
    snoozedUntil === null
      ? null
      : raised === "completion"
        ? handStatus.latestRun!.completedAt
        : raised !== null
          ? ((hasRuntime ? iso(shell.updatedAt) : null) ?? iso(shell.snoozedAt))
          : snoozedUntil <= nowMs
            ? iso(shell.snoozedUntil)
            : null;
  return {
    key: shell.id,
    parentKey: orchestrationParentThreadId(shell.lineage),
    projectId: shell.projectId,
    branch: shell.branch,
    rolePresetId: shell.rolePreset?.id ?? null,
    metaAt: iso(shell.metaAt),
    archived: shell.archivedAt !== null,
    createdAt: DateTime.formatIso(shell.createdAt),
    status: {
      ...handStatus,
      hasActionableProposedPlan: shell.hasActionableProposedPlan,
      lastErrorClass: shell.lastErrorClass ?? null,
      wokeAt,
      backgroundWorkHoldsCompletion: holdsCompletion,
      lastVisitedAt: iso(shell.lastVisitedAt),
      settled: shell.settledOverride === "settled",
      snoozed: snoozedUntil !== null && snoozedUntil > nowMs && raised === null,
      limitParked: shell.limitRecovery?.snooze === true && shell.snoozedUntil != null,
      environmentConnected: true,
      shellStatus: "live",
    },
  };
}

export interface ClassifiedShells {
  readonly classification: OrchestrationClassification;
  readonly shellsById: ReadonlyMap<string, OrchestrationV2ThreadShell>;
  readonly inputsById: ReadonlyMap<string, OrchestrationThreadInput>;
}

export function classifyShells(
  shells: ReadonlyArray<OrchestrationV2ThreadShell>,
  nowMs: number,
): ClassifiedShells {
  const inputs = shells.map((shell) => orchestrationThreadInputFromShell(shell, nowMs));
  return {
    classification: classifyOrchestration(inputs),
    shellsById: new Map(shells.map((shell) => [shell.id, shell])),
    inputsById: new Map(inputs.map((input) => [input.key, input])),
  };
}

const rowsOf = (tree: OrchestrationTree) =>
  tree.projects.flatMap((project) => project.branches.flatMap((branch) => branch.rows));

/** Pod rows of the trees `t3_orchestration_tree` returns: one meta's, or every meta's and No meta's. */
export function selectedPodIds(
  classification: OrchestrationClassification,
  metaThreadId: ThreadId | undefined,
): ReadonlyArray<ThreadId> {
  const trees =
    metaThreadId === undefined
      ? [...Object.values(classification.trees), classification.noMeta]
      : [classification.trees[metaThreadId]!];
  return trees.flatMap((tree) =>
    rowsOf(tree).flatMap((row) =>
      row.kind === "pod" ? [row.key as ThreadId] : row.pods.map((pod) => pod.key as ThreadId),
    ),
  );
}

/**
 * Subagent statuses outside the delegated-task vocabulary. `idle` is a
 * follow-up held behind a held queue, which `task_status` reports as queued.
 */
function cellStatus(status: OrchestrationV2Subagent["status"]): OrchestratorMcpDelegatedTaskStatus {
  return status === "pending" || status === "idle" ? "queued" : status;
}

/**
 * One entry per organ id, in the order the organ started. A follow-up record
 * copies its cell's organ, so cells are deduped by child thread, keeping the
 * latest record. The payload has one `round` per organ, so it is the latest
 * round, and cells are listed by round.
 */
export function podOrgans(
  subagents: ReadonlyArray<OrchestrationV2Subagent>,
  classified: ClassifiedShells,
): ReadonlyArray<Organ> {
  const organs = new Map<
    string,
    {
      readonly label: NonNullable<OrchestrationV2Subagent["organ"]>;
      round: number;
      readonly cells: Map<ThreadId, OrchestrationV2Subagent>;
    }
  >();
  // Records are in creation order, which places organs and cells.
  for (const record of subagents) {
    const label = record.organ;
    const childThreadId = record.childThreadId;
    if (label === undefined || childThreadId === null) continue;
    const organ = organs.get(label.id) ?? { label, round: label.round, cells: new Map() };
    organs.set(label.id, organ);
    organ.round = Math.max(organ.round, label.round);
    const kept = organ.cells.get(childThreadId);
    if (
      kept === undefined ||
      DateTime.toEpochMillis(record.updatedAt) >= DateTime.toEpochMillis(kept.updatedAt)
    ) {
      organ.cells.set(childThreadId, record);
    }
  }
  return [...organs.values()].map(({ label, round, cells }) => ({
    id: label.id,
    presetId: label.presetId,
    goal: label.goal,
    round,
    cells: [...cells.values()]
      .map((record, index) => ({ record, index }))
      .sort(
        (left, right) =>
          left.record.organ!.round - right.record.organ!.round || left.index - right.index,
      )
      .flatMap(({ record }): Cell[] => {
        const childThreadId = record.childThreadId!;
        const input = classified.inputsById.get(childThreadId);
        // An archived or deleted cell has no active shell, as in the sidebar.
        if (input === undefined || input.archived) return [];
        return [
          {
            threadId: childThreadId,
            role: classified.shellsById.get(childThreadId)?.rolePreset?.id ?? null,
            model: record.model,
            status: cellStatus(record.status),
            dot: resolveOrchestrationDot(input.status, null).dot,
          },
        ];
      }),
  }));
}

/**
 * The L14 shape has rows only as `slices`. A No-meta ad-hoc chat is a
 * slice-shaped entry with no pods; a slice-less pod is a slice-shaped entry
 * whose only pod is itself, so its organs survive.
 */
export function orchestrationTreeResult(input: {
  readonly classified: ClassifiedShells;
  readonly metaThreadId: ThreadId | undefined;
  readonly organsByPodId: ReadonlyMap<string, ReadonlyArray<Organ>>;
}): OrchestratorMcpOrchestrationTreeResult {
  const { classification, shellsById } = input.classified;
  const title = (key: string) => shellsById.get(key)?.title ?? "";
  const dot = (row: OrchestrationRow): OrchestrationDot => row.rollup.dot;
  const pod = (row: OrchestrationRow): Pod => ({
    threadId: row.key as ThreadId,
    title: title(row.key),
    dot: dot(row),
    ...(row.repoTag === undefined ? {} : { repoTag: row.repoTag }),
    organs: input.organsByPodId.get(row.key) ?? [],
  });
  const slice = (row: OrchestrationRow): Slice => ({
    threadId: row.key as ThreadId,
    title: title(row.key),
    dot: dot(row),
    pods: row.kind === "pod" ? [pod(row)] : row.pods.map(pod),
  });
  const tree = (source: OrchestrationTree): Tree => ({
    projects: source.projects.map((project) => ({
      projectId: project.projectId as ProjectId,
      branches: project.branches.map((branch) => ({
        branch: branch.branch,
        slices: branch.rows.map(slice),
      })),
    })),
  });
  const metaKeys = input.metaThreadId === undefined ? classification.metas : [input.metaThreadId];
  return {
    metas: classification.metas.map((key) => ({
      threadId: key as ThreadId,
      title: title(key),
      dot: classification.trees[key]!.rollup.dot,
      unread: classification.trees[key]!.unread,
    })),
    noMeta: input.metaThreadId === undefined ? tree(classification.noMeta) : { projects: [] },
    trees: Object.fromEntries(metaKeys.map((key) => [key, tree(classification.trees[key]!)])),
    stale: false,
  };
}
