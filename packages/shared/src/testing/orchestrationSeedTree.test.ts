import {
  OrchestrationDot,
  OrchestrationProjectShell,
  OrchestrationV2AppThread,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadShell,
  OrchestrationV2ThreadShellJson,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  classifyOrchestration,
  orchestrationParentThreadId,
  resolveOrchestrationDot,
  type OrchestrationDotInput,
  type OrchestrationRow,
} from "../orchestrationTree.ts";
import { backgroundWorkHoldsCompletion } from "../orchestrationV2PendingBackgroundWork.ts";
import {
  SEED_AD_HOC_CHAT_ID,
  SEED_CELL_COUNT,
  SEED_CROSS_REPO_POD_ID,
  SEED_EPOCH,
  SEED_META_COUNT,
  SEED_POD_COUNT,
  SEED_SLICELESS_POD_ID,
  SEED_SLICE_COUNT,
  SEED_THREAD_COUNT,
  orchestrationSeedTree,
  pad,
  seedExpectedDots,
  seedMetaId,
  staleShellIds,
} from "./orchestrationSeedTree.ts";

const seed = orchestrationSeedTree;
const subagents = Object.values(seed.subagentsByThreadId).flat();
const decodeProject = Schema.decodeSync(OrchestrationProjectShell);
const decodeAppThread = Schema.decodeSync(OrchestrationV2AppThread);
const decodeShell = Schema.decodeSync(OrchestrationV2ThreadShell);
const decodeSubagent = Schema.decodeSync(OrchestrationV2Subagent);
const encodeShellJson = Schema.encodeSync(OrchestrationV2ThreadShellJson);
const decodeShellJson = Schema.decodeUnknownSync(OrchestrationV2ThreadShellJson);

const idleInput: OrchestrationDotInput = {
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  runtimeStatus: null,
  latestRun: null,
  lastErrorClass: null,
  wokeAt: null,
  backgroundWorkHoldsCompletion: false,
  lastVisitedAt: null,
  settled: false,
  snoozed: false,
  limitParked: false,
  environmentConnected: true,
  shellStatus: "live",
};

