import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { podBrowsingThread, type PodServiceLink } from "@t3tools/client-runtime/state/pod-runtime";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  PodRuntimeSnapshot,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";

import { resolveDiscoveredServerUrl } from "~/browser/browserTargetResolver";
import type { OpenPreviewMutation } from "~/browser/openFileInPreview";
import { recordVisitForThread } from "~/browserHistoryStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { readEnvironmentSupportsServerBrowser, readThreadShells } from "~/state/entities";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { openPreviewSession } from "../preview/openPreviewSession";
import { toastManager } from "../ui/toast";

/**
 * A pod service's URL is the environment host's loopback, so it opens in that
 * host's own browser, streamed to this client, whichever client this is. A
 * server without one falls back to the client's browser, reached the way a
 * discovered port is.
 */
async function openPodServiceInThread<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly link: PodServiceLink;
  readonly openPreview: OpenPreviewMutation<E>;
}) {
  const environmentId = input.threadRef.environmentId;
  const onServer = readEnvironmentSupportsServerBrowser(environmentId);
  const result = await openPreviewSession({
    openPreview: input.openPreview,
    threadRef: input.threadRef,
    url: onServer ? input.link.url : resolveDiscoveredServerUrl(environmentId, input.link.url),
    ...(onServer ? { runtime: "server" as const } : {}),
  });
  return mapAtomCommandResult(result, (snapshot) => {
    recordVisitForThread(input.threadRef, input.link.url);
    useRightPanelStore.getState().openBrowser(input.threadRef, snapshot.tabId);
  });
}

const NOT_ALLOWED_ATOM = Atom.make(false).pipe(Atom.withLabel("pod-services:no-environment"));

/**
 * Opens a pod's service in a browser tab of `threadId`, or, from outside a
 * thread, of the latest thread on the pod's worktree, which it navigates to.
 */
export function useOpenPodService(environmentId: EnvironmentId | null) {
  const openPreview = useAtomCommand(previewEnvironment.open, "pod service open");
  const allowed = useAtomValue(
    environmentId === null
      ? NOT_ALLOWED_ATOM
      : previewEnvironment.open.permissionAtom(environmentId),
  );
  const navigate = useNavigate();

  const openIn = async (
    environmentId: EnvironmentId,
    pod: PodRuntimeSnapshot,
    link: PodServiceLink,
    threadId: ThreadId | null,
    /** Show the thread first, so a tab opened from another thread's menu is seen. */
    options?: { readonly navigate?: boolean },
  ) => {
    let threadRef: ScopedThreadRef;
    if (threadId !== null) {
      threadRef = scopeThreadRef(environmentId, threadId);
      if (options?.navigate === true)
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        });
    } else {
      const thread = podBrowsingThread(readThreadShells(), environmentId, pod);
      if (thread === undefined) {
        toastManager.add({
          type: "info",
          title: `Could not open ${link.name}`,
          description: "No thread uses this pod's worktree. Open one there to browse its services.",
        });
        return;
      }
      threadRef = scopeThreadRef(environmentId, thread.id);
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    }
    const result = await openPodServiceInThread({ threadRef, link, openPreview });
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: `Could not open ${link.name}`,
      description: error instanceof Error ? error.message : "The browser tab did not open.",
    });
  };

  const open = async (pod: PodRuntimeSnapshot, link: PodServiceLink, threadId: ThreadId | null) => {
    if (environmentId === null) return;
    await openIn(environmentId, pod, link, threadId);
  };

  /** For callers spanning environments, such as the sidebar's thread menu. */
  return { open, openIn, allowed };
}
