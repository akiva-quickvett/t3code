import type { OrganGroup } from "@t3tools/client-runtime/state/subagentRuntime";
import { ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { runningOrganCellThreadIds } from "./OrganDock.logic";

function group(
  id: string,
  running: boolean,
  childThreadIds: ReadonlyArray<string | null>,
): OrganGroup {
  return {
    organId: `organ_${id}_organ_id`,
    presetId: "review",
    goal: "Review",
    running,
    rounds: [1, 2].map((round) => ({
      round,
      cells: childThreadIds.map((childThreadId, index) => ({
        childThreadId: childThreadId === null ? null : ThreadId.make(`${childThreadId}-r${round}`),
        subagentId: `subagent-${id}-${round}-${index}`,
        title: null,
        role: null,
        model: null,
        status: running ? "running" : "completed",
        dot: running ? "working" : "idle",
      })),
    })),
  };
}

it("collects the latest round's cell threads of running organs only, as the dock lists", () => {
  const ids = runningOrganCellThreadIds([
    group("live", true, ["a", null]),
    group("done", false, ["b"]),
  ]);
  expect([...ids].sort()).toEqual(["a-r2"]);
});
