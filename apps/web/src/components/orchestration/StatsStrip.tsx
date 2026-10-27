import {
  activeAgentsDot,
  createSliceBurnReader,
  formatActiveAgents,
  formatBurn,
  headroomDot,
  hostVerdictRows,
  metaBurnRow,
  statsSummaryText,
} from "@t3tools/client-runtime/state/orchestration-stats";
import type { EnvironmentId, HostHeadroom, ThreadId } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { cn } from "~/lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useServerConfigs } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { OrchestrationDot } from "./OrchestrationDot";

const statsAtom = (environmentId: EnvironmentId) =>
  serverEnvironment.orchestrationStatsLive({ environmentId, input: {} });

/** A slice's burn for its tooltip, read on hover; null unless a strip holds the stream. */
export const sliceBurn = createSliceBurnReader(appAtomRegistry, statsAtom);

export interface StatsStripMeta {
  readonly threadId: ThreadId;
  readonly title: string;
}

export interface StatsStripProps {
  readonly environmentId: EnvironmentId;
  /** The metas in the tab bar, for the per-meta burn row. */
  readonly metas?: ReadonlyArray<StatsStripMeta>;
}

const NO_METAS: ReadonlyArray<StatsStripMeta> = [];

const VERDICT_TEXT: Record<HostHeadroom, string> = {
  ok: "text-success-foreground",
  low: "text-warning-foreground",
  exhausted: "text-error-foreground",
  unknown: "",
};

/** Stock servers send no stats, so the strip renders nothing and opens no stream. */
export function StatsStrip({ environmentId, metas = NO_METAS }: StatsStripProps) {
  const supported =
    useServerConfigs().get(environmentId)?.environment.capabilities.orchestrationStats === true;
  if (!supported) return null;
  return <LiveStatsStrip environmentId={environmentId} metas={metas} />;
}

function LiveStatsStrip({
  environmentId,
  metas,
}: {
  readonly environmentId: EnvironmentId;
  readonly metas: ReadonlyArray<StatsStripMeta>;
}) {
  const snapshot = useEnvironmentQuery(statsAtom(environmentId)).data;
  const [expanded, setExpanded] = useState(false);
  // Hold the line's height until the first snapshot so the sidebar bottom does not jump.
  if (snapshot === null) return <div className="h-5 shrink-0 border-t border-border" />;
  const { activeAgents, burn, host } = snapshot;
  const metaRow = metaBurnRow(burn.perMeta, metas);
  return (
    <div className="shrink-0 border-t border-border text-2xs text-muted-foreground tabular-nums">
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={statsSummaryText(snapshot)}
        aria-controls={`stats-strip-details-${environmentId}`}
        onClick={() => setExpanded((open) => !open)}
        className="flex h-5 w-full items-center gap-1.5 overflow-hidden whitespace-nowrap px-2.5 text-left"
      >
        <OrchestrationDot dot={activeAgentsDot(activeAgents)} label="Agents" />
        <span>{formatActiveAgents(activeAgents)}</span>
        <span className="opacity-50">│</span>
        <span>{formatBurn(burn)}</span>
        <span className="opacity-50">│</span>
        <span>host</span>
        <OrchestrationDot dot={headroomDot(host.verdict)} label={`Host ${host.verdict}`} />
        <span className={VERDICT_TEXT[host.verdict]}>{host.verdict}</span>
        <ChevronDownIcon
          aria-hidden
          className={cn("ml-auto size-2.5 shrink-0", expanded && "rotate-180")}
        />
      </button>
      {expanded ? (
        <div
          id={`stats-strip-details-${environmentId}`}
          className="border-t border-dashed border-border px-2.5 pt-0.5 pb-1.5"
        >
          <DetailRow label="turns running">{activeAgents.runningTurns}</DetailRow>
          <DetailRow label="live provider sessions">
            {activeAgents.liveSessions} · {activeAgents.idleSessions} idle
          </DetailRow>
          <DetailRow label="burn (10 min, completed turns)">{formatBurn(burn)}</DetailRow>
          {metaRow === null ? null : <DetailRow label={metaRow.labels}>{metaRow.values}</DetailRow>}
          {hostVerdictRows(host).map((row) => (
            <DetailRow key={row.resource} label={row.resource}>
              <span className={VERDICT_TEXT[row.verdict]}>{row.verdict}</span>
            </DetailRow>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DetailRow({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex h-4.5 items-center justify-between gap-2 whitespace-nowrap">
      <span className="min-w-0 truncate">{label}</span>
      <span className="shrink-0">{children}</span>
    </div>
  );
}
