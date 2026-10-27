import { describe, expect, it } from "vite-plus/test";

import {
  buildDraftActionMenuItems,
  buildThreadActionMenuItems,
  podServiceMenuChoice,
  snoozeMenuChoice,
  type ThreadActionMenuState,
  type ThreadSnoozeTreeMenuState,
} from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
    rolePresets: false,
    threadUsage: false,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

function ids(state: ThreadActionMenuState): string[] {
  return buildThreadActionMenuItems(state).map((item) => item.id);
}

function settleItems(state: ThreadActionMenuState): string[][] {
  return buildThreadActionMenuItems(state)
    .filter((item) => item.id.includes("settle") && item.id !== "auto-settle")
    .map((item) => [item.id, item.label]);
}

function allIds(state: ThreadActionMenuState): string[] {
  const flatten = (items: ReturnType<typeof buildThreadActionMenuItems>): string[] =>
    items.flatMap((item) => [item.id, ...(item.children ? flatten(item.children) : [])]);
  return flatten(buildThreadActionMenuItems(state));
}

describe("buildThreadActionMenuItems", () => {
  it("offers New ticket only where the server has role presets, even without operate", () => {
    expect(ids(baseState)).not.toContain("new-ticket");
    const items = buildThreadActionMenuItems({
      ...baseState,
      canOperate: false,
      supports: { ...baseState.supports, rolePresets: true },
    });
    expect(items.find((item) => item.id === "new-ticket")).toMatchObject({ label: "New ticket" });
    expect(items.find((item) => item.id === "new-ticket")?.disabled).toBeFalsy();
  });

  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("preserves local actions and restores mutations after a grant", () => {
    const denied = buildThreadActionMenuItems({ ...baseState, canOperate: false, branch: "main" });
    expect(denied.filter((item) => !item.disabled).map((item) => item.id)).toEqual([
      "new-thread-on-branch",
      "mark-unread",
      "copy",
      "project-settings",
    ]);
    const allowed = buildThreadActionMenuItems({ ...baseState, canOperate: true });
    expect(allowed.every((item) => !item.disabled)).toBe(true);
  });

  it("hides lifecycle items when the environment lacks the capabilities", () => {
    expect(
      ids({
        ...baseState,
        supports: {
          settlement: false,
          autoSettleOptOut: false,
          snooze: false,
          pinning: false,
          titleRegeneration: false,
          rolePresets: false,
          threadUsage: false,
        },
      }),
    ).toEqual(["rename", "mark-unread", "copy", "project-settings", "archive", "delete"]);
  });

  it("groups project settings with utility actions before archive", () => {
    const items = buildThreadActionMenuItems(baseState);
    const copyIndex = items.findIndex((item) => item.id === "copy");
    expect(items[copyIndex + 1]).toMatchObject({
      id: "project-settings",
      label: "Project settings",
      icon: "settings",
    });
    expect(items[copyIndex + 2]?.id).toBe("archive");
  });

  it("offers project filtering only for surfaces with a scoped thread list", () => {
    expect(ids(baseState)).not.toContain("filter-by-project");
    expect(
      buildThreadActionMenuItems({
        ...baseState,
        projectFilter: { label: "Beta Project", isActive: false },
      }).find((item) => item.id === "filter-by-project"),
    ).toMatchObject({ label: "Filter by Beta Project", icon: "folder-tree" });
  });

  it("offers the way back to all projects once the list is scoped", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      projectFilter: { label: "Beta Project", isActive: true },
    });
    const filterIndex = items.findIndex((candidate) => candidate.id === "filter-by-project");
    expect(items[filterIndex]).toMatchObject({ label: "Show all projects", icon: "folder-tree" });
    expect(items[filterIndex - 1]?.id).toBe("mark-unread");
    expect(items[filterIndex + 1]?.id).toBe("auto-settle");
  });

  it("includes branch items only for threads with a branch", () => {
    const withBranch = allIds({ ...baseState, branch: "feat/menu" });
    expect(withBranch).toContain("new-thread-on-branch");
    expect(withBranch).toContain("copy-branch");
    expect(allIds(baseState)).not.toContain("new-thread-on-branch");
    expect(allIds(baseState)).not.toContain("copy-branch");
  });

  it("flips lifecycle labels with thread state", () => {
    expect(ids({ ...baseState, isPinned: true, isSettled: true, isSnoozed: true })).toEqual(
      expect.arrayContaining(["unpin", "unsettle", "unsnooze"]),
    );
    expect(ids(baseState)).toEqual(expect.arrayContaining(["pin", "settle", "snooze"]));
  });

  it("offers auto-settle as a submenu with the current option checked", () => {
    const find = (state: ThreadActionMenuState) =>
      buildThreadActionMenuItems(state).find((item) => item.id === "auto-settle");
    const on = find(baseState);
    expect(on?.label).toBe("Auto-settle behavior");
    expect(on?.children?.map((child) => [child.id, child.checked])).toEqual([
      ["auto-settle:enabled", true],
      ["auto-settle:disabled", false],
    ]);
    const off = find({ ...baseState, autoSettleEnabled: false });
    expect(off?.children?.map((child) => child.checked)).toEqual([false, true]);
    const items = buildThreadActionMenuItems(baseState);
    expect(items[items.findIndex((item) => item.id === "mark-unread") + 1]?.id).toBe("auto-settle");
    expect(
      ids({ ...baseState, supports: { ...baseState.supports, autoSettleOptOut: false } }),
    ).not.toContain("auto-settle");
  });

  it("disables snooze when the thread cannot snooze, keeping presets visible", () => {
    const snooze = buildThreadActionMenuItems({ ...baseState, canSnoozeNow: false }).find(
      (item) => item.id === "snooze",
    );
    expect(snooze?.disabled).toBe(true);
    expect(snooze?.children?.map((child) => child.id)).toEqual(["snooze:hour", "snooze:custom"]);
  });

  describe("snooze trees", () => {
    const idleTree: ThreadSnoozeTreeMenuState = {
      hasDescendants: true,
      treeHasActiveWork: false,
      threadHasActiveWork: false,
      snoozesWhenIdle: false,
    };
    const snoozeItems = (snoozeTree: ThreadSnoozeTreeMenuState) =>
      buildThreadActionMenuItems({ ...baseState, snoozeTree }).filter(
        (item) => item.id.startsWith("snooze") || item.id === "cancel-snooze-when-idle",
      );

    it("snoozes the tree by default and offers only this thread when it has descendants", () => {
      expect(snoozeItems(idleTree).map((item) => [item.id, item.label])).toEqual([
        ["snooze", "Snooze"],
        ["snooze-thread", "Snooze only this thread"],
      ]);
      expect(snoozeItems(idleTree)[1]?.children?.map((child) => child.id)).toEqual([
        "snooze-thread:hour",
        "snooze-thread:custom",
      ]);
      expect(snoozeItems({ ...idleTree, hasDescendants: false }).map((item) => item.id)).toEqual([
        "snooze",
      ]);
    });

    it("waits for active work instead of refusing", () => {
      const items = snoozeItems({ ...idleTree, treeHasActiveWork: true });
      expect(items.map((item) => [item.label, item.disabled ?? false])).toEqual([
        ["Snooze when idle", false],
        ["Snooze only this thread", false],
      ]);
      expect(
        buildThreadActionMenuItems({
          ...baseState,
          canSnoozeNow: false,
          snoozeTree: { ...idleTree, treeHasActiveWork: true, threadHasActiveWork: true },
        }).find((item) => item.id === "snooze")?.disabled,
      ).toBeFalsy();
    });

    it("offers the way out of a snooze that waits, and Wake for a snoozed thread", () => {
      expect(snoozeItems({ ...idleTree, snoozesWhenIdle: true }).map((item) => item.label)).toEqual(
        ["Cancel snooze when idle"],
      );
      expect(
        ids({ ...baseState, isSnoozed: true, snoozeTree: idleTree }).filter((id) =>
          id.includes("snooze"),
        ),
      ).toEqual(["unsnooze"]);
    });

    it("maps a clicked preset to its scope and whether it waits", () => {
      const busy = { ...idleTree, treeHasActiveWork: true };
      expect(snoozeMenuChoice("snooze:hour", busy)).toEqual({
        presetId: "hour",
        scope: "tree",
        whenIdle: true,
      });
      expect(snoozeMenuChoice("snooze-thread:custom", busy)).toEqual({
        presetId: "custom",
        scope: "thread",
        whenIdle: false,
      });
      expect(snoozeMenuChoice("snooze:hour", undefined)).toMatchObject({ whenIdle: false });
      expect(snoozeMenuChoice("unsnooze", busy)).toBeNull();
    });
  });

  it("offers subtree settle and unsettle beside settle only where they can change something", () => {
    const tree = { hasUnsettledDescendants: false, hasDescendants: false };
    expect(ids({ ...baseState, settleTree: tree })).toEqual(ids(baseState));
    expect(ids({ ...baseState, isSettled: true, settleTree: tree })).toEqual(
      ids({ ...baseState, isSettled: true }),
    );
    const both = { hasUnsettledDescendants: true, hasDescendants: true };
    expect(settleItems({ ...baseState, settleTree: both })).toEqual([
      ["settle", "Settle thread"],
      ["settle-tree", "Settle with subtree"],
    ]);
    // Agents woken since the root settled can be settled again with it.
    expect(settleItems({ ...baseState, isSettled: true, settleTree: both })).toEqual([
      ["unsettle", "Un-settle thread"],
      ["unsettle-tree", "Unsettle with subtree"],
      ["settle-tree", "Settle with subtree"],
    ]);
    // Every agent already settled: only the server knows which the root's settle closed.
    expect(
      settleItems({
        ...baseState,
        isSettled: true,
        settleTree: { hasUnsettledDescendants: false, hasDescendants: true },
      }),
    ).toEqual([
      ["unsettle", "Un-settle thread"],
      ["unsettle-tree", "Unsettle with subtree"],
    ]);
    expect(
      ids({
        ...baseState,
        supports: { ...baseState.supports, settlement: false },
        settleTree: both,
      }),
    ).not.toContain("settle-tree");
    const readOnly = buildThreadActionMenuItems({
      ...baseState,
      canOperate: false,
      settleTree: both,
    });
    expect(readOnly.find((item) => item.id === "settle-tree")?.disabled).toBe(true);
  });

  it("offers only the way out while a subtree settle waits for work to end", () => {
    expect(
      settleItems({
        ...baseState,
        isSettlePending: true,
        settleTree: { hasUnsettledDescendants: true, hasDescendants: true },
      }),
    ).toEqual([["unsettle", "Cancel settle when idle"]]);
    expect(settleItems({ ...baseState, isSettlePending: true })).toEqual([
      ["unsettle", "Cancel settle when idle"],
    ]);
    // A settled root waiting on a re-settle keeps both ways back.
    expect(
      settleItems({
        ...baseState,
        isSettled: true,
        isSettlePending: true,
        settleTree: { hasUnsettledDescendants: true, hasDescendants: true },
      }),
    ).toEqual([
      ["unsettle", "Un-settle thread"],
      ["unsettle-tree", "Unsettle with subtree"],
    ]);
  });

  it("disables title regeneration while one is in flight", () => {
    const item = buildThreadActionMenuItems({ ...baseState, isRegeneratingTitle: true }).find(
      (candidate) => candidate.id === "regenerate-title",
    );
    expect(item).toMatchObject({ label: "Regenerating…", disabled: true });
  });

  it("marks delete as destructive and keeps it last", () => {
    const items = buildThreadActionMenuItems({ ...baseState, branch: "main" });
    expect(items.at(-1)).toMatchObject({ id: "delete", destructive: true });
  });
  it("offers archive as a non-destructive action right before delete", () => {
    const items = buildThreadActionMenuItems(baseState);
    const archiveItem = items.at(-2);
    expect(archiveItem?.id).toBe("archive");
    expect(archiveItem?.icon).toBe("archive");
    expect(archiveItem?.separatorBefore).toBe(true);
    expect(archiveItem?.destructive).toBeFalsy();
    expect(items.at(-1)?.id).toBe("delete");
  });

  it("keeps archive available even when the environment lacks every other capability", () => {
    expect(
      ids({
        ...baseState,
        supports: {
          settlement: false,
          autoSettleOptOut: false,
          snooze: false,
          pinning: false,
          titleRegeneration: false,
          rolePresets: false,
          threadUsage: false,
        },
      }),
    ).toContain("archive");
  });

  it("disables archive while the thread is running", () => {
    const archiveItem = buildThreadActionMenuItems({ ...baseState, isRunning: true }).find(
      (item) => item.id === "archive",
    );
    expect(archiveItem?.disabled).toBe(true);
  });
});

