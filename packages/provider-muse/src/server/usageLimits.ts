/**
 * Muse Code's subscription usage limits. Meta reports the account's windows
 * with every model response, and Muse forwards them as `usage/changed`. When a
 * window runs out, Meta refuses the next request and Muse fails the turn.
 */
import type {
  ProviderUsageLimitsUpdate,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as DateTime from "effect/DateTime";

import { LATEST_DATE_MS, type MuseSubscriptionUsage } from "./protocol.ts";

const MINUTE_MS = 60_000;
const WEEK_MINS = 7 * 24 * 60;
// Meta's short window is a 5-hour block; a report states it, a refusal does not.
const FALLBACK_WINDOW_MINS = 5 * 60;

const isoFromMs = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

function sessionWindow(
  usedPercent: number,
  windowDurationMins: number,
  resetsAtMs: number,
): ServerProviderUsageWindow {
  return {
    id: "window",
    kind: "session",
    label: "Session",
    usedPercent: clampPercent(usedPercent),
    windowDurationMins: Math.round(windowDurationMins),
    resetsAt: isoFromMs(resetsAtMs),
  };
}

function weeklyWindow(usedPercent: number, resetsAtMs: number): ServerProviderUsageWindow {
  return {
    id: "weekly",
    kind: "weekly",
    label: "Weekly",
    usedPercent: clampPercent(usedPercent),
    windowDurationMins: WEEK_MINS,
    resetsAt: isoFromMs(resetsAtMs),
  };
}

/**
 * One account-wide pair, not per model: Meta reports a single short window and
 * a weekly block for the whole subscription tier.
 */
export function museUsageToUpdate(usage: MuseSubscriptionUsage): ProviderUsageLimitsUpdate {
  return {
    windows: [
      sessionWindow(
        usage.window.usedPercent,
        usage.window.windowDurationMins,
        usage.window.resetsAtMs,
      ),
      weeklyWindow(usage.weekly.usedPercent, usage.weekly.resetsAtMs),
    ],
  };
}

/**
 * Muse has no probe that answers between turns: `usage/read` returns only what
 * the answering host process has itself observed, so the fresh host a status
 * check starts reports nothing (verified on Muse 1.4.11). The last report a turn
 * delivered stands in, and until one arrives the headroom is unknown, not ok.
 */
export function museUsageLimitsBeforeReport(checkedAt: string): ServerProviderUsageLimits {
  return makeUnavailableUsageLimits({
    checkedAt,
    reason: "probeFailed",
    message: "Muse Code reports usage limits with its next reply.",
  });
}

/**
 * Muse surfaces Meta's quota refusal as `API error 429: Subscription quota
 * exhausted. Your usage window resets at 2026-10-13T10:45:52Z.`, at times
 * wrapped by a credential proxy. Muse can also type the stop as `error.quota`,
 * but a relayed refusal arrives untyped, so the text still counts.
 */
export function isMuseUsageLimitFailure(message: string | undefined): boolean {
  return message !== undefined && /\b429\b/.test(message) && /quota|usage limit/i.test(message);
}

const NAMED_RESET =
  /\bresets at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/i;

type MuseQuotaRefusal = {
  readonly quota?: { readonly resetsAtMs: number } | undefined;
  readonly message?: string | undefined;
};

/**
 * When a stopped turn can run again: every exhausted window must reset first.
 * The resets come from the used-up windows of the last report and the window
 * the refusal stopped at; the latest one still ahead wins.
 */
export function museUsageLimitResetAt(
  usage: MuseSubscriptionUsage | undefined,
  nowMs: number,
  refusal?: MuseQuotaRefusal,
): string | null {
  const resets = [
    ...[usage?.window, usage?.weekly].map((window) =>
      window && window.usedPercent >= 100 ? window.resetsAtMs : undefined,
    ),
    ...(refusal ? [refusedWindows(usage, nowMs, refusal)?.resetsAtMs] : []),
  ].filter((ms) => isAhead(ms, nowMs));
  return resets.length > 0 ? isoFromMs(Math.max(...resets)) : null;
}

function namedResetMs(message: string | undefined): number | undefined {
  const named = message?.match(NAMED_RESET)?.[1];
  return named === undefined ? undefined : Date.parse(named);
}

function isAhead(ms: number | undefined, nowMs: number): ms is number {
  return ms !== undefined && Number.isFinite(ms) && ms > nowMs && ms <= LATEST_DATE_MS;
}

/**
 * Which windows a refusal stopped at, and when they reset. Muse's typed quota
 * names no window (only `limitKind: "tierLimit"`), so a reset equal to one the
 * last report gave identifies that window, or both when they reset together;
 * otherwise a reset further off than the short window lasts can only be the
 * weekly one. The typed reset wins over the one the text names.
 *
 * Meta's refusal text names the short window ("Your usage window resets ..."),
 * so a refusal with no reset at all stopped there, at the reset the last report
 * gave. Usage and recovery both take that reset: a wrong guess costs one
 * refused retry, after which the report's reset has passed and nothing is
 * guessed again. A refusal whose own reset has already passed marks nothing.
 */
function refusedWindows(
  usage: MuseSubscriptionUsage | undefined,
  nowMs: number,
  refusal: MuseQuotaRefusal,
):
  | { readonly kinds: ReadonlyArray<"session" | "weekly">; readonly resetsAtMs: number }
  | undefined {
  const stated = [refusal.quota?.resetsAtMs, namedResetMs(refusal.message)].filter(
    (ms) => ms !== undefined,
  );
  if (stated.length === 0) {
    return usage && isAhead(usage.window.resetsAtMs, nowMs)
      ? { kinds: ["session"], resetsAtMs: usage.window.resetsAtMs }
      : undefined;
  }
  const resetsAtMs = stated.find((ms) => isAhead(ms, nowMs));
  if (resetsAtMs === undefined) return undefined;
  const matching = (
    [
      ["session", usage?.window.resetsAtMs],
      ["weekly", usage?.weekly.resetsAtMs],
    ] as const
  ).flatMap(([kind, reset]) => (reset === resetsAtMs ? [kind] : []));
  if (matching.length > 0) return { kinds: matching, resetsAtMs };
  const windowMins = usage?.window.windowDurationMins ?? FALLBACK_WINDOW_MINS;
  return {
    kinds: [resetsAtMs - nowMs > windowMins * MINUTE_MS ? "weekly" : "session"],
    resetsAtMs,
  };
}

/**
 * The windows a quota refusal says are used up, at 100% until they reset, so
 * the instance reads exhausted even when the last report predates the stop.
 * Without a reset ahead there is nothing truthful to mark.
 */
export function museQuotaRefusalUpdate(
  usage: MuseSubscriptionUsage | undefined,
  nowMs: number,
  refusal: MuseQuotaRefusal,
): ProviderUsageLimitsUpdate | undefined {
  const refused = refusedWindows(usage, nowMs, refusal);
  if (refused === undefined) return undefined;
  const windowMins = usage?.window.windowDurationMins ?? FALLBACK_WINDOW_MINS;
  return {
    windows: refused.kinds.map((kind) =>
      kind === "weekly"
        ? weeklyWindow(100, refused.resetsAtMs)
        : sessionWindow(100, windowMins, refused.resetsAtMs),
    ),
  };
}
