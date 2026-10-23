import type { OrganPreset } from "@t3tools/contracts";

/**
 * Cells name built-in role presets only. The server merges user edits over
 * these, so a change here reaches everyone who never edited the preset.
 */
export const DEFAULT_ORGAN_PRESETS: ReadonlyArray<OrganPreset> = [
  {
    id: "implementation",
    label: "Implementation",
    goalTemplate: "Implement: {goal}",
    cells: [{ role: "implementor", count: 1 }],
  },
  {
    id: "review-t3-council",
    label: "Tier 3 review council",
    goalTemplate: "Review at tier 3: {goal}",
    cells: [
      { role: "review-t3", count: 1 },
      { role: "review-t3-grok", count: 1 },
      { role: "scout", count: 2 },
    ],
  },
  {
    id: "scouts",
    label: "Scouts",
    goalTemplate: "Scout: {goal}",
    cells: [{ role: "scout", count: 3 }],
  },
  {
    id: "research",
    label: "Research",
    goalTemplate: "Research: {goal}",
    cells: [{ role: "research", count: 2 }],
  },
  {
    id: "design",
    label: "Design",
    goalTemplate: "Design: {goal}",
    cells: [{ role: "designer", count: 2 }],
  },
];
