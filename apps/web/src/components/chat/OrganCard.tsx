import type { OrchestrationDot as OrchestrationDotKind, ThreadId } from "@t3tools/contracts";
import { ArrowUpRightIcon, ChevronRightIcon } from "lucide-react";
import { memo, useState } from "react";

import { cn } from "~/lib/utils";
import { OrchestrationDot } from "../orchestration/OrchestrationDot";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { AgentElapsed } from "./AgentElapsed";
import {
  ORGAN_CELL_STATE_LABELS,
  type OrganCardGroup,
  type OrganCardSection,
  type OrganCellState,
  organCardAvatars,
  organCardSummary,
} from "./OrganCard.logic";

/**
 * One shell for an organ group and a provider-native workflow group; build `group` with
 * `organCardFromOrgan` or `organCardFromWorkflow`. The card reads nothing but its props, so
 * expanding it never subscribes to a cell's thread: transcripts load only when a handler opens one.
 */
export interface OrganCardProps {
  readonly group: OrganCardGroup;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  /** The whole cell row. */
  readonly onOpenCell: (threadId: ThreadId) => void;
  /** The row's ↗. */
  readonly onOpenChat: (threadId: ThreadId) => void;
  /** The header's ↗, for a group with a chat of its own (a workflow's coordinator). */
  readonly onOpenGroupChat?: (() => void) | undefined;
}

