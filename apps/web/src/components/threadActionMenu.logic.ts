import type { ContextMenuItem } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { MetaPromoteBlocker } from "@t3tools/client-runtime/state/organ-presets";
import { agentTreeDescendants } from "@t3tools/client-runtime/state/thread-relationships";
import {
  type SnoozePreset,
  type ThreadSettleTreeState,
  threadHasActiveWork,
  threadTreeHasActiveWork,
} from "@t3tools/client-runtime/state/thread-settled";

export type ThreadActionMenuId =
  | "new-thread-on-branch"
  | "new-ticket"
  | "filter-by-project"
  | "project-settings"
  | "pin"
  | "unpin"
  | "settle"
  | "unsettle"
  | "settle-tree"
  | "unsettle-tree"
  | "auto-settle"
  | "auto-settle:enabled"
  | "auto-settle:disabled"
  | "promote-meta"
  | "demote-meta"
  | "snooze"
  | `snooze:${string}`
  | "snooze-thread"
  | `snooze-thread:${string}`
  | "unsnooze"
  | "cancel-snooze-when-idle"
  | "rename"
  | "regenerate-title"
  | "mark-unread"
  | "usage-cost"
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "copy-thread-id"
  | "pod-services"
  | `pod-open:${string}`
  | `pod-copy:${string}`
  | "archive"
  | "delete";

export type DraftActionMenuId =
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "project-settings"
  | "discard";

export function buildDraftActionMenuItems(options: {
  readonly hasPath: boolean;
  readonly hasBranch: boolean;
  readonly hasProject: boolean;
}): ReadonlyArray<ContextMenuItem<DraftActionMenuId>> {
  return [
    {
      id: "copy",
      label: "Copy",
      icon: "copy",
      disabled: !options.hasPath && !options.hasBranch,
      children: [
        ...(options.hasPath ? [{ id: "copy-path" as const, label: "Path", icon: "folder" }] : []),
        ...(options.hasBranch
          ? [{ id: "copy-branch" as const, label: "Branch", icon: "git-branch" }]
          : []),
      ],
    },
    ...(options.hasProject
      ? [{ id: "project-settings" as const, label: "Project settings", icon: "settings" }]
      : []),
    {
      id: "discard",
      label: "Discard draft",
      icon: "trash",
      destructive: true,
      separatorBefore: true,
    },
  ];
}

export interface ThreadActionMenuState {
  readonly canOperate: boolean;
  readonly branch: string | null;
  readonly projectFilter: {
    readonly label: string;
    readonly isActive: boolean;
  } | null;
  readonly isPinned: boolean;
  readonly isSettled: boolean;
  /** A tree settle waits for work to end; un-settling cancels it. */
  readonly isSettlePending?: boolean;
  readonly autoSettleEnabled: boolean;
  readonly isSnoozed: boolean;
  readonly canSnoozeNow: boolean;
  readonly isRegeneratingTitle: boolean;
  /** Archive rejects a thread with an attached provider, so disable it here rather than let the action fail. */
  readonly isRunning: boolean;
  readonly supports: {
    readonly settlement: boolean;
    readonly autoSettleOptOut: boolean;
    readonly snooze: boolean;
    readonly pinning: boolean;
    readonly titleRegeneration: boolean;
    readonly rolePresets: boolean;
    /** The environment reports thread usage and this connection may read usage. */
    readonly threadUsage: boolean;
    /** The environment takes `thread.meta.set`; absent on stock servers. */
    readonly metas?: boolean;
  };
  readonly isMeta?: boolean;
  /** Why the server would refuse a promote, or null when it would accept one. */
  readonly metaPromoteBlocker?: MetaPromoteBlocker | null;
  readonly snoozePresets: ReadonlyArray<SnoozePreset>;
  /** Present when the server snoozes agent trees; absent keeps the single-thread menu. */
  readonly snoozeTree?: ThreadSnoozeTreeMenuState;
  /** Present when the server settles agent trees; absent keeps the single-thread menu. */
  readonly settleTree?: ThreadSettleTreeState;
  /** The published services of the pod the thread runs in; absent or empty hides them. */
  readonly podServices?: ThreadPodServicesMenuState;
}

export interface ThreadPodServicesMenuState {
  readonly services: ReadonlyArray<{
    readonly name: string;
    readonly reachLabel: string | null;
  }>;
  /** This connection may open browser tabs in the environment. */
  readonly canOpen: boolean;
}

function podServiceMenuItems(
  podServices: ThreadPodServicesMenuState | undefined,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  if (podServices === undefined || podServices.services.length === 0) return [];
  return [
    {
      id: "pod-services",
      label: "Pod services",
      icon: "globe",
      children: podServices.services.flatMap(({ name, reachLabel }, index) => [
        {
          id: `pod-open:${name}` as const,
          label: `Open ${name}`,
          disabled: !podServices.canOpen,
          ...(index > 0 ? { separatorBefore: true } : {}),
        },
        {
          id: `pod-copy:${name}` as const,
          label: reachLabel === null ? `Copy ${name} URL` : `Copy ${name} URL (${reachLabel})`,
          icon: "copy",
        },
      ]),
    },
  ];
}

