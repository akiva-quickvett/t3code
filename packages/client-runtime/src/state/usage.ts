import {
  type AgentUsageHeadroom,
  type AgentUsageLimits,
  type EnvironmentId,
  isProviderAvailable,
  type ProviderInstanceId,
  type ServerProvider,
  type UsageHeadroomThresholds,
  type UsageSummary,
  type UsageSummaryInput,
  USAGE_LIMITS_MIN_REFRESH_INTERVAL_MS,
} from "@t3tools/contracts";
import { projectAgentUsageLimits } from "@t3tools/shared/usageLimits";
import * as Schema from "effect/Schema";
import type { AtomRegistry } from "effect/reactivity";

import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import type { createEnvironmentPresentationAtoms } from "./presentation.ts";
import { executeAtomQuery, runAtomCommand, squashAtomCommandFailure } from "./runtime.ts";
import type { createServerEnvironmentAtoms } from "./server.ts";

const isEnvironmentRpcUnavailable = Schema.is(EnvironmentRpcUnavailableError);

export function needsCursorKeychainAccess(
  summary: UsageSummary | null,
  providers: readonly ServerProvider[] | null,
): boolean {
  return (
    summary?.sources.some((source) => source.action === "enableCursorKeychain") === true &&
    providers?.some((provider) => provider.driver === "cursor" && provider.status === "ready") ===
      true
  );
}

/**
 * Any environment reading a Cursor account already reports that account's
 * history from every machine, so the prompt only adds duplicates there.
 */
export function cursorKeychainAccessEnvironments<
  E extends { readonly summary: UsageSummary | null; readonly needsCursorKeychainAccess: boolean },
>(environments: readonly E[]): readonly E[] {
  const hasCursorAccount = environments.some((environment) =>
    environment.summary?.sources.some(
      (source) =>
        source.fingerprint.provider === "cursor" && source.fingerprint.hostId === "cursor.com",
    ),
  );
  return hasCursorAccount
    ? []
    : environments.filter((environment) => environment.needsCursorKeychainAccess);
}

// Unknown (last check failed) may still have room, so it ranks above exhausted.
const HEADROOM_RANK: Record<AgentUsageHeadroom, number> = {
  ok: 0,
  low: 1,
  unknown: 2,
  exhausted: 3,
};

/** Stable: rows with equal headroom keep their order. */
export function sortByHeadroom<T extends Pick<AgentUsageLimits, "headroom">>(
  rows: readonly T[],
): readonly T[] {
  return [...rows].sort(
    (left, right) => HEADROOM_RANK[left.headroom] - HEADROOM_RANK[right.headroom],
  );
}

/** The accounts a limited thread can move to: the other usable instances of its driver. */
export function switchAccountCandidates(
  providers: readonly ServerProvider[],
  currentInstanceId: ProviderInstanceId,
  thresholds: UsageHeadroomThresholds,
  now: number,
): readonly AgentUsageLimits[] {
  const driver = providers.find((provider) => provider.instanceId === currentInstanceId)?.driver;
  return sortByHeadroom(
    providers
      .filter(
        (provider) =>
          provider.driver === driver &&
          provider.instanceId !== currentInstanceId &&
          provider.enabled &&
          provider.installed &&
          isProviderAvailable(provider) &&
          provider.auth.status !== "unauthenticated",
      )
      .map((provider) => projectAgentUsageLimits(provider, thresholds, now)),
  );
}

const limitsRefreshAfter = new Map<EnvironmentId, number>();
const limitsRefreshes = new Map<EnvironmentId, Promise<unknown>>();

export async function refreshUsageLimits<A>(
  environmentId: EnvironmentId,
  refresh: () => Promise<A>,
  automatic = false,
  afterPending = false,
): Promise<A | undefined> {
  const pending = limitsRefreshes.get(environmentId);
  if (pending !== undefined) {
    if (afterPending) {
      try {
        await pending;
      } catch {}
      return refreshUsageLimits(environmentId, refresh, false, true);
    }
    return automatic ? undefined : ((await pending) as A);
  }
  const refreshAfter = limitsRefreshAfter.get(environmentId) ?? 0;
  // @effect-diagnostics-next-line globalDate:off
  if (automatic && Date.now() < refreshAfter) return;
  const current = Promise.resolve()
    .then(refresh)
    .finally(() => {
      limitsRefreshes.delete(environmentId);
      // @effect-diagnostics-next-line globalDate:off
      limitsRefreshAfter.set(environmentId, Date.now() + USAGE_LIMITS_MIN_REFRESH_INTERVAL_MS);
    });
  limitsRefreshes.set(environmentId, current);
  return await current;
}

export async function refreshUsage({
  registry,
  server,
  presentations,
  environmentIds,
  input,
}: {
  registry: AtomRegistry.AtomRegistry;
  server: Pick<
    ReturnType<typeof createServerEnvironmentAtoms>,
    "usageSummary" | "refreshUsageRates"
  >;
  presentations: Pick<ReturnType<typeof createEnvironmentPresentationAtoms>, "presentationAtom">;
  environmentIds: readonly EnvironmentId[];
  input: UsageSummaryInput;
}): Promise<void> {
  await Promise.all(
    environmentIds.map(async (environmentId) => {
      const query = server.usageSummary({ environmentId, input });
      const presentation = presentations.presentationAtom(environmentId);
      const controller = new AbortController();
      const abortWhenDisconnected = () => {
        if (registry.get(presentation)?.connection.phase !== "connected") controller.abort();
      };
      const unsubscribe = registry.subscribe(presentation, abortWhenDisconnected);
      abortWhenDisconnected();
      try {
        const ratesResult = await runAtomCommand(
          registry,
          server.refreshUsageRates,
          { environmentId, input: {} },
          { reportFailure: false },
        );
        const sessionUnavailable =
          ratesResult._tag === "Failure" &&
          isEnvironmentRpcUnavailable(squashAtomCommandFailure(ratesResult));
        registry.refresh(query);
        if (sessionUnavailable || controller.signal.aborted) return;
        await executeAtomQuery(registry, query, {
          reportFailure: false,
          signal: controller.signal,
        });
      } finally {
        unsubscribe();
      }
    }),
  );
}
