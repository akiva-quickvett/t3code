import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  classifyOrchestration,
  foldOrchestrationDots,
  orchestrationParentThreadId,
  resolveOrchestrationDot,
  type OrchestrationClassification,
  type OrchestrationDotInput,
  type OrchestrationThreadInput,
  type OrchestrationTree,
} from "./orchestrationTree.ts";

const idleStatus: OrchestrationDotInput = {
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  runtimeStatus: null,
  latestRun: null,
  lastErrorClass: null,
  wokeAt: null,
  backgroundWorkHoldsCompletion: false,
  lastVisitedAt: "2026-01-01T00:00:00.000Z",
  settled: false,
  snoozed: false,
  limitParked: false,
  environmentConnected: true,
  shellStatus: "live",
};

let clock = 0;
function thread(
  key: string,
  options: Partial<Omit<OrchestrationThreadInput, "status">> & {
    readonly status?: Partial<OrchestrationDotInput>;
  } = {},
): OrchestrationThreadInput {
  clock += 1;
  return {
    key,
    parentKey: null,
    projectId: "project-a",
    branch: "main",
    rolePresetId: null,
    metaAt: null,
    archived: false,
    createdAt: `2026-01-01T00:00:00.${String(clock).padStart(3, "0")}Z`,
    ...options,
    status: { ...idleStatus, ...options.status },
  };
}

const meta = (key: string) => thread(key, { metaAt: "2026-01-01T00:00:00.000Z" });
const slice = (key: string, parentKey: string | null, options = {}) =>
  thread(key, { rolePresetId: "slice", parentKey, ...options });
const pod = (key: string, parentKey: string | null, options = {}) =>
  thread(key, { rolePresetId: "broker", parentKey, ...options });

const needsYou = { hasPendingApprovals: true };

function rowKeys(tree: OrchestrationTree): string[] {
  return tree.projects.flatMap((project) =>
    project.branches.flatMap((branch) =>
      branch.rows.flatMap((row) => [row.key, ...row.pods.map((pod) => pod.key)]),
    ),
  );
}

function placedKeys(result: OrchestrationClassification): string[] {
  return [
    ...result.metas,
    ...result.metas.flatMap((key) => rowKeys(result.trees[key]!)),
    ...rowKeys(result.noMeta),
  ];
}

describe("orchestrationParentThreadId", () => {
  it("follows the supervisor, else a subagent's parent, never a fork's", () => {
    const parent = ThreadId.make("parent");
    const supervisor = ThreadId.make("supervisor");
    expect(
      orchestrationParentThreadId({
        relationshipToParent: null,
        parentThreadId: null,
        supervisorThreadId: supervisor,
      }),
    ).toBe(supervisor);
    expect(
      orchestrationParentThreadId({ relationshipToParent: "subagent", parentThreadId: parent }),
    ).toBe(parent);
    expect(
      orchestrationParentThreadId({ relationshipToParent: "fork", parentThreadId: parent }),
    ).toBeNull();
  });
});

