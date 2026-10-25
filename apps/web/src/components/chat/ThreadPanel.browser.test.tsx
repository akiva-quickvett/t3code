import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, type ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { selectActiveRightPanelSurface, useRightPanelStore } from "../../rightPanelStore";
import { RightPanelSurfaceContent } from "./RightPanelSurfaceContent";

// Stands in for subscribeThread: the projection hook is what opens and closes it.
const subscriptions = vi.hoisted(() => ({ open: new Map<string, number>() }));
vi.mock("../../state/entities", async (importOriginal) => {
  const { scopedThreadKey: keyOf } = await import("@t3tools/client-runtime/environment");
  const { useEffect: useMountEffect } = await import("react");
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    useThreadProjection: (ref: ScopedThreadRef | null) => {
      const key = ref === null ? null : keyOf(ref);
      useMountEffect(() => {
        if (key === null) return;
        subscriptions.open.set(key, (subscriptions.open.get(key) ?? 0) + 1);
        return () => {
          const count = (subscriptions.open.get(key) ?? 0) - 1;
          if (count > 0) subscriptions.open.set(key, count);
          else subscriptions.open.delete(key);
        };
      }, [key]);
      return null;
    },
    useQuietThreadShell: () => null,
    useProject: () => null,
    useThreadVisibleTurnItems: () => [],
    useThreadCheckpointSummaries: () => [],
  };
});
vi.mock("./MessagesTimeline", () => ({ MessagesTimeline: () => null }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useNavigate: () => vi.fn(),
}));
vi.mock("../../hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useEnvironmentSettings: (
    _environmentId: string,
    select: (settings: { timestampFormat: string }) => unknown,
  ) => select({ timestampFormat: "locale" }),
}));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useEnvironmentScope: () => true,
}));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => vi.fn(),
}));

const environmentId = EnvironmentId.make("env-1");
const parentRef = scopeThreadRef(environmentId, ThreadId.make("broker"));
const cellA = ThreadId.make("cell-A");
const cellB = ThreadId.make("cell-B");
const openSubscriptions = () => [...subscriptions.open.entries()];

function ParentPanel() {
  const surface = useRightPanelStore((state) =>
    selectActiveRightPanelSurface(state.byThreadKey, parentRef),
  );
  return (
    <RightPanelSurfaceContent
      surface={surface}
      activeSurfaceId={surface?.id ?? null}
      threadRef={parentRef}
      environmentId={environmentId}
      visible
      composerDraftTarget={parentRef}
      keybindings={[]}
      configuredPreviewUrls={[]}
      workspaceMutationId={null}
      getShortcutContext={() => ({}) as never}
      onSendAnnotation={() => {}}
      onCloseSurface={(closed) => useRightPanelStore.getState().closeSurface(parentRef, closed.id)}
      terminal={{} as never}
      pullRequest={{} as never}
      files={{} as never}
    />
  );
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  subscriptions.open.clear();
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<ParentPanel />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("subscribes to the one live cell and releases it when replaced or closed", () => {
  const store = useRightPanelStore.getState();
  const keyA = scopedThreadKey(scopeThreadRef(environmentId, cellA));
  const keyB = scopedThreadKey(scopeThreadRef(environmentId, cellB));

  act(() => store.openThread(parentRef, cellA));
  expect(openSubscriptions()).toEqual([[keyA, 1]]);

  act(() => store.openThread(parentRef, cellB));
  expect(openSubscriptions()).toEqual([[keyB, 1]]);

  act(() => store.close(parentRef));
  expect(openSubscriptions()).toEqual([]);

  act(() => store.show(parentRef));
  expect(openSubscriptions()).toEqual([[keyB, 1]]);

  act(() => store.closeSurface(parentRef, "thread"));
  expect(openSubscriptions()).toEqual([]);
});

it("closes the cell from its own header", () => {
  act(() => useRightPanelStore.getState().openThread(parentRef, cellA));
  const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
  act(() => close!.click());
  expect(openSubscriptions()).toEqual([]);
  expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, parentRef)).toBe(
    null,
  );
});
