import { RegistryContext } from "@effect/atom-react";
import { deriveOrganGroups } from "@t3tools/client-runtime/state/subagentRuntime";
import {
  EnvironmentId,
  MessageId,
  type OrchestrationV2Subagent,
  type OrganId,
  ThreadId,
} from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import * as DateTime from "effect/DateTime";
import { act, createRef, memo, Profiler, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { ComposerBannerStack } from "./ComposerBannerStack";
import { MessagesTimeline } from "./MessagesTimeline";
import { OrganDock, organDockBannerItem, useOrganDockOrgans } from "./OrganDock";
import { revealSubagentInTimeline } from "./timelineReveal";

const h = await vi.hoisted(async () => {
  const { Atom, AtomRegistry } = await import("effect/reactivity");
  return {
    registry: AtomRegistry.make(),
    thread: Atom.make<{ projection: { subagents: ReadonlyArray<unknown> } } | null>(null).pipe(
      Atom.keepAlive,
    ),
    noShell: Atom.make(null),
    cellShells: new Map<string, unknown>(),
  };
});

vi.mock(import("../../state/threads"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentThreadDetails: { ...actual.environmentThreadDetails, threadAtom: () => h.thread },
    environmentThreadShells: {
      ...actual.environmentThreadShells,
      threadShellAtom: () => h.noShell,
    },
  } as never;
});
vi.mock(import("./PodSummaryCard"), () => ({
  PodSummaryCard: () => <></>,
  useOrganCellShells: () => h.cellShells as never,
}));

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PARENT_ID = ThreadId.make("thread-1");
const ORGAN_ID = "organ_review_council" as OrganId;
const CREATED_AT = "2026-10-27T09:00:00.000Z";
const CELLS = ["cell-a", "cell-b"] as const;

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
type Entry = TimelineProps["timelineEntries"][number];
type CellStatus = OrchestrationV2Subagent["status"];

for (const cell of CELLS) {
  h.cellShells.set(cell, {
    shellStatus: "idle",
    rolePreset: { id: "review-t3", label: `review ${cell}` },
  });
}

function record(cell: string, status: CellStatus, progress?: string) {
  const at = DateTime.makeUnsafe(CREATED_AT);
  return {
    id: `subagent-${cell}`,
    threadId: PARENT_ID,
    runId: "run-1",
    childThreadId: ThreadId.make(cell),
    organ: { id: ORGAN_ID, presetId: "review-council", goal: "Review the diff", round: 1 },
    status,
    model: "claude-opus-5-5",
    title: cell,
    prompt: "Review",
    result: null,
    startedAt: at,
    completedAt: status === "completed" ? at : null,
    updatedAt: at,
    ...(progress === undefined ? {} : { progress }),
  } as unknown as OrchestrationV2Subagent;
}

function entries(status: CellStatus): Entry[] {
  return [
    {
      id: "entry-user",
      kind: "message",
      createdAt: CREATED_AT,
      message: {
        id: MessageId.make("message-user"),
        role: "user",
        text: "Review the diff",
        runId: null,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        streaming: false,
      },
    },
    ...CELLS.map(
      (cell) =>
        ({
          id: `item-${cell}`,
          kind: "event",
          createdAt: CREATED_AT,
          projectedItem: {
            position: 0,
            visibility: "local",
            sourceThreadId: PARENT_ID,
            sourceItemId: `item-${cell}`,
            item: {
              id: `item-${cell}`,
              type: "subagent",
              threadId: PARENT_ID,
              runId: "run-1",
              subagentId: `subagent-${cell}`,
              childThreadId: cell,
              status,
              title: cell,
              origin: "app_owned",
              driver: "claudeAgent",
              providerInstanceId: "claudeAgent",
              providerTurnId: null,
              startedAt: null,
              completedAt: null,
              updatedAt: {},
            },
          },
        }) as never,
    ),
  ];
}

const setSubagents = (subagents: ReadonlyArray<OrchestrationV2Subagent>) =>
  act(async () => h.registry.set(h.thread, { projection: { subagents } }));

let threadCount = 0;
function timelineProps(overrides: Partial<TimelineProps> = {}): TimelineProps {
  threadCount += 1;
  return {
    isWorking: false,
    activeTurnInProgress: false,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    turnDiffSummaries: [],
    runs: [],
    routeThreadKey: `environment-local:organ-thread-${threadCount}`,
    timelineEntries: [],
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onForkFromRun: async () => {},
    onRollbackCheckpoint: () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light",
    timestampFormat: "locale",
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
    onManualNavigation: () => {},
    ...overrides,
  };
}

