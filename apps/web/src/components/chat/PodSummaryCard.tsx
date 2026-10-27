import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { orchestrationThreadInput } from "@t3tools/client-runtime/state/orchestration-tree";
import { podRuntimeActions } from "@t3tools/client-runtime/state/pod-runtime";
import type {
  EnvironmentShellStatus,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  deriveOrganGroups,
  type OrganCellShell,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import {
  orchestrationParentThreadId,
  resolveOrchestrationDot,
} from "@t3tools/shared/orchestrationTree";
import { useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import {
  BoxIcon,
  ChevronRightIcon,
  CopyIcon,
  EllipsisIcon,
  GitBranchIcon,
  GlobeIcon,
  SquareTerminalIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { useQuietThreadShell, useThreadProjection } from "../../state/entities";
import { environmentConnectedAtom, orchestrationTree } from "../../state/orchestrationTree";
import {
  useEnvironmentSupportsPodRuntime,
  useMountPodRuntime,
  useWorktreePod,
} from "../../state/podRuntime";
import { environmentShell } from "../../state/shell";
import { environmentThreadShells } from "../../state/threads";
import { buildThreadRouteParams } from "../../threadRoutes";
import { OrchestrationDot } from "../orchestration/OrchestrationDot";
import { isEnvironmentStale, useEnvironmentConnection } from "../orchestration/StaleBanner";
import { usePodActions } from "../pods/usePodActions";
import { useThreadPodServiceMenu } from "../pods/useThreadPodServiceMenu";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { podOrganCount, podOrganLines, podSummaryText } from "./PodSummaryCard.logic";

// The pod atoms' family key; split on a character ids never contain.
const podAtomKey = (ref: ScopedThreadRef) => `${ref.environmentId}\u0000${ref.threadId}`;

// A number, so shell ticks that leave the count alone re-render nothing.
const podOrganCountAtom = Atom.family((key: string) => {
  const separator = key.indexOf("\u0000");
  const environmentId = key.slice(0, separator) as EnvironmentId;
  const podId = key.slice(separator + 1) as ThreadId;
  return Atom.make((get) =>
    podOrganCount(get(environmentThreadShells.environmentThreadsAtom(environmentId)), podId),
  ).pipe(Atom.withLabel(`pod-card-organ-count:${key}`));
});

// What `deriveOrganGroups` reads from a cell's shell. Streaming ticks replace
// every shell without changing these, so they must not re-render the lines.
function sameCellShells(
  left: ReadonlyMap<ThreadId, OrganCellShell>,
  right: ReadonlyMap<ThreadId, OrganCellShell>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [id, cell] of right) {
    const prior = left.get(id);
    if (
      prior === undefined ||
      (prior.shellStatus === "empty") !== (cell.shellStatus === "empty") ||
      prior.rolePreset?.id !== cell.rolePreset?.id ||
      resolveOrchestrationDot(prior, null).dot !== resolveOrchestrationDot(cell, null).dot
    ) {
      return false;
    }
  }
  return true;
}

// The organ cells a thread delegated, as `deriveOrganGroups` reads them, built
// the way the orchestration tree builds its inputs so card and sidebar dots
// agree. Read by an expanded pod card, and by the chat of any thread that has
// organs (its dock and organ cards); each read walks the environment's shells.
const podCellShellsAtom = Atom.family((key: string) => {
  const separator = key.indexOf("\u0000");
  const environmentId = key.slice(0, separator) as EnvironmentId;
  const podId = key.slice(separator + 1) as ThreadId;
  return Atom.make((get) => {
    const environmentConnected = get(environmentConnectedAtom(environmentId));
    const shellStatus = get(environmentShell.statusAtom(environmentId));
    const now = new Date().toISOString();
    const next = new Map<ThreadId, OrganCellShell>();
    for (const source of get(environmentThreadShells.environmentThreadsAtom(environmentId))) {
      if (source.lineage.organ === undefined) continue;
      if (orchestrationParentThreadId(source.lineage) !== podId) continue;
      const shell = get(
        environmentThreadShells.threadShellAtom(scopeThreadRef(environmentId, source.id)),
      );
      if (shell === null) continue;
      const { status } = orchestrationThreadInput(shell, {
        parentKey: null,
        wokeAt: threadWokeAt(shell, { now }),
        now,
        environmentConnected,
        shellStatus,
      });
      next.set(source.id, { ...status, rolePreset: shell.rolePreset ?? null });
    }
    return next;
  }).pipe(Atom.withEquality(sameCellShells), Atom.withLabel(`pod-card-cell-shells:${key}`));
});

const NO_CELL_SHELLS = Atom.make<ReadonlyMap<ThreadId, OrganCellShell>>(new Map());

/** The organ cells delegated by `ref`, as `deriveOrganGroups` reads them. */
export function useOrganCellShells(ref: ScopedThreadRef | null) {
  return useAtomValue(ref === null ? NO_CELL_SHELLS : podCellShellsAtom(podAtomKey(ref)));
}

// Module scope so the compiler keys it on its arguments, as TreeRow's does.
function resolvePodDot(
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

/**
 * One pod (broker thread) in its slice's chat. Collapsed, it reads shells
 * only; expanding mounts the pod's projection, so the pod's thread
 * subscription lives exactly as long as the card is open.
 */
export function PodSummaryCard(props: {
  readonly environmentId: EnvironmentId;
  /** The pod's broker thread. */
  readonly threadId: ThreadId;
}) {
  const { environmentId, threadId } = props;
  const threadRef = scopeThreadRef(environmentId, threadId);
  const key = scopedThreadKey(threadRef);
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const shell = useQuietThreadShell(threadRef);
  const connection = useEnvironmentConnection(environmentId);
  const rollup = useAtomValue(orchestrationTree.rollupAtom(environmentId, key));
  const organCount = useAtomValue(podOrganCountAtom(podAtomKey(threadRef)));
  const podsSupported = useEnvironmentSupportsPodRuntime(environmentId);
  const own =
    shell === null
      ? null
      : resolvePodDot(shell, connection.environmentConnected, connection.shellStatus);
  const dot = rollup?.dot ?? own?.dot ?? null;
  const stale = isEnvironmentStale(connection);
  const dim = own?.dim === true && !stale;

  const openPod = () => {
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
  };

  return (
    <div
      data-stale={stale || undefined}
      className={cn(
        "overflow-hidden rounded-lg border border-border bg-card text-xs",
        stale && "opacity-45",
      )}
    >
      <div className="flex h-11 items-center gap-1.5 pr-2 pl-1.5 hover:bg-accent">
        <Button
          variant="ghost-muted"
          size="icon-micro"
          aria-expanded={expanded}
          aria-label={expanded ? "Hide organs" : "Show organs"}
          onClick={() => setExpanded((open) => !open)}
        >
          <ChevronRightIcon className={cn(expanded && "rotate-90")} />
        </Button>
        <div
          role="button"
          tabIndex={0}
          aria-label="Open pod chat"
          onClick={openPod}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            openPod();
          }}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 self-stretch"
        >
          <BoxIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className={cn("min-w-0 shrink truncate font-medium", dim && "opacity-55")}>
            {shell?.title ?? "Pod"}
          </span>
          {shell?.branch ? (
            <Badge variant="outline" size="sm" shrink>
              <GitBranchIcon />
              <span className="truncate">{shell.branch}</span>
            </Badge>
          ) : null}
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {podSummaryText(organCount, rollup?.needsYouCount ?? 0)}
          </span>
          {dot !== null && <OrchestrationDot dot={dot} />}
        </div>
        {podsSupported && shell?.worktreePath ? (
          <PodCardMenu
            threadRef={threadRef}
            worktreePath={shell.worktreePath}
            onOpenPod={openPod}
          />
        ) : null}
      </div>
      {expanded && <PodOrgans threadRef={threadRef} onOpenPod={openPod} />}
    </div>
  );
}

const NO_SUBAGENTS: ReadonlyArray<never> = [];

/** Mounted only while expanded: the one place the card subscribes to the pod. */
function PodOrgans(props: { readonly threadRef: ScopedThreadRef; readonly onOpenPod: () => void }) {
  const projection = useThreadProjection(props.threadRef);
  const cellShells = useOrganCellShells(props.threadRef);
  const subagents = projection?.projection.subagents ?? NO_SUBAGENTS;
  const lines = podOrganLines(deriveOrganGroups(subagents, (id) => cellShells.get(id)));

  return (
    <div className="border-t border-border px-3 pt-2 pb-2.5">
      {projection === null ? (
        <div className="flex h-6 items-center px-2 text-muted-foreground">Loading organs…</div>
      ) : lines.length === 0 ? (
        <div className="flex h-6 items-center px-2 text-muted-foreground">No organs yet</div>
      ) : (
        lines.map((line) => (
          <button
            key={line.organId}
            type="button"
            onClick={props.onOpenPod}
            className="flex h-6 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left hover:bg-accent"
          >
            <OrchestrationDot dot={line.dot} />
            <span className="w-42.5 shrink-0 truncate">{line.name}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{line.detail}</span>
          </button>
        ))
      )}
    </div>
  );
}

function PodCardMenu(props: {
  readonly threadRef: ScopedThreadRef;
  readonly worktreePath: string;
  readonly onOpenPod: () => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={<Button variant="ghost-muted" size="icon-micro" aria-label="Pod actions" />}
      >
        <EllipsisIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        <PodCardMenuItems {...props} />
      </MenuPopup>
    </Menu>
  );
}

/**
 * Mounted only while the menu is open, so idle cards hold no pod stream or
 * command atoms. URLs and the shell come from PR #23's pod hooks.
 */
function PodCardMenuItems(props: {
  readonly threadRef: ScopedThreadRef;
  readonly worktreePath: string;
  readonly onOpenPod: () => void;
}) {
  const { threadRef, worktreePath } = props;
  useMountPodRuntime(threadRef.environmentId);
  const pod = useWorktreePod(threadRef.environmentId, worktreePath);
  const services = useThreadPodServiceMenu();
  const actions = usePodActions(threadRef.environmentId);
  // `read` is not reactive; `pod` above re-renders this when the pod arrives.
  const menu = pod === undefined ? undefined : services.read(threadRef, worktreePath);
  const openShell =
    pod === undefined
      ? undefined
      : podRuntimeActions(pod).find((action) => action.kind === "openShell");

  return (
    <>
      <MenuItem onClick={props.onOpenPod}>
        <BoxIcon />
        Open pod chat
      </MenuItem>
      {menu?.links.map((link) => (
        <MenuItem
          key={`open:${link.name}`}
          disabled={!menu.state.canOpen}
          onClick={() => services.run(menu, { kind: "open", name: link.name }, threadRef)}
        >
          <GlobeIcon />
          Open {link.name}
        </MenuItem>
      ))}
      {menu?.links.map((link) => (
        <MenuItem
          key={`copy:${link.name}`}
          onClick={() => services.run(menu, { kind: "copy", name: link.name }, threadRef)}
        >
          <CopyIcon />
          Copy {link.name} URL
        </MenuItem>
      ))}
      {pod !== undefined && openShell !== undefined ? (
        <>
          <MenuSeparator />
          <MenuItem
            disabled={!actions.allowed(openShell)}
            onClick={() => void actions.run(pod.id, openShell, threadRef.threadId)}
          >
            <SquareTerminalIcon />
            {openShell.label}
          </MenuItem>
        </>
      ) : null}
    </>
  );
}
