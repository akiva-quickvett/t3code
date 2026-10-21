import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { UsageLimitSourceId } from "./usageLimitSourceId.ts";

/**
 * `id` is stable per provider (`five_hour`, `seven_day_opus`, `primary`) so a
 * sparse turn-driven update lands on the same row a full probe produced.
 */
export const ServerProviderUsageWindow = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: Schema.Literals(["session", "weekly", "monthly", "other"]),
  label: TrimmedNonEmptyString,
  usedPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resetsAt: Schema.optional(IsoDateTime),
  windowDurationMins: Schema.optional(NonNegativeInt),
});
export type ServerProviderUsageWindow = typeof ServerProviderUsageWindow.Type;

export const ServerProviderResetCredits = Schema.Struct({
  availableCount: NonNegativeInt,
  nextExpiresAt: Schema.optional(IsoDateTime),
  /** Pins hub redemption to the displayed credit, including retries from another client. */
  nextCreditId: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderResetCredits = typeof ServerProviderResetCredits.Type;

/**
 * `unavailable` distinguishes an account that can never report windows (API
 * key, Bedrock) from a probe that failed this time, so clients can keep the
 * last good bars for the latter and clear them for the former.
 */
export const ServerProviderUsageLimits = Schema.Struct({
  checkedAt: IsoDateTime,
  windows: ForwardCompatibleArray(ServerProviderUsageWindow),
  credentialFingerprint: Schema.optional(TrimmedNonEmptyString),
  resetCredits: Schema.optional(ServerProviderResetCredits),
  externalUsage: Schema.optional(
    Schema.Struct({
      label: TrimmedNonEmptyString,
      url: TrimmedNonEmptyString,
    }),
  ),
  unavailable: Schema.optional(
    Schema.Struct({
      reason: Schema.Literals(["unsupported", "probeFailed"]),
      message: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
});
export type ServerProviderUsageLimits = typeof ServerProviderUsageLimits.Type;

/**
 * Sparse by contract: Claude's `rate_limit_event` names one window at a time
 * and Codex documents its notification as a partial. Windows merge by `id` onto
 * the instance's published snapshot; omitted windows are unchanged.
 */
export const ProviderUsageLimitsUpdate = Schema.Struct({
  windows: Schema.Array(ServerProviderUsageWindow),
});
export type ProviderUsageLimitsUpdate = typeof ProviderUsageLimitsUpdate.Type;

export const UsageLimitSourceAccount = Schema.Struct({
  id: TrimmedNonEmptyString,
  driver: ProviderDriverKind,
  email: Schema.optional(TrimmedNonEmptyString),
  plan: Schema.optional(TrimmedNonEmptyString),
  workspaceId: Schema.optional(TrimmedNonEmptyString),
  usageLimits: ServerProviderUsageLimits,
});
export type UsageLimitSourceAccount = typeof UsageLimitSourceAccount.Type;

export const UsageLimitSourceSnapshot = Schema.Struct({
  id: UsageLimitSourceId,
  kind: Schema.Literal("cliproxy"),
  label: TrimmedNonEmptyString,
  checkedAt: IsoDateTime,
  accounts: ForwardCompatibleArray(UsageLimitSourceAccount),
  error: Schema.optional(TrimmedNonEmptyString),
});
export type UsageLimitSourceSnapshot = typeof UsageLimitSourceSnapshot.Type;

export const UsageLimitSourceSnapshots = ForwardCompatibleArray(UsageLimitSourceSnapshot);
export type UsageLimitSourceSnapshots = typeof UsageLimitSourceSnapshots.Type;

export const UsageLimitSourceConsumeResetCreditInput = Schema.Struct({
  sourceId: UsageLimitSourceId,
  accountId: TrimmedNonEmptyString,
  creditId: TrimmedNonEmptyString,
});
export type UsageLimitSourceConsumeResetCreditInput =
  typeof UsageLimitSourceConsumeResetCreditInput.Type;

export const ProviderConsumeResetCreditInput = Schema.Union([
  Schema.Struct({ instanceId: ProviderInstanceId }),
  UsageLimitSourceConsumeResetCreditInput,
]);
export type ProviderConsumeResetCreditInput = typeof ProviderConsumeResetCreditInput.Type;

export class UsageLimitSourceError extends Schema.TaggedError<UsageLimitSourceError>()(
  "UsageLimitSourceError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export const ProviderConsumeResetCreditOutcome = Schema.Literals([
  "reset",
  "nothingToReset",
  "noCredit",
  "alreadyRedeemed",
]);
export type ProviderConsumeResetCreditOutcome = typeof ProviderConsumeResetCreditOutcome.Type;

export const ProviderConsumeResetCreditResult = Schema.Struct({
  outcome: ProviderConsumeResetCreditOutcome,
  warning: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderConsumeResetCreditResult = typeof ProviderConsumeResetCreditResult.Type;

export const UsageLimitsReport = Schema.Struct({
  createdAt: IsoDateTime,
  accounts: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      driver: ProviderDriverKind,
      label: TrimmedNonEmptyString,
      plan: Schema.optional(TrimmedNonEmptyString),
      email: Schema.optional(TrimmedNonEmptyString),
      sourceLabel: Schema.optional(TrimmedNonEmptyString),
      instanceId: Schema.optional(ProviderInstanceId),
      resetCreditInput: Schema.optional(ProviderConsumeResetCreditInput),
      displayName: Schema.optional(Schema.String),
      accentColor: Schema.optional(Schema.String),
      limits: ServerProviderUsageLimits,
    }),
  ),
  notices: Schema.Array(Schema.String),
});
export type UsageLimitsReport = typeof UsageLimitsReport.Type;

/**
 * The shortest gap between two limit checks anyone can ask for: a client's
 * refresh and an agent's `refresh: true` both wait this long after the last one.
 */
export const USAGE_LIMITS_MIN_REFRESH_INTERVAL_MS = 5 * 60_000;

export const HeadroomPercent = Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 100 }));

