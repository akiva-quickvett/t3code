import { arrayElementsEqual } from "@t3tools/client-runtime/state/entities";
import {
  NO_META_TAB_KEY,
  type OrchestrationRootRollup,
} from "@t3tools/client-runtime/state/orchestration-tree";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { providerSupportsManualCompaction } from "../chat/ContextWindowMeter.logic";

/**
 * Every environment's metas in the order given, then the one No meta tab
 * shared by all of them. Within an environment the classifier sorts by `metaAt`.
 */
export function metaTabKeys(
  perEnvironmentMetaKeys: ReadonlyArray<ReadonlyArray<string>>,
): ReadonlyArray<string> {
  return [...perEnvironmentMetaKeys.flat(), NO_META_TAB_KEY];
}

/** Read-only: an unresolved key is never written back, so a returning meta reselects. */
export function resolveSelectedTabKey(
  tabKeys: ReadonlyArray<string>,
  selectedKey: string | null,
): string | null {
  if (selectedKey !== null && tabKeys.includes(selectedKey)) return selectedKey;
  return tabKeys[0] ?? null;
}

/** A meta tab shows its tree's roll-up (the meta included) and needs-you plus done-unread. */
export function metaTabStatus(rollup: OrchestrationRootRollup | null) {
  return { dot: rollup?.dot ?? "idle", unread: rollup?.unread ?? 0 } as const;
}

// Atom families key on strings, so an environment list travels joined.
const ENVIRONMENT_SEPARATOR = "\u0000";

export const joinEnvironmentIds = (environmentIds: ReadonlyArray<EnvironmentId>) =>
  environmentIds.join(ENVIRONMENT_SEPARATOR);

export const splitEnvironmentIds = (key: string) =>
  key === "" ? [] : (key.split(ENVIRONMENT_SEPARATOR) as EnvironmentId[]);

/**
 * The bar's derivations over the tree atoms, each equal-value stable, so a
 * streaming tick that changes neither the tab keys nor No meta's count
 * notifies nothing. Keyed by `joinEnvironmentIds`.
 */
export function createMetaTabAtoms(tree: {
  readonly metaKeysAtom: (environmentId: EnvironmentId) => Atom.Atom<ReadonlyArray<string>>;
  readonly rollupAtom: (
    environmentId: EnvironmentId,
    rootKey: string,
  ) => Atom.Atom<OrchestrationRootRollup | null>;
}) {
  const tabKeysAtom = Atom.family((environmentIdsKey: string) => {
    const environmentIds = splitEnvironmentIds(environmentIdsKey);
    let previous: ReadonlyArray<string> = [];
    return Atom.make((get) => {
      const next = metaTabKeys(environmentIds.map((id) => get(tree.metaKeysAtom(id))));
      if (arrayElementsEqual(previous, next)) return previous;
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`web-meta-tab-keys:${environmentIdsKey}`));
  });

  // No meta spans every environment; like the mockup it shows a count, no dot.
  const noMetaUnreadAtom = Atom.family((environmentIdsKey: string) => {
    const environmentIds = splitEnvironmentIds(environmentIdsKey);
    return Atom.make((get) =>
      environmentIds.reduce(
        (sum, id) => sum + (get(tree.rollupAtom(id, NO_META_TAB_KEY))?.unread ?? 0),
        0,
      ),
    ).pipe(Atom.withLabel(`web-no-meta-unread:${environmentIdsKey}`));
  });

  return { tabKeysAtom, noMetaUnreadAtom };
}

export type MetaClearAvailability =
  | { readonly enabled: true }
  | { readonly enabled: false; readonly reason: string };

/** Mirrors the server's `hasConversation`: a `/compact` with attachments still counts. */
function isConversationMessage(message: {
  readonly role: string;
  readonly text: string;
  readonly attachments: ReadonlyArray<unknown>;
}) {
  return (
    message.role === "user" &&
    (message.text.trim().toLowerCase() !== "/compact" || message.attachments.length > 0)
  );
}

/**
 * The shell says whether any user message exists. The loaded window, when it
 * holds the whole thread, also rules out a meta whose only messages are
 * `/compact`. Unloaded or paged history proves nothing, so it leaves the call
 * to the server rather than waiting on a load that may never come.
 */
export function metaClearAvailability(input: {
  readonly canOperate: boolean;
  readonly provider: Parameters<typeof providerSupportsManualCompaction>[0];
  /** The shell's `latestUserMessageAt !== null`. */
  readonly hasUserMessage: boolean;
  /** Null until the meta's detail has loaded. */
  readonly loaded: {
    readonly messages: ReadonlyArray<{
      readonly role: string;
      readonly text: string;
      readonly attachments: ReadonlyArray<unknown>;
    }>;
    readonly hasMoreHistory: boolean;
  } | null;
}): MetaClearAvailability {
  if (!input.canOperate)
    return { enabled: false, reason: "This connection cannot change threads." };
  if (!providerSupportsManualCompaction(input.provider)) {
    return { enabled: false, reason: "This meta's provider can't compact its context" };
  }
  const empty = { enabled: false, reason: "Nothing to clear yet" } as const;
  if (!input.hasUserMessage) return empty;
  if (
    input.loaded !== null &&
    !input.loaded.hasMoreHistory &&
    !input.loaded.messages.some(isConversationMessage)
  ) {
    return empty;
  }
  return { enabled: true };
}

/** The titles Settings → Organs → Metas uses for the same refusals. */
export const SET_META_FAILURE_TITLE = {
  promote: "Could not promote the thread",
  demote: "Could not demote the meta",
} as const;

export function setMetaFor<A, E>(
  setThreadMeta: (value: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly threadId: ThreadId; readonly enabled: boolean };
  }) => Promise<AtomCommandResult<A, E>>,
  threadRef: ScopedThreadRef,
  enabled: boolean,
): Promise<AtomCommandResult<A, E>> {
  return setThreadMeta({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId, enabled },
  });
}