export const OrganCard = memo(function OrganCard({
  group,
  expanded,
  onToggle,
  onOpenCell,
  onOpenChat,
  onOpenGroupChat,
}: OrganCardProps) {
  const cells = group.sections.flatMap((section) => section.cells);
  const avatars = organCardAvatars(cells);
  const summary = organCardSummary(cells);
  const active = group.sections.some((section) => section.running);
  return (
    <div
      data-organ-card={group.kind}
      className="overflow-hidden rounded-lg border border-border bg-card"
    >
      <Collapsible open={expanded} onOpenChange={onToggle}>
        <div className="flex items-center hover:bg-accent/50">
          <CollapsibleTrigger
            aria-label={`${group.label}, ${summary}`}
            className="flex h-11 min-w-0 flex-1 items-center gap-2.5 px-3 text-left text-sm"
          >
            <ChevronRightIcon
              aria-hidden
              className={cn("size-3.5 shrink-0 text-muted-foreground", expanded && "rotate-90")}
            />
            <span className="flex shrink-0 items-center -space-x-1.5" aria-hidden>
              {avatars.initials.map(({ key, initial }) => (
                <span
                  key={key}
                  className="inline-flex size-5 items-center justify-center rounded-full bg-muted font-bold text-3xs text-foreground ring-2 ring-card"
                >
                  {initial}
                </span>
              ))}
              {avatars.overflow > 0 ? (
                <span className="inline-flex size-5 items-center justify-center rounded-full bg-muted font-medium text-3xs text-muted-foreground ring-2 ring-card">
                  +{avatars.overflow}
                </span>
              ) : null}
            </span>
            <span className="shrink-0 truncate font-medium">{group.label}</span>
            {group.round !== null && group.round > 1 ? (
              <span className="shrink-0 rounded border border-border px-1 text-3xs text-muted-foreground tabular-nums">
                r{group.round}
              </span>
            ) : null}
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-xs text-muted-foreground",
                active ? "text-info" : group.outcome?.status === "failed" && "text-destructive",
              )}
            >
              {summary}
            </span>
            <span className="shrink-0 text-2xs text-muted-foreground">
              <AgentElapsed agent={group.timing} />
            </span>
          </CollapsibleTrigger>
          {onOpenGroupChat ? (
            <Button
              variant="ghost"
              size="icon-micro"
              aria-label={`Open ${group.label} chat`}
              title="Open full chat"
              className="mr-2"
              onClick={onOpenGroupChat}
            >
              <ArrowUpRightIcon />
            </Button>
          ) : null}
        </div>
        {/* Virtualized timeline rows must settle before disclosure scroll anchoring resumes. */}
        <CollapsiblePanel animate={false}>
          {expanded ? (
            <div className="border-t border-border px-3 pt-2 pb-2.5">
              {group.goal !== null ? (
                <p className="mb-1.5 line-clamp-2 text-xs">
                  <span className="text-muted-foreground">Goal</span> {group.goal}
                </p>
              ) : null}
              {group.sections.map((section) => (
                <OrganCardSectionView
                  key={section.key}
                  section={section}
                  onOpenCell={onOpenCell}
                  onOpenChat={onOpenChat}
                />
              ))}
              {group.outcome !== null ? (
                <div className="mt-2 border-t border-dashed border-border pt-1.5 text-xs">
                  <span
                    className={cn(
                      "mr-1.5",
                      group.outcome.status === "failed"
                        ? "text-destructive"
                        : "text-muted-foreground",
                    )}
                  >
                    Outcome · {OUTCOME_LABELS[group.outcome.status]}
                  </span>
                  {group.outcome.summary !== null ? (
                    <p className="line-clamp-3 whitespace-pre-line">{group.outcome.summary}</p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
});

const OUTCOME_LABELS = { completed: "finished", failed: "failed", stopped: "stopped" } as const;

function OrganCardSectionView({
  section,
  onOpenCell,
  onOpenChat,
}: {
  readonly section: OrganCardSection;
  readonly onOpenCell: (threadId: ThreadId) => void;
  readonly onOpenChat: (threadId: ThreadId) => void;
}) {
  // An untouched section follows the adapter, so a new round folds the previous one; a section
  // the user toggled keeps their choice.
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? section.defaultOpen;
  const rows = section.cells.map((cell) => (
    <OrganCellRow
      key={cell.key}
      threadId={cell.threadId}
      role={cell.role}
      model={cell.model}
      dot={cell.dot}
      state={cell.state}
      onOpenCell={onOpenCell}
      onOpenChat={onOpenChat}
    />
  ));
  if (section.title === null) return rows;
  const count = `${section.cells.length} ${section.cells.length === 1 ? "cell" : "cells"}`;
  return (
    <Collapsible open={open} onOpenChange={setOverride}>
      <CollapsibleTrigger className="mt-0.5 flex h-6 w-full items-center gap-2 text-left text-2xs text-muted-foreground">
        <ChevronRightIcon aria-hidden className={cn("size-3 shrink-0", open && "rotate-90")} />
        <span className="shrink-0">
          {section.title}
          {section.running ? " · running" : ""}
        </span>
        <span aria-hidden className="h-px flex-1 bg-border" />
        <span className="shrink-0 tabular-nums">{count}</span>
      </CollapsibleTrigger>
      <CollapsiblePanel animate={false}>{open ? rows : null}</CollapsiblePanel>
    </Collapsible>
  );
}

const STATE_TINT: Partial<Record<OrganCellState, string>> = {
  "needs-you": "text-warning-foreground",
  limited: "text-warning-foreground",
  failed: "text-destructive",
};

/**
 * Primitive props only: a streaming cell hands the card a new group, and every row whose own
 * fields did not change skips the render.
 */
const OrganCellRow = memo(function OrganCellRow({
  threadId,
  role,
  model,
  dot,
  state,
  onOpenCell,
  onOpenChat,
}: {
  readonly threadId: ThreadId | null;
  readonly role: string;
  readonly model: string | null;
  readonly dot: OrchestrationDotKind;
  readonly state: OrganCellState;
  readonly onOpenCell: (threadId: ThreadId) => void;
  readonly onOpenChat: (threadId: ThreadId) => void;
}) {
  const stateLabel = ORGAN_CELL_STATE_LABELS[state];
  return (
    <div
      data-organ-cell
      className="group/cell relative flex h-6 items-center gap-2 rounded-sm pr-1 pl-2 text-xs hover:bg-accent/50"
    >
      {/* The row and ↗ are sibling buttons, so neither press can reach the other. */}
      {threadId !== null ? (
        <button
          type="button"
          aria-label={`Open ${role} beside the chat`}
          className="absolute inset-0 cursor-pointer rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
          onClick={() => onOpenCell(threadId)}
        />
      ) : null}
      <span className="pointer-events-none flex shrink-0 items-center">
        <OrchestrationDot dot={dot} />
      </span>
      <span className="pointer-events-none w-30 shrink-0 truncate">{role}</span>
      <span className="pointer-events-none w-30 shrink-0 truncate text-muted-foreground">
        {model ?? ""}
      </span>
      <span
        className={cn(
          "pointer-events-none min-w-0 flex-1 truncate text-muted-foreground",
          STATE_TINT[state],
        )}
      >
        {stateLabel}
      </span>
      {threadId !== null ? (
        <span className="relative flex opacity-0 group-hover/cell:opacity-100 group-focus-within/cell:opacity-100">
          <Button
            variant="ghost"
            size="icon-micro"
            aria-label={`Open ${role} chat`}
            title="Open full chat"
            onClick={() => onOpenChat(threadId)}
          >
            <ArrowUpRightIcon />
          </Button>
        </span>
      ) : null}
    </div>
  );
});