/** Which pod service a clicked entry opens or copies, or null for any other entry. */
export function podServiceMenuChoice(
  action: ThreadActionMenuId,
): { readonly kind: "open" | "copy"; readonly name: string } | null {
  if (action.startsWith("pod-open:")) return { kind: "open", name: action.slice(9) };
  if (action.startsWith("pod-copy:")) return { kind: "copy", name: action.slice(9) };
  return null;
}

export interface ThreadSnoozeTreeMenuState {
  readonly hasDescendants: boolean;
  /** Work anywhere in the tree makes a tree snooze wait until it ends. */
  readonly treeHasActiveWork: boolean;
  readonly threadHasActiveWork: boolean;
  /** A snooze already waits for work to end; its way out is to cancel it. */
  readonly snoozesWhenIdle: boolean;
}

/** The snooze-tree part of a thread's menu, read from the environment's shells. */
export function threadSnoozeTreeMenuState(
  thread: EnvironmentThreadShell,
  threads: ReadonlyArray<EnvironmentThreadShell>,
  now: string,
): ThreadSnoozeTreeMenuState {
  return {
    hasDescendants: agentTreeDescendants(thread, threads).length > 0,
    treeHasActiveWork: threadTreeHasActiveWork(thread, threads, { now }),
    threadHasActiveWork: threadHasActiveWork(thread, { now }),
    snoozesWhenIdle: thread.snoozeWhenIdle != null,
  };
}

/** Which snooze a clicked preset asks for, or null when the id is not a snooze preset. */
export function snoozeMenuChoice(
  action: ThreadActionMenuId,
  tree: ThreadSnoozeTreeMenuState | undefined,
): {
  readonly presetId: string;
  readonly scope: "tree" | "thread";
  readonly whenIdle: boolean;
} | null {
  const thread = action.startsWith("snooze-thread:");
  if (!thread && !action.startsWith("snooze:")) return null;
  const presetId = action.slice(action.indexOf(":") + 1);
  if (thread) return { presetId, scope: "thread", whenIdle: tree?.threadHasActiveWork === true };
  return { presetId, scope: "tree", whenIdle: tree?.treeHasActiveWork === true };
}

function snoozePresetChildren<Prefix extends "snooze" | "snooze-thread">(
  prefix: Prefix,
  presets: ReadonlyArray<SnoozePreset>,
): ReadonlyArray<ContextMenuItem<`${Prefix}:${string}`>> {
  return [
    ...presets.map((preset) => ({
      id: `${prefix}:${preset.id}` as const,
      label: `${preset.label} (${preset.whenLabel})`,
    })),
    { id: `${prefix}:custom` as const, label: "Custom…", separatorBefore: true },
  ];
}

/**
 * Snooze covers the thread's agent tree by default; "only this thread" is the
 * exception. Active work turns a snooze into one that waits for it to end.
 */
function snoozeMenuItems(
  state: ThreadActionMenuState,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  if (state.isSnoozed) return [{ id: "unsnooze", label: "Wake thread", icon: "clock" }];
  const tree = state.snoozeTree;
  if (tree === undefined)
    return [
      {
        id: "snooze",
        label: "Snooze",
        icon: "clock",
        disabled: !state.canSnoozeNow,
        children: snoozePresetChildren("snooze", state.snoozePresets),
      },
    ];
  if (tree.snoozesWhenIdle)
    return [{ id: "cancel-snooze-when-idle", label: "Cancel snooze when idle", icon: "clock" }];
  return [
    {
      id: "snooze",
      label: tree.treeHasActiveWork ? "Snooze when idle" : "Snooze",
      icon: "clock",
      children: snoozePresetChildren("snooze", state.snoozePresets),
    },
    ...(tree.hasDescendants
      ? [
          {
            id: "snooze-thread" as const,
            label: tree.threadHasActiveWork
              ? "Snooze only this thread when idle"
              : "Snooze only this thread",
            icon: "clock",
            children: snoozePresetChildren("snooze-thread", state.snoozePresets),
          },
        ]
      : []),
  ];
}

/**
 * Settling acts on the thread alone by default; the subtree variants reach
 * the agents under it, including ones a collapsed row or the settled shelf
 * hides. A subtree unsettle reopens what that subtree settle settled, which
 * only the server knows, so it is offered whenever there are agents.
 */
function settleTreeMenuItems(
  state: ThreadActionMenuState,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  const tree = state.settleTree;
  if (tree === undefined) return [];
  return [
    ...(state.isSettled && tree.hasDescendants
      ? [{ id: "unsettle-tree" as const, label: "Unsettle with subtree", icon: "circle-check" }]
      : []),
    // On a settled root this re-settles agents woken since; a settle already
    // waiting is not asked for twice.
    ...(tree.hasUnsettledDescendants && state.isSettlePending !== true
      ? [{ id: "settle-tree" as const, label: "Settle with subtree", icon: "circle-check" }]
      : []),
  ];
}

