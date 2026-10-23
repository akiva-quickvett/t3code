import * as DateTime from "effect/DateTime";
import {
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationDot,
  type OrchestrationProjectShell,
  type OrchestrationV2AppThread,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadShell,
  type OrganLabel,
  type ThreadRolePreset,
} from "@t3tools/contracts";

import type { ResolvedOrchestrationDot } from "../orchestrationTree.ts";

export const SEED_EPOCH = "2026-10-01T09:00:00.000Z";
/** Snoozes and limit parks must still be ahead when the seed lands on a live dev server. */
export const SEED_FAR_FUTURE = "2100-01-01T00:00:00.000Z";

const EPOCH_MS = Date.parse(SEED_EPOCH);
const at = (minute: number) => DateTime.makeUnsafe(EPOCH_MS + minute * 60_000);
const FAR_FUTURE = DateTime.makeUnsafe(SEED_FAR_FUTURE);

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CLAUDE_INSTANCE = ProviderInstanceId.make("claudeAgent");
const MODEL = "claude-opus-5-5";
const modelSelection = { instanceId: CLAUDE_INSTANCE, model: MODEL };

const HOME = ProjectId.make("seed-project-home");
const WEB = ProjectId.make("seed-project-web");
const SERVER = ProjectId.make("seed-project-server");

const project = (id: ProjectId, title: string): OrchestrationProjectShell => ({
  id,
  title,
  workspaceRoot: `/seed/${title}`,
  defaultModelSelection: null,
  scripts: [],
  createdAt: SEED_EPOCH,
  updatedAt: SEED_EPOCH,
});

const role = (id: string, label: string): ThreadRolePreset => ({ id, label });
const ROLES = {
  meta: role("meta", "Meta orchestrator"),
  slice: role("slice", "Slice orchestrator"),
  broker: role("broker", "Pod broker"),
  implementor: role("implementor", "Implementor"),
  tester: role("tester", "Tester"),
  scout: role("scout", "Scout"),
  research: role("research", "Researcher"),
  "review-t3": role("review-t3", "Reviewer (tier 3)"),
  "review-t3-grok": role("review-t3-grok", "Reviewer (tier 3, second)"),
  designer: role("designer", "Designer"),
};
type CellRole = Exclude<keyof typeof ROLES, "meta" | "slice" | "broker">;

/**
 * One concrete field shape per state. `done` is a completed run never visited:
 * done-unread on orchestration rows, idle on cells (L21).
 */
type SeedState =
  | "needs-approval"
  | "needs-input"
  | "plan-ready"
  | "failed"
  | "limited"
  | "limit-parked"
  | "woke"
  | "working"
  | "runtime-idle"
  | "background"
  | "done"
  | "done-unread"
  | "idle"
  | "snoozed"
  | "settled";

const DOT_BY_STATE: Record<SeedState, OrchestrationDot> = {
  "needs-approval": "needs-you",
  "needs-input": "needs-you",
  "plan-ready": "needs-you",
  failed: "failed",
  limited: "limited",
  "limit-parked": "limited",
  woke: "woke",
  working: "working",
  "runtime-idle": "waiting",
  background: "waiting",
  done: "done-unread",
  "done-unread": "done-unread",
  idle: "idle",
  snoozed: "idle",
  settled: "idle",
};

const SUBAGENT_STATUS: Record<SeedState, OrchestrationV2Subagent["status"]> = {
  "needs-approval": "waiting",
  "needs-input": "waiting",
  "plan-ready": "completed",
  failed: "failed",
  limited: "failed",
  "limit-parked": "failed",
  woke: "completed",
  working: "running",
  "runtime-idle": "idle",
  background: "running",
  done: "completed",
  "done-unread": "completed",
  idle: "completed",
  snoozed: "completed",
  settled: "completed",
};

type SeedKind = "meta" | "slice" | "pod" | "cell" | "chat";

interface SeedThreadSpec {
  readonly id: ThreadId;
  readonly kind: SeedKind;
  readonly title: string;
  readonly projectId: ProjectId;
  readonly branch: string | null;
  readonly state: SeedState;
  readonly rolePreset: ThreadRolePreset | null;
  readonly parent: {
    readonly id: ThreadId;
    readonly rootId: ThreadId;
    readonly supervised: boolean;
  } | null;
  readonly organ: OrganLabel | null;
  /** Minutes after the epoch; every other timestamp of the thread is a small offset from it. */
  readonly minute: number;
}

