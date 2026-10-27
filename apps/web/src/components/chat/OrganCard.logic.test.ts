import type {
  OrganCell,
  OrganGroup,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  organCardAvatars,
  organCardFromOrgan,
  organCardFromWorkflow,
  organCardTiming,
  organCellState,
  organCardSummary,
} from "./OrganCard.logic";

function cell(id: string, overrides: Partial<OrganCell> = {}): OrganCell {
  return {
    childThreadId: ThreadId.make(id),
    subagentId: `subagent-${id}`,
    title: null,
    role: { id: "reviewer", label: "Reviewer" },
    model: "claude-opus-5-5",
    status: "running",
    dot: "working",
    ...overrides,
  };
}

function organ(overrides: Partial<OrganGroup> = {}): OrganGroup {
  return {
    organId: "organ_abcdefgh12",
    presetId: "review-council",
    goal: "Review the sidebar",
    rounds: [
      { round: 1, cells: [cell("a", { status: "completed", dot: "idle" }), cell("b")] },
      { round: 2, cells: [cell("c"), cell("d", { dot: "needs-you" })] },
    ],
    running: true,
    ...overrides,
  };
}

const at = (iso: string) => DateTime.makeUnsafe(iso);

function member(id: string, overrides: Partial<RuntimeSubagent> = {}): RuntimeSubagent {
  return {
    id,
    kind: "workflow_agent",
    title: id,
    role: null,
    model: "gpt-5.4",
    effort: null,
    status: "completed",
    activationCount: 1,
    usage: null,
    progress: null,
    lastToolName: null,
    result: null,
    error: null,
    outputFile: null,
    parentAgentId: "workflow",
    agentIndex: 0,
    phaseIndex: 0,
    phaseTitle: null,
    attempt: null,
    workflowName: null,
    phases: [],
    runHandles: null,
    childThreadId: null,
    recentActivity: [],
    firstSeenAt: "2026-10-01T00:00:00.000Z",
    startedAt: "2026-10-01T00:00:00.000Z",
    completedAt: "2026-10-01T00:01:00.000Z",
    updatedAt: "2026-10-01T00:01:00.000Z",
    ...overrides,
  };
}

describe("organCellState", () => {
  it("keeps attention dots and tells quiet cells apart by their record", () => {
    expect(organCellState("needs-you", "running")).toBe("needs-you");
    expect(organCellState("limited", "waiting")).toBe("limited");
    expect(organCellState("idle", "completed")).toBe("finished");
    expect(organCellState("done-unread", "completed")).toBe("finished");
    expect(organCellState("idle", "interrupted")).toBe("stopped");
    expect(organCellState("idle", "idle")).toBe("idle");
  });
});

describe("organCardSummary", () => {
  it("counts each state, most urgent first", () => {
    expect(
      organCardSummary([
        { state: "working" },
        { state: "failed" },
        { state: "needs-you" },
        { state: "working" },
        { state: "finished" },
      ]),
    ).toBe("1 needs you · 1 failed · 2 working · 1 finished");
  });
});

describe("organCardFromOrgan", () => {
  it("gives each round a section and each cell a row", () => {
    const card = organCardFromOrgan(organ(), { label: "Review council", records: [] });
    expect(card.sections.map((section) => [section.title, section.cells.length])).toEqual([
      ["Round 1", 2],
      ["Round 2", 2],
    ]);
    expect(card.sections.map((section) => section.running)).toEqual([false, true]);
    expect(card.sections.map((section) => section.defaultOpen)).toEqual([false, true]);
    expect(card.round).toBe(2);
    expect(card.label).toBe("Review council");
    expect(card.sections[1]!.cells[1]).toMatchObject({
      threadId: "d",
      role: "Reviewer",
      model: "Claude Opus 5.5",
      state: "needs-you",
    });
  });

  it("falls back to the preset id and the record title", () => {
    const card = organCardFromOrgan(
      organ({ rounds: [{ round: 1, cells: [cell("a", { role: null, title: "scout" })] }] }),
      { records: [] },
    );
    expect(card.label).toBe("review-council");
    expect(card.sections[0]!.cells[0]!.role).toBe("scout");
  });
});

describe("organCardTiming", () => {
  it("spans the earliest start to the latest end once nothing runs", () => {
    expect(
      organCardTiming([
        {
          status: "completed",
          startedAt: at("2026-10-01T00:01:00.000Z"),
          completedAt: at("2026-10-01T00:03:00.000Z"),
        },
        {
          status: "failed",
          startedAt: at("2026-10-01T00:00:00.000Z"),
          completedAt: at("2026-10-01T00:02:00.000Z"),
        },
      ]),
    ).toEqual({
      status: "completed",
      startedAt: "2026-10-01T00:00:00.000Z",
      completedAt: "2026-10-01T00:03:00.000Z",
    });
  });

  it("keeps counting while a member runs", () => {
    expect(
      organCardTiming([
        {
          status: "completed",
          startedAt: at("2026-10-01T00:00:00.000Z"),
          completedAt: at("2026-10-01T00:03:00.000Z"),
        },
        { status: "running", startedAt: at("2026-10-01T00:01:00.000Z"), completedAt: null },
      ]),
    ).toMatchObject({ status: "running", completedAt: null });
  });
});

describe("organCardAvatars", () => {
  it("draws the model family's initial for three cells and counts the rest", () => {
    const avatars = organCardAvatars([
      { key: "a", model: "Claude Opus 5.5" },
      { key: "b", model: "Claude Fable 5.1" },
      { key: "c", model: null },
      { key: "d", model: "GPT-5.4" },
    ]);
    expect(avatars.initials.map(({ initial }) => initial)).toEqual(["O", "F", "?"]);
    expect(avatars.overflow).toBe(1);
  });
});

describe("organCardFromWorkflow", () => {
  const workflow = member("workflow", {
    kind: "workflow",
    workflowName: "Audit",
    parentAgentId: null,
    status: "running",
    completedAt: null,
  });

  it("gives each phase with members a section and keeps unphased members last", () => {
    const card = organCardFromWorkflow({
      workflow,
      phases: [
        {
          index: 0,
          title: "Scan",
          members: [member("a", { status: "running", childThreadId: "thread-a" })],
          state: "running",
          settledCount: 0,
        },
        { index: 1, title: "Fix", members: [], state: "pending", settledCount: 0 },
      ],
      unphasedMembers: [member("b", { phaseIndex: null })],
    });
    expect(card.label).toBe("Audit");
    expect(card.sections.map((section) => section.title)).toEqual(["Scan", null]);
    expect(card.sections[0]!.cells[0]).toMatchObject({
      threadId: "thread-a",
      dot: "working",
      state: "working",
    });
    expect(card.outcome).toBeNull();
  });

  it("reports the workflow's result once it and every member settled", () => {
    const card = organCardFromWorkflow({
      workflow: { ...workflow, status: "completed", result: "All clean" },
      phases: [
        {
          index: 0,
          title: "Scan",
          members: [member("a"), member("b", { status: "cancelled" })],
          state: "done",
          settledCount: 2,
        },
      ],
      unphasedMembers: [],
    });
    expect(card.outcome).toEqual({ status: "stopped", summary: "All clean" });
  });
});
