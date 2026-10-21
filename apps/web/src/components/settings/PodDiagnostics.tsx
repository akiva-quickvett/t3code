import {
  type PodRuntimeAction,
  podRuntimeActions,
  podRuntimeStatePresentation,
  podServiceLinks,
} from "@t3tools/client-runtime/state/pod-runtime";
import type {
  EnvironmentId,
  PodRuntimeOrphan,
  PodRuntimeSnapshot,
  PodRuntimeStatus,
} from "@t3tools/contracts";

import { formatBytes } from "../../lib/formatBytes";
import { useEnvironmentSupportsPodRuntime } from "../../state/podRuntime";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { usePodActions } from "../pods/usePodActions";
import { useOpenPodService } from "../pods/useOpenPodService";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsSection } from "./settingsLayout";

const STATS_INPUT = { includeStats: true } as const;

/** What Diagnostics offers per pod: lifecycle only; shells open from a thread. */
const isDiagnosticsAction = (action: PodRuntimeAction) =>
  action.kind === "request" &&
  (action.request === "start" || action.request === "stop" || action.request === "remove");

function memoryLabel(status: PodRuntimeStatus, podId: string) {
  const bytes = status.stats?.find((entry) => entry.podId === podId)?.memoryBytes;
  return bytes == null ? "—" : formatBytes(bytes);
}

/** Each running service opens in an environment browser tab; its tailnet address is shown to copy. */
function PodServices(props: {
  readonly environmentId: EnvironmentId;
  readonly pod: PodRuntimeSnapshot;
}) {
  const services = useOpenPodService(props.environmentId);
  const links = podServiceLinks(props.pod);
  if (links.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 text-xs">
      {links.map((link) => (
        <span key={link.name} className="inline-flex items-center gap-1">
          <Button
            size="xs"
            variant="link"
            disabled={!services.allowed}
            onClick={() => void services.open(props.pod, link, null)}
          >
            {link.name}
          </Button>
          {link.tailnetUrl === undefined ? null : (
            <span className="select-all font-mono text-muted-foreground">{link.tailnetUrl}</span>
          )}
        </span>
      ))}
    </div>
  );
}

function PodRow(props: {
  readonly environmentId: EnvironmentId;
  readonly pod: PodRuntimeSnapshot;
  readonly memory: string;
  readonly onAction: (action: PodRuntimeAction) => void;
  readonly allowed: (action: PodRuntimeAction) => boolean;
}) {
  const presentation = podRuntimeStatePresentation(props.pod.state);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 sm:px-5">
      <div className="min-w-0 flex-1">
        <Tooltip>
          <TooltipTrigger
            render={<div className="truncate font-mono text-xs">{props.pod.worktreePath}</div>}
          />
          <TooltipPopup side="top">{props.pod.worktreePath}</TooltipPopup>
        </Tooltip>
        <div className="text-muted-foreground text-xs">
          {props.pod.id}
          {props.pod.lastError === null ? null : ` · ${props.pod.lastError.message}`}
        </div>
        <PodServices environmentId={props.environmentId} pod={props.pod} />
      </div>
      <Badge
        variant={
          presentation.tone === "failed"
            ? "error"
            : presentation.tone === "running"
              ? "success"
              : "secondary"
        }
        size="sm"
      >
        {presentation.label}
      </Badge>
      <span className="w-16 text-right font-mono text-muted-foreground text-xs tabular-nums">
        {props.memory}
      </span>
      <div className="flex gap-1">
        {podRuntimeActions(props.pod)
          .filter(isDiagnosticsAction)
          .map((action) => (
            <Button
              key={action.label}
              size="xs"
              variant={
                action.kind === "request" && action.destructive ? "destructive-outline" : "outline"
              }
              disabled={!props.allowed(action)}
              onClick={() => props.onAction(action)}
            >
              {action.label}
            </Button>
          ))}
      </div>
    </div>
  );
}

function OrphanRow(props: {
  readonly orphan: PodRuntimeOrphan;
  readonly onRemove: () => void;
  readonly canRemove: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 sm:px-5">
      <div className="min-w-0 flex-1">
        <div className="font-mono text-xs">{props.orphan.podId}</div>
        <div className="text-muted-foreground text-xs">
          No pod record owns {props.orphan.containerIds.length} container(s) and{" "}
          {props.orphan.volumeIds.length} volume(s) labelled for this environment.
        </div>
      </div>
      <Badge variant="warning" size="sm">
        {props.orphan.running ? "orphan, running" : "orphan"}
      </Badge>
      <Button
        size="xs"
        variant="destructive-outline"
        disabled={!props.canRemove}
        onClick={props.onRemove}
      >
        Remove
      </Button>
    </div>
  );
}

/**
 * Every pod of the environment, orphans included, with memory use. Mounting it
 * is what makes the server ask Docker; it polls only while this screen shows.
 */
export function PodDiagnostics(props: { readonly environmentId: EnvironmentId | null }) {
  const supported = useEnvironmentSupportsPodRuntime(props.environmentId);
  const status = useEnvironmentQuery(
    supported && props.environmentId !== null
      ? serverEnvironment.podRuntimeDiagnostics({
          environmentId: props.environmentId,
          input: STATS_INPUT,
        })
      : null,
  );
  const { run, allowed } = usePodActions(props.environmentId);
  const environmentId = props.environmentId;
  if (!supported || environmentId === null) return null;
  const data = status.data;
  const empty = data !== null && data.pods.length === 0 && data.orphans.length === 0;
  const act = (pod: PodRuntimeSnapshot, action: PodRuntimeAction) =>
    void run(pod.id, action, null).then(status.refresh);
  const removeAction: PodRuntimeAction = {
    kind: "request",
    request: "remove",
    label: "Remove pod",
    destructive: true,
  };
  return (
    <SettingsSection title="Pods">
      {data === null ? (
        <p className="px-4 py-3 text-muted-foreground text-xs sm:px-5">
          {status.error ?? "Loading pods…"}
        </p>
      ) : empty ? (
        <p className="px-4 py-3 text-muted-foreground text-xs sm:px-5">
          {data.enabled
            ? "No pods. A new worktree runs in one when its project's t3.json has a pod block and you choose Container."
            : "Pods are off. Turn them on under Settings → General → Pods."}
        </p>
      ) : (
        <div className="divide-y divide-border/60">
          {data.pods.map((pod) => (
            <PodRow
              key={pod.id}
              environmentId={environmentId}
              pod={pod}
              memory={memoryLabel(data, pod.id)}
              allowed={allowed}
              onAction={(action) => act(pod, action)}
            />
          ))}
          {data.orphans.map((orphan) => (
            <OrphanRow
              key={orphan.podId}
              orphan={orphan}
              canRemove={allowed(removeAction)}
              onRemove={() => void run(orphan.podId, removeAction, null).then(status.refresh)}
            />
          ))}
        </div>
      )}
    </SettingsSection>
  );
}
