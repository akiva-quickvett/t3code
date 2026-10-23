import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { BackgroundScope } from "./background.ts";
import { OrchestrationStatsSnapshot } from "./orchestrationStats.ts";
import { HostResourcesSnapshot } from "./resourceTelemetry.ts";

describe("orchestration stats contracts", () => {
  it("decodes a warming snapshot with an unknown host", () => {
    const snapshot = Schema.decodeSync(OrchestrationStatsSnapshot)({
      activeAgents: { runningTurns: 2, liveSessions: 3, idleSessions: 1 },
      burn: {
        state: "warming",
        tokensPerMinute: 1200.5,
        usdPerHour: 0.75,
        approximate: true,
        perMeta: { "thread-meta": { tokensPerMinute: 1200.5, usdPerHour: 0.75 } },
        perSlice: {},
      },
      host: { verdict: "unknown", cpu: null, ram: 0.4, swap: null, load: 0.8 },
    });
    expect(snapshot.burn.perMeta["thread-meta" as never]?.usdPerHour).toBe(0.75);
    expect(snapshot.host.verdict).toBe("unknown");
  });

  it("decodes host snapshots with and without swap and load", () => {
    const decode = Schema.decodeUnknownSync(HostResourcesSnapshot);
    const older = {
      sampledAt: 1,
      cpuUtilization: 0.5,
      cpuCount: 8,
      availableMemoryBytes: 1024,
      totalMemoryBytes: 4096,
    };
    expect(decode(older).swapUsedBytes).toBeUndefined();
    expect(
      decode({ ...older, swapUsedBytes: 512, swapTotalBytes: 2048, loadAverage1m: 1.25 })
        .loadAverage1m,
    ).toBe(1.25);
  });

  it("adds no BackgroundScope", () => {
    expect(BackgroundScope.members.map((member) => member.fields.type.literal)).toEqual([
      "server-config",
      "provider-status",
      "vcs-status",
      "git-refs",
      "diagnostics",
      "thread",
    ]);
  });
});
