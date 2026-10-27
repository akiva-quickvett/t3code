import { EnvironmentId, type OrchestrationStatsSnapshot, ThreadId } from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import * as EnvironmentRegistry from "../connection/registry.ts";
import * as Persistence from "../platform/persistence.ts";

import {
  activeAgentsDot,
  createSliceBurnReader,
  formatBurn,
  formatTokenRate,
  formatUsdPerHour,
  headroomDot,
  hostVerdictRows,
  metaBurnRow,
  statsSummaryText,
} from "./orchestrationStats.ts";
import { createServerEnvironmentAtoms } from "./server.ts";

const sliceId = ThreadId.make("slice-s");
const workId = ThreadId.make("meta-work");
const personalId = ThreadId.make("meta-personal");

function snapshot(
  overrides: { readonly burn?: Partial<OrchestrationStatsSnapshot["burn"]> } = {},
): OrchestrationStatsSnapshot {
  return {
    activeAgents: { runningTurns: 4, liveSessions: 7, idleSessions: 3 },
    burn: {
      state: "ready",
      tokensPerMinute: 18_000,
      usdPerHour: 4.2,
      approximate: false,
      perMeta: {},
      perSlice: { [sliceId]: { tokensPerMinute: 3_000, usdPerHour: 1.1 } },
      ...overrides.burn,
    },
    host: { verdict: "ok", cpu: 0.2, ram: 0.5, swap: 0.1, load: 0.4 },
  };
}

describe("format helpers", () => {
  it("rounds token rates to two significant figures with a unit", () => {
    expect(formatTokenRate(18_000)).toBe("18k tok/m");
    expect(formatTokenRate(18_449)).toBe("18k tok/m");
    expect(formatTokenRate(1_234)).toBe("1.2k tok/m");
    expect(formatTokenRate(950)).toBe("950 tok/m");
    expect(formatTokenRate(999_999)).toBe("1M tok/m");
    expect(formatTokenRate(0)).toBe("0 tok/m");
  });

  it("rounds dollars per hour to two significant figures", () => {
    expect(formatUsdPerHour(4.2)).toBe("$4.2/h");
    expect(formatUsdPerHour(4.249)).toBe("$4.2/h");
    expect(formatUsdPerHour(1.1)).toBe("$1.1/h");
    expect(formatUsdPerHour(123)).toBe("$120/h");
    expect(formatUsdPerHour(0)).toBe("$0/h");
  });

  it("prefixes the dollars with ≈ when a price was unknown", () => {
    expect(formatBurn(snapshot({ burn: { approximate: true } }).burn)).toBe("18k tok/m · ≈$4.2/h");
  });

  it("reads ≈ warming until the window fills", () => {
    expect(formatBurn(snapshot({ burn: { state: "warming", approximate: true } }).burn)).toBe(
      "≈ warming",
    );
  });

  it("maps verdicts and activity to dot kinds", () => {
    expect(headroomDot("ok")).toBe("done-unread");
    expect(headroomDot("low")).toBe("needs-you");
    expect(headroomDot("exhausted")).toBe("failed");
    expect(headroomDot("unknown")).toBe("idle");
    expect(activeAgentsDot({ runningTurns: 1, liveSessions: 1, idleSessions: 0 })).toBe("working");
    expect(activeAgentsDot({ runningTurns: 0, liveSessions: 2, idleSessions: 2 })).toBe("idle");
  });

  it("builds the summary line", () => {
    expect(statsSummaryText(snapshot())).toBe("7 active · 3 idle, 18k tok/m · $4.2/h, host ok");
  });
});

describe("host verdict rows", () => {
  it("uses the fixed thresholds per resource", () => {
    expect(
      hostVerdictRows({ verdict: "exhausted", cpu: null, ram: 0.97, swap: 0.6, load: 1 }),
    ).toEqual([
      { resource: "ram", verdict: "exhausted" },
      { resource: "swap", verdict: "low" },
      { resource: "load", verdict: "ok" },
      { resource: "cpu", verdict: "unknown" },
    ]);
  });

  it("counts a busy CPU as low only when nothing else explains the server's low", () => {
    const cpu = (verdict: "ok" | "low", ram: number) =>
      hostVerdictRows({ verdict, cpu: 0.95, ram, swap: 0, load: 0.5 }).find(
        (row) => row.resource === "cpu",
      )?.verdict;
    expect(cpu("ok", 0.5)).toBe("ok");
    expect(cpu("low", 0.5)).toBe("low");
    expect(cpu("low", 0.9)).toBe("ok");
  });
});

describe("metaBurnRow", () => {
  const metas = [
    { threadId: workId, title: "Work" },
    { threadId: personalId, title: "Personal" },
  ];

  it("is null while the snapshot has no per-meta figures", () => {
    expect(metaBurnRow({}, metas)).toBeNull();
  });

  it("joins the metas that have a figure", () => {
    expect(
      metaBurnRow(
        {
          [workId]: { tokensPerMinute: 15_000, usdPerHour: 3.6 },
          [personalId]: { tokensPerMinute: 3_000, usdPerHour: 0.6 },
        },
        metas,
      ),
    ).toEqual({ labels: "Work · Personal", values: "$3.6/h · $0.6/h" });
  });
});

describe("createSliceBurnReader", () => {
  const environmentId = EnvironmentId.make("environment-stats");
  const statsAtom = Atom.family((_environmentId: string) =>
    Atom.make<AsyncResult.AsyncResult<OrchestrationStatsSnapshot, unknown>>(
      AsyncResult.success(snapshot()),
    ),
  );

  it("returns the snapshot's per-slice figure while the strip holds the stream", () => {
    const registry = AtomRegistry.make();
    const sliceBurn = createSliceBurnReader(registry, statsAtom);
    const release = registry.mount(statsAtom(environmentId));
    expect(sliceBurn(environmentId, sliceId)).toEqual({ tokensPerMinute: 3_000, usdPerHour: 1.1 });
    expect(sliceBurn(environmentId, ThreadId.make("slice-other"))).toBeNull();
    release();
  });

  it("never mounts the stream itself", () => {
    const registry = AtomRegistry.make();
    const sliceBurn = createSliceBurnReader(registry, statsAtom);
    expect(sliceBurn(environmentId, sliceId)).toBeNull();
    expect(registry.getNodes().has(statsAtom(environmentId))).toBe(false);
  });
});

describe("orchestrationStatsLive", () => {
  it("drops the stream as soon as the strip unmounts", () => {
    // Building the family runs nothing, so unused services are enough here.
    const runtime = Atom.runtime(
      Layer.merge(
        Layer.succeed(
          EnvironmentRegistry.EnvironmentRegistry,
          {} as EnvironmentRegistry.EnvironmentRegistry["Service"],
        ),
        Layer.succeed(
          Persistence.EnvironmentCacheStore,
          {} as Persistence.EnvironmentCacheStore["Service"],
        ),
      ),
    );
    const atoms = createServerEnvironmentAtoms(runtime, {
      initialConfigValueAtom: () => Atom.make(null),
    });
    const environmentId = EnvironmentId.make("environment-stats");
    const atom = atoms.orchestrationStatsLive({ environmentId, input: {} });
    expect(atom.idleTTL).toBe(0);
    expect(atoms.orchestrationStatsLive({ environmentId, input: {} })).toBe(atom);
  });
});
