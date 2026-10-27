import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { selectActiveRightPanelSurface, useRightPanelStore } from "../../rightPanelStore";
import { RightPanelSurfaceContent } from "./RightPanelSurfaceContent";

// Stable empties, as the real atoms return: a fresh array per render would
// read as new data on every pass.
const empty = vi.hoisted(() => ({ list: [] as never[] }));
vi.mock("../../state/entities", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useThreadProjection: () => null,
  useQuietThreadShell: () => null,
  useProject: () => null,
  useThreadVisibleTurnItems: () => empty.list,
  useThreadCheckpointSummaries: () => empty.list,
}));
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

it("starts each cell with an empty draft so text never reaches the wrong cell", async () => {
  const store = useRightPanelStore.getState();
  const draft = page.getByRole("textbox", { name: "Message this cell" });

  act(() => store.openThread(parentRef, cellA));
  await userEvent.type(draft, "x");
  await expect.element(draft).toHaveValue("x");

  act(() => store.openThread(parentRef, cellB));
  await expect.element(draft).toHaveValue("");
});

it("closes the cell from its own header", () => {
  act(() => useRightPanelStore.getState().openThread(parentRef, cellA));
  const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
  act(() => close!.click());
  expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, parentRef)).toBe(
    null,
  );
});
