import { describe, expect, it } from "vite-plus/test";

import { hostHeadroom, hostPressure } from "./hostHeadroom.ts";

const healthy = {
  cpuUtilization: 0.3,
  cpuCount: 4,
  availableMemoryBytes: 50,
  totalMemoryBytes: 100,
  swapUsedBytes: 0,
  swapTotalBytes: 100,
  loadAverage1m: 1,
};

describe("hostHeadroom", () => {
  it("classifies RAM available at its 15% and 5% boundaries", () => {
    expect(hostHeadroom({ ...healthy, availableMemoryBytes: 15 })).toBe("ok");
    expect(hostHeadroom({ ...healthy, availableMemoryBytes: 14 })).toBe("low");
    expect(hostHeadroom({ ...healthy, availableMemoryBytes: 5 })).toBe("low");
    expect(hostHeadroom({ ...healthy, availableMemoryBytes: 4 })).toBe("exhausted");
  });

  it("classifies swap used at its 50% and 90% boundaries", () => {
    expect(hostHeadroom({ ...healthy, swapUsedBytes: 50 })).toBe("ok");
    expect(hostHeadroom({ ...healthy, swapUsedBytes: 51 })).toBe("low");
    expect(hostHeadroom({ ...healthy, swapUsedBytes: 90 })).toBe("low");
    expect(hostHeadroom({ ...healthy, swapUsedBytes: 95 })).toBe("exhausted");
  });

  it("treats a host without swap as healthy swap", () => {
    expect(hostHeadroom({ ...healthy, swapUsedBytes: 0, swapTotalBytes: 0 })).toBe("ok");
    const { swapUsedBytes: _used, swapTotalBytes: _total, ...withoutSwap } = healthy;
    expect(hostHeadroom(withoutSwap)).toBe("ok");
  });

  it("classifies load per CPU at its 1.5 and 3 boundaries", () => {
    expect(hostHeadroom({ ...healthy, loadAverage1m: 6 })).toBe("ok");
    expect(hostHeadroom({ ...healthy, loadAverage1m: 6.4 })).toBe("low");
    expect(hostHeadroom({ ...healthy, loadAverage1m: 12 })).toBe("low");
    expect(hostHeadroom({ ...healthy, loadAverage1m: 12.4 })).toBe("exhausted");
  });

  it("needs CPU above 90% on two consecutive samples", () => {
    const busy = { ...healthy, cpuUtilization: 0.95 };
    expect(hostHeadroom(busy)).toBe("ok");
    expect(hostHeadroom(busy, { ...healthy, cpuUtilization: 0.4 })).toBe("ok");
    expect(hostHeadroom(busy, { ...healthy, cpuUtilization: 0.91 })).toBe("low");
    expect(hostHeadroom({ ...healthy, cpuUtilization: 0.9 }, busy)).toBe("ok");
  });

  it("reports the worst signal", () => {
    expect(hostHeadroom({ ...healthy, availableMemoryBytes: 10, swapUsedBytes: 95 })).toBe(
      "exhausted",
    );
  });

  it("is unknown when RAM is unknown", () => {
    expect(hostHeadroom({ ...healthy, availableMemoryBytes: 0, totalMemoryBytes: 0 })).toBe(
      "unknown",
    );
    expect(hostPressure({ ...healthy, totalMemoryBytes: 0 }).ram).toBeNull();
  });
});
