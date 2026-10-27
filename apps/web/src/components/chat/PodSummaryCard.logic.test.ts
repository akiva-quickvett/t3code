import type { OrganCell, OrganGroup } from "@t3tools/client-runtime/state/subagentRuntime";
import { type OrganId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { organName, podOrganCount, podOrganLines, podSummaryText } from "./PodSummaryCard.logic";

const pod = ThreadId.make("pod");
const organA = "organ_aaaaaaaa" as OrganId;
const organB = "organ_bbbbbbbb" as OrganId;

function cellThread(
  id: string,
  options: { organ?: OrganId; parent?: string; relationship?: "subagent" | "fork" | null },
) {
  return {
    lineage: {
      rootThreadId: ThreadId.make(id),
      parentThreadId: options.parent === undefined ? pod : ThreadId.make(options.parent),
      relationshipToParent: options.relationship === undefined ? "subagent" : options.relationship,
      ...(options.organ === undefined
        ? {}
        : { organ: { id: options.organ, presetId: "implementation", goal: "g", round: 1 } }),
    },
  } as const;
}

describe("podOrganCount", () => {
  it("counts distinct organs among the pod's own organ cells", () => {
    expect(
      podOrganCount(
        [
          cellThread("a1", { organ: organA }),
          cellThread("a2", { organ: organA }),
          cellThread("b1", { organ: organB }),
          cellThread("plain", {}),
          cellThread("other-pod", { organ: organB, parent: "elsewhere" }),
          cellThread("fork", { organ: organB, relationship: "fork" }),
        ],
        pod,
      ),
    ).toBe(2);
  });
});

describe("podSummaryText", () => {
  it("names organs and needs-you counts", () => {
    expect(podSummaryText(4, 2)).toBe("4 organs · 2 need you");
    expect(podSummaryText(1, 0)).toBe("1 organ");
    expect(podSummaryText(0, 1)).toBe("no organs · 1 need you");
  });
});

describe("organName", () => {
  it("reads a preset id as words", () => {
    expect(organName("review-t3")).toBe("Review t3");
    expect(organName("implementation")).toBe("Implementation");
  });
});

function cell(dot: OrganCell["dot"], status: OrganCell["status"] = "running"): OrganCell {
  return {
    childThreadId: null,
    subagentId: `${dot}-${status}`,
    title: null,
    role: null,
    model: null,
    status,
    dot,
  };
}

function group(organId: OrganId, rounds: ReadonlyArray<ReadonlyArray<OrganCell>>): OrganGroup {
  return {
    organId,
    presetId: "review-t3",
    goal: "g",
    rounds: rounds.map((cells, index) => ({ round: index + 1, cells })),
    running: true,
  };
}

describe("podOrganLines", () => {
  it("summarises the latest round, most urgent state first", () => {
    const [line] = podOrganLines([
      group(organA, [
        [cell("failed", "failed")],
        [cell("working"), cell("needs-you"), cell("failed", "failed"), cell("working")],
      ]),
    ]);
    expect(line).toEqual({
      organId: organA,
      name: "Review t3",
      dot: "needs-you",
      detail: "r2 · 1 needs you · 1 failed · 2 working",
    });
  });

  it("tells finished, stopped and not-started idle cells apart", () => {
    const [line] = podOrganLines([
      group(organB, [
        [
          cell("idle", "completed"),
          cell("done-unread", "completed"),
          cell("idle", "cancelled"),
          cell("idle", "pending"),
        ],
      ]),
    ]);
    expect(line?.detail).toBe("r1 · 2 finished · 1 stopped · 1 idle");
    expect(line?.dot).toBe("done-unread");
  });
});
