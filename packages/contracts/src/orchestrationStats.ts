import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId } from "./baseSchemas.ts";

/** Same literals as `AgentUsageHeadroom`; `unknown` when the host reported nothing usable. */
export const HostHeadroom = Schema.Literals(["ok", "low", "exhausted", "unknown"]);
export type HostHeadroom = typeof HostHeadroom.Type;

export const OrchestrationBurnRate = Schema.Struct({
  tokensPerMinute: Schema.Number,
  usdPerHour: Schema.Number,
});
export type OrchestrationBurnRate = typeof OrchestrationBurnRate.Type;

export const OrchestrationStatsSnapshot = Schema.Struct({
  activeAgents: Schema.Struct({
    runningTurns: NonNegativeInt,
    liveSessions: NonNegativeInt,
    idleSessions: NonNegativeInt,
  }),
  burn: Schema.Struct({
    /** Burn is sampled in memory only, so it reads `warming` until a full window has passed since start. */
    state: Schema.Literals(["warming", "ready"]),
    tokensPerMinute: Schema.Number,
    usdPerHour: Schema.Number,
    /** Some model in the window had no known price. */
    approximate: Schema.Boolean,
    perMeta: Schema.Record(ThreadId, OrchestrationBurnRate),
    perSlice: Schema.Record(ThreadId, OrchestrationBurnRate),
  }),
  host: Schema.Struct({
    verdict: HostHeadroom,
    cpu: Schema.NullOr(Schema.Number),
    ram: Schema.NullOr(Schema.Number),
    swap: Schema.NullOr(Schema.Number),
    load: Schema.NullOr(Schema.Number),
  }),
});
export type OrchestrationStatsSnapshot = typeof OrchestrationStatsSnapshot.Type;