describe("thread menu pod services", () => {
  const podServices = (
    services: Array<{ name: string; reachLabel: string | null }>,
    canOpen = true,
  ): ThreadActionMenuState => ({ ...baseState, podServices: { services, canOpen } });
  const podItem = (state: ThreadActionMenuState) =>
    buildThreadActionMenuItems(state).find((item) => item.id === "pod-services");

  it("offers Open and Copy for each published service of the thread's pod", () => {
    const item = podItem(
      podServices([
        { name: "web", reachLabel: null },
        { name: "api", reachLabel: "host only" },
      ]),
    );
    expect(item?.children?.map((child) => [child.id, child.label])).toEqual([
      ["pod-open:web", "Open web"],
      ["pod-copy:web", "Copy web URL"],
      ["pod-open:api", "Open api"],
      ["pod-copy:api", "Copy api URL (host only)"],
    ]);
    expect(podServiceMenuChoice("pod-copy:api")).toEqual({ kind: "copy", name: "api" });
    expect(podServiceMenuChoice("pod-open:web")).toEqual({ kind: "open", name: "web" });
    expect(podServiceMenuChoice("copy-path")).toBeNull();
  });

  it("hides the section for a host thread and for a pod with nothing published", () => {
    expect(podItem(baseState)).toBeUndefined();
    expect(podItem(podServices([]))).toBeUndefined();
  });

  it("keeps Copy for read-only clients and disables Open without browser permission", () => {
    const item = podItem({
      ...podServices([{ name: "web", reachLabel: null }], false),
      canOperate: false,
    });
    expect(item?.disabled).toBeUndefined();
    expect(item?.children?.map((child) => [child.id, child.disabled])).toEqual([
      ["pod-open:web", true],
      ["pod-copy:web", undefined],
    ]);
  });
});

