import { type LegendListRef } from "@legendapp/list/react";
import type { HandoffTimelineRun } from "@t3tools/client-runtime/handoff";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  deriveLatestThreadRun,
  deriveRunlessWorkStartedAt,
  deriveThreadActivityRun,
  deriveThreadRuntime,
} from "@t3tools/client-runtime/state/thread-execution";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { memo, useRef, useState } from "react";

import { useIncrementalTimelineEntries } from "../../hooks/useIncrementalTimelineEntries";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useTheme } from "../../hooks/useTheme";
import { derivePhase, isLatestRunSettled } from "../../session-logic";
import {
  useProject,
  useQuietThreadShell,
  useThreadCheckpointSummaries,
  useThreadProjection,
  useThreadVisibleTurnItems,
} from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import type { ChatMessage } from "../../types";
import { MessagesTimeline } from "./MessagesTimeline";

const NO_MESSAGES: ReadonlyArray<ChatMessage> = [];
const EMPTY_RUNS: ReadonlyArray<HandoffTimelineRun> = [];
const noop = () => {};
const noopAsync = async () => {};

export type ThreadTimelineDensity = "compact";

/**
 * A read-only timeline for one thread outside its route. Mounting it opens the
 * thread's subscription and unmounting closes it, so callers key it by thread.
 */
export const ThreadTimelineHost = memo(function ThreadTimelineHost(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly density: ThreadTimelineDensity;
}) {
  const { environmentId, threadId } = props;
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  const timestampFormat = useEnvironmentSettings(
    environmentId,
    (settings) => settings.timestampFormat,
  );
  const listRef = useRef<LegendListRef | null>(null);
  const [liveFollow, setLiveFollow] = useState(true);

  const threadRef = scopeThreadRef(environmentId, threadId);
  const threadKey = scopedThreadKey(threadRef);
  const shell = useQuietThreadShell(threadRef);
  const project = useProject(shell ? scopeProjectRef(environmentId, shell.projectId) : null);
  const projection = useThreadProjection(threadRef)?.projection ?? null;
  const visibleTurnItems = useThreadVisibleTurnItems(threadRef);
  const turnDiffSummaries = useThreadCheckpointSummaries(threadRef);
  const timelineEntries = useIncrementalTimelineEntries(threadKey, {
    visibleTurnItems,
    optimisticMessages: NO_MESSAGES,
    ...(projection === null
      ? {}
      : { attempts: projection.attempts, nodes: projection.nodes, plans: projection.plans }),
  });

  const latestRun = projection === null ? null : deriveLatestThreadRun(projection);
  const activityRun = projection === null ? null : deriveThreadActivityRun(projection);
  const runtime = projection === null ? null : deriveThreadRuntime(projection);
  const runlessWorkActive = projection !== null && deriveRunlessWorkStartedAt(projection) !== null;
  const onOpenThread = useStableCallback((childThreadId: ThreadId) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, childThreadId)),
    });
  });
  const onIsAtEndChange = useStableCallback((isAtEnd: boolean) => {
    if (isAtEnd) setLiveFollow(true);
  });
  const onManualNavigation = useStableCallback(() => setLiveFollow(false));
  const isWorking = derivePhase(runtime) === "running" || runlessWorkActive;
  const workspaceRoot = shell?.worktreePath ?? project?.workspaceRoot ?? undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-density={props.density}>
      <MessagesTimeline
        isWorking={isWorking}
        runlessWorkActive={runlessWorkActive}
        activeTurnInProgress={isWorking || !isLatestRunSettled(latestRun, runtime)}
        awaitingUser={shell !== null && (shell.hasPendingApprovals || shell.hasPendingUserInput)}
        listRef={listRef}
        timelineEntries={timelineEntries}
        runs={projection?.runs ?? EMPTY_RUNS}
        latestRun={activityRun}
        runningRunId={runtime?.activeRunId ?? null}
        turnDiffSummaries={turnDiffSummaries}
        activeThreadEnvironmentId={environmentId}
        routeThreadKey={threadKey}
        onOpenTurnDiff={noop}
        onOpenThread={onOpenThread}
        onForkFromRun={noopAsync}
        onRollbackCheckpoint={noop}
        supportsConversationRollback={false}
        onRevertToTurnCount={noop}
        isRevertingCheckpoint={false}
        onImageExpand={noop}
        markdownCwd={workspaceRoot}
        resolvedTheme={resolvedTheme}
        timestampFormat={timestampFormat}
        workspaceRoot={workspaceRoot}
        anchorMessageId={null}
        onAnchorReady={noop}
        onAnchorSizeChanged={noop}
        contentInsetEndAdjustment={0}
        onIsAtEndChange={onIsAtEndChange}
        liveFollowEnabled={liveFollow}
        onManualNavigation={onManualNavigation}
        hideEmptyPlaceholder={projection === null}
        topFadeEnabled={false}
      />
    </div>
  );
});