/**
 * When an account counts as `low`. Any window at 100 % makes it `exhausted`
 * whatever these say. Monthly and other windows use the weekly threshold.
 */
// Users hand-edit these in settings.json, which decodes as one schema: a bad
// value falls back to its default instead of discarding every other setting.
const withFallback = <S extends Schema.Top>(schema: S, fallback: S["Encoded"]) => {
  const decodeValue = Schema.decodeUnknownOption(schema as never);
  return Schema.optionalKey(Schema.Unknown).pipe(
    Schema.decodeTo(
      schema,
      SchemaTransformation.transformOptional<S["Encoded"], unknown>({
        decode: (raw) =>
          Option.some(
            Option.isSome(raw) && Option.isSome(decodeValue(raw.value))
              ? (raw.value as S["Encoded"])
              : fallback,
          ),
        encode: (value) => value,
      }),
    ),
  );
};

export const UsageHeadroomThresholds = Schema.Struct({
  sessionLowPercent: withFallback(HeadroomPercent, 85),
  weeklyLowPercent: withFallback(HeadroomPercent, 95),
});
/** The settings.json field: anything but an object decodes as the defaults. */
export const UsageHeadroomSetting = withFallback(UsageHeadroomThresholds, {});
export type UsageHeadroomThresholds = typeof UsageHeadroomThresholds.Type;

/** `unknown` only when the last limit check failed. */
export const AgentUsageHeadroom = Schema.Literals(["ok", "low", "unknown", "exhausted"]);
export type AgentUsageHeadroom = typeof AgentUsageHeadroom.Type;

export const AgentUsageLimitsStatus = Schema.Union([
  Schema.Literals(["ok", "stale"]),
  Schema.Struct({ unavailable: Schema.Literals(["unsupported", "probeFailed"]) }),
]);
export type AgentUsageLimitsStatus = typeof AgentUsageLimitsStatus.Type;

/**
 * What agents see of one provider instance's limits. Deliberately left out:
 * account email, credential fingerprint, hub URLs and keys, and reset-credit
 * ids. Keep it to a few hundred bytes; every orchestrator call carries it.
 */
export const AgentUsageLimits = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  label: TrimmedNonEmptyString,
  plan: Schema.optional(TrimmedNonEmptyString),
  checkedAt: IsoDateTime,
  windows: Schema.Array(
    Schema.Struct({
      kind: ServerProviderUsageWindow.fields.kind,
      label: ServerProviderUsageWindow.fields.label,
      usedPercent: ServerProviderUsageWindow.fields.usedPercent,
      resetsAt: ServerProviderUsageWindow.fields.resetsAt,
    }),
  ),
  status: AgentUsageLimitsStatus,
  headroom: AgentUsageHeadroom,
});
export type AgentUsageLimits = typeof AgentUsageLimits.Type;

export const AgentUsageLimitsInput = Schema.Struct({
  driver: Schema.optional(ProviderDriverKind),
  instanceId: Schema.optional(ProviderInstanceId),
  /** Probes instances whose last check is at least the minimum refresh interval old. */
  refresh: Schema.optional(Schema.Boolean),
});
export type AgentUsageLimitsInput = typeof AgentUsageLimitsInput.Type;

export const AgentUsageLimitsResult = Schema.Struct({
  instances: Schema.Array(AgentUsageLimits),
});
export type AgentUsageLimitsResult = typeof AgentUsageLimitsResult.Type;
