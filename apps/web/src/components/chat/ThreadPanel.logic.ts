import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";

export type CellDispatchMode = "steer" | "queue";

/**
 * A message steers the cell's running turn; an idle cell takes it as its next
 * turn. The server resolves "steer" against its own active run, so a run that
 * starts or ends mid-send is not targeted from a stale client view.
 */
export function cellDispatchMode(running: boolean): CellDispatchMode {
  return running ? "steer" : "queue";
}

export function cellDispatchHint(mode: CellDispatchMode): string {
  return mode === "steer" ? "steers the running turn" : "queues after the turn";
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
