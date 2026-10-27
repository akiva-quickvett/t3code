import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { memo, useState } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { newMessageId } from "../../lib/utils";
import { readThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { OrchestrationSidebar } from "../orchestration/OrchestrationSidebar";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";

export interface OrchestrationSidebarHostProps {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  /** The Chat view's rename commit, so both views validate and report alike. */
  readonly onCommitRename: (
    threadRef: ScopedThreadRef,
    title: string,
    originalTitle: string,
  ) => void;
  /** A thread row was opened, e.g. to close the mobile sheet. */
  readonly onRowActivate: () => void;
}

/** Memoized: the chat list's host renders on every shell tick, and this view must not. */
export const OrchestrationSidebarHost = memo(function OrchestrationSidebarHost(
  props: OrchestrationSidebarHostProps,
) {
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [renaming, setRenaming] = useState<{
    readonly threadRef: ScopedThreadRef;
    readonly originalTitle: string;
    readonly title: string;
  } | null>(null);

  // A web-origin `/compact` queued behind any running turn (L5): a user action,
  // so held supervised wakes release. Per-provider availability is the tab menu's.
  const clearMeta = useStableCallback(async (metaThreadRef: ScopedThreadRef) => {
    const shell = readThreadShell(metaThreadRef);
    if (shell === null) return;
    const result = await startTurn({
      environmentId: metaThreadRef.environmentId,
      input: {
        threadId: metaThreadRef.threadId,
        message: { messageId: newMessageId(), role: "user", text: "/compact", attachments: [] },
        runtimeMode: shell.runtimeMode,
        interactionMode: shell.interactionMode,
        dispatchMode: "queue",
      },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not clear the meta",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  });
  const startRename = useStableCallback((threadRef: ScopedThreadRef) => {
    const title = readThreadShell(threadRef)?.title;
    if (title !== undefined) setRenaming({ threadRef, originalTitle: title, title });
  });
  const submitRename = () => {
    if (renaming === null) return;
    setRenaming(null);
    props.onCommitRename(renaming.threadRef, renaming.title, renaming.originalTitle);
  };

  const onRowActivate = useStableCallback(props.onRowActivate);

  return (
    <>
      <OrchestrationSidebar
        environmentIds={props.environmentIds}
        onClearMeta={clearMeta}
        onRenameThread={startRename}
        onRowActivate={onRowActivate}
      />
      <Dialog
        open={renaming !== null}
        onOpenChange={(open) => (open ? undefined : setRenaming(null))}
      >
        <DialogPopup className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename thread</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <Input
              autoFocus
              aria-label="Thread title"
              value={renaming?.title ?? ""}
              onChange={(event) => {
                const title = event.target.value;
                setRenaming((current) => (current === null ? null : { ...current, title }));
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                event.preventDefault();
                submitRename();
              }}
            />
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button onClick={submitRename}>Save</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
});