describe("meta menu entries", () => {
  const metaState = (patch: Partial<ThreadActionMenuState>): ThreadActionMenuState => ({
    ...baseState,
    supports: { ...baseState.supports, metas: true },
    isMeta: false,
    metaPromoteBlocker: null,
    ...patch,
  });
  const metaItems = (state: ThreadActionMenuState) =>
    buildThreadActionMenuItems(state)
      .filter((item) => item.id === "promote-meta" || item.id === "demote-meta")
      .map((item) => [item.id, item.label, item.disabled === true]);

  it("hides both entries on a server without metas", () => {
    expect(metaItems({ ...baseState, isMeta: true })).toEqual([]);
    expect(metaItems(baseState)).toEqual([]);
  });

  it("offers promote on a top-level thread and demote on a meta", () => {
    expect(metaItems(metaState({}))).toEqual([["promote-meta", "Promote to meta", false]]);
    expect(metaItems(metaState({ isMeta: true }))).toEqual([["demote-meta", "Demote meta", false]]);
  });

  it("hides both entries on a delegated child", () => {
    expect(metaItems(metaState({ metaPromoteBlocker: "delegated-child" }))).toEqual([]);
  });

  it.each([
    ["supervised", "Promote to meta (supervised launch)"],
    ["archived", "Promote to meta (unarchive first)"],
  ] as const)("disables promote with the reason when %s", (blocker, label) => {
    expect(metaItems(metaState({ metaPromoteBlocker: blocker }))).toEqual([
      ["promote-meta", label, true],
    ]);
  });

  it("disables both directions without operate permission", () => {
    expect(metaItems(metaState({ canOperate: false }))).toEqual([
      ["promote-meta", "Promote to meta", true],
    ]);
    expect(metaItems(metaState({ canOperate: false, isMeta: true }))).toEqual([
      ["demote-meta", "Demote meta", true],
    ]);
  });
});

describe("buildDraftActionMenuItems", () => {
  it("offers only the copy values the draft has", () => {
    const items = buildDraftActionMenuItems({ hasPath: false, hasBranch: true, hasProject: true });
    expect(items[0]).toMatchObject({ id: "copy", disabled: false });
    expect(items[0]?.children?.map((item) => item.id)).toEqual(["copy-branch"]);

    const noCopy = buildDraftActionMenuItems({
      hasPath: false,
      hasBranch: false,
      hasProject: true,
    });
    expect(noCopy[0]).toMatchObject({ id: "copy", disabled: true, children: [] });
  });

  it("drops project settings without a project and keeps discard last", () => {
    const items = buildDraftActionMenuItems({ hasPath: true, hasBranch: false, hasProject: false });
    expect(items.map((item) => item.id)).toEqual(["copy", "discard"]);
    expect(items.at(-1)).toMatchObject({ label: "Discard draft", destructive: true });
  });
});