describe("orchestrationSeedTree", () => {
  it("decodes with the contract schemas, in memory and over the JSON wire", () => {
    for (const project of seed.projects) {
      expect(() => decodeProject(project)).not.toThrow();
    }
    for (const thread of seed.appThreads) {
      expect(() => decodeAppThread(thread)).not.toThrow();
    }
    for (const shell of seed.threads) {
      expect(() => decodeShell(shell)).not.toThrow();
      const wire = JSON.parse(JSON.stringify(encodeShellJson(shell)));
      expect(decodeShellJson(wire)).toEqual(shell);
    }
    for (const subagent of subagents) {
      expect(() => decodeSubagent(subagent)).not.toThrow();
    }
  });

  it("has the advertised counts and ties every child to a parent record", () => {
    const roles = seed.threads.map((thread) => thread.rolePreset?.id);
    expect(roles.filter((role) => role === "meta")).toHaveLength(SEED_META_COUNT);
    expect(roles.filter((role) => role === "slice")).toHaveLength(SEED_SLICE_COUNT);
    expect(roles.filter((role) => role === "broker")).toHaveLength(SEED_POD_COUNT);
    expect([SEED_META_COUNT, SEED_SLICE_COUNT, SEED_POD_COUNT]).toEqual([2, 6, 15]);
    expect(seed.threads).toHaveLength(SEED_THREAD_COUNT);

    const cells = seed.appThreads.filter((thread) => thread.lineage.organ !== undefined);
    expect(cells).toHaveLength(SEED_CELL_COUNT);
    const cellsPerOrgan = new Map<string, number>();
    for (const cell of cells) {
      const organId = cell.lineage.organ!.id;
      cellsPerOrgan.set(organId, (cellsPerOrgan.get(organId) ?? 0) + 1);
      const record = seed.subagentsByThreadId[cell.lineage.parentThreadId!]?.find(
        (task) => task.childThreadId === cell.id,
      );
      expect(record?.organ).toEqual(cell.lineage.organ);
    }
    expect(new Set(cellsPerOrgan.values())).toEqual(new Set([1, 2, 3, 4, 5]));

    for (const thread of seed.appThreads) {
      const parent = orchestrationParentThreadId(thread.lineage);
      if (parent === null) continue;
      expect(
        seed.subagentsByThreadId[parent]?.some((task) => task.childThreadId === thread.id),
      ).toBe(true);
    }
    expect(DateTime.formatIso(seed.appThreads[0]!.createdAt)).toBe(SEED_EPOCH);
  });

  it("resolves every dot, dim and stale case the fixture intends", () => {
    const now = Date.parse("2027-01-01T00:00:00.000Z");
    const resolved = seed.threads.map((shell) => {
      const json = encodeShellJson(shell);
      const snoozedUntil = json.snoozedUntil ?? null;
      const input: OrchestrationDotInput = {
        hasPendingApprovals:
          json.pendingRuntimeRequest !== null && json.pendingRuntimeRequest.kind !== "user_input",
        hasPendingUserInput: json.pendingRuntimeRequest?.kind === "user_input",
        hasActionableProposedPlan: json.hasActionableProposedPlan,
        runtimeStatus:
          json.latestRunId === null && json.activeProviderThreadId === null
            ? null
            : (json.activityRunStatus ?? json.status),
        latestRun:
          json.latestRunId === null || json.status === "idle"
            ? null
            : { status: json.status, completedAt: json.latestRunCompletedAt ?? null },
        lastErrorClass: json.lastErrorClass ?? null,
        wokeAt: snoozedUntil !== null && Date.parse(snoozedUntil) <= now ? snoozedUntil : null,
        backgroundWorkHoldsCompletion: backgroundWorkHoldsCompletion(
          shell.pendingBackgroundTasks ?? [],
        ),
        lastVisitedAt: json.lastVisitedAt ?? null,
        settled: json.settledOverride === "settled",
        snoozed: snoozedUntil !== null && Date.parse(snoozedUntil) > now,
        limitParked: json.limitRecovery?.snooze === true && snoozedUntil !== null,
        environmentConnected: true,
        shellStatus: staleShellIds.cached.some((id) => id === shell.id)
          ? "cached"
          : staleShellIds.synchronizing.some((id) => id === shell.id)
            ? "synchronizing"
            : "live",
      };
      const role = shell.rolePreset?.id;
      const isRow =
        role === "slice" ||
        role === "broker" ||
        (orchestrationParentThreadId(shell.lineage) === null && json.metaAt == null);
      const result = resolveOrchestrationDot(input, isRow ? json.createdAt : null);
      expect([shell.id, result]).toEqual([shell.id, seedExpectedDots[shell.id]]);
      return result;
    });

    expect(new Set(resolved.map((result) => result.dot))).toEqual(
      new Set(OrchestrationDot.literals),
    );
    expect(resolved.some((result) => result.stale)).toBe(true);
    expect(resolved.filter((result) => result.dim && !result.stale)).toHaveLength(4);
  });

  it("classifies into two metas, the slice-less pod and ad-hoc chat under No meta, and one repo tag", () => {
    const result = classifyOrchestration(
      seed.threads.map((shell) => ({
        key: shell.id,
        parentKey: orchestrationParentThreadId(shell.lineage),
        projectId: shell.projectId,
        branch: shell.branch,
        rolePresetId: shell.rolePreset?.id ?? null,
        metaAt: shell.metaAt ? DateTime.formatIso(shell.metaAt) : null,
        archived: false,
        createdAt: DateTime.formatIso(shell.createdAt),
        status: idleInput,
      })),
    );
    expect(result.metas).toEqual([seedMetaId(1), seedMetaId(2)]);
    const rows = (tree: (typeof result)["noMeta"]): OrchestrationRow[] =>
      tree.projects.flatMap((project) =>
        project.branches.flatMap((branch) => branch.rows.flatMap((row) => [row, ...row.pods])),
      );
    const metaRows = result.metas.flatMap((key) => rows(result.trees[key]!));
    expect(metaRows.filter((row) => row.kind === "slice")).toHaveLength(SEED_SLICE_COUNT);
    expect(metaRows.filter((row) => row.kind === "pod")).toHaveLength(SEED_POD_COUNT - 1);
    expect(metaRows.filter((row) => row.repoTag !== undefined).map((row) => row.key)).toEqual([
      SEED_CROSS_REPO_POD_ID,
    ]);
    expect(rows(result.noMeta).map((row) => [row.key, row.kind])).toEqual([
      [SEED_SLICELESS_POD_ID, "pod"],
      [SEED_AD_HOC_CHAT_ID, "ad-hoc"],
    ]);
  });
});

describe("pad", () => {
  it("returns exactly n threads, deterministically, leaving the tree unchanged", () => {
    const padded = pad(seed, 300);
    expect(padded.threads).toHaveLength(300);
    expect(padded.appThreads).toHaveLength(300);
    expect(new Set(padded.threads.map((thread) => thread.id)).size).toBe(300);
    expect(padded.threads.slice(0, SEED_THREAD_COUNT)).toEqual(seed.threads);
    expect(padded.subagentsByThreadId).toBe(seed.subagentsByThreadId);
    expect(pad(seed, 300)).toEqual(padded);
    expect(pad(pad(seed, 100), 300)).toEqual(padded);
    expect(() => pad(seed, SEED_THREAD_COUNT - 1)).toThrow();
  });
});