interface SeedThread {
  readonly appThread: OrchestrationV2AppThread;
  readonly shell: OrchestrationV2ThreadShell;
  /** The record on the parent that tracks this thread, if it has a parent. */
  readonly subagent: OrchestrationV2Subagent | null;
}

const runId = (id: ThreadId) => RunId.make(`seed-run-${id}`);

function buildThread(spec: SeedThreadSpec): SeedThread {
  const { id, state, minute: t } = spec;
  const hasRun = state !== "runtime-idle";
  const active = state === "working" || state === "needs-approval" || state === "needs-input";
  const failed = state === "failed" || state === "limited" || state === "limit-parked";
  const completedMinute = hasRun && !active ? t + 5 : null;
  const lastVisitedMinute =
    state === "done-unread"
      ? t + 3
      : state === "idle" || state === "snoozed" || state === "settled"
        ? t + 8
        : state === "woke" || state === "plan-ready"
          ? t + 6
          : null;
  const snoozedAt =
    state === "snoozed" || state === "woke" || state === "limit-parked" ? at(t + 7) : null;
  const snoozedUntil =
    state === "woke"
      ? at(t + 9)
      : state === "snoozed" || state === "limit-parked"
        ? FAR_FUTURE
        : null;
  const updatedAt = at(t + 10);
  const childOfSubagent = spec.parent !== null && !spec.parent.supervised;
  const taskId = NodeId.make(`seed-task-${id}`);

  const appThread: OrchestrationV2AppThread = {
    createdBy: spec.kind === "meta" || spec.kind === "chat" ? "user" : "agent",
    creationSource: spec.kind === "meta" || spec.kind === "chat" ? "web" : "mcp",
    id,
    projectId: spec.projectId,
    title: spec.title,
    providerInstanceId: CLAUDE_INSTANCE,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: state === "plan-ready" ? "plan" : "default",
    branch: spec.branch,
    worktreePath: null,
    activeProviderThreadId: ProviderThreadId.make(`seed-provider-${id}`),
    lineage: {
      parentThreadId: childOfSubagent ? spec.parent!.id : null,
      relationshipToParent: childOfSubagent ? "subagent" : null,
      rootThreadId: childOfSubagent ? spec.parent!.rootId : id,
      ...(spec.parent?.supervised ? { supervisorThreadId: spec.parent.id } : {}),
      ...(spec.organ === null ? {} : { organ: spec.organ }),
    },
    forkedFrom: childOfSubagent ? { type: "node", nodeId: taskId } : null,
    createdAt: at(t),
    updatedAt,
    archivedAt: null,
    settledOverride: state === "settled" ? "settled" : null,
    settledAt: state === "settled" ? at(t + 9) : null,
    ...(snoozedAt === null ? {} : { snoozedAt, snoozedUntil }),
    ...(state === "limit-parked"
      ? {
          limitRecovery: {
            runId: runId(id),
            resetAt: SEED_FAR_FUTURE,
            autoResume: true,
            snooze: true,
          },
        }
      : {}),
    ...(spec.kind === "meta" ? { metaAt: at(t), autoSettleDisabledAt: at(t) } : {}),
    ...(spec.rolePreset === null ? {} : { rolePreset: spec.rolePreset }),
    lastVisitedAt: lastVisitedMinute === null ? null : at(lastVisitedMinute),
    deletedAt: null,
  };

  const shell: OrchestrationV2ThreadShell = {
    ...appThread,
    latestRunId: hasRun ? runId(id) : null,
    latestRunRequestedAt: hasRun ? at(t + 1) : null,
    latestRunStartedAt: hasRun ? at(t + 1) : null,
    latestRunCompletedAt: completedMinute === null ? null : at(completedMinute),
    activeRunId: active ? runId(id) : null,
    activityRunStartedAt: active ? at(t + 1) : null,
    activityRunStatus: active ? (state === "working" ? "running" : "waiting") : null,
    status: !hasRun ? "idle" : active ? "running" : failed ? "failed" : "completed",
    ...(failed
      ? {
          lastError: state === "failed" ? "Provider exited with code 1." : "Usage limit reached.",
          lastErrorClass: state === "failed" ? "provider_error" : "usage_limit",
          ...(state === "failed" ? {} : { usageLimitResetAt: SEED_FAR_FUTURE }),
        }
      : {}),
    pendingRuntimeRequest:
      state === "needs-approval" || state === "needs-input"
        ? {
            id: RuntimeRequestId.make(`seed-request-${id}`),
            kind: state === "needs-approval" ? "command" : "user_input",
            createdAt: at(t + 2),
          }
        : null,
    latestVisibleMessage: null,
    latestUserMessageAt: hasRun ? at(t + 1) : null,
    hasActionableProposedPlan: state === "plan-ready",
    pendingBackgroundTasks:
      state === "background" ? [{ taskId: `seed-background-${id}`, kind: "monitor" }] : [],
    providerInstanceHistory: [CLAUDE_INSTANCE],
    itemCount: hasRun ? 6 : 0,
    visibleItemCount: hasRun ? 4 : 0,
  };

  const subagent: OrchestrationV2Subagent | null =
    spec.parent === null
      ? null
      : {
          id: taskId,
          threadId: spec.parent.id,
          runId: runId(spec.parent.id),
          parentNodeId: NodeId.make(`seed-node-${spec.parent.id}`),
          origin: "app_owned",
          createdBy: "agent",
          driver: CLAUDE,
          providerInstanceId: CLAUDE_INSTANCE,
          providerThreadId: ProviderThreadId.make(`seed-provider-${spec.parent.id}`),
          childThreadId: id,
          nativeTaskRef: null,
          prompt: spec.title,
          title: spec.title,
          model: MODEL,
          modelSelection,
          // Organ cells and supervised runs always wake their parent (L26).
          ...(spec.organ !== null || spec.parent.supervised
            ? { completionWake: "always" as const }
            : {}),
          ...(spec.parent.supervised ? { supervised: true as const } : {}),
          ...(spec.organ === null ? {} : { organ: spec.organ }),
          status: SUBAGENT_STATUS[state],
          result: SUBAGENT_STATUS[state] === "completed" ? "Done." : null,
          startedAt: at(t),
          completedAt: completedMinute === null ? null : at(completedMinute),
          updatedAt,
        };

  return { appThread, shell, subagent };
}

