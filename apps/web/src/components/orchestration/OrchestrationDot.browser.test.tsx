import type { OrchestrationDot as OrchestrationDotKind } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import "~/index.css";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { OrchestrationDot, orchestrationDotGlyph } from "./OrchestrationDot";

const DOTS: ReadonlyArray<OrchestrationDotKind> = [
  "needs-you",
  "failed",
  "limited",
  "woke",
  "working",
  "waiting",
  "done-unread",
  "idle",
];

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("maps each dot to the signed vocabulary: filled = act now, hollow = take a look, ✕ = broke", () => {
  expect(Object.fromEntries(DOTS.map((dot) => [dot, orchestrationDotGlyph(dot)]))).toEqual({
    "needs-you": { tone: "warning", fill: "filled", cross: false, small: false },
    failed: { tone: "error", fill: "filled", cross: true, small: false },
    limited: { tone: "warning", fill: "ring", cross: true, small: false },
    woke: { tone: "warning", fill: "ring", cross: false, small: false },
    working: { tone: "info", fill: "filled", cross: false, small: false },
    waiting: { tone: "info", fill: "ring", cross: false, small: false },
    "done-unread": { tone: "success", fill: "filled", cross: false, small: false },
    idle: { tone: "muted", fill: "filled", cross: false, small: true },
  });
});

it("draws each glyph statically", async () => {
  await act(() =>
    root.render(
      <>
        {DOTS.map((dot) => (
          <OrchestrationDot key={dot} dot={dot} />
        ))}
      </>,
    ),
  );
  for (const dot of DOTS) {
    const element = container.querySelector<HTMLElement>(`[data-dot="${dot}"]`)!;
    const style = getComputedStyle(element);
    const glyph = orchestrationDotGlyph(dot);
    expect(style.width).toBe(glyph.small ? "6px" : "8px");
    expect(style.opacity).toBe(glyph.small ? "0.55" : "1");
    expect(style.borderTopColor).not.toBe("rgba(0, 0, 0, 0)");
    if (glyph.fill === "filled") expect(style.backgroundColor).toBe(style.borderTopColor);
    else expect(style.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    const cross = getComputedStyle(element, "::before");
    expect(cross.content === "none" || cross.content === "normal").toBe(!glyph.cross);
    expect(style.animationName).toBe("none");
    expect(style.transitionDuration).toBe("0s");
  }
  expect(document.getAnimations()).toEqual([]);
});
