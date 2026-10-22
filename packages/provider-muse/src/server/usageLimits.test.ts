import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  UsageHeadroomThresholds,
  type ProviderUsageLimitsUpdate,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  applyUsageLimitsUpdate,
  resolveUsageLimitsAfterProbe,
} from "@t3tools/provider-core/server/usageLimits";
import { projectAgentUsageLimits } from "@t3tools/shared/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { MuseSettings } from "../settings.ts";
import type { MuseSubscriptionUsage } from "./protocol.ts";
import { makePendingMuseProvider } from "./status.ts";
import {
  isMuseUsageLimitFailure,
  museQuotaRefusalUpdate,
  museUsageLimitResetAt,
  museUsageLimitsBeforeReport,
  museUsageToUpdate,
} from "./usageLimits.ts";

// What Meta reported after a reply on 2026-10-08, as Muse forwards it.
const usage = {
  observedAtMs: 1791447762610,
  tier: "tier-1",
  window: { usedPercent: 0, windowDurationMins: 300, resetsAtMs: 1791465557000 },
  weekly: { usedPercent: 5, resetsAtMs: 1791763200000 },
} satisfies MuseSubscriptionUsage;
const nowMs = usage.observedAtMs;
// The refusal this slice hit live (2026-10-22) while T3 still showed Muse headroom ok.
const liveReset = "2026-10-22T07:58:42.000Z";
const liveRefusal = {
  message:
    "API error 429 [request_id=826ba6da-a835-4b22-bc11-8270b7fa0fad]: Subscription quota exhausted. Your usage window resets at 2026-10-22T07:58:42Z. (rate_limit_error)",
};
// How Muse 1.4.6 ended a turn at a real quota stop (2026-10-13), relayed by a credential proxy.
const realRefusal =
  "API error 429: All credentials for model muse-wonder-1.0-contributor are cooling down (last error: rate_limit_exceeded: Subscription quota exhausted. Your usage window resets at 2026-10-13T10:45:52Z.) (after 10 provider attempts)";

describe("Muse usage limit failures", () => {
  it("recognizes Meta's quota refusal and no other failure", () => {
    expect(
      isMuseUsageLimitFailure(
        "API error 429: Subscription quota exhausted. Your usage window resets soon. (rate_limit_error)",
      ),
    ).toBe(true);
    expect(isMuseUsageLimitFailure(realRefusal)).toBe(true);
    // A plain rate limit retries on its own; it is not a used-up subscription window.
    expect(isMuseUsageLimitFailure("API error 429: Rate limit exceeded. (rate_limit_error)")).toBe(
      false,
    );
    expect(isMuseUsageLimitFailure("Subscription quota exhausted.")).toBe(false);
    expect(isMuseUsageLimitFailure(undefined)).toBe(false);
  });

  it("resumes once every exhausted window has reset", () => {
    const sessionOut = { ...usage, window: { ...usage.window, usedPercent: 103 } };
    expect(museUsageLimitResetAt(sessionOut, nowMs)).toBe("2026-10-08T13:19:17.000Z");
    const bothOut = { ...sessionOut, weekly: { ...usage.weekly, usedPercent: 100 } };
    expect(museUsageLimitResetAt(bothOut, nowMs)).toBe("2026-10-12T00:00:00.000Z");
  });

  it("takes the reset a refusal names or types when no report has one", () => {
    expect(museUsageLimitResetAt(undefined, nowMs, { message: realRefusal })).toBe(
      "2026-10-13T10:45:52.000Z",
    );
    const quota = { resetsAtMs: usage.window.resetsAtMs };
    expect(museUsageLimitResetAt(usage, nowMs, { quota })).toBe("2026-10-08T13:19:17.000Z");
    // A used-up weekly window still holds the turn back after the typed reset.
    const weeklyOut = { ...usage, weekly: { ...usage.weekly, usedPercent: 100 } };
    expect(museUsageLimitResetAt(weeklyOut, nowMs, { quota })).toBe("2026-10-12T00:00:00.000Z");
  });

  it("has no reset time unless a report shows a used-up window that resets later", () => {
    expect(museUsageLimitResetAt(undefined, nowMs)).toBeNull();
    expect(museUsageLimitResetAt(usage, nowMs)).toBeNull();
    const sessionOut = { ...usage, window: { ...usage.window, usedPercent: 100 } };
    expect(museUsageLimitResetAt(sessionOut, usage.window.resetsAtMs)).toBeNull();
    const afterNamedReset = Date.parse("2026-10-14T00:00:00Z");
    expect(museUsageLimitResetAt(undefined, afterNamedReset, { message: realRefusal })).toBeNull();
  });
});

const thresholds = Schema.decodeSync(UsageHeadroomThresholds)({});
const enabledSettings = Schema.decodeSync(MuseSettings)({ enabled: true });

