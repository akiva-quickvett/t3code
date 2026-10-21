import type { PodRuntimeAction } from "@t3tools/client-runtime/state/pod-runtime";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, PodRuntimeId, ThreadId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

import { requestConfirmDialog } from "../../confirmDialog";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useTerminalUiStateStore } from "../../terminalUiStateStore";
import { toastManager } from "../ui/toast";

const CONFIRMATIONS = {
  recreate:
    "Recreate this pod?\nIts containers and Docker volume are deleted and built again; the stack's data is lost.",
  remove:
    "Remove this pod?\nIts containers and Docker volume are deleted; the stack's data is lost. The worktree stays.",
  removeAnyway:
    "Remove this pod anyway?\nIt is forgotten even though Docker refused; whatever Docker kept is listed under Diagnostics → Pods.",
} as const;

async function confirmDestructive(message: string): Promise<boolean> {
  return (
    (await requestConfirmDialog(message, { variant: "destructive" })) ??
    window.confirm(message.replace("\n", " "))
  );
}

type CommandResult = Parameters<typeof isAtomCommandInterrupted>[0];

function reportFailure(title: string, result: CommandResult) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : "The pod runtime refused the request.",
  });
}

const NOT_ALLOWED_ATOM = Atom.make(false).pipe(Atom.withLabel("pod-actions:no-environment"));

/** Runs a pod action from any surface: chip, palette or Diagnostics. */
export function usePodActions(environmentId: EnvironmentId | null) {
  const start = useAtomCommand(serverEnvironment.startPod, "pod start");
  const stop = useAtomCommand(serverEnvironment.stopPod, "pod stop");
  const recreate = useAtomCommand(serverEnvironment.recreatePod, "pod recreate");
  const recreateAgent = useAtomCommand(
    serverEnvironment.recreatePodAgentContainer,
    "pod recreate agent container",
  );
  const remove = useAtomCommand(serverEnvironment.removePod, "pod remove");
  const openShell = useAtomCommand(serverEnvironment.openPodShell, "pod open shell");
  const ensureTerminal = useTerminalUiStateStore((store) => store.ensureTerminal);
  const canChange = useAtomValue(
    environmentId === null
      ? NOT_ALLOWED_ATOM
      : serverEnvironment.startPod.permissionAtom(environmentId),
  );
  const canOpenShell = useAtomValue(
    environmentId === null
      ? NOT_ALLOWED_ATOM
      : serverEnvironment.openPodShell.permissionAtom(environmentId),
  );

  const run = async (
    podId: PodRuntimeId,
    action: PodRuntimeAction,
    threadId: ThreadId | null,
  ): Promise<void> => {
    if (environmentId === null) return;
    if (action.kind === "openShell") {
      if (threadId === null) return;
      const result = await openShell({ environmentId, input: { podId, threadId } });
      if (result._tag === "Success")
        ensureTerminal(scopeThreadRef(environmentId, threadId), result.value.terminalId, {
          open: true,
          active: true,
        });
      return reportFailure("Could not open the pod shell", result);
    }
    const input = { environmentId, input: { podId } };
    if (action.destructive) {
      const message =
        action.force === true
          ? CONFIRMATIONS.removeAnyway
          : action.request === "recreate"
            ? CONFIRMATIONS.recreate
            : CONFIRMATIONS.remove;
      if (!(await confirmDestructive(message))) return;
    }
    const title = `Could not ${action.label.toLowerCase()}`;
    switch (action.request) {
      case "start":
        return reportFailure(title, await start(input));
      case "stop":
        return reportFailure(title, await stop(input));
      case "recreate":
        return reportFailure(title, await recreate(input));
      case "recreateAgentContainer":
        return reportFailure(title, await recreateAgent(input));
      case "remove":
        return reportFailure(
          title,
          await remove({
            environmentId,
            input: { podId, ...(action.force === true ? { force: true } : {}) },
          }),
        );
    }
  };

  /** Whether this session may run the action on the destination environment. */
  const allowed = (action: PodRuntimeAction) =>
    action.kind === "openShell" ? canOpenShell : canChange;

  return { run, allowed };
}
