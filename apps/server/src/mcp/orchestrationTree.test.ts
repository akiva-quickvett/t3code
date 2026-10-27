import { describe, expect, it } from "@effect/vitest";
import { orchestrationSeedTree, seedSliceId } from "@t3tools/shared/testing/orchestrationSeedTree";
import * as DateTime from "effect/DateTime";

import { orchestrationThreadInputFromShell } from "./orchestrationTree.ts";

describe("orchestrationThreadInputFromShell", () => {
  const NOW_MS = Date.parse("2027-01-01T00:00:00.000Z");
  const snoozedShell = orchestrationSeedTree.threads.find((shell) => shell.id === seedSliceId(5))!;
  // A failed run after the snooze, then a new turn still waiting.
  const failedAfterSnooze = {
    ...snoozedShell,
    status: "failed" as const,
    latestRunCompletedAt: DateTime.add(snoozedShell.snoozedAt!, { minutes: 1 }),
    updatedAt: DateTime.add(snoozedShell.snoozedAt!, { minutes: 2 }),
  };

  it("reads a failure wake from the runtime status, as the sidebar does", () => {
    const waiting = orchestrationThreadInputFromShell(
      { ...failedAfterSnooze, activityRunStatus: "waiting" },
      NOW_MS,
    );
    expect([waiting.status.snoozed, waiting.status.wokeAt]).toEqual([true, null]);

    const failed = orchestrationThreadInputFromShell(failedAfterSnooze, NOW_MS);
    expect([failed.status.snoozed, failed.status.wokeAt]).toEqual([
      false,
      DateTime.formatIso(failedAfterSnooze.updatedAt),
    ]);
  });
});