const openCell = vi.fn();
const dockRenders = vi.fn();
// Memoised like the banner's `OrganDock`, so the profiler counts a render only when ChatView's
// inputs (the kept organs and a stable `onOpenCell`) change.
const ProfiledDock = memo(function ProfiledDock(props: ComponentProps<typeof OrganDock>) {
  return (
    <Profiler id="dock" onRender={dockRenders}>
      <OrganDock {...props} />
    </Profiler>
  );
});

/** ChatView's composition: the dock reads the same records the timeline renders. */
function Chat({ props, subagents }: { props: TimelineProps; subagents: Subagents }) {
  const organs = useOrganDockOrgans(
    deriveOrganGroups(subagents, (id) => h.cellShells.get(id) as never),
  );
  const dockItem = organDockBannerItem(organs, openCell);
  return (
    <>
      <MessagesTimeline {...props} />
      <ComposerBannerStack
        items={
          dockItem === null
            ? []
            : [{ ...dockItem, content: <ProfiledDock organs={organs} onOpenCell={openCell} /> }]
        }
      />
    </>
  );
}
type Subagents = ReadonlyArray<OrchestrationV2Subagent>;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.body.appendChild(document.createElement("div"));
  container.style.cssText = "height: 900px; width: 900px; display: flex; flex-direction: column;";
  root = createRoot(container);
  dockRenders.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = (element: React.ReactElement) =>
  act(async () =>
    root.render(<RegistryContext.Provider value={h.registry}>{element}</RegistryContext.Provider>),
  );
const placeholder = () => container.querySelector(`[data-organ-docked="${ORGAN_ID}"]`);
const card = () => container.querySelector('[data-organ-card="organ"]');
const dock = () => container.querySelector('[data-organ-dock="true"]');
const cellRows = () => container.querySelectorAll("[data-organ-cell]");

it("docks a running organ, ignores streamed output, and returns the card to its turn when it finishes", async () => {
  const props = timelineProps({ organsDocked: true });
  const running = CELLS.map((cell) => record(cell, "running"));
  await setSubagents(running);
  await render(
    <Chat props={{ ...props, timelineEntries: entries("running") }} subagents={running} />,
  );

  expect(placeholder()?.textContent).toContain("Review council · docked below · 2 working");
  expect(card()).toBeNull();
  expect(dock()?.textContent).toContain("1 organ running");
  const rendersWhileRunning = dockRenders.mock.calls.length;

  // A cell streaming output rewrites its record without changing anything the dock draws.
  const streaming = [record("cell-a", "running", "Reading src/index.ts"), running[1]!];
  await setSubagents(streaming);
  await render(
    <Chat props={{ ...props, timelineEntries: entries("running") }} subagents={streaming} />,
  );
  expect(dockRenders).toHaveBeenCalledTimes(rendersWhileRunning);

  const finished = CELLS.map((cell) => record(cell, "completed"));
  await setSubagents(finished);
  await render(
    <Chat props={{ ...props, timelineEntries: entries("completed") }} subagents={finished} />,
  );
  expect(dock()).toBeNull();
  expect(placeholder()).toBeNull();
  // A settled turn folds its work, the card with it.
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.startsWith("Worked for"))
      ?.click(),
  );
  const organCard = card();
  expect(organCard?.textContent).toContain("Review council");
  // In its turn: after the message that started it.
  const userRow = container.querySelector('[data-message-id="message-user"]');
  expect(userRow?.compareDocumentPosition(organCard!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
});

it("renders the card in place when the host has no dock", async () => {
  const running = CELLS.map((cell) => record(cell, "running"));
  await setSubagents(running);
  await render(<MessagesTimeline {...timelineProps({ timelineEntries: entries("running") })} />);
  expect(placeholder()).toBeNull();
  expect(card()).not.toBeNull();
});

it("opens with the organ's card expanded after Show in parent chat", async () => {
  const onManualNavigation = vi.fn();
  const props = timelineProps({ timelineEntries: entries("completed"), onManualNavigation });
  await setSubagents(CELLS.map((cell) => record(cell, "completed")));
  revealSubagentInTimeline(props.routeThreadKey, ThreadId.make("cell-b"));
  await render(<MessagesTimeline {...props} />);

  await vi.waitFor(() => expect(cellRows()).toHaveLength(2));
  expect(container.textContent).toContain("review cell-b");
  expect(onManualNavigation).toHaveBeenCalled();
});
