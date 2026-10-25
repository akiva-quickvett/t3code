import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { OrchestrationRootRollup } from "@t3tools/client-runtime/state/orchestration-tree";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import { orchestrationThreadInput } from "@t3tools/client-runtime/state/orchestration-tree";
import { threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { resolveOrchestrationDot } from "@t3tools/shared/orchestrationTree";
import { Atom } from "effect/reactivity";
import {
  BoxIcon,
  ChevronRightIcon,
  EllipsisIcon,
  GitBranchIcon,
  MessageSquareIcon,
  TicketIcon,
} from "lucide-react";
import { memo, type MouseEvent, useEffect, useEffectEvent, useState } from "react";

import { useThreadActionMenu } from "../../hooks/useThreadActionMenu";
import { cn } from "../../lib/utils";
import { useProject, useQuietThreadShell } from "../../state/entities";
import { orchestrationTree } from "../../state/orchestrationTree";
import { Button } from "../ui/button";
import { OrchestrationDot } from "./OrchestrationDot";
import { isEnvironmentStale, useEnvironmentConnection } from "./StaleBanner";

export type TreeRowKind = "slice" | "pod" | "ad-hoc" | "branch";

/**
 * Every prop is a primitive or a stable callback, so a container re-render
 * with an equal row model commits nothing here.
 */
export interface TreeRowProps {
  /** The row's key in the container's flat row model; callbacks receive it. */
  readonly rowKey: string;
  readonly environmentId: EnvironmentId;
  /** Null for rows that are not threads (branches). */
  readonly threadId: ThreadId | null;
  /** Shown when the row has no thread, or before its shell arrives. */
  readonly label: string;
  readonly kind: TreeRowKind;
  readonly depth: number;
  /** Bit `i` draws the indent guide of level `i`. */
  readonly guideMask: number;
  /** Null for leaves. */
  readonly expanded: boolean | null;
  /** `orchestrationTree.rollupAtom`'s root key; read only while collapsed. */
  readonly rollupKey: string | null;
  readonly repoTag: string | null;
  readonly noSlice: boolean;
  readonly selected: boolean;
  readonly onSelect: (rowKey: string) => void;
  readonly onToggle: (rowKey: string) => void;
  readonly onRename: (rowKey: string) => void;
}

const KIND_ICONS = {
  slice: TicketIcon,
  pod: BoxIcon,
  "ad-hoc": MessageSquareIcon,
  branch: GitBranchIcon,
} satisfies Record<TreeRowKind, unknown>;

const GUIDE_STEP_PX = 12;

const NO_ROLLUP_ATOM = Atom.make<OrchestrationRootRollup | null>(null).pipe(
  Atom.withLabel("web-orchestration-row-rollup:none"),
);

// Module scope so the compiler keys it on its arguments: `now` is read when
// the quiet shell or the connection changes, never on a timer, as the tree
// atoms do.
function resolveRowDot(
  shell: EnvironmentThreadShell,
  environmentConnected: boolean,
  shellStatus: EnvironmentShellStatus,
) {
  const now = new Date().toISOString();
  const input = orchestrationThreadInput(shell, {
    parentKey: null,
    wokeAt: threadWokeAt(shell, { now }),
    now,
    environmentConnected,
    shellStatus,
  });
  return resolveOrchestrationDot(input.status, shell.createdAt);
}

function guideStyle(depth: number, guideMask: number) {
  const offsets: string[] = [];
  for (let level = 0; level < depth; level += 1) {
    if (guideMask & (1 << level)) offsets.push(`${level * GUIDE_STEP_PX + 5}px 0`);
  }
  return {
    width: depth * GUIDE_STEP_PX,
    backgroundImage: offsets
      .map(() => "linear-gradient(var(--color-border),var(--color-border))")
      .join(","),
    backgroundSize: "1px 100%",
    backgroundRepeat: "no-repeat",
    backgroundPosition: offsets.join(","),
  };
}

export const TreeRow = memo(function TreeRow(props: TreeRowProps) {
  const { rowKey, environmentId, threadId, kind, depth, guideMask, expanded, selected } = props;
  const threadRef = threadId === null ? null : scopeThreadRef(environmentId, threadId);
  const shell = useQuietThreadShell(threadRef);
  const connection = useEnvironmentConnection(environmentId);
  const { environmentConnected, shellStatus } = connection;
  const collapsed = expanded === false;
  const rollup = useAtomValue(
    collapsed && props.rollupKey !== null
      ? orchestrationTree.rollupAtom(environmentId, props.rollupKey)
      : NO_ROLLUP_ATOM,
  );
  const own = shell === null ? null : resolveRowDot(shell, environmentConnected, shellStatus);
  const stale = isEnvironmentStale(connection);
  const dim = own?.dim === true && !stale;
  const dot = collapsed && rollup !== null ? rollup.dot : (own?.dot ?? null);
  const needsYouCount = collapsed ? (rollup?.needsYouCount ?? 0) : 0;
  const KindIcon = KIND_ICONS[kind];
  const [menuAt, setMenuAt] = useState<MenuRequest | null>(null);

  const openMenu = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setMenuAt({ x: event.clientX, y: event.clientY });
  };

  return (
    <div
      role="treeitem"
      aria-selected={selected}
      aria-expanded={expanded ?? undefined}
      aria-level={depth + 1}
      data-row-key={rowKey}
      data-stale={stale || undefined}
      data-dim={dim || undefined}
      onClick={() => props.onSelect(rowKey)}
      className={cn(
        "group/tree-row relative flex h-6 cursor-pointer select-none items-center whitespace-nowrap pr-1.5 text-xs hover:bg-accent",
        selected &&
          "bg-accent/60 before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary",
        stale && "opacity-45",
      )}
    >
      <span className="flex w-5 shrink-0 items-center pl-2">
        {dot !== null && <OrchestrationDot dot={dot} />}
      </span>
      {depth > 0 && <span className="h-6 shrink-0" style={guideStyle(depth, guideMask)} />}
      <span
        className="flex w-3 shrink-0 items-center justify-center self-stretch text-muted-foreground"
        onClick={
          expanded === null
            ? undefined
            : (event) => {
                event.stopPropagation();
                props.onToggle(rowKey);
              }
        }
      >
        {expanded !== null && (
          <ChevronRightIcon className={cn("size-2.5", expanded && "rotate-90")} aria-hidden />
        )}
      </span>
      <span
        className={cn(
          "mr-1 flex w-3.5 shrink-0 items-center justify-center text-muted-foreground",
          dim && "opacity-55",
        )}
      >
        <KindIcon className="size-3" aria-hidden />
      </span>
      <span className={cn("min-w-0 flex-1 truncate", dim && "opacity-55")}>
        {shell?.title ?? props.label}
      </span>
      {props.repoTag !== null && <RowTag dim={dim}>{props.repoTag}</RowTag>}
      {props.noSlice && <RowTag dim={dim}>no slice</RowTag>}
      <span className="flex w-7 shrink-0 items-center justify-end group-hover/tree-row:invisible">
        {needsYouCount > 0 && (
          <span
            aria-label={`${needsYouCount} need you`}
            className="h-3.5 min-w-3.5 rounded-full bg-warning px-1 text-center font-semibold text-3xs text-black/90 tabular-nums leading-3.5"
          >
            {needsYouCount}
          </span>
        )}
      </span>
      {threadRef !== null && (
        <span className="absolute top-1 right-2 hidden group-hover/tree-row:flex">
          <Button variant="ghost" size="icon-tiny" aria-label="Thread actions" onClick={openMenu}>
            <EllipsisIcon />
          </Button>
        </span>
      )}
      {threadRef !== null && shell !== null && menuAt !== null && (
        <TreeRowMenu
          threadRef={threadRef}
          projectId={shell.projectId}
          request={menuAt}
          onStartRename={() => props.onRename(rowKey)}
        />
      )}
    </div>
  );
});

function RowTag({ dim, children }: { readonly dim: boolean; readonly children: string }) {
  return (
    <span
      className={cn(
        "ml-1.5 inline-flex h-4 max-w-22 shrink-0 items-center truncate rounded border border-border bg-muted px-1.5 text-3xs text-muted-foreground",
        dim && "opacity-55",
      )}
    >
      {children}
    </span>
  );
}

interface MenuRequest {
  readonly x: number;
  readonly y: number;
}

/**
 * Mounted on the first "…" click, so idle rows carry none of the shared
 * menu's subscriptions. Each click's new request object reopens it.
 */
function TreeRowMenu(props: {
  readonly threadRef: ScopedThreadRef;
  readonly projectId: EnvironmentThreadShell["projectId"];
  readonly request: MenuRequest;
  readonly onStartRename: () => void;
}) {
  const project = useProject(scopeProjectRef(props.threadRef.environmentId, props.projectId));
  const { openMenu } = useThreadActionMenu({
    threadRef: props.threadRef,
    projectCwd: project?.workspaceRoot ?? null,
    onStartRename: props.onStartRename,
  });
  const open = useEffectEvent((request: MenuRequest) => openMenu(request));
  useEffect(() => open(props.request), [props.request]);
  return null;
}
