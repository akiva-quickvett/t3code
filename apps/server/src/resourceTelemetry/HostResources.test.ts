import { describe, expect, it } from "@effect/vitest";

import { darwinSwap, linuxSwap } from "./HostResources.ts";

describe("HostResources swap parsing", () => {
  it("reads Linux SwapTotal and SwapFree", () => {
    const meminfo = [
      "MemTotal:       16384000 kB",
      "MemAvailable:    8192000 kB",
      "SwapCached:            0 kB",
      "SwapTotal:       2097148 kB",
      "SwapFree:        1048574 kB",
    ].join("\n");
    expect(linuxSwap(meminfo)).toEqual({
      swapTotalBytes: 2097148 * 1024,
      swapUsedBytes: (2097148 - 1048574) * 1024,
    });
  });

  it("reads a macOS vm.swapusage line", () => {
    expect(darwinSwap("total = 2048.00M  used = 1024.25M  free = 1023.75M  (encrypted)\n")).toEqual(
      { swapTotalBytes: 2048 * 1024 ** 2, swapUsedBytes: Math.round(1024.25 * 1024 ** 2) },
    );
    expect(darwinSwap("total = 1.50G  used = 0.00M  free = 1.50G  (encrypted)")).toEqual({
      swapTotalBytes: Math.round(1.5 * 1024 ** 3),
      swapUsedBytes: 0,
    });
  });

  it("leaves swap unknown when the output does not parse", () => {
    expect(linuxSwap("")).toBeNull();
    expect(linuxSwap("SwapTotal:       2097148 kB")).toBeNull();
    expect(darwinSwap("")).toBeNull();
    expect(darwinSwap("vm.swapusage: unknown oid")).toBeNull();
  });
});
