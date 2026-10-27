import type { OrganCell, OrganGroup } from "@t3tools/client-runtime/state/subagentRuntime";
import { ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import "~/index.css";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { OrganCard, type OrganCardProps } from "./OrganCard";
import { organCardFromOrgan } from "./OrganCard.logic";

const h = vi.hoisted(() => ({
  threadSubscriptions: vi.fn(),
  dotRenders: [] as string[],
}));

// A cell's transcript loads only when a handler opens it: the card must not reach any thread
// detail or shell atom on its own.
vi.mock("../../state/threads", () => ({
  environmentThreadDetails: {
    threadAtom: (...args: unknown[]) => h.threadSubscriptions("threadAtom", ...args),
  },
}));
vi.mock("../../state/entities", () => ({
  useThreadShell: (...args: unknown[]) => h.threadSubscriptions("useThreadShell", ...args),
  useQuietThreadShell: (...args: unknown[]) =>
    h.threadSubscriptions("useQuietThreadShell", ...args),
}));
vi.mock("../orchestration/OrchestrationDot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../orchestration/OrchestrationDot")>();
  return {
    ...actual,
    OrchestrationDot: (props: Parameters<typeof actual.OrchestrationDot>[0]) => {
      h.dotRenders.push(props.dot);
      return actual.OrchestrationDot(props);
    },
  };
});

function cell(id: string, overrides: Partial<OrganCell> = {}): OrganCell {
  return {
    childThreadId: ThreadId.make(id),
    subagentId: `subagent-${id}`,
    title: null,
    role: { id: "reviewer", label: `reviewer-${id}` },
    model: "claude-opus-5-5",
    status: "running",
    dot: "working",
    ...overrides,
  };
}

function organ(overrides: Partial<OrganGroup> = {}): OrganGroup {
  return {
    organId: "organ_abcdefgh12",
    presetId: "review-council",
    goal: "Review the sidebar",
    rounds: [
      { round: 1, cells: [cell("a", { status: "completed", dot: "idle" }), cell("b")] },
      { round: 2, cells: [cell("c"), cell("d")] },
    ],
    running: true,
    ...overrides,
  };
}

let root: Root;
let container: HTMLDivElement;

const handlers = {
  onToggle: vi.fn(),
  onOpenCell: vi.fn(),
  onOpenChat: vi.fn(),
};

function render(group: OrganGroup, expanded: boolean) {
  const props: OrganCardProps = {
    group: organCardFromOrgan(group, { label: "Review council", records: [] }),
    expanded,
    ...handlers,
  };
  return act(() => root.render(<OrganCard {...props} />));
}

const button = (label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const click = (element: HTMLElement) => act(() => element.click());

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  h.threadSubscriptions.mockReset();
  h.dotRenders.length = 0;
  for (const handler of Object.values(handlers)) handler.mockReset();
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("OrganCard", () => {
  it("expands into round sections and cell rows without subscribing to any cell", async () => {
    await render(organ(), false);
    expect(container.querySelectorAll("[data-organ-cell]")).toHaveLength(0);

    await click(container.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]')!);
    expect(handlers.onToggle).toHaveBeenCalledOnce();

    await render(organ(), true);
    expect(container.textContent).toContain("Round 1");
    expect(container.textContent).toContain("Round 2");
    // Only the latest round starts open.
    expect(container.querySelectorAll("[data-organ-cell]")).toHaveLength(2);
    const roundOne = [
      ...container.querySelectorAll<HTMLButtonElement>('[data-slot="collapsible-trigger"]'),
    ].find((trigger) => trigger.textContent?.startsWith("Round 1"))!;
    await click(roundOne);
    expect(container.querySelectorAll("[data-organ-cell]")).toHaveLength(4);
    expect(h.threadSubscriptions).not.toHaveBeenCalled();
    expect(handlers.onOpenCell).not.toHaveBeenCalled();
  });

  it("reports a row press as open-cell and ↗ as open-chat, never both", async () => {
    await render(organ(), true);

    await click(button("Open reviewer-d beside the chat"));
    expect(handlers.onOpenCell).toHaveBeenCalledExactlyOnceWith("d");
    expect(handlers.onOpenChat).not.toHaveBeenCalled();

    await click(button("Open reviewer-c chat"));
    expect(handlers.onOpenChat).toHaveBeenCalledExactlyOnceWith("c");
    expect(handlers.onOpenCell).toHaveBeenCalledOnce();
    expect(handlers.onToggle).not.toHaveBeenCalled();
  });

  it("opens a cell from the keyboard", async () => {
    await render(organ(), true);
    button("Open reviewer-d beside the chat").focus();
    await userEvent.keyboard("{Enter}");
    expect(handlers.onOpenCell).toHaveBeenCalledExactlyOnceWith("d");

    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
    expect(handlers.onOpenChat).toHaveBeenCalledExactlyOnceWith("d");
  });

  it("folds the previous round when a new one arrives", async () => {
    await render(organ(), true);
    const latest = organ({
      rounds: [...organ().rounds, { round: 3, cells: [cell("e"), cell("f")] }],
    });
    await render(latest, true);
    expect(
      [
        ...container.querySelectorAll("[data-organ-cell] button[aria-label$='beside the chat']"),
      ].map((row) => row.getAttribute("aria-label")),
    ).toEqual(["Open reviewer-e beside the chat", "Open reviewer-f beside the chat"]);
  });

  it("shows the outcome only once every cell is done", async () => {
    await render(organ(), true);
    expect(container.textContent).not.toContain("Outcome");

    const done = organ({
      running: false,
      outcome: "completed",
      rounds: [{ round: 1, cells: [cell("a", { status: "completed", dot: "idle" })] }],
    });
    await render(done, true);
    expect(container.textContent).toContain("Outcome · finished");
  });

  it("re-renders only the cell whose state changed", async () => {
    await render(organ(), true);
    h.dotRenders.length = 0;

    await render(
      organ({
        rounds: [
          { round: 1, cells: [cell("a", { status: "completed", dot: "idle" }), cell("b")] },
          { round: 2, cells: [cell("c"), cell("d", { dot: "needs-you" })] },
        ],
      }),
      true,
    );
    expect(h.dotRenders).toEqual(["needs-you"]);
  });
});
