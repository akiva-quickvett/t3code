import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { WifiOffIcon } from "lucide-react";

import { useEnvironment } from "../../state/environments";
import { environmentConnectedAtom } from "../../state/orchestrationTree";
import { environmentShell } from "../../state/shell";

/** The two inputs `resolveOrchestrationDot` reads for staleness; both are primitives. */
export function useEnvironmentConnection(environmentId: EnvironmentId) {
  return {
    environmentConnected: useAtomValue(environmentConnectedAtom(environmentId)),
    shellStatus: useAtomValue(environmentShell.statusAtom(environmentId)),
  };
}

/** Same rule as `resolveOrchestrationDot`'s `stale`, for rows and containers without a thread. */
export function isEnvironmentStale(input: ReturnType<typeof useEnvironmentConnection>): boolean {
  return (
    !input.environmentConnected ||
    input.shellStatus === "cached" ||
    input.shellStatus === "synchronizing"
  );
}

export function useEnvironmentStale(environmentId: EnvironmentId): boolean {
  return isEnvironmentStale(useEnvironmentConnection(environmentId));
}

/**
 * One static row at the top of a stale environment's subtree; renders nothing
 * while the environment is live, so containers can always mount it.
 */
export function StaleBanner({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const stale = useEnvironmentStale(environmentId);
  const label = useEnvironment(environmentId)?.label ?? "environment";
  if (!stale) return null;
  return (
    <div
      role="status"
      className="flex h-6 shrink-0 items-center gap-1.5 overflow-hidden whitespace-nowrap border-b border-border bg-muted px-2.5 text-2xs text-warning-foreground"
    >
      <WifiOffIcon className="size-3 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">Reconnecting to {label}…</span>
    </div>
  );
}