describe("Muse usage limit windows", () => {
  const checkedAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
  const pendingProvider = makePendingMuseProvider(enabledSettings).pipe(
    Effect.map((draft): ServerProvider => ({
      ...draft,
      instanceId: ProviderInstanceId.make("muse"),
      driver: ProviderDriverKind.make("muse"),
    })),
  );
  const apply = (provider: ServerProvider, update: ProviderUsageLimitsUpdate | undefined) => {
    const usageLimits = update
      ? applyUsageLimitsUpdate({ previous: provider.usageLimits, update, checkedAt })
      : provider.usageLimits;
    return usageLimits ? { ...provider, usageLimits } : provider;
  };
  const project = (provider: ServerProvider, at = nowMs) =>
    projectAgentUsageLimits(provider, thresholds, at);
  const refusalNaming = (reset: string) =>
    `API error 429: Subscription quota exhausted. Your usage window resets at ${reset}.`;

  it("maps a report to the session and weekly windows with their resets", () => {
    expect(museUsageToUpdate(usage).windows).toEqual([
      {
        id: "window",
        kind: "session",
        label: "Session",
        usedPercent: 0,
        windowDurationMins: 300,
        resetsAt: "2026-10-08T13:19:17.000Z",
      },
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 5,
        windowDurationMins: 10080,
        resetsAt: "2026-10-12T00:00:00.000Z",
      },
    ]);
    // Meta's over-quota percentages can pass 100; the contract caps them.
    const over = { ...usage, window: { ...usage.window, usedPercent: 103 } };
    expect(museUsageToUpdate(over).windows[0]?.usedPercent).toBe(100);
  });

  it.effect("is unknown until the first report, then derives ok, low, and exhausted", () =>
    Effect.gen(function* () {
      const pending = yield* pendingProvider;
      expect(project(pending)).toMatchObject({
        windows: [],
        status: { unavailable: "probeFailed" },
        headroom: "unknown",
      });

      const reported = apply(pending, museUsageToUpdate(usage));
      expect(project(reported)).toMatchObject({
        windows: [
          { kind: "session", usedPercent: 0, resetsAt: "2026-10-08T13:19:17.000Z" },
          { kind: "weekly", usedPercent: 5, resetsAt: "2026-10-12T00:00:00.000Z" },
        ],
        status: "ok",
        headroom: "ok",
      });

      const busy = { ...usage, window: { ...usage.window, usedPercent: 90 } };
      expect(project(apply(reported, museUsageToUpdate(busy))).headroom).toBe("low");
      const spent = { ...usage, weekly: { ...usage.weekly, usedPercent: 100 } };
      expect(project(apply(reported, museUsageToUpdate(spent))).headroom).toBe("exhausted");
    }),
  );

  it.effect("marks the refused window exhausted until the reset the refusal names", () =>
    Effect.gen(function* () {
      const reported = apply(yield* pendingProvider, museUsageToUpdate(usage));
      const refused = apply(
        reported,
        museQuotaRefusalUpdate(usage, nowMs, { message: refusalNaming("2026-10-08T13:19:17Z") }),
      );
      expect(project(refused)).toMatchObject({
        windows: [
          { kind: "session", usedPercent: 100 },
          { kind: "weekly", usedPercent: 5 },
        ],
        headroom: "exhausted",
      });
      expect(project(refused, Date.parse("2026-10-08T13:19:18Z")).headroom).toBe("ok");

      // A refusal before any report still lands, and a reset beyond the short
      // window can only be the weekly one.
      const unreported = apply(
        yield* pendingProvider,
        museQuotaRefusalUpdate(undefined, nowMs, { message: realRefusal }),
      );
      expect(project(unreported)).toMatchObject({
        windows: [{ kind: "weekly", usedPercent: 100, resetsAt: "2026-10-13T10:45:52.000Z" }],
        headroom: "exhausted",
      });
      expect(project(unreported, Date.parse("2026-10-13T10:45:53Z")).headroom).toBe("ok");
    }),
  );

  it("marks the short window from the last report when the refusal names no time", () => {
    const untimed = { quota: undefined, message: "API error 429: Subscription quota exhausted." };
    expect(museQuotaRefusalUpdate(usage, nowMs, untimed)?.windows).toEqual([
      expect.objectContaining({
        id: "window",
        usedPercent: 100,
        resetsAt: "2026-10-08T13:19:17.000Z",
      }),
    ]);
    // Recovery resumes at the same reset Usage shows.
    expect(museUsageLimitResetAt(usage, nowMs, untimed)).toBe("2026-10-08T13:19:17.000Z");
    expect(museQuotaRefusalUpdate(undefined, nowMs, untimed)).toBeUndefined();
    expect(museUsageLimitResetAt(undefined, nowMs, untimed)).toBeNull();
    const typed = { quota: { resetsAtMs: usage.weekly.resetsAtMs } };
    expect(museQuotaRefusalUpdate(usage, nowMs, typed)?.windows[0]?.id).toBe("weekly");
  });

  it("marks nothing when the refusal's own reset has already passed", () => {
    const lapsed = { quota: { resetsAtMs: nowMs - 1 } };
    expect(museQuotaRefusalUpdate(usage, nowMs, lapsed)).toBeUndefined();
    expect(museUsageLimitResetAt(usage, nowMs, lapsed)).toBeNull();
  });

  it("marks both windows when they reset together at the refusal's reset", () => {
    const together = { ...usage, weekly: { ...usage.weekly, resetsAtMs: usage.window.resetsAtMs } };
    const refusal = { quota: { resetsAtMs: usage.window.resetsAtMs } };
    expect(
      museQuotaRefusalUpdate(together, nowMs, refusal)?.windows.map((window) => [
        window.id,
        window.usedPercent,
        window.resetsAt,
      ]),
    ).toEqual([
      ["window", 100, "2026-10-08T13:19:17.000Z"],
      ["weekly", 100, "2026-10-08T13:19:17.000Z"],
    ]);
    expect(museUsageLimitResetAt(together, nowMs, refusal)).toBe("2026-10-08T13:19:17.000Z");
  });

  it("prefers the typed reset over the one the text names", () => {
    const refusal = {
      quota: { resetsAtMs: usage.weekly.resetsAtMs },
      message:
        "API error 429: Subscription quota exhausted. Your usage window resets at 2026-10-08T13:19:17Z.",
    };
    expect(museQuotaRefusalUpdate(usage, nowMs, refusal)?.windows).toEqual([
      expect.objectContaining({
        id: "weekly",
        usedPercent: 100,
        resetsAt: "2026-10-12T00:00:00.000Z",
      }),
    ]);
    expect(museUsageLimitResetAt(usage, nowMs, refusal)).toBe("2026-10-12T00:00:00.000Z");
  });

  it.effect("stops at the refusal this slice hit live while Muse still read ok", () =>
    Effect.gen(function* () {
      expect(isMuseUsageLimitFailure(liveRefusal.message)).toBe(true);
      const at = Date.parse("2026-10-22T05:12:00Z");
      const pending = yield* pendingProvider;

      const unreported = apply(pending, museQuotaRefusalUpdate(undefined, at, liveRefusal));
      expect(project(unreported, at)).toMatchObject({
        windows: [{ kind: "session", usedPercent: 100, resetsAt: liveReset }],
        headroom: "exhausted",
      });
      expect(museUsageLimitResetAt(undefined, at, liveRefusal)).toBe(liveReset);

      const report = {
        observedAtMs: at - 60_000,
        tier: "tier-1",
        window: { usedPercent: 62, windowDurationMins: 300, resetsAtMs: Date.parse(liveReset) },
        weekly: { usedPercent: 40, resetsAtMs: Date.parse("2026-10-26T00:00:00Z") },
      } satisfies MuseSubscriptionUsage;
      const reported = apply(pending, museUsageToUpdate(report));
      expect(project(reported, at).headroom).toBe("ok");
      const refused = apply(reported, museQuotaRefusalUpdate(report, at, liveRefusal));
      expect(project(refused, at)).toMatchObject({
        windows: [
          { kind: "session", usedPercent: 100, resetsAt: liveReset },
          { kind: "weekly", usedPercent: 40, resetsAt: "2026-10-26T00:00:00.000Z" },
        ],
        headroom: "exhausted",
      });

      const after = Date.parse(liveReset) + 1;
      expect(museQuotaRefusalUpdate(report, after, liveRefusal)).toBeUndefined();
      expect(museUsageLimitResetAt(report, after, liveRefusal)).toBeNull();
    }),
  );

  it.effect("attributes a refusal to the reported window its reset matches", () =>
    Effect.gen(function* () {
      // The week ends in two hours, sooner than the short window lasts.
      const weekEnding = {
        ...usage,
        weekly: { usedPercent: 98, resetsAtMs: nowMs + 2 * 3_600_000 },
      };
      const reported = apply(yield* pendingProvider, museUsageToUpdate(weekEnding));
      const refused = apply(
        reported,
        museQuotaRefusalUpdate(weekEnding, nowMs, {
          quota: { resetsAtMs: weekEnding.weekly.resetsAtMs },
        }),
      );
      expect(project(refused)).toMatchObject({
        windows: [
          { kind: "session", usedPercent: 0, resetsAt: "2026-10-08T13:19:17.000Z" },
          { kind: "weekly", usedPercent: 100, resetsAt: "2026-10-08T10:22:42.610Z" },
        ],
        headroom: "exhausted",
      });
    }),
  );

  it.effect("keeps a report across status checks that cannot read limits", () =>
    Effect.gen(function* () {
      const reported = apply(yield* pendingProvider, museUsageToUpdate(usage)).usageLimits;
      const probed = museUsageLimitsBeforeReport(checkedAt);
      expect(resolveUsageLimitsAfterProbe({ published: reported, probed })).toBe(reported);

      const unreported = resolveUsageLimitsAfterProbe({
        published: (yield* pendingProvider).usageLimits,
        probed,
      });
      expect(unreported).toBe(probed);
      const pending = yield* pendingProvider;
      expect(project({ ...pending, usageLimits: unreported! }).headroom).toBe("unknown");
    }),
  );
});
