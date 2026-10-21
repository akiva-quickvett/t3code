import {
  type AgentUsageHeadroom,
  type OrchestrationV2LimitRecovery,
  type OrchestrationV2LimitRecoveryUpdate,
  type ProviderInstanceId,
  type RunId,
  type ServerProvider,
  type UsageHeadroomThresholds,
} from "@t3tools/contracts";
import { switchAccountCandidates } from "@t3tools/client-runtime/state/usage";
import { GaugeIcon } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { LimitWindows } from "../usage/UsageLimits";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { ComposerBanner } from "./ComposerBanner";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

type SwitchAccountProps = {
  readonly providers: readonly ServerProvider[];
  readonly currentInstanceId: ProviderInstanceId;
  readonly thresholds: UsageHeadroomThresholds;
  readonly onSwitch: (instanceId: ProviderInstanceId) => void;
};

type RecoveryProps = {
  runId: RunId;
  resetAt: string | null;
  stoppedAt: string;
  snoozedUntil: string | null;
  recovery: OrchestrationV2LimitRecovery | null;
  onChange: (recovery: OrchestrationV2LimitRecoveryUpdate) => Promise<void>;
  switchAccount: SwitchAccountProps | null;
};

export function usageLimitRecoveryBannerItem(props: RecoveryProps): ComposerBannerStackItem {
  const { runId, resetAt, stoppedAt } = props;
  const canSchedule = resetAt !== null && Date.parse(resetAt) > Date.parse(stoppedAt);
  return {
    id: `usage-limit-recovery:${runId}`,
    variant: "warning",
    priority: "urgent",
    icon: <GaugeIcon />,
    title: "Usage limit reached",
    description: resetAt
      ? `Resets ${new Date(resetAt).toLocaleString()}`
      : "Reset time unavailable; retry manually",
    actions: canSchedule ? <RecoveryActions key={`${runId}:${resetAt}`} {...props} /> : null,
    children: props.switchAccount ? <SwitchAccountList {...props.switchAccount} /> : null,
  };
}

const HEADROOM_BADGE: Record<
  AgentUsageHeadroom,
  { readonly label: string; readonly variant: "success" | "warning" | "error" | "outline" }
> = {
  ok: { label: "Available", variant: "success" },
  low: { label: "Low", variant: "warning" },
  exhausted: { label: "Exhausted", variant: "error" },
  unknown: { label: "Unknown", variant: "outline" },
};

// Memoized on props that only change with provider snapshots, so composer
// typing and other chat renders skip it.
const SwitchAccountList = memo(function SwitchAccountList({
  providers,
  currentInstanceId,
  thresholds,
  onSwitch,
}: SwitchAccountProps) {
  const [now, setNow] = useState(() => Date.now());
  const candidates = switchAccountCandidates(providers, currentInstanceId, thresholds, now);
  // One timer, not a ticking clock: catch up after a snapshot update, then wake
  // at the next reset so a refilled window stops counting against its account.
  useEffect(() => {
    const nextReset = Math.min(
      ...candidates.flatMap((account) =>
        account.windows.flatMap((limitWindow) => {
          const at = Date.parse(limitWindow.resetsAt ?? "");
          return at > now ? [at] : [];
        }),
      ),
    );
    const delay = Date.now() - now > 1_000 ? 0 : nextReset - Date.now() + 1;
    if (!Number.isFinite(delay)) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(delay, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [candidates, now]);
  if (candidates.length === 0) return null;
  return (
    <ComposerBanner.Body className="flex flex-col gap-2 pt-1 pb-1.5 pe-2">
      <span className="text-xs font-medium text-muted-foreground">Switch account</span>
      {candidates.map((account) => {
        const badge = HEADROOM_BADGE[account.headroom];
        // Bars read the raw snapshot, as Usage → Limits does; the projection's
        // floored percentages are for agents and would read 1% off here.
        const limits = providers.find(
          (provider) => provider.instanceId === account.instanceId,
        )?.usageLimits;
        const windows = limits?.unavailable ? [] : (limits?.windows ?? []);
        return (
          <div key={account.instanceId} className="flex min-w-0 flex-col gap-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-xs">
                {account.label}
                {account.plan ? ` · ${account.plan}` : null}
              </span>
              <Badge size="sm" variant={badge.variant}>
                {badge.label}
              </Badge>
              <Button
                size="xs"
                variant="ghost"
                className="ms-auto"
                onClick={() => onSwitch(account.instanceId)}
              >
                Switch
              </Button>
            </div>
            {windows.length > 0 ? (
              <LimitWindows compact driver={account.driver} windows={windows} now={now} />
            ) : null}
          </div>
        );
      })}
    </ComposerBanner.Body>
  );
});

function RecoveryActions({ runId, resetAt, recovery, snoozedUntil, onChange }: RecoveryProps) {
  const [pending, setPending] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const delay = Date.parse(resetAt ?? "") - Math.max(nowMs, Date.now());
    if (!Number.isFinite(delay) || delay <= 0) return;
    const timer = window.setTimeout(() => setNowMs(Date.now()), Math.min(delay + 1, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [resetAt, nowMs]);

  const scheduled =
    recovery?.runId === runId && recovery.resetAt === resetAt && recovery.autoResume;
  const snoozed =
    recovery?.snooze === true &&
    recovery.runId === runId &&
    recovery.resetAt === resetAt &&
    resetAt !== null &&
    snoozedUntil !== null &&
    Date.parse(snoozedUntil) === Date.parse(resetAt);
  async function toggle(action: "resume" | "snooze") {
    if (resetAt === null) return;
    if (action === "snooze" && !snoozed && Date.parse(resetAt) <= Date.now()) {
      toastManager.add({
        type: "error",
        title: "Could not snooze thread",
        description: "The reset time has passed. Retry the thread manually.",
      });
      setNowMs(Date.now());
      return;
    }
    setPending(true);
    try {
      await onChange({
        runId,
        resetAt,
        ...(action === "resume" ? { autoResume: !scheduled } : { snooze: !snoozed }),
      });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: action === "resume" ? "Could not change auto-resume" : "Could not snooze thread",
        description: cause instanceof Error ? cause.message : "An error occurred.",
      });
    }
    setPending(false);
  }
  // Failures go to a toast: the actions column is auto-sized, so inline error
  // text would widen it and crush the title.
  return (
    <>
      <Button size="xs" variant="ghost" disabled={pending} onClick={() => void toggle("resume")}>
        {pending ? "Saving..." : scheduled ? "Cancel auto-resume" : "Resume at reset"}
      </Button>
      {!snoozed ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={pending || Date.parse(resetAt!) <= nowMs}
          onClick={() => void toggle("snooze")}
        >
          {pending ? "Saving..." : "Snooze until reset"}
        </Button>
      ) : null}
    </>
  );
}