interface OrganSpec {
  readonly presetId: string;
  readonly goal: string;
  readonly cells: ReadonlyArray<readonly [CellRole, SeedState]>;
}

interface PodSpec {
  readonly state: SeedState;
  readonly note: string;
  /** Set only for the cross-repo pod; otherwise the slice's project. */
  readonly projectId?: ProjectId;
  readonly organs?: ReadonlyArray<OrganSpec>;
}

interface SliceSpec {
  readonly meta: 1 | 2;
  readonly projectId: ProjectId;
  readonly state: SeedState;
  readonly note: string;
  readonly pods: ReadonlyArray<PodSpec>;
}

const METAS: ReadonlyArray<{ readonly state: SeedState; readonly note: string }> = [
  { state: "working", note: "working" },
  { state: "idle", note: "idle" },
];

/** Pods are numbered 1..14 in this order; pod 15 is the slice-less one. */
const SLICES: ReadonlyArray<SliceSpec> = [
  {
    meta: 1,
    projectId: WEB,
    state: "working",
    note: "working",
    pods: [
      {
        state: "needs-approval",
        note: "needs approval",
        organs: [
          {
            presetId: "review-t3-council",
            goal: "Review the sidebar rewrite.",
            cells: [
              ["review-t3", "working"],
              ["review-t3", "working"],
              ["review-t3-grok", "working"],
            ],
          },
        ],
      },
      {
        state: "working",
        note: "working",
        organs: [
          {
            presetId: "implementation",
            goal: "Implement the tab strip.",
            cells: [
              ["implementor", "working"],
              ["tester", "done"],
            ],
          },
        ],
      },
      {
        state: "failed",
        note: "cross-repo, failed",
        projectId: SERVER,
        organs: [
          {
            presetId: "scouts",
            goal: "Map every caller of the tree-parent index.",
            cells: [
              ["scout", "done"],
              ["scout", "done"],
              ["scout", "done"],
              ["scout", "done"],
              ["scout", "failed"],
            ],
          },
        ],
      },
    ],
  },
  {
    meta: 1,
    projectId: WEB,
    state: "runtime-idle",
    note: "waiting",
    pods: [
      { state: "background", note: "waiting on background work" },
      { state: "limited", note: "usage limit" },
      { state: "limit-parked", note: "limit-parked" },
    ],
  },
  {
    meta: 1,
    projectId: SERVER,
    state: "done",
    note: "finished, never visited",
    pods: [
      { state: "idle", note: "idle" },
      {
        state: "done-unread",
        note: "done, unread",
        organs: [
          {
            presetId: "research",
            goal: "Compare tree-parent semantics across clients.",
            cells: [["research", "done"]],
          },
        ],
      },
    ],
  },
  {
    meta: 2,
    projectId: SERVER,
    state: "woke",
    note: "woke",
    pods: [
      { state: "needs-input", note: "needs input" },
      { state: "plan-ready", note: "plan ready" },
      { state: "idle", note: "idle, cached" },
    ],
  },
  {
    meta: 2,
    projectId: WEB,
    state: "snoozed",
    note: "snoozed",
    pods: [
      {
        state: "working",
        note: "working, synchronizing",
        organs: [
          {
            presetId: "design",
            goal: "Mock the orchestration sidebar.",
            cells: [
              ["designer", "working"],
              ["designer", "working"],
              ["designer", "needs-input"],
              ["designer", "done"],
            ],
          },
        ],
      },
      { state: "woke", note: "woke" },
    ],
  },
  {
    meta: 2,
    projectId: SERVER,
    state: "settled",
    note: "settled",
    pods: [{ state: "settled", note: "settled" }],
  },
];

