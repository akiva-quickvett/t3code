import type { OrchestrationV2Command, OrchestrationV2ThreadShell, RunId } from "@t3tools/contracts";

type MessageDispatchCommand = Extract<OrchestrationV2Command, { type: "message.dispatch" }>;
export type CellDispatchMode = MessageDispatchCommand["dispatchMode"];

/** A message steers the cell's running turn; an idle cell takes it as its next turn. */
export function cellDispatchMode(activeRunId: RunId | null): CellDispatchMode {
  return activeRunId === null
    ? { type: "queue_after_active" }
    : { type: "steer_active", targetRunId: activeRunId };
}

export function cellDispatchHint(mode: CellDispatchMode): string {
  return mode.type === "steer_active" ? "steers the running turn" : "queues after the turn";
}

/** The cell's role when it has one, so a pod's cells read as their jobs, not their titles. */
export function threadSurfaceLabel(
  shell: Pick<OrchestrationV2ThreadShell, "title" | "rolePreset"> | null,
): string {
  const role = shell?.rolePreset?.label.trim();
  if (role) return role;
  const title = shell?.title.trim();
  return title ? title : "Thread";
}
