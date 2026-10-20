import type {
  OrchestrationV2ContextHandoff,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";

export const MIXED_ORGANIZATION_NOTICE =
  "Mixed organization: earlier reasoning from the other organization didn't carry over.";

export const MIXED_ORGANIZATION_NOTE = [
  "Note: this thread moved to a provider account in another organization.",
  "Earlier reasoning from the other organization is unavailable to you, so re-read the thread with t3_thread_read before relying on earlier conclusions.",
  "Anything published under the other organization stays private to it, so its links may not open from this account; republish what the thread still needs, or when the user asks, and update the thread's own links to it.",
].join(" ");

/** Provider instances whose conversation the handoffs carry. */
export function handoffSourceInstanceIds(input: {
  readonly handoffs: ReadonlyArray<Pick<OrchestrationV2ContextHandoff, "fromProviderThreadIds">>;
  readonly providerThreads: ReadonlyArray<
    Pick<OrchestrationV2ProviderThread, "id" | "providerInstanceId">
  >;
}): ReadonlyArray<ProviderInstanceId> {
  const sourceThreadIds = new Set(
    input.handoffs.flatMap((handoff) => handoff.fromProviderThreadIds),
  );
  return [
    ...new Set(
      input.providerThreads
        .filter((thread) => sourceThreadIds.has(thread.id))
        .map((thread) => thread.providerInstanceId),
    ),
  ];
}

/**
 * Handoffs into a provider thread made after its last turn the provider accepted. A start that
 * failed before the provider took the prompt leaves its handoff here for the retry to announce.
 */
export function handoffsSinceAcceptedTurn<
  Handoff extends Pick<OrchestrationV2ContextHandoff, "toProviderThreadId" | "targetRunId">,
>(input: {
  readonly providerThreadId: OrchestrationV2ProviderThread["id"];
  readonly handoffs: ReadonlyArray<Handoff>;
  readonly runs: ReadonlyArray<
    Pick<OrchestrationV2Run, "id" | "ordinal" | "providerThreadId" | "activeAttemptId">
  >;
  readonly providerTurns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "runAttemptId">>;
}): ReadonlyArray<Handoff> {
  const acceptedAttemptIds = new Set(input.providerTurns.map((turn) => turn.runAttemptId));
  const lastAcceptedOrdinal = Math.max(
    0,
    ...input.runs
      .filter(
        (run) =>
          run.providerThreadId === input.providerThreadId &&
          acceptedAttemptIds.has(run.activeAttemptId),
      )
      .map((run) => run.ordinal),
  );
  const ordinalByRunId = new Map(input.runs.map((run) => [run.id, run.ordinal]));
  return input.handoffs.filter(
    (handoff) =>
      handoff.toProviderThreadId === input.providerThreadId &&
      (ordinalByRunId.get(handoff.targetRunId) ?? 0) > lastAcceptedOrdinal,
  );
}

export interface InstanceOrganization {
  readonly driver: ProviderDriverKind;
  readonly organizationKey: string | undefined;
}

/**
 * Keys are compared only within one driver, since each driver has its own account ids. An unknown
 * organization never counts: the note claims a loss only when both sides are known.
 */
export function crossesOrganization(
  target: InstanceOrganization | undefined,
  sources: ReadonlyArray<InstanceOrganization | undefined>,
): boolean {
  return (
    target?.organizationKey !== undefined &&
    sources.some(
      (source) =>
        source?.driver === target.driver &&
        source.organizationKey !== undefined &&
        source.organizationKey !== target.organizationKey,
    )
  );
}
