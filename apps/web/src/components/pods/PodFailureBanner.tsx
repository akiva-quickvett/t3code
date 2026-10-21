import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { podFailureActions } from "@t3tools/client-runtime/state/pod-runtime";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { BoxIcon } from "lucide-react";

import { useThreadActions } from "../../hooks/useThreadActions";
import { useClientSettings } from "../../hooks/useSettings";
import { useQuietThreadShell, useServerConfigs } from "../../state/entities";
import { useWorktreePod } from "../../state/podRuntime";
import { requestCustomSnooze } from "../CustomSnoozeDialog";
import { resolveSnoozePresets } from "../Sidebar.snooze";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuShortcut, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { usePodActions } from "./usePodActions";

/**
 * Shown on a thread whose pod failed to stop, and on an awake thread whose pod
 * failed to start, so neither fails quietly. Keep snoozed puts the thread's
 * tree back to sleep, which also hides a start failure's banner. Its own
 * component: a pod change re-renders only this.
 */
export function PodFailureBanner(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const configs = useServerConfigs();
  const supported =
    configs.get(props.environmentId)?.environment.capabilities.threadSnoozeTree === true;
  const thread = useQuietThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  const pod = useWorktreePod(props.environmentId, supported ? thread?.worktreePath : null);
  const { run, allowed } = usePodActions(props.environmentId);
  const { snoozeThread } = useThreadActions();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  if (thread === null || pod === undefined) return null;
  const actions = podFailureActions(pod);
  if (actions === null) return null;
  // A stop fails exactly while the threads are parked, and its pod still holds
  // memory, so it shows whatever the thread's snooze; a failed start waits for
  // the thread to wake.
  const stopFailed = pod.state === "stop_failed";
  if (!stopFailed && effectiveSnoozed(thread, { now: new Date().toISOString() })) return null;

  const keepSnoozed = async (snoozedUntil: string) => {
    const result = await snoozeThread(
      scopeThreadRef(props.environmentId, props.threadId),
      snoozedUntil,
      {
        whenIdle: true,
      },
    );
    if (result._tag === "Failure")
      toastManager.add({ type: "error", title: "Could not snooze the thread" });
  };

  return (
    <div className="pointer-events-auto mx-auto w-fit max-w-[calc(100%-2rem)] pt-3">
      <Alert variant="error" role="alert" surface="glass" controlAlignment="first-line">
        <BoxIcon />
        <AlertTitle>
          {pod.state === "start_failed" ? "The pod did not start" : "The pod did not stop"}
        </AlertTitle>
        <AlertDescription>{pod.lastError?.message}</AlertDescription>
        <AlertAction>
          {actions.map((action) => (
            <Button
              key={action.label}
              size="xs"
              variant={
                action.kind === "request" && action.destructive ? "destructive-outline" : "outline"
              }
              disabled={!allowed(action)}
              onClick={() => void run(pod.id, action, props.threadId)}
            >
              {action.label}
            </Button>
          ))}
          {stopFailed ? null : (
            <Menu>
              <MenuTrigger render={<Button size="xs" variant="outline" />}>
                Keep snoozed
              </MenuTrigger>
              <MenuPopup align="end">
                {resolveSnoozePresets(new Date(), timestampFormat).map((preset) => (
                  <MenuItem key={preset.id} onClick={() => void keepSnoozed(preset.snoozedUntil)}>
                    {preset.label}
                    <MenuShortcut>{preset.whenLabel}</MenuShortcut>
                  </MenuItem>
                ))}
                <MenuSeparator />
                <MenuItem
                  onClick={async () => {
                    const choice = await requestCustomSnooze();
                    if (choice) await keepSnoozed(choice.snoozedUntil);
                  }}
                >
                  Custom…
                </MenuItem>
              </MenuPopup>
            </Menu>
          )}
        </AlertAction>
      </Alert>
    </div>
  );
}
