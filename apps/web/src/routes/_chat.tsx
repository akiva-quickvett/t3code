import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import {
  mergeOrchestrationOrders,
  nextNeedsYouTarget,
} from "@t3tools/client-runtime/state/orchestration-tree";
import { AuthPreviewOperateScope } from "@t3tools/contracts";
import { Outlet, createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { ThreadRouteView } from "../components/ThreadRouteView";
import { ThreadLinkPrompt } from "../components/promptLinks/ThreadLinkPrompt";
import { useClientSettings, useLegacySidebarEnabled } from "../hooks/useSettings";
import { openCommandPalette } from "../commandPaletteBus";
import { useProjects } from "../state/entities";
import { isPreviewAvailableFor } from "../browser/previewRuntime";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentScope } from "../state/session";
import { selectProjectGroupingSettings } from "../logicalProject";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import { dispatchPreviewAction } from "../components/preview/previewActionBus";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useScratchProject } from "../hooks/useScratchProject";
import { startNewThreadFromContext } from "../lib/chatThreadActions";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isEditableFocused } from "../lib/editableFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { undoLatestThreadAction } from "../hooks/showThreadUndoNotice";
import { resolveShortcutCommand } from "../keybindings";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { readNavigationParentRef } from "../state/agentTree";
import {
  orchestrationTree,
  readEnvironmentSupportsOrchestrationMetas,
} from "../state/orchestrationTree";
import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { buildThreadRouteParams } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";

function readOrchestrationOrder() {
  return mergeOrchestrationOrders(
    Array.from(enabledEnvironmentIds(appAtomRegistry.get(environmentCatalog.catalogValueAtom)))
      .filter(readEnvironmentSupportsOrchestrationMetas)
      .map((environmentId) => appAtomRegistry.get(orchestrationTree.orderAtom(environmentId))),
  );
}

