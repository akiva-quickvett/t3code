import { describe, expect, it } from "vite-plus/test";
import { MessageId } from "@t3tools/contracts";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import {
  deriveTimelineMinimapItems,
  resolveTimelineMinimapPreview,
  resolveTimelineMinimapTickIndex,
  sampleTimelineMinimapItems,
  TIMELINE_MINIMAP_MAX_TICKS,
} from "./timelineMinimapItems";
import type { ChatMessage } from "../../types";

function rows(
  entries: ReadonlyArray<readonly ["user" | "assistant", string]>,
): MessagesTimelineRow[] {
  const messages: ChatMessage[] = entries.map(([role, text], index) => ({
    id: MessageId.make(`message-${index}`),
    role,
    text,
    streaming: false,
    runId: null,
    createdAt: new Date(index * 1000).toISOString(),
    updatedAt: new Date(index * 1000).toISOString(),
  }));
  return messages.map((message) => ({
    kind: "message",
    id: message.id,
    createdAt: message.createdAt,
    message,
    durationStart: message.createdAt,
    showAssistantMeta: false,
    showAssistantCopyButton: false,
    assistantCopyStreaming: false,
  }));
}

describe("timeline minimap previews", () => {
  it("previews the last assistant response before the next prompt and retains jump targets", () => {
    const source = rows([
      ["user", "  Inspect\n this  "],
      ["assistant", "Working"],
      ["assistant", " Done\t now "],
      ["user", "Next"],
      ["assistant", "Second answer"],
    ]);
    const items = deriveTimelineMinimapItems(source);
    expect(items).toHaveLength(2);
    expect(resolveTimelineMinimapPreview(items[0]!)).toEqual({
      ...items[0],
      userText: "Inspect this",
      assistantText: "Done now",
    });
    expect(source[items[0]!.rowIndex]!.id).toBe(items[0]!.id);
    expect(resolveTimelineMinimapPreview(items[1]!)?.assistantText).toBe("Second answer");
    expect(items[0]?.assistantText).toBe(" Done\t now ");
  });

  it("handles an unanswered prompt, empty responses, and a closed preview", () => {
    const items = deriveTimelineMinimapItems(
      rows([
        ["user", "First"],
        ["assistant", " \n\t"],
        ["user", "Next"],
      ]),
    );
    expect(items.map((item) => resolveTimelineMinimapPreview(item)?.assistantText)).toEqual([
      null,
      null,
    ]);
    expect(resolveTimelineMinimapPreview(null)).toBeNull();
  });

  it("shows fresh streaming text without changing the jump target", () => {
    const first = deriveTimelineMinimapItems(
      rows([
        ["user", "Explain"],
        ["assistant", "First"],
      ]),
    )[0]!;
    const next = { ...first, assistantText: "First\n second" };
    expect(resolveTimelineMinimapPreview(next)).toEqual({
      ...first,
      assistantText: "First second",
    });
    expect(resolveTimelineMinimapPreview(first)?.assistantText).toBe("First");
  });
});

describe("timeline minimap sampling", () => {
  const turns = (count: number) =>
    deriveTimelineMinimapItems(
      rows(
        Array.from({ length: count }, (_, index) => ["user", `Prompt ${index}`] as const).flatMap(
          (prompt) => [prompt, ["assistant", "Answer"] as const],
        ),
      ),
    );

  it("keeps every turn while they fit the rail", () => {
    const items = turns(TIMELINE_MINIMAP_MAX_TICKS);
    expect(sampleTimelineMinimapItems(items)).toBe(items);
  });

  it("thins a long thread to the tick budget, keeping the first and latest turns", () => {
    const items = turns(500);
    const ticks = sampleTimelineMinimapItems(items);
    expect(ticks).toHaveLength(TIMELINE_MINIMAP_MAX_TICKS);
    expect(ticks[0]).toBe(items[0]);
    expect(ticks.at(-1)).toBe(items.at(-1));
    expect(new Set(ticks.map((item) => item.id)).size).toBe(ticks.length);
    // Each tick still jumps to a real user row in order.
    const rowIndexes = ticks.map((item) => item.rowIndex);
    expect(rowIndexes).toEqual(rowIndexes.toSorted((a, b) => a - b));
  });

  it("lights the tick at or before the current turn", () => {
    const items = turns(500);
    const ticks = sampleTimelineMinimapItems(items);
    const tickIndexOf = (turn: number) => resolveTimelineMinimapTickIndex(ticks, items[turn]);
    const secondTickTurn = items.indexOf(ticks[1]!);

    expect(tickIndexOf(0)).toBe(0);
    expect(tickIndexOf(secondTickTurn - 1)).toBe(0);
    expect(tickIndexOf(secondTickTurn)).toBe(1);
    expect(tickIndexOf(items.length - 1)).toBe(ticks.length - 1);
    expect(resolveTimelineMinimapTickIndex(ticks, null)).toBeNull();
  });

  it("maps each turn to its own tick when nothing is sampled", () => {
    const items = turns(10);
    expect(items.map((item) => resolveTimelineMinimapTickIndex(items, item))).toEqual(
      items.map((_, index) => index),
    );
  });
});