export const seedMetaId = (n: number) => ThreadId.make(`seed-meta-${n}`);
export const seedSliceId = (n: number) => ThreadId.make(`seed-slice-${n}`);
export const seedPodId = (n: number) => ThreadId.make(`seed-pod-${n}`);
export const seedCellId = (pod: number, n: number) => ThreadId.make(`seed-cell-${pod}-${n}`);
export const SEED_AD_HOC_CHAT_ID = ThreadId.make("seed-chat-1");
export const SEED_SLICELESS_POD_ID = seedPodId(15);
export const SEED_CROSS_REPO_POD_ID = seedPodId(3);
export const SEED_NEVER_VISITED_SLICE_ID = seedSliceId(3);

/**
 * Stale is the client's shell status, not a thread field, so tests apply it to
 * these threads themselves (L29).
 */
export const staleShellIds = {
  cached: [seedPodId(11)],
  synchronizing: [seedPodId(12)],
} as const;

function buildSpecs(): SeedThreadSpec[] {
  const specs: SeedThreadSpec[] = [];
  let minute = 0;
  const add = (spec: Omit<SeedThreadSpec, "minute">) => {
    specs.push({ ...spec, minute });
    minute += 15;
  };
  const addPod = (
    n: number,
    pod: PodSpec,
    projectId: ProjectId,
    parent: SeedThreadSpec["parent"] & {},
  ) => {
    const podId = seedPodId(n);
    add({
      id: podId,
      kind: "pod",
      title: `Pod ${n} · ${pod.note}`,
      projectId: pod.projectId ?? projectId,
      branch: `seed/pod-${n}`,
      state: pod.state,
      rolePreset: ROLES.broker,
      parent,
      organ: null,
    });
    let cell = 0;
    (pod.organs ?? []).forEach((organ, index) => {
      const label: OrganLabel = {
        id: `organ_seed0000pod${n}${String.fromCharCode(97 + index)}`,
        presetId: organ.presetId,
        goal: organ.goal,
        round: 1,
      };
      for (const [cellRole, state] of organ.cells) {
        cell += 1;
        add({
          id: seedCellId(n, cell),
          kind: "cell",
          title: `Cell ${n}-${cell} · ${ROLES[cellRole].label}`,
          projectId: pod.projectId ?? projectId,
          branch: `seed/pod-${n}`,
          state,
          rolePreset: ROLES[cellRole],
          parent: { id: podId, rootId: parent.rootId, supervised: false },
          organ: label,
        });
      }
    });
  };

  METAS.forEach((meta, index) =>
    add({
      id: seedMetaId(index + 1),
      kind: "meta",
      title: `Meta ${index + 1} · ${meta.note}`,
      projectId: HOME,
      branch: null,
      state: meta.state,
      rolePreset: ROLES.meta,
      parent: null,
      organ: null,
    }),
  );
  let pod = 0;
  SLICES.forEach((slice, index) => {
    const sliceId = seedSliceId(index + 1);
    add({
      id: sliceId,
      kind: "slice",
      title: `Slice ${index + 1} · ${slice.note}`,
      projectId: slice.projectId,
      branch: `seed/slice-${index + 1}`,
      state: slice.state,
      rolePreset: ROLES.slice,
      parent: { id: seedMetaId(slice.meta), rootId: seedMetaId(slice.meta), supervised: true },
      organ: null,
    });
    for (const podSpec of slice.pods) {
      pod += 1;
      // A slice's root is itself: supervision does not join lineages.
      addPod(pod, podSpec, slice.projectId, { id: sliceId, rootId: sliceId, supervised: false });
    }
  });
  // A pod a meta launched directly, with no slice above it.
  addPod(15, { state: "working", note: "no slice" }, WEB, {
    id: seedMetaId(2),
    rootId: seedMetaId(2),
    supervised: false,
  });
  add({
    id: SEED_AD_HOC_CHAT_ID,
    kind: "chat",
    title: "Ad-hoc chat · done, never visited",
    projectId: HOME,
    branch: null,
    state: "done",
    rolePreset: null,
    parent: null,
    organ: null,
  });
  return specs;
}