function ChatRouteGlobalShortcuts() {
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const selectedThreadKeysSize = useThreadSelectionStore((state) => state.selectedThreadKeys.size);
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread, routeThreadRef } =
    useHandleNewThread();
  const canOperatePreview = useEnvironmentScope(
    routeThreadRef?.environmentId ?? null,
    AuthPreviewOperateScope,
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const navigate = useNavigate();
  const legacySidebarEnabled = useLegacySidebarEnabled();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { scratchEnvironmentId, startScratchThread } = useScratchProject();
  const projectGroupCount = buildSidebarProjectSnapshots({
    projects,
    settings: projectGroupingSettings,
    primaryEnvironmentId,
    resolveEnvironmentLabel: () => null,
  }).length;
  const terminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  // The `previewOpen` shortcut-context flag here uses the store-only value;
  // the URL-aware arbitration lives inside ChatView's `onTogglePreview`,
  // which we invoke via the action bus to avoid duplicating the rule.
  const previewOpen = useRightPanelStore((state) =>
    routeThreadRef
      ? selectActiveRightPanel(state.byThreadKey, routeThreadRef) === "preview"
      : false,
  );
  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
          previewFocus: isPreviewFocused(),
          previewOpen,
          editableFocus: isEditableFocused(event.target),
          modelPickerOpen: isModelPickerOpen(),
        },
      });

      if (isCommandPaletteOpen()) {
        return;
      }

      if (command === "thread.undo") {
        if (event.repeat || isModelPickerOpen()) return;
        if (undoLatestThreadAction()) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }

      if (command === "thread.goToParent") {
        const parentRef = routeThreadRef === null ? null : readNavigationParentRef(routeThreadRef);
        if (parentRef === null) return;
        event.preventDefault();
        event.stopPropagation();
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(parentRef),
        });
        return;
      }

      if (command === "sidebar.showAgentTree") {
        const environmentId = routeThreadRef?.environmentId ?? primaryEnvironmentId;
        if (
          legacySidebarEnabled ||
          environmentId === null ||
          !readEnvironmentSupportsOrchestrationMetas(environmentId)
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        useUiStateStore.getState().toggleSidebarView();
        return;
      }

      // Navigation, like a deep link: it picks the target's tab but keeps the view.
      if (command === "sidebar.nextNeedsYou") {
        if (legacySidebarEnabled) return;
        const currentKey = routeThreadRef === null ? null : scopedThreadKey(routeThreadRef);
        const target = nextNeedsYouTarget(readOrchestrationOrder(), currentKey);
        const targetRef = target === null ? null : parseScopedThreadKey(target.threadKey);
        if (target === null || targetRef === null) return;
        event.preventDefault();
        event.stopPropagation();
        useUiStateStore.getState().setSelectedMetaThreadKey(target.tabKey);
        if (target.threadKey === currentKey) return;
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(targetRef),
        });
        return;
      }

      if (event.key === "Escape" && selectedThreadKeysSize > 0) {
        event.preventDefault();
        clearSelection();
        return;
      }

      if (command === "chat.newLocal") {
        event.preventDefault();
        event.stopPropagation();
        void startNewThreadFromContext({
          activeDraftThread,
          activeThread: activeThread ?? undefined,
          defaultProjectRef,
          handleNewThread,
        });
        return;
      }

      if (command === "chat.newWithoutProject") {
        const environmentId = scratchEnvironmentId(
          activeThread?.environmentId ?? activeDraftThread?.environmentId ?? primaryEnvironmentId,
        );
        if (environmentId === null) return;
        event.preventDefault();
        event.stopPropagation();
        void startScratchThread(environmentId);
        return;
      }

      if (command === "chat.new") {
        event.preventDefault();
        event.stopPropagation();
        if (!legacySidebarEnabled && projectGroupCount > 1) {
          openCommandPalette({ open: "new-thread-in" });
          return;
        }
        void startNewThreadFromContext({
          activeDraftThread,
          activeThread: activeThread ?? undefined,
          defaultProjectRef,
          handleNewThread,
        });
        return;
      }

      if (command === "preview.toggle") {
        event.preventDefault();
        event.stopPropagation();
        if (!routeThreadRef || (!canOperatePreview && !previewOpen)) return;
        if (!isPreviewAvailableFor(routeThreadRef.environmentId)) {
          toastManager.add(
            stackedThreadToast({
              type: "info",
              title: "Preview is desktop-only",
              description: "Open T3 Code in the desktop app to use the in-app preview.",
            }),
          );
          return;
        }
        dispatchPreviewAction("toggle-panel");
        return;
      }

      if (
        command === "preview.refresh" ||
        command === "preview.focusUrl" ||
        command === "preview.zoomIn" ||
        command === "preview.zoomOut" ||
        command === "preview.resetZoom"
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (!canOperatePreview) return;
        const action =
          command === "preview.refresh"
            ? "refresh"
            : command === "preview.focusUrl"
              ? "focus-url"
              : command === "preview.zoomIn"
                ? "zoom-in"
                : command === "preview.zoomOut"
                  ? "zoom-out"
                  : "reset-zoom";
        dispatchPreviewAction(action);
      }
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [
    activeDraftThread,
    activeThread,
    clearSelection,
    canOperatePreview,
    handleNewThread,
    keybindings,
    defaultProjectRef,
    previewOpen,
    primaryEnvironmentId,
    projectGroupCount,
    routeThreadRef,
    scratchEnvironmentId,
    selectedThreadKeysSize,
    startScratchThread,
    legacySidebarEnabled,
    navigate,
    terminalOpen,
  ]);

  return null;
}

function ChatRouteLayout() {
  // Both thread routes render here, not in their own leaf components, so the
  // draft-to-thread promotion keeps one ChatView mounted across the swap.
  const threadTarget = useThreadRouteTarget();
  return (
    <>
      <ChatRouteGlobalShortcuts />
      {threadTarget?.kind === "server" ? (
        <ThreadLinkPrompt threadRef={threadTarget.threadRef} />
      ) : null}
      {threadTarget ? <ThreadRouteView target={threadTarget} /> : <Outlet />}
    </>
  );
}

export const Route = createFileRoute("/_chat")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ChatRouteLayout,
});
