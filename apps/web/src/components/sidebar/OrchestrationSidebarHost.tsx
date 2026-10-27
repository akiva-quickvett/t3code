import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { memo, useEffect, useRef, useState } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useThreadRouteRef } from "../../hooks/useThreadRouteTarget";
import { newMessageId } from "../../lib/utils";
import { readThreadShell } from "../../state/entities";
import { environmentServerConfigsAtom } from "../../state/server";
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

// The same order `_chat.tsx` feeds `mergeOrchestrationOrders`, so tabs and
// next-needs-you agree. Kept by reference while unchanged, so config churn
// re-renders nothing.
const orchestrationEnvironmentIdsAtom = (() => {
  let previous: ReadonlyArray<EnvironmentId> = [];
  return Atom.make((get) => {
    const configs = get(environmentServerConfigsAtom);
    const next = Array.from(enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))).filter(
      (environmentId) =>
        configs.get(environmentId)?.environment.capabilities.orchestrationMetas === true,
    );
    if (next.length === previous.length && next.every((id, index) => id === previous[index])) {
      return previous;
    }
    previous = next;
    return next;
  }).pipe(Atom.withLabel("web-orchestration-environment-ids"));
})();

/** Empty when no enabled environment has metas, which hides the Orchestration view. */
export function useOrchestrationEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return useAtomValue(orchestrationEnvironmentIdsAtom);
}

export interface OrchestrationSidebarHostProps {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  /** The Chat view's rename commit, so both views validate and report alike. */
  readonly onCommitRename: (
    threadRef: ScopedThreadRef,
    title: string,
    originalTitle: string,
  ) => void;
  /** Called when the routed thread changes, e.g. to close the mobile sheet. */
  readonly onNavigate: () => void;
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

  // The tree navigates on its own; a new route is the pick.
  const routeRef = useThreadRouteRef();
  const routeKey = routeRef === null ? null : scopedThreadKey(routeRef);
  const shownRouteKey = useRef(routeKey);
  const onNavigate = useStableCallback(props.onNavigate);
  useEffect(() => {
    if (shownRouteKey.current === routeKey) return;
    shownRouteKey.current = routeKey;
    onNavigate();
  }, [routeKey, onNavigate]);

  return (
    <>
      <OrchestrationSidebar
        environmentIds={props.environmentIds}
        onClearMeta={clearMeta}
        onRenameThread={startRename}
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
