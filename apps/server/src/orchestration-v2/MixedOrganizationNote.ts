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

/**
 * The instance that last ran a provider thread's native conversation, when another instance now
 * resumes it natively (instances sharing one Claude config dir), and the run that made the switch.
 * Nothing once a turn on the resuming instance was accepted.
 */
export function nativeResumeSource(input: {
  readonly providerThread: Pick<OrchestrationV2ProviderThread, "id" | "nativeThreadRef">;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerThreads: ReadonlyArray<
    Pick<OrchestrationV2ProviderThread, "id" | "nativeThreadRef">
  >;
  readonly runs: ReadonlyArray<
    Pick<
      OrchestrationV2Run,
      "id" | "ordinal" | "providerThreadId" | "activeAttemptId" | "providerInstanceId"
    >
  >;
  readonly providerTurns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "runAttemptId">>;
}):
  | { readonly instanceId: ProviderInstanceId; readonly switchRunId: OrchestrationV2Run["id"] }
  | undefined {
  const nativeId = input.providerThread.nativeThreadRef?.nativeId;
  if (nativeId == null) return undefined;
  const conversationThreadIds = new Set([
    input.providerThread.id,
    ...input.providerThreads
      .filter((thread) => thread.nativeThreadRef?.nativeId === nativeId)
      .map((thread) => thread.id),
  ]);
  const acceptedAttemptIds = new Set(input.providerTurns.map((turn) => turn.runAttemptId));
  const conversationRuns = input.runs
    .filter(
      (run) => run.providerThreadId !== null && conversationThreadIds.has(run.providerThreadId),
    )
    .toSorted((left, right) => left.ordinal - right.ordinal);
  const lastAccepted = conversationRuns.findLast((run) =>
    acceptedAttemptIds.has(run.activeAttemptId),
  );
  if (lastAccepted === undefined || lastAccepted.providerInstanceId === input.providerInstanceId) {
    return undefined;
  }
  const switchRun = conversationRuns.find((run) => run.ordinal > lastAccepted.ordinal);
  return switchRun === undefined
    ? undefined
    : { instanceId: lastAccepted.providerInstanceId, switchRunId: switchRun.id };
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
