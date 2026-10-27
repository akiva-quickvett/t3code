import type { OrganId, ThreadId } from "@t3tools/contracts";
import type { OrganGroup } from "@t3tools/client-runtime/state/subagentRuntime";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { memo, useState } from "react";

import { cn } from "~/lib/utils";
import { OrchestrationDot } from "../orchestration/OrchestrationDot";
import { ComposerBannerDockScroll, type ComposerBannerStackContent } from "./ComposerBannerStack";
import {
  organDockOrgansEqual,
  organDockRowSummary,
  organDockSummaryText,
  selectOrganDockOrgans,
  type OrganDockCell,
  type OrganDockOrgan,
} from "./OrganDock.logic";

/**
 * The thread's running organs, kept by reference until something the dock draws changes, so a
 * cell streaming output (a new projection every token) never re-renders the dock.
 */
export function useOrganDockOrgans(
  groups: ReadonlyArray<OrganGroup>,
  labelOf?: (group: OrganGroup) => string,
): ReadonlyArray<OrganDockOrgan> {
  const next = selectOrganDockOrgans(groups, labelOf);
  const [kept, setKept] = useState(next);
  if (!organDockOrgansEqual(kept, next)) {
    setKept(next);
    return next;
  }
  return kept;
}

/**
 * One stack entry for every running organ: the stack shows only its front entry and hides the
 * rest behind a peek, so per-organ entries would hide all organs but one, and the summary header
 * and the 360px cap belong to the dock as a whole.
 */
export function organDockBannerItem(
  organs: ReadonlyArray<OrganDockOrgan>,
  onOpenCell: (threadId: ThreadId) => void,
): ComposerBannerStackContent | null {
  if (organs.length === 0) return null;
  return {
    id: "organ-dock",
    variant: "default",
    priority: "activity",
    layout: "dock",
    content: <OrganDock organs={organs} onOpenCell={onOpenCell} />,
  };
}

export const OrganDock = memo(function OrganDock({
  organs,
  onOpenCell,
}: {
  readonly organs: ReadonlyArray<OrganDockOrgan>;
  readonly onOpenCell: (threadId: ThreadId) => void;
}) {
  const [minimised, setMinimised] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<OrganId>>(() => new Set());
  const toggleOrgan = (organId: OrganId) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(organId)) next.add(organId);
      return next;
    });

  return (
    <div data-organ-dock="true" className="text-xs">
      <button
        type="button"
        aria-expanded={!minimised}
        onClick={() => setMinimised((value) => !value)}
        className="flex h-7 w-full cursor-pointer items-center gap-2 px-3 text-start text-muted-foreground"
      >
        <span className="min-w-0 flex-1 truncate">{organDockSummaryText(organs)}</span>
        <ChevronDownIcon aria-hidden className={cn("size-3.5", minimised && "rotate-180")} />
      </button>
      {minimised ? null : (
        <ComposerBannerDockScroll>
          {organs.map((organ) => (
            <OrganDockRow
              key={organ.organId}
              organ={organ}
              expanded={expanded.has(organ.organId)}
              onToggle={() => toggleOrgan(organ.organId)}
              onOpenCell={onOpenCell}
            />
          ))}
        </ComposerBannerDockScroll>
      )}
    </div>
  );
});

function OrganDockRow({
  organ,
  expanded,
  onToggle,
  onOpenCell,
}: {
  readonly organ: OrganDockOrgan;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onOpenCell: (threadId: ThreadId) => void;
}) {
  const { dot, settled, total } = organDockRowSummary(organ);
  return (
    <div data-organ-id={organ.organId}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex h-7 w-full cursor-pointer items-center gap-2 whitespace-nowrap px-3 text-start hover:bg-accent"
      >
        <OrchestrationDot dot={dot} />
        <span className="w-[150px] flex-none truncate font-medium">{organ.label}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{organ.goal}</span>
        <span className="text-2xs text-muted-foreground tabular-nums">
          {settled}/{total}
        </span>
        {organ.round > 1 ? (
          <span className="text-2xs text-muted-foreground">r{organ.round}</span>
        ) : null}
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3.5 text-muted-foreground", expanded && "rotate-90")}
        />
      </button>
      {expanded ? (
        <div className="pb-1 pl-9 pr-3">
          {organ.cells.map((cell) => (
            <OrganDockCellRow key={cell.key} cell={cell} onOpenCell={onOpenCell} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function OrganDockCellRow({
  cell,
  onOpenCell,
}: {
  readonly cell: OrganDockCell;
  readonly onOpenCell: (threadId: ThreadId) => void;
}) {
  const { childThreadId } = cell;
  return (
    <button
      type="button"
      disabled={childThreadId === null}
      onClick={childThreadId === null ? undefined : () => onOpenCell(childThreadId)}
      className="flex h-6 w-full cursor-pointer items-center gap-2 whitespace-nowrap rounded-md px-2 text-start hover:bg-accent disabled:cursor-default disabled:hover:bg-transparent"
    >
      <OrchestrationDot dot={cell.dot} />
      <span className="w-24 flex-none truncate">{cell.role ?? "cell"}</span>
      <span className="w-28 flex-none truncate text-muted-foreground">{cell.model}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{cell.status}</span>
    </button>
  );
}
