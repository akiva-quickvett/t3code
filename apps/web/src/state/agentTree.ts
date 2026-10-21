import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  agentTreeAncestorIds,
  navigationParentThreadId,
} from "@t3tools/client-runtime/state/thread-relationships";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useUiStateStore } from "../uiStateStore";
import { readThreadShell } from "./entities";

/** Turns the sidebar's agent tree on and expands the thread's ancestors so its row shows. */
export function showThreadInAgentTree(ref: ScopedThreadRef | null): void {
  const { showAgentTree } = useUiStateStore.getState();
  if (ref === null) {
    showAgentTree(null, []);
    return;
  }
  const ancestorIds = agentTreeAncestorIds(ref.threadId, (threadId) =>
    readThreadShell(scopeThreadRef(ref.environmentId, threadId)),
  );
  showAgentTree(
    scopedThreadKey(ref),
    ancestorIds.map((threadId) => scopedThreadKey(scopeThreadRef(ref.environmentId, threadId))),
  );
}

/** The thread "Go to parent" opens, or null when this client does not have it. */
export function readNavigationParentRef(ref: ScopedThreadRef): ScopedThreadRef | null {
  const thread = readThreadShell(ref);
  const parentThreadId = thread === null ? null : navigationParentThreadId(thread);
  if (parentThreadId === null) return null;
  const parentRef = scopeThreadRef(ref.environmentId, parentThreadId);
  return readThreadShell(parentRef) === null ? null : parentRef;
}
