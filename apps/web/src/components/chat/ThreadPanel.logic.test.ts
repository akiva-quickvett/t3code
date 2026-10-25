import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { cellDispatchHint, cellDispatchMode, threadSurfaceLabel } from "./ThreadPanel.logic";

describe("cellDispatchMode", () => {
  it("steers the running run of a working cell", () => {
    const runId = RunId.make("run-1");
    const mode = cellDispatchMode(runId);
    expect(mode).toEqual({ type: "steer_active", targetRunId: runId });
    expect(cellDispatchHint(mode)).toBe("steers the running turn");
  });

  it("queues behind the turn of an idle cell", () => {
    const mode = cellDispatchMode(null);
    expect(mode).toEqual({ type: "queue_after_active" });
    expect(cellDispatchHint(mode)).toBe("queues after the turn");
  });
});

describe("threadSurfaceLabel", () => {
  it("prefers the cell's role, then its title", () => {
    expect(
      threadSurfaceLabel({
        title: "Round 2",
        rolePreset: { id: "implementor", label: "implementor" },
      } as Parameters<typeof threadSurfaceLabel>[0]),
    ).toBe("implementor");
    expect(threadSurfaceLabel({ title: "Round 2", rolePreset: null })).toBe("Round 2");
    expect(threadSurfaceLabel(null)).toBe("Thread");
  });
});
