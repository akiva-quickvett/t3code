import {
  AuthDiagnosticsReadScope,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { createStore } from "zustand/vanilla";

import { readEnvironmentSupportsThreadUsage } from "./entities";
import { readEnvironmentScope } from "./session";

/** Older servers have no thread usage read, and it needs the same grant as the Usage page. */
export function canReadThreadUsage(environmentId: EnvironmentId): boolean {
  return (
    readEnvironmentSupportsThreadUsage(environmentId) &&
    readEnvironmentScope(environmentId, AuthDiagnosticsReadScope)
  );
}

/** Kept apart from the dialog so menus and the palette can open it without loading its UI. */
export const threadUsageDialogRequest = createStore<{ threadRef: ScopedThreadRef | null }>(() => ({
  threadRef: null,
}));

export function openThreadUsageDialog(threadRef: ScopedThreadRef): void {
  threadUsageDialogRequest.setState({ threadRef });
}

export function closeThreadUsageDialog(): void {
  threadUsageDialogRequest.setState({ threadRef: null });
}
