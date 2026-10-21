import type { ScopedThreadRef, UsageThreadTree } from "@t3tools/contracts";
import { formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import { useEffect } from "react";
import { useStore } from "zustand";

import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { closeThreadUsageDialog, threadUsageDialogRequest } from "../state/threadUsage";
import { Badge } from "./ui/badge";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

export function ThreadUsageDialogHost() {
  const threadRef = useStore(threadUsageDialogRequest, (state) => state.threadRef);
  useEffect(() => closeThreadUsageDialog, []);
  return threadRef ? <ThreadUsageDialog threadRef={threadRef} /> : null;
}

function ThreadUsageDialog({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  // Mounted only while open, so the read runs when the dialog opens and never on a chat render.
  const { data, error } = useEnvironmentQuery(
    serverEnvironment.usageThreadTree({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closeThreadUsageDialog();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Cost of this work</DialogTitle>
          <DialogDescription>
            Estimated API-equivalent cost of this thread and every thread it launched or delegated
            to.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : data === null ? (
            <p className="text-sm text-muted-foreground" role="status">
              Reading usage…
            </p>
          ) : (
            <ThreadUsageTable tree={data} />
          )}
        </DialogPanel>
        {data !== null && data.unpricedRecords > 0 ? (
          <DialogFooter variant="bare">
            <span className="text-xs text-muted-foreground">
              {data.unpricedRecords} usage records have no known price and are not in the cost.
            </span>
          </DialogFooter>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function ThreadUsageTable({ tree }: { readonly tree: UsageThreadTree }) {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-x-6">
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-muted-foreground">Cost</span>
          <span className="text-2xl font-semibold text-foreground">{formatUsd(tree.costUsd)}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-muted-foreground">Tokens</span>
          <span className="text-2xl font-semibold text-foreground">
            {formatTokens(tree.tokens)}
          </span>
        </div>
      </div>
      <ul className="flex flex-col gap-1 text-sm">
        {tree.threads.map((row) => (
          <li
            key={row.threadId}
            className="flex items-center gap-2"
            style={{ paddingInlineStart: `${row.depth}rem` }}
          >
            <span className="min-w-0 flex-1 truncate">{row.title ?? "Untitled thread"}</span>
            {row.preset ? <Badge variant="outline">{row.preset}</Badge> : null}
            <span className="w-14 text-right text-muted-foreground tabular-nums">
              {formatTokens(row.tokens)}
            </span>
            <span className="w-16 text-right tabular-nums">{formatUsd(row.costUsd)}</span>
          </li>
        ))}
      </ul>
      {tree.omittedThreads === undefined ? null : (
        <p className="text-xs text-muted-foreground">
          {tree.omittedThreads} more threads are in the total but not listed.
        </p>
      )}
      <p className="text-xs text-muted-foreground">Usage since {tree.sinceDay} (UTC).</p>
    </div>
  );
}