describe("classifyOrchestration", () => {
  it("places a supervised slice and its pod under the meta, by the slice's project and branch", () => {
    const result = classifyOrchestration([
      meta("meta"),
      slice("slice", "meta", { projectId: "project-b", branch: "feature" }),
      pod("pod", "slice", { projectId: "project-b", branch: "pod-branch" }),
    ]);

    expect(result.metas).toEqual(["meta"]);
    expect(result.trees.meta!.projects).toEqual([
      {
        projectId: "project-b",
        branches: [
          {
            branch: "feature",
            rows: [
              expect.objectContaining({
                key: "slice",
                kind: "slice",
                pods: [expect.objectContaining({ key: "pod", kind: "pod" })],
              }),
            ],
          },
        ],
      },
    ]);
    expect(rowKeys(result.noMeta)).toEqual([]);
  });

  it("shows a cross-repo pod once, under its slice's project with a repo tag", () => {
    const result = classifyOrchestration([
      meta("meta"),
      slice("slice", "meta", { projectId: "project-a" }),
      pod("pod", "slice", { projectId: "project-b" }),
    ]);

    const tree = result.trees.meta!;
    expect(tree.projects.map((project) => project.projectId)).toEqual(["project-a"]);
    expect(tree.projects[0]!.branches[0]!.rows[0]!.pods).toEqual([
      expect.objectContaining({ key: "pod", repoTag: "project-b" }),
    ]);
    expect(placedKeys(result).filter((key) => key === "pod")).toHaveLength(1);
  });

  it("puts ad-hoc roots, slice-less pods and meta-less slices in No meta only", () => {
    const result = classifyOrchestration([
      meta("meta"),
      thread("ad-hoc"),
      pod("pod-under-meta", "meta"),
      pod("pod-alone", null),
      slice("slice-root", null),
      slice("slice-under-ad-hoc", "ad-hoc"),
    ]);

    expect(rowKeys(result.trees.meta!)).toEqual([]);
    expect(rowKeys(result.noMeta).sort()).toEqual(
      ["ad-hoc", "pod-alone", "pod-under-meta", "slice-root", "slice-under-ad-hoc"].sort(),
    );
  });

  it("reaches the meta through nested supervision", () => {
    const result = classifyOrchestration([
      meta("meta"),
      slice("outer", "meta"),
      slice("inner", "outer"),
      pod("pod", "inner", { status: needsYou }),
    ]);

    const rows = result.trees.meta!.projects[0]!.branches[0]!.rows;
    expect(rows.map((row) => row.key)).toEqual(["outer", "inner"]);
    expect(rows[1]!.pods.map((row) => row.key)).toEqual(["pod"]);
    expect(rows[0]!.rollup).toEqual({ dot: "idle", needsYouCount: 0 });
    expect(rowKeys(result.noMeta)).toEqual([]);
  });

  it("shows a meta inside another meta's lineage only as its own tab", () => {
    const result = classifyOrchestration([
      meta("outer"),
      slice("outer-slice", "outer"),
      thread("inner", { metaAt: "2026-02-01T00:00:00.000Z", parentKey: "outer-slice" }),
      slice("inner-slice", "inner", { status: needsYou }),
    ]);

    expect(result.metas).toEqual(["outer", "inner"]);
    expect(rowKeys(result.trees.outer!)).toEqual(["outer-slice"]);
    expect(rowKeys(result.trees.inner!)).toEqual(["inner-slice"]);
    expect(result.trees.outer!.rollup).toEqual({ dot: "idle", needsYouCount: 0 });
  });

  it("places every thread once when lineage has a cycle or a missing parent", () => {
    const result = classifyOrchestration([
      slice("a", "c"),
      slice("b", "a"),
      slice("c", "b"),
      pod("hanging", "b"),
      slice("orphan", "deleted"),
    ]);

    const placed = placedKeys(result);
    expect(placed.sort()).toEqual(["a", "b", "c", "hanging", "orphan"]);
    expect(rowKeys(result.noMeta)).toContain("orphan");
  });

  it("rolls a meta's non-row child into the tab only", () => {
    const result = classifyOrchestration([
      meta("meta"),
      thread("scout", { parentKey: "meta", status: needsYou }),
    ]);

    expect(rowKeys(result.trees.meta!)).toEqual([]);
    expect(rowKeys(result.noMeta)).toEqual([]);
    expect(result.trees.meta!.rollup.needsYouCount).toBe(1);
    expect(result.trees.meta!.unread).toBe(1);
  });

  it("maps each cell to the tree that holds it", () => {
    const result = classifyOrchestration([
      meta("meta"),
      pod("slice-less-pod", "meta"),
      thread("stray-cell", { parentKey: "slice-less-pod" }),
      slice("slice", "meta"),
      pod("pod", "slice"),
      thread("cell", { parentKey: "pod" }),
    ]);

    expect(result.treeKeyByThreadKey["stray-cell"]).toBeNull();
    expect(result.treeKeyByThreadKey.cell).toBe("meta");
  });

  it("leaves archived threads out", () => {
    const result = classifyOrchestration([
      meta("meta"),
      slice("archived", "meta", { archived: true }),
    ]);
    expect(rowKeys(result.trees.meta!)).toEqual([]);
  });

  it("rolls the slice up to needs-you with a count across its pods", () => {
    const result = classifyOrchestration([
      meta("meta"),
      slice("slice", "meta", { status: { runtimeStatus: "running" } }),
      pod("pod-1", "slice", { status: needsYou }),
      pod("pod-2", "slice", { status: { hasPendingUserInput: true } }),
      thread("cell", { parentKey: "pod-1", status: { runtimeStatus: "failed" } }),
    ]);

    const tree = result.trees.meta!;
    const sliceRow = tree.projects[0]!.branches[0]!.rows[0]!;
    expect(sliceRow.rollup).toEqual({ dot: "needs-you", needsYouCount: 2 });
    expect(sliceRow.pods[0]!.rollup).toEqual({ dot: "needs-you", needsYouCount: 1 });
    expect(tree.rollup).toEqual({ dot: "needs-you", needsYouCount: 2 });
    expect(tree.unread).toBe(2);
  });

  it("counts a never-visited finished slice as unread, but not a never-visited cell", () => {
    const finished = {
      lastVisitedAt: null,
      latestRun: { status: "completed" as const, completedAt: "2026-06-01T00:00:00.000Z" },
    };
    const result = classifyOrchestration([
      meta("meta"),
      slice("slice", "meta", { status: finished }),
      pod("pod", "slice"),
      thread("cell", { parentKey: "pod", status: finished }),
    ]);

    const sliceRow = result.trees.meta!.projects[0]!.branches[0]!.rows[0]!;
    expect(result.trees.meta!.unread).toBe(1);
    expect(sliceRow.rollup.dot).toBe("done-unread");
    expect(sliceRow.pods[0]!.rollup.dot).toBe("idle");
  });
});

