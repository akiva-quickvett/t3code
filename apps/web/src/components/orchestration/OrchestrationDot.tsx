import type { OrchestrationDot as OrchestrationDotKind } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

export interface OrchestrationDotGlyph {
  readonly tone: "warning" | "error" | "info" | "success" | "muted";
  /** Filled = act now, ring = take a look. */
  readonly fill: "filled" | "ring";
  /** Something broke. */
  readonly cross: boolean;
  readonly small: boolean;
}

// The contract has one needs-you kind; the mockup's approval look stands for
// approval, input and plan ready alike.
const GLYPHS: Record<OrchestrationDotKind, OrchestrationDotGlyph> = {
  "needs-you": { tone: "warning", fill: "filled", cross: false, small: false },
  failed: { tone: "error", fill: "filled", cross: true, small: false },
  limited: { tone: "warning", fill: "ring", cross: true, small: false },
  woke: { tone: "warning", fill: "ring", cross: false, small: false },
  working: { tone: "info", fill: "filled", cross: false, small: false },
  waiting: { tone: "info", fill: "ring", cross: false, small: false },
  "done-unread": { tone: "success", fill: "filled", cross: false, small: false },
  idle: { tone: "muted", fill: "filled", cross: false, small: true },
};

export const ORCHESTRATION_DOT_LABELS: Record<OrchestrationDotKind, string> = {
  "needs-you": "Needs you",
  failed: "Failed",
  limited: "Usage-limited",
  woke: "Woke",
  working: "Working",
  waiting: "Waiting",
  "done-unread": "Finished, unread",
  idle: "Quiet",
};

export function orchestrationDotGlyph(dot: OrchestrationDotKind): OrchestrationDotGlyph {
  return GLYPHS[dot];
}

const TONE_BORDER: Record<OrchestrationDotGlyph["tone"], string> = {
  warning: "border-warning",
  error: "border-error",
  info: "border-info",
  success: "border-success",
  muted: "border-muted-foreground",
};

const TONE_FILL: Record<OrchestrationDotGlyph["tone"], string> = {
  warning: "bg-warning",
  error: "bg-error",
  info: "bg-info",
  success: "bg-success",
  muted: "bg-muted-foreground",
};

const TONE_CROSS: Record<OrchestrationDotGlyph["tone"], string> = {
  warning: "before:bg-warning after:bg-warning",
  error: "before:bg-error after:bg-error",
  info: "before:bg-info after:bg-info",
  success: "before:bg-success after:bg-success",
  muted: "before:bg-muted-foreground after:bg-muted-foreground",
};

const CROSS =
  "before:absolute before:inset-x-px before:top-1/2 before:-mt-[0.75px] before:h-[1.5px] before:rotate-45 after:absolute after:inset-x-px after:top-1/2 after:-mt-[0.75px] after:h-[1.5px] after:-rotate-45";

function glyphClassName(glyph: OrchestrationDotGlyph): string {
  return cn(
    "relative inline-block shrink-0 rounded-full border-2",
    glyph.small ? "size-1.5 opacity-55" : "size-2",
    TONE_BORDER[glyph.tone],
    glyph.fill === "filled" && TONE_FILL[glyph.tone],
    glyph.cross && CROSS,
    // A cross on a filled dot is cut out of it; on a ring it takes the ring's colour.
    glyph.cross &&
      (glyph.fill === "filled" ? "before:bg-white after:bg-white" : TONE_CROSS[glyph.tone]),
  );
}

const CLASS_NAMES = Object.fromEntries(
  Object.entries(GLYPHS).map(([dot, glyph]) => [dot, glyphClassName(glyph)]),
) as Record<OrchestrationDotKind, string>;

/** Static by design: status dots never animate or transition. */
export function OrchestrationDot({
  dot,
  label = ORCHESTRATION_DOT_LABELS[dot],
}: {
  readonly dot: OrchestrationDotKind;
  readonly label?: string;
}) {
  return <span role="img" aria-label={label} data-dot={dot} className={CLASS_NAMES[dot]} />;
}
