import {
  podMcpListenerProblem,
  podRuntimeActions,
  podRuntimeStatePresentation,
  podServiceLinks,
  type PodRuntimeTone,
} from "@t3tools/client-runtime/state/pod-runtime";
import type { EnvironmentId, PodRuntimeSnapshot, ThreadId } from "@t3tools/contracts";
import { BoxIcon, GlobeIcon, TriangleAlertIcon } from "lucide-react";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";

import { useQuietThreadShell } from "../../state/entities";
import { useWorktreePod } from "../../state/podRuntime";
import { Badge } from "../ui/badge";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { usePodActions } from "./usePodActions";
import { useOpenPodService } from "./useOpenPodService";

const TONE_VARIANT: Readonly<Record<PodRuntimeTone, "success" | "info" | "secondary" | "error">> = {
  running: "success",
  busy: "info",
  idle: "secondary",
  failed: "error",
};

/** A pod whose agents cannot reach T3 warns, whatever its state's tone. */
function podChipLook(pod: PodRuntimeSnapshot) {
  return podMcpListenerProblem(pod) === undefined
    ? { variant: TONE_VARIANT[podRuntimeStatePresentation(pod.state).tone], Icon: BoxIcon }
    : { variant: "warning" as const, Icon: TriangleAlertIcon };
}

function podTitle(pod: PodRuntimeSnapshot) {
  const { label } = podRuntimeStatePresentation(pod.state);
  const detail = pod.lastError?.message ?? podMcpListenerProblem(pod);
  return detail === undefined ? `Pod ${label}` : `Pod ${label}: ${detail}`;
}

function PodChipMenu(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly pod: PodRuntimeSnapshot;
}) {
  const { run, allowed } = usePodActions(props.environmentId);
  const services = useOpenPodService(props.environmentId);
  const links = podServiceLinks(props.pod);
  const presentation = podRuntimeStatePresentation(props.pod.state);
  const listenerProblem = podMcpListenerProblem(props.pod);
  const look = podChipLook(props.pod);
  const actions = podRuntimeActions(props.pod).filter(
    (action) => action.kind !== "openShell" || props.threadId !== null,
  );
  return (
    <Menu>
      <MenuTrigger
        render={
          <Badge
            render={<button type="button" />}
            variant={look.variant}
            size="sm"
            title={podTitle(props.pod)}
            aria-label={podTitle(props.pod)}
          />
        }
      >
        <look.Icon />
        Pod: {presentation.label}
      </MenuTrigger>
      <MenuPopup align="start">
        {props.pod.lastError === null ? null : (
          <>
            <div className="max-w-72 px-2 py-1 text-muted-foreground text-xs">
              {props.pod.lastError.message}
            </div>
            <MenuSeparator />
          </>
        )}
        {props.pod.hostnameProblem === undefined ? null : (
          <>
            <div className="max-w-72 px-2 py-1 text-muted-foreground text-xs">
              {props.pod.hostnameProblem}
            </div>
            <MenuSeparator />
          </>
        )}
        {listenerProblem === undefined ? null : (
          <>
            <div className="max-w-72 px-2 py-1 text-warning text-xs">{listenerProblem}</div>
            <MenuSeparator />
          </>
        )}
        {links.map((link) => (
          <MenuItem
            key={`service:${link.name}`}
            disabled={!services.allowed}
            onClick={() => void services.open(props.pod, link, props.threadId)}
          >
            <GlobeIcon />
            Open {link.name}
          </MenuItem>
        ))}
        {links.length > 0 && actions.length > 0 ? <MenuSeparator /> : null}
        {actions.map((action) => (
          <MenuItem
            key={`${action.kind}:${action.label}`}
            variant={action.kind === "request" && action.destructive ? "destructive" : "default"}
            disabled={!allowed(action)}
            onClick={() => void run(props.pod.id, action, props.threadId)}
          >
            {action.label}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

/**
 * The pod of a thread's worktree, if it has one: its state at a glance and,
 * unless slim, its actions. Its own component so a pod change re-renders only
 * the chip.
 */
export function PodChip(props: {
  readonly environmentId: EnvironmentId;
  readonly worktreePath: string | null | undefined;
  readonly threadId?: ThreadId | null;
  /** A sidebar row has no room for a menu; the chip only shows the state. */
  readonly slim?: boolean;
}) {
  const pod = useWorktreePod(props.environmentId, props.worktreePath);
  if (pod === undefined) return null;
  if (props.slim !== true)
    return (
      <PodChipMenu
        environmentId={props.environmentId}
        threadId={props.threadId ?? null}
        pod={pod}
      />
    );
  const look = podChipLook(pod);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge variant={look.variant} size="sm" aria-label={podTitle(pod)}>
            <look.Icon />
          </Badge>
        }
      />
      <TooltipPopup side="top">{podTitle(pod)}</TooltipPopup>
    </Tooltip>
  );
}

/** The chip for a server thread, found by the worktree its shell records. */
export function ThreadPodChip(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Sits on a row of its own, as in the thread details panel. */
  readonly row?: boolean;
}) {
  const thread = useQuietThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  const pod = useWorktreePod(props.environmentId, thread?.worktreePath);
  if (pod === undefined) return null;
  const chip = (
    <PodChipMenu environmentId={props.environmentId} threadId={props.threadId} pod={pod} />
  );
  return props.row === true ? <div className="flex px-2 py-1">{chip}</div> : chip;
}
