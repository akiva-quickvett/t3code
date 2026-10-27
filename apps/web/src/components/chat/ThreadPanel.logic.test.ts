import { describe, expect, it } from "vite-plus/test";

import { cellDispatchHint, cellDispatchMode, threadSurfaceLabel } from "./ThreadPanel.logic";

describe("cellDispatchMode", () => {
  it("steers the running run of a working cell", () => {
    const mode = cellDispatchMode(true);
    expect(mode).toBe("steer");
    expect(cellDispatchHint(mode)).toBe("steers the running turn");
  });

  it("queues behind the turn of an idle cell", () => {
    const mode = cellDispatchMode(false);
    expect(mode).toBe("queue");
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
