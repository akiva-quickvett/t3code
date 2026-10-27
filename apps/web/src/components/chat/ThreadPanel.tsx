import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { deriveThreadRuntime } from "@t3tools/client-runtime/state/thread-execution";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { cn, newMessageId } from "../../lib/utils";
import { useQuietThreadShell, useThreadProjection } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { cellDispatchHint, cellDispatchMode, threadSurfaceLabel } from "./ThreadPanel.logic";
import { ThreadTimelineHost } from "./ThreadTimelineHost";

/**
 * One cell beside its parent chat: a compact live transcript and a composer
 * that talks to the cell directly. Open it with the right panel store's
 * `openThread(parentRef, threadId)`.
 */
export function ThreadPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onClose: () => void;
}) {
  const { environmentId, threadId } = props;
  const navigate = useNavigate();
  const threadRef = scopeThreadRef(environmentId, threadId);
  const shell = useQuietThreadShell(threadRef);
  // The same projection atom the timeline reads, so the dot, the composer mode
  // and the timeline agree on whether the cell is running.
  const projection = useThreadProjection(threadRef)?.projection ?? null;
  const running =
    projection !== null && (deriveThreadRuntime(projection)?.activeRunId ?? null) !== null;
  const organ = shell?.lineage.organ;

  return (
    <div className="flex h-full min-h-0 flex-col bg-card text-xs">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pr-2.5 pl-3">
        <span
          aria-hidden
          className={cn(
            "size-2 shrink-0 rounded-full",
            running ? "bg-primary" : "bg-muted-foreground/40",
          )}
        />
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="truncate">
            {threadSurfaceLabel(shell)}
            {shell ? ` · ${shell.modelSelection.model}` : null}
          </span>
          {organ ? (
            <span className="truncate text-muted-foreground">
              · {organ.goal} r{organ.round}
            </span>
          ) : null}
        </div>
        <Button
          variant="ghost-muted"
          size="icon-xs"
          aria-label="Open full chat"
          title="Open full chat"
          onClick={() => {
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
            });
          }}
        >
          <ArrowUpRightIcon />
        </Button>
        <Button
          variant="ghost-muted"
          size="icon-xs"
          aria-label="Close"
          title="Close"
          onClick={props.onClose}
        >
          <XIcon />
        </Button>
      </div>
      <ThreadTimelineHost environmentId={environmentId} threadId={threadId} density="compact" />
      <ThreadPanelComposer
        environmentId={environmentId}
        threadId={threadId}
        shell={shell}
        running={running}
      />
    </div>
  );
}

function ThreadPanelComposer(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly shell: EnvironmentThreadShell | null;
  readonly running: boolean;
}) {
  const { shell } = props;
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn);
  const canDispatch = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const mode = cellDispatchMode(props.running);
  const canSend = canDispatch && shell !== null && !sending && text.trim().length > 0;

  const send = async () => {
    if (!canSend) return;
    const sent = text.trim();
    setSending(true);
    setText("");
    const result = await startThreadTurn({
      environmentId: props.environmentId,
      input: {
        threadId: props.threadId,
        message: { messageId: newMessageId(), role: "user", text: sent, attachments: [] },
        runtimeMode: shell.runtimeMode,
        interactionMode: shell.interactionMode,
        dispatchMode: mode,
      },
    });
    setSending(false);
    // Keep anything typed while the send was in flight.
    if (result._tag === "Failure") setText((current) => (current === "" ? sent : current));
  };

  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-t border-border px-3 py-2.5">
      <Textarea
        size="sm"
        aria-label="Message this cell"
        placeholder="Message this cell. Its reply becomes its task result."
        value={text}
        disabled={!canDispatch}
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          void send();
        }}
      />
      <div className="flex items-center justify-between gap-2 text-2xs text-muted-foreground">
        <span className="truncate">{cellDispatchHint(mode)}</span>
        <Button size="xs" disabled={!canSend} onClick={() => void send()}>
          Send
        </Button>
      </div>
    </div>
  );
}
