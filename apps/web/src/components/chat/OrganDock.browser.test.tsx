import "../../index.css";

import type { OrganGroup } from "@t3tools/client-runtime/state/subagentRuntime";
import { ThreadId } from "@t3tools/contracts";
import { act, memo, Profiler } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { ComposerBannerStack, type ComposerBannerStackItem } from "./ComposerBannerStack";
import { OrganDock, organDockBannerItem, useOrganDockOrgans } from "./OrganDock";
import { runningOrganCellThreadIds } from "./OrganDock.logic";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  container.style.width = "760px";
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

type OrganCellFixture = OrganGroup["rounds"][number]["cells"][number];

function organGroup(
  id: string,
  cellCount: number,
  overrides: Partial<OrganCellFixture> = {},
): OrganGroup {
  return {
    organId: `organ_${id}_organ_id`,
    presetId: `review-${id}`,
    goal: `Review ${id}`,
    running: true,
    rounds: [
      {
        round: 1,
        cells: Array.from({ length: cellCount }, (_, index) => ({
          childThreadId: ThreadId.make(`thread-${id}-${index}`),
          subagentId: `subagent-${id}-${index}`,
          title: `Cell ${index}`,
          role: { id: "reviewer", label: "reviewer" },
          model: "Opus 5.5",
          status: "running",
          dot: "working",
          ...overrides,
        })),
      },
    ],
  };
}

const openCell = vi.fn();
const NO_ITEMS: ReadonlyArray<ComposerBannerStackItem> = [];

function Dock({
  groups,
  extraItems = NO_ITEMS,
}: {
  groups: ReadonlyArray<OrganGroup>;
  extraItems?: ReadonlyArray<ComposerBannerStackItem>;
}) {
  const dockItem = organDockBannerItem(useOrganDockOrgans(groups), openCell);
  return <ComposerBannerStack items={dockItem ? [...extraItems, dockItem] : extraItems} />;
}

// Memoised like the banner content's `OrganDock`, so the profiler counts dock renders only
// when the hook hands over a new organs reference.
const ProfiledDock = memo(function ProfiledDock({
  organs,
  onRender,
}: {
  organs: ReturnType<typeof useOrganDockOrgans>;
  onRender: () => void;
}) {
  return (
    <Profiler id="dock" onRender={onRender}>
      <OrganDock organs={organs} onOpenCell={openCell} />
    </Profiler>
  );
});

it("re-renders only when a cell's status changes, not on streamed output", async () => {
  let dockRenders = 0;
  const onRender = () => {
    dockRenders += 1;
  };
  function Host({ groups }: { groups: ReadonlyArray<OrganGroup> }) {
    return <ProfiledDock organs={useOrganDockOrgans(groups)} onRender={onRender} />;
  }
  const render = (groups: ReadonlyArray<OrganGroup>) =>
    act(async () => root.render(<Host groups={groups} />));

  await render([organGroup("a", 3)]);
  // The scroll area commits again once it has measured its overflow.
  const mounted = dockRenders;

  // A streamed token rebuilds the projection, so every group and cell is a fresh object.
  await render([organGroup("a", 3)]);
  await render([organGroup("a", 3)]);
  expect(dockRenders).toBe(mounted);

  await render([organGroup("a", 3, { status: "completed", dot: "done-unread" })]);
  expect(dockRenders).toBeGreaterThan(mounted);
});

it("keeps six running organs within the 360px cap and scrolls inside it", async () => {
  await act(async () =>
    root.render(<Dock groups={["a", "b", "c", "d", "e", "f"].map((id) => organGroup(id, 4))} />),
  );
  const rows = container.querySelectorAll<HTMLButtonElement>("[data-organ-id] > button");
  expect(rows).toHaveLength(6);
  await act(async () => rows.forEach((row) => row.click()));

  const dock = container.querySelector<HTMLElement>("[data-organ-dock]")!;
  expect(dock.getBoundingClientRect().height).toBeLessThanOrEqual(360);
  const viewport = dock.querySelector<HTMLElement>("[data-slot=scroll-area-viewport]")!;
  expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);

  await act(async () =>
    container.querySelectorAll<HTMLButtonElement>("[data-organ-id] > div > button")[0]!.click(),
  );
  expect(openCell).toHaveBeenCalledWith("thread-a-0");
});

it("lets an urgent banner take the front slot ahead of the dock", async () => {
  const frontText = () =>
    container.querySelector("[data-composer-banner-drawer]")?.textContent ?? "";
  await act(async () => root.render(<Dock groups={[organGroup("a", 2)]} />));
  expect(frontText()).toContain("1 organ running");

  const urgent: ComposerBannerStackItem = {
    id: "usage-limit",
    variant: "warning",
    priority: "urgent",
    icon: null,
    title: "Usage limit reached",
  };
  await act(async () => root.render(<Dock groups={[organGroup("a", 2)]} extraItems={[urgent]} />));
  expect(frontText()).toContain("Usage limit reached");
  expect(frontText()).not.toContain("organ running");
});

it("takes the front slot once background work covering only organ cells is filtered away", async () => {
  const frontText = () =>
    container.querySelector("[data-composer-banner-drawer]")?.textContent ?? "";
  const groups = [organGroup("a", 2)];
  const backgroundItem = (childThreadIds: ReadonlyArray<string>): ComposerBannerStackItem[] =>
    childThreadIds.length === 0
      ? []
      : [
          {
            id: "background-work",
            variant: "default",
            priority: "activity",
            icon: null,
            title: "Waiting on 2 subagents",
          },
        ];

  await act(async () =>
    root.render(<Dock groups={groups} extraItems={backgroundItem(["thread-a-0", "thread-a-1"])} />),
  );
  expect(frontText()).toContain("Waiting on 2 subagents");

  const organCells = runningOrganCellThreadIds(groups);
  const remaining = ["thread-a-0", "thread-a-1"].filter((id) => !organCells.has(ThreadId.make(id)));
  await act(async () =>
    root.render(<Dock groups={groups} extraItems={backgroundItem(remaining)} />),
  );
  expect(frontText()).toContain("1 organ running");
});
