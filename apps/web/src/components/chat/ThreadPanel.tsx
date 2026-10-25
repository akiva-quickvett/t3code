import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { cn, newMessageId, randomUUID } from "../../lib/utils";
import { useQuietThreadShell } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentScope } from "../../state/session";
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
  const shell = useQuietThreadShell(scopeThreadRef(environmentId, threadId));
  const organ = shell?.lineage.organ;
  const activeRunId = shell?.runtime?.activeRunId ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-card text-xs">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pr-2.5 pl-3">
        <span
          aria-hidden
          className={cn(
            "size-2 shrink-0 rounded-full",
            activeRunId !== null ? "bg-primary" : "bg-muted-foreground/40",
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
        activeRunId={activeRunId}
      />
    </div>
  );
}

function ThreadPanelComposer(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly activeRunId: Parameters<typeof cellDispatchMode>[0];
}) {
  const dispatchCommand = useOrchestrationCommand(orchestrationEnvironment.v2.dispatchCommand);
  const permitted = useAtomValue(
    orchestrationEnvironment.v2.dispatchCommand.permissionAtom(props.environmentId),
  );
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const canDispatch = permitted && canOperate;
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const mode = cellDispatchMode(props.activeRunId);
  const canSend = canDispatch && !sending && text.trim().length > 0;

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    const result = await dispatchCommand({
      environmentId: props.environmentId,
      input: {
        type: "message.dispatch",
        commandId: CommandId.make(randomUUID()),
        createdBy: "user",
        creationSource: "web",
        threadId: props.threadId,
        messageId: newMessageId(),
        text,
        attachments: [],
        dispatchMode: mode,
      },
    });
    setSending(false);
    if (result._tag === "Success") setText("");
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
