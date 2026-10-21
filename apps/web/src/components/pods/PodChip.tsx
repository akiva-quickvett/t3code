import {
  podRuntimeActions,
  podRuntimeStatePresentation,
  type PodRuntimeTone,
} from "@t3tools/client-runtime/state/pod-runtime";
import type { EnvironmentId, PodRuntimeSnapshot, ThreadId } from "@t3tools/contracts";
import { BoxIcon } from "lucide-react";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";

import { useQuietThreadShell } from "../../state/entities";
import { useWorktreePod } from "../../state/podRuntime";
import { Badge } from "../ui/badge";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { usePodActions } from "./usePodActions";

const TONE_VARIANT: Readonly<Record<PodRuntimeTone, "success" | "info" | "secondary" | "error">> = {
  running: "success",
  busy: "info",
  idle: "secondary",
  failed: "error",
};

function podTitle(pod: PodRuntimeSnapshot) {
  const { label } = podRuntimeStatePresentation(pod.state);
  return pod.lastError === null ? `Pod ${label}` : `Pod ${label}: ${pod.lastError.message}`;
}

function PodChipMenu(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly pod: PodRuntimeSnapshot;
}) {
  const { run, allowed } = usePodActions(props.environmentId);
  const presentation = podRuntimeStatePresentation(props.pod.state);
  const actions = podRuntimeActions(props.pod).filter(
    (action) => action.kind !== "openShell" || props.threadId !== null,
  );
  return (
    <Menu>
      <MenuTrigger
        render={
          <Badge
            render={<button type="button" />}
            variant={TONE_VARIANT[presentation.tone]}
            size="sm"
            title={podTitle(props.pod)}
            aria-label={podTitle(props.pod)}
          />
        }
      >
        <BoxIcon />
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
  const presentation = podRuntimeStatePresentation(pod.state);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge variant={TONE_VARIANT[presentation.tone]} size="sm" aria-label={podTitle(pod)}>
            <BoxIcon />
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
