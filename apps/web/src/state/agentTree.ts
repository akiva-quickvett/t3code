import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { navigationParentThreadId } from "@t3tools/client-runtime/state/thread-relationships";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { readThreadShell } from "./entities";

/** The thread "Go to parent" opens, or null when this client does not have it. */
export function readNavigationParentRef(ref: ScopedThreadRef): ScopedThreadRef | null {
  const thread = readThreadShell(ref);
  const parentThreadId = thread === null ? null : navigationParentThreadId(thread);
  if (parentThreadId === null) return null;
  const parentRef = scopeThreadRef(ref.environmentId, parentThreadId);
  return readThreadShell(parentRef) === null ? null : parentRef;
}
