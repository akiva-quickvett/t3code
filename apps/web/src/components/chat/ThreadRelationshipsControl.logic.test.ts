import type { ThreadRelationshipWalkRow } from "@t3tools/client-runtime/state/thread-relationships";
import { OrganId, OrganPresetId, type OrganLabel, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadLineageGroups } from "./ThreadRelationshipsControl.logic";

const current = ThreadId.make("current");

function child(id: string, status: string): ThreadRelationshipWalkRow {
  const threadId = ThreadId.make(id);
  return {
    threadId,
    fromThreadId: current,
    depth: 1,
    edge: { sourceThreadId: current, targetThreadId: threadId, kind: "subagent", status },
  };
}

function organ(id: string, round: number): OrganLabel {
  return {
    id: OrganId.make(id),
    presetId: OrganPresetId.make("scout-pod"),
    goal: "Map the code",
    round,
  };
}

const summarize = (result: ReturnType<typeof threadLineageGroups>) =>
  result.groups.map((group) => ({
    id: group.id,
    label: group.label,
    threads: group.rows.map((row) => row.threadId),
    expanded: group.expanded,
  }));

describe("threadLineageGroups", () => {
  const parent: ThreadRelationshipWalkRow = {
    threadId: ThreadId.make("parent"),
    fromThreadId: current,
    depth: 1,
    edge: {
      sourceThreadId: ThreadId.make("parent"),
      targetThreadId: current,
      kind: "subagent",
      status: "running",
    },
  };

  it("keeps the related, active and previous split for threads outside organs", () => {
    const result = threadLineageGroups(
      [parent, child("a", "running"), child("b", "completed")],
      current,
      () => undefined,
    );

    expect(summarize(result)).toEqual([
      { id: "related", label: null, threads: ["parent"], expanded: true },
      { id: "active", label: null, threads: ["a"], expanded: true },
      { id: "previous", label: "Previous agents", threads: ["b"], expanded: false },
    ]);
    expect(result.active.map((row) => row.threadId)).toEqual(["a"]);
  });

  it("gathers an organ's cells under one heading with its latest round", () => {
    const organs: Record<string, OrganLabel> = {
      s1: organ("organ_aaaaaaaa", 1),
      s2: organ("organ_aaaaaaaa", 2),
      s3: organ("organ_bbbbbbbb", 1),
    };
    const result = threadLineageGroups(
      [
        child("s1", "completed"),
        child("loose", "running"),
        child("s2", "running"),
        child("s3", "completed"),
        child("old", "failed"),
      ],
      current,
      (threadId) => organs[threadId],
    );

    expect(summarize(result)).toEqual([
      { id: "related", label: null, threads: [], expanded: true },
      { id: "active", label: null, threads: ["loose"], expanded: true },
      {
        id: "organ:organ_aaaaaaaa",
        label: "Scout pod · r2",
        threads: ["s1", "s2"],
        expanded: true,
      },
      { id: "organ:organ_bbbbbbbb", label: "Scout pod · r1", threads: ["s3"], expanded: false },
      { id: "previous", label: "Previous agents", threads: ["old"], expanded: false },
    ]);
    // Organ cells still count toward the panel's running total.
    expect(result.active.map((row) => row.threadId)).toEqual(["loose", "s2"]);
  });
});