describe("resolveOrchestrationDot", () => {
  const dotOf = (status: Partial<OrchestrationDotInput>) =>
    resolveOrchestrationDot({ ...idleStatus, ...status }, null).dot;
  const unseenCompletion = {
    latestRun: { status: "completed" as const, completedAt: "2026-02-01T00:00:00.000Z" },
  };

  it.each([
    ["needs-you over failed", { ...needsYou, runtimeStatus: "failed" as const }, "needs-you"],
    [
      "failed over woke",
      { runtimeStatus: "failed" as const, wokeAt: "2026-02-01T00:00:00.000Z" },
      "failed",
    ],
    [
      "limited over woke",
      {
        runtimeStatus: "failed" as const,
        lastErrorClass: "usage_limit" as const,
        wokeAt: "2026-02-01T00:00:00.000Z",
      },
      "limited",
    ],
    [
      "woke over working",
      { wokeAt: "2026-02-01T00:00:00.000Z", runtimeStatus: "running" as const },
      "woke",
    ],
    [
      "working over waiting",
      { runtimeStatus: "running" as const, backgroundWorkHoldsCompletion: true },
      "working",
    ],
    [
      "waiting over done-unread",
      { backgroundWorkHoldsCompletion: true, ...unseenCompletion },
      "waiting",
    ],
    ["done-unread over idle", unseenCompletion, "done-unread"],
    ["idle", {}, "idle"],
  ] as const)("%s", (_name, status, expected) => {
    expect(dotOf(status)).toBe(expected);
  });

  it("shows a usage-limit failure as limited, never failed", () => {
    expect(
      dotOf({
        lastVisitedAt: null,
        lastErrorClass: "usage_limit",
        latestRun: { status: "failed", completedAt: "2026-02-01T00:00:00.000Z" },
      }),
    ).toBe("limited");
  });

  it("counts an unseen failed run as failed even without a failed runtime", () => {
    expect(
      dotOf({
        lastVisitedAt: null,
        lastErrorClass: "provider_error",
        latestRun: { status: "failed", completedAt: "2026-02-01T00:00:00.000Z" },
      }),
    ).toBe("failed");
  });

  it("maps runtime waiting to working and runtime idle to waiting", () => {
    expect(dotOf({ runtimeStatus: "waiting" })).toBe("working");
    expect(dotOf({ runtimeStatus: "idle" })).toBe("waiting");
  });

  it("drops woke once visited after the wake, or once settled", () => {
    expect(
      dotOf({ wokeAt: "2026-02-01T00:00:00.000Z", lastVisitedAt: "2026-03-01T00:00:00.000Z" }),
    ).toBe("idle");
    expect(dotOf({ wokeAt: "2026-02-01T00:00:00.000Z", settled: true })).toBe("idle");
  });

  it("keeps the dot of a synchronizing or disconnected shell, stale and dimmed", () => {
    const status = { ...idleStatus, runtimeStatus: "running" as const };
    expect(resolveOrchestrationDot({ ...status, shellStatus: "synchronizing" }, null)).toEqual({
      dot: "working",
      dim: true,
      stale: true,
    });
    expect(resolveOrchestrationDot({ ...status, environmentConnected: false }, null)).toEqual({
      dot: "working",
      dim: true,
      stale: true,
    });
  });

  it("dims snoozed, settled and limit-parked threads without marking them stale", () => {
    for (const flag of ["snoozed", "settled", "limitParked"] as const) {
      expect(resolveOrchestrationDot({ ...idleStatus, [flag]: true }, null)).toEqual({
        dot: "idle",
        dim: true,
        stale: false,
      });
    }
  });

  it("counts a never-visited completion only for orchestration rows created before it", () => {
    const status = {
      ...idleStatus,
      lastVisitedAt: null,
      latestRun: { status: "completed" as const, completedAt: "2026-02-01T00:00:00.000Z" },
    };
    expect(resolveOrchestrationDot(status, "2026-01-15T00:00:00.000Z").dot).toBe("done-unread");
    expect(resolveOrchestrationDot(status, "2026-03-01T00:00:00.000Z").dot).toBe("idle");
    expect(resolveOrchestrationDot(status, null).dot).toBe("idle");
  });
});

describe("foldOrchestrationDots", () => {
  it("returns the highest dot and the needs-you count", () => {
    expect(foldOrchestrationDots(["idle", "needs-you", "failed", "needs-you"])).toEqual({
      dot: "needs-you",
      needsYouCount: 2,
    });
    expect(foldOrchestrationDots([])).toEqual({ dot: "idle", needsYouCount: 0 });
  });
});
