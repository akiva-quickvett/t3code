import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

export interface TimelineMinimapItem {
  readonly id: string;
  readonly rowIndex: number;
  readonly userText: string | null;
  readonly assistantText: string | null;
}

export function deriveTimelineMinimapItems(
  rows: ReadonlyArray<MessagesTimelineRow>,
): TimelineMinimapItem[] {
  const items: TimelineMinimapItem[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind !== "message" || row.message.role !== "user") {
      continue;
    }

    items.push({
      id: row.id,
      rowIndex: index,
      userText: row.message.text,
      assistantText: resolveFinalAssistantTextForTurn(rows, index),
    });
  }
  return items;
}

// Ticks sit 8px apart until the rail hits its `calc(100vh - 18rem)` cap, then
// pack into a solid bar. This many still leaves room between them on a
// laptop-height window.
export const TIMELINE_MINIMAP_MAX_TICKS = 64;

/** Evenly samples long threads down to the tick budget, keeping the first and latest turns. */
export function sampleTimelineMinimapItems(
  items: TimelineMinimapItem[],
  maxTicks = TIMELINE_MINIMAP_MAX_TICKS,
): TimelineMinimapItem[] {
  if (items.length <= maxTicks) return items;
  return Array.from(
    { length: maxTicks },
    (_, tick) => items[Math.round((tick * (items.length - 1)) / (maxTicks - 1))]!,
  );
}

/** The tick that stands for `current` on a sampled rail: the last one at or before its row. */
export function resolveTimelineMinimapTickIndex(
  ticks: ReadonlyArray<TimelineMinimapItem>,
  current: TimelineMinimapItem | null | undefined,
): number | null {
  if (!current) return null;
  let tickIndex: number | null = null;
  for (const [index, tick] of ticks.entries()) {
    if (tick.rowIndex > current.rowIndex) break;
    tickIndex = index;
  }
  return tickIndex;
}

function resolveFinalAssistantTextForTurn(
  rows: ReadonlyArray<MessagesTimelineRow>,
  userRowIndex: number,
) {
  let finalAssistantText: string | null = null;
  for (let index = userRowIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind !== "message") {
      continue;
    }
    if (row.message.role === "user") {
      break;
    }
    if (row.message.role === "assistant") {
      finalAssistantText = row.message.text ?? null;
    }
  }
  return finalAssistantText;
}

function compactMinimapPreview(text: string | null | undefined) {
  const compact = text?.replace(/\s+/g, " ").trim() ?? "";
  return compact.length > 0 ? compact : null;
}

export function resolveTimelineMinimapPreview(
  item: TimelineMinimapItem | null,
): TimelineMinimapItem | null {
  return item === null
    ? null
    : {
        ...item,
        userText: compactMinimapPreview(item.userText),
        assistantText: compactMinimapPreview(item.assistantText),
      };
}