/**
 * A delegated child is a row under its parent, never a meta, so it gets
 * neither entry. A supervised or archived thread shows promote disabled with
 * the server's reason.
 */
function metaMenuItems(
  state: ThreadActionMenuState,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  if (state.supports.metas !== true) return [];
  if (state.isMeta === true) return [{ id: "demote-meta", label: "Demote meta", icon: "crown" }];
  const blocker = state.metaPromoteBlocker ?? null;
  if (blocker === "delegated-child") return [];
  return [
    blocker === null
      ? { id: "promote-meta", label: "Promote to meta", icon: "crown" }
      : {
          id: "promote-meta",
          label: `Promote to meta (${blocker === "archived" ? "unarchive first" : "supervised launch"})`,
          icon: "crown",
          disabled: true,
        },
  ];
}

/**
 * Local navigation, read markers, and copying remain available to read-only
 * clients; opening a pod service has its own browser permission.
 */
export function threadActionRequiresOperate(action: ThreadActionMenuId): boolean {
  if (action === "pod-services" || podServiceMenuChoice(action) !== null) return false;
  return ![
    "new-thread-on-branch",
    "new-ticket",
    "project-settings",
    "mark-unread",
    "usage-cost",
    "copy",
    "copy-path",
    "copy-branch",
    "copy-thread-id",
  ].includes(action);
}

export function buildThreadActionMenuItems(
  state: ThreadActionMenuState,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  const items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> = [
    ...(state.branch
      ? [
          {
            id: "new-thread-on-branch" as const,
            label: `New thread on ${state.branch}`,
            icon: "message-square-plus",
          },
        ]
      : []),
    ...(state.supports.rolePresets
      ? [{ id: "new-ticket" as const, label: "New ticket", icon: "message-square-plus" }]
      : []),
    ...(state.supports.pinning
      ? [
          state.isPinned
            ? { id: "unpin" as const, label: "Unpin thread", icon: "pin-off" }
            : { id: "pin" as const, label: "Pin thread", icon: "pin" },
        ]
      : []),
    ...(state.supports.settlement
      ? [
          state.isSettled
            ? { id: "unsettle" as const, label: "Un-settle thread", icon: "circle-check" }
            : state.isSettlePending === true
              ? { id: "unsettle" as const, label: "Cancel settle when idle", icon: "circle-check" }
              : { id: "settle" as const, label: "Settle thread", icon: "circle-check" },
        ]
      : []),
    ...(state.supports.settlement ? settleTreeMenuItems(state) : []),
    ...(state.supports.snooze ? snoozeMenuItems(state) : []),
    ...metaMenuItems(state),
    { id: "rename", label: "Rename thread", icon: "pencil", separatorBefore: true },
    ...(state.supports.titleRegeneration
      ? [
          {
            id: "regenerate-title" as const,
            label: state.isRegeneratingTitle ? "Regenerating…" : "Regenerate title",
            icon: "refresh-cw",
            disabled: state.isRegeneratingTitle,
          },
        ]
      : []),
    { id: "mark-unread", label: "Mark unread", icon: "mail-open" },
    ...(state.projectFilter
      ? [
          {
            id: "filter-by-project" as const,
            label: state.projectFilter.isActive
              ? "Show all projects"
              : `Filter by ${state.projectFilter.label}`,
            icon: "folder-tree",
          },
        ]
      : []),
    ...(state.supports.autoSettleOptOut
      ? [
          {
            id: "auto-settle" as const,
            label: "Auto-settle behavior",
            icon: "timer",
            children: [
              {
                id: "auto-settle:enabled" as const,
                label: "Enabled",
                checked: state.autoSettleEnabled,
              },
              {
                id: "auto-settle:disabled" as const,
                label: "Disabled",
                checked: !state.autoSettleEnabled,
              },
            ],
          },
        ]
      : []),
    ...(state.supports.threadUsage
      ? [{ id: "usage-cost" as const, label: "Cost of this work", icon: "coins" }]
      : []),
    ...podServiceMenuItems(state.podServices),
    {
      id: "copy",
      label: "Copy",
      icon: "copy",
      separatorBefore: true,
      children: [
        { id: "copy-path", label: "Path", icon: "folder" },
        ...(state.branch
          ? [{ id: "copy-branch" as const, label: "Branch", icon: "git-branch" }]
          : []),
        { id: "copy-thread-id", label: "Thread ID", icon: "hash" },
      ],
    },
    { id: "project-settings", label: "Project settings", icon: "settings" },
    {
      id: "archive",
      label: "Archive thread",
      icon: "archive",
      disabled: state.isRunning,
      separatorBefore: true,
    },
    {
      id: "delete",
      label: "Delete",
      destructive: true,
      icon: "trash",
    },
  ];
  return state.canOperate
    ? items
    : items.map((item) =>
        threadActionRequiresOperate(item.id)
          ? {
              ...item,
              disabled: true,
              ...(item.children
                ? { children: item.children.map((child) => ({ ...child, disabled: true })) }
                : {}),
            }
          : item,
      );
}