const SPECS = buildSpecs();
const PAD_START_MINUTE = (SPECS.at(-1)?.minute ?? 0) + 15;

export interface OrchestrationSeedTree {
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  /** In creation order, so parents precede children. */
  readonly appThreads: ReadonlyArray<OrchestrationV2AppThread>;
  /** Shells of `appThreads`, same order. */
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  /** Keyed by the parent thread; supervised slices sit on their meta's list. */
  readonly subagentsByThreadId: Readonly<Record<ThreadId, ReadonlyArray<OrchestrationV2Subagent>>>;
}

function assemble(threads: ReadonlyArray<SeedThread>) {
  const subagentsByThreadId: Record<ThreadId, OrchestrationV2Subagent[]> = {};
  for (const { subagent } of threads) {
    if (subagent !== null) (subagentsByThreadId[subagent.threadId] ??= []).push(subagent);
  }
  return {
    appThreads: threads.map((thread) => thread.appThread),
    threads: threads.map((thread) => thread.shell),
    subagentsByThreadId,
  };
}

export const orchestrationSeedTree: OrchestrationSeedTree = {
  projects: [project(HOME, "home"), project(WEB, "web"), project(SERVER, "server")],
  ...assemble(SPECS.map(buildThread)),
};

const countKind = (kind: SeedKind) => SPECS.filter((spec) => spec.kind === kind).length;
export const SEED_META_COUNT = countKind("meta");
export const SEED_SLICE_COUNT = countKind("slice");
export const SEED_POD_COUNT = countKind("pod");
export const SEED_CELL_COUNT = countKind("cell");
export const SEED_THREAD_COUNT = SPECS.length;

const STALE_IDS = new Set<ThreadId>([...staleShellIds.cached, ...staleShellIds.synchronizing]);

/** What `resolveOrchestrationDot` should give each seed thread, stale ids applied. */
export const seedExpectedDots: Readonly<Record<ThreadId, ResolvedOrchestrationDot>> =
  Object.fromEntries(
    SPECS.map((spec) => {
      const stale = STALE_IDS.has(spec.id);
      return [
        spec.id,
        {
          dot: spec.kind === "cell" && spec.state === "done" ? "idle" : DOT_BY_STATE[spec.state],
          dim:
            stale ||
            spec.state === "snoozed" ||
            spec.state === "settled" ||
            spec.state === "limit-parked",
          stale,
        },
      ];
    }),
  );

/** Adds idle ad-hoc threads in the home project until the seed holds exactly `n` threads. */
export function pad(seed: OrchestrationSeedTree, n: number): OrchestrationSeedTree {
  if (n < seed.threads.length) {
    throw new Error(`Cannot pad a seed of ${seed.threads.length} threads down to ${n}.`);
  }
  const padded = seed.threads.length - SEED_THREAD_COUNT;
  const extra = Array.from({ length: n - seed.threads.length }, (_, index) => {
    const number = padded + index + 1;
    return buildThread({
      id: ThreadId.make(`seed-pad-${number}`),
      kind: "chat",
      title: `Padding chat ${number}`,
      projectId: HOME,
      branch: null,
      state: "idle",
      rolePreset: null,
      parent: null,
      organ: null,
      minute: PAD_START_MINUTE + number,
    });
  });
  return {
    ...seed,
    appThreads: [...seed.appThreads, ...extra.map((thread) => thread.appThread)],
    threads: [...seed.threads, ...extra.map((thread) => thread.shell)],
  };
}
