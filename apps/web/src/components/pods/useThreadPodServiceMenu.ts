import {
  podServiceLinks,
  podServiceShareTarget,
  type PodServiceLink,
} from "@t3tools/client-runtime/state/pod-runtime";
import type { PodRuntimeSnapshot, ScopedThreadRef } from "@t3tools/contracts";

import { clientReachesEnvironmentLoopback } from "~/browser/browserTargetResolver";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readWorktreePod } from "~/state/podRuntime";
import { previewEnvironment } from "~/state/preview";
import type { ThreadPodServicesMenuState } from "../threadActionMenu.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { useOpenPodService } from "./useOpenPodService";

export interface ThreadPodServicesMenu {
  readonly pod: PodRuntimeSnapshot;
  readonly links: ReadonlyArray<PodServiceLink & { readonly copyUrl: string }>;
  readonly state: ThreadPodServicesMenuState;
}

/**
 * The pod-services part of a thread's menu: Open in an environment browser
 * tab, which reaches loopback services from any client, and Copy of the URL
 * that best reaches the service from elsewhere.
 */
export function useThreadPodServiceMenu() {
  const { openIn } = useOpenPodService(null);
  const { copyToClipboard } = useCopyToClipboard<{ name: string; url: string }>({
    target: "pod service URL",
    onCopy: ({ name, url }) => {
      toastManager.add({ type: "success", title: `${name} URL copied`, description: url });
    },
    onError: (error) =>
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy pod service URL",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      ),
  });

  const read = (
    threadRef: ScopedThreadRef,
    worktreePath: string | null | undefined,
  ): ThreadPodServicesMenu | undefined => {
    const pod = readWorktreePod(threadRef.environmentId, worktreePath);
    if (pod === undefined) return undefined;
    const clientOnHost = clientReachesEnvironmentLoopback(threadRef.environmentId);
    const links = podServiceLinks(pod).map((link) => {
      const target = podServiceShareTarget(link, clientOnHost);
      return { ...link, copyUrl: target.url, reachLabel: target.reachLabel };
    });
    if (links.length === 0) return undefined;
    return {
      pod,
      links,
      state: {
        services: links.map(({ name, reachLabel }) => ({ name, reachLabel })),
        canOpen: appAtomRegistry.get(
          previewEnvironment.open.permissionAtom(threadRef.environmentId),
        ),
      },
    };
  };

  const run = (
    menu: ThreadPodServicesMenu | undefined,
    choice: { readonly kind: "open" | "copy"; readonly name: string },
    threadRef: ScopedThreadRef,
  ) => {
    const link = menu?.links.find((candidate) => candidate.name === choice.name);
    if (menu === undefined || link === undefined) return;
    if (choice.kind === "copy") {
      copyToClipboard(link.copyUrl, { name: link.name, url: link.copyUrl });
      return;
    }
    void openIn(threadRef.environmentId, menu.pod, link, threadRef.threadId);
  };

  return { read, run };
}
