import type {
  EnvironmentId,
  HostHeadroom,
  OrchestrationBurnRate,
  OrchestrationDot,
  OrchestrationStatsSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import { hostResourceVerdicts } from "@t3tools/shared/hostHeadroom";
import * as Option from "effect/Option";
import { AsyncResult, type Atom, type AtomRegistry } from "effect/reactivity";

/** Two significant figures, so the strip changes only when the server would publish. */
function twoSignificant(value: number): number {
  return value === 0 ? 0 : Number(value.toPrecision(2));
}

export function formatTokenRate(tokensPerMinute: number): string {
  const rounded = twoSignificant(Math.max(0, tokensPerMinute));
  const figure =
    rounded >= 1e6 ? `${rounded / 1e6}M` : rounded >= 1e3 ? `${rounded / 1e3}k` : `${rounded}`;
  return `${figure} tok/m`;
}

export function formatUsdPerHour(usdPerHour: number, approximate = false): string {
  return `${approximate ? "≈" : ""}$${twoSignificant(Math.max(0, usdPerHour))}/h`;
}

/** Tokens and dollars, or "≈ warming" until the server's window has filled once. */
export function formatBurn(burn: OrchestrationStatsSnapshot["burn"]): string {
  if (burn.state === "warming") return "≈ warming";
  return `${formatTokenRate(burn.tokensPerMinute)} · ${formatUsdPerHour(burn.usdPerHour, burn.approximate)}`;
}

const HEADROOM_DOTS: Record<HostHeadroom, OrchestrationDot> = {
  ok: "done-unread",
  low: "needs-you",
  exhausted: "failed",
  unknown: "idle",
};

/** The dot whose colour matches a verdict: done, warning, error, or quiet when unknown. */
export function headroomDot(verdict: HostHeadroom): OrchestrationDot {
  return HEADROOM_DOTS[verdict];
}

export function activeAgentsDot(activeAgents: OrchestrationStatsSnapshot["activeAgents"]) {
  return activeAgents.runningTurns > 0 ? ("working" as const) : ("idle" as const);
}

export function formatActiveAgents(activeAgents: OrchestrationStatsSnapshot["activeAgents"]) {
  return `${activeAgents.liveSessions} active · ${activeAgents.idleSessions} idle`;
}

/** The collapsed line as plain text, for the strip's accessible name. */
export function statsSummaryText(snapshot: OrchestrationStatsSnapshot): string {
  return [
    formatActiveAgents(snapshot.activeAgents),
    formatBurn(snapshot.burn),
    `host ${snapshot.host.verdict}`,
  ].join(", ");
}

export interface HostVerdictRow {
  readonly resource: "ram" | "swap" | "load" | "cpu";
  readonly verdict: HostHeadroom;
}

/**
 * CPU is low only over two samples and the snapshot carries one, so CPU reads
 * low only when the server's verdict is low or worse and no other resource
 * explains it. Exact rows need per-resource verdicts from the server.
 */
export function hostVerdictRows(host: OrchestrationStatsSnapshot["host"]): HostVerdictRow[] {
  const verdicts = hostResourceVerdicts(host);
  const othersFine = [verdicts.ram, verdicts.swap, verdicts.load].every(
    (verdict) => verdict === "ok" || verdict === "unknown",
  );
  const overallLow = host.verdict === "low" || host.verdict === "exhausted";
  const cpu: HostHeadroom =
    overallLow && othersFine && host.cpu !== null && host.cpu > 0.9 ? "low" : verdicts.cpu;
  return (["ram", "swap", "load", "cpu"] as const).map((resource) => ({
    resource,
    verdict: resource === "cpu" ? cpu : verdicts[resource],
  }));
}

export interface MetaBurnRow {
  readonly labels: string;
  readonly values: string;
}

/** One row over the metas that have a figure; null when none has one yet. */
export function metaBurnRow(
  perMeta: OrchestrationStatsSnapshot["burn"]["perMeta"],
  metas: ReadonlyArray<{ readonly threadId: ThreadId; readonly title: string }>,
): MetaBurnRow | null {
  const known = metas.flatMap((meta) => {
    const rate = perMeta[meta.threadId];
    return rate === undefined ? [] : [{ title: meta.title, rate }];
  });
  if (known.length === 0) return null;
  return {
    labels: known.map((entry) => entry.title).join(" · "),
    values: known.map((entry) => formatUsdPerHour(entry.rate.usdPerHour)).join(" · "),
  };
}

export function sliceBurnOf(
  snapshot: OrchestrationStatsSnapshot | null,
  sliceThreadId: ThreadId,
): OrchestrationBurnRate | null {
  return snapshot?.burn.perSlice[sliceThreadId] ?? null;
}

/**
 * Reads a slice's burn on demand, e.g. when its tooltip opens, so slice rows
 * never re-render on stats pushes. It peeks at the registry node and never
 * mounts the atom: with no strip mounted there is no subscription to open, and
 * the answer is null.
 */
export function createSliceBurnReader(
  registry: AtomRegistry.AtomRegistry,
  statsAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationStatsSnapshot, unknown>>,
) {
  return (environmentId: EnvironmentId, sliceThreadId: ThreadId): OrchestrationBurnRate | null => {
    const node = registry.getNodes().get(statsAtom(environmentId));
    if (node === undefined) return null;
    const result: AsyncResult.AsyncResult<OrchestrationStatsSnapshot, unknown> = node.value();
    return sliceBurnOf(Option.getOrNull(AsyncResult.value(result)), sliceThreadId);
  };
}
