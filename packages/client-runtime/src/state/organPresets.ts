import type { OrchestrationV2ThreadShell, ServerConfig } from "@t3tools/contracts";

type Capabilities = ServerConfig["environment"]["capabilities"];

/** Stock servers lack the flag, so their clients hide Organs settings. */
export function supportsOrganPresets(capabilities: Capabilities | undefined): boolean {
  return capabilities?.organPresets === true;
}

/** Stock servers lack the flag, so their clients offer no promote or demote. */
export function supportsOrchestrationMetas(capabilities: Capabilities | undefined): boolean {
  return capabilities?.orchestrationMetas === true;
}

export type MetaPromoteBlocker = "delegated-child" | "supervised" | "archived";

/**
 * The client twin of the server's promote preconditions, checked in the same
 * order, so a disabled entry names the refusal the server would give. Forks
 * have no tree parent and are promotable.
 */
export function metaPromoteBlocker(
  thread: Pick<OrchestrationV2ThreadShell, "lineage"> & {
    readonly archivedAt: unknown;
  },
): MetaPromoteBlocker | null {
  if (thread.lineage.relationshipToParent === "subagent") return "delegated-child";
  if (thread.lineage.supervisorThreadId !== undefined) return "supervised";
  if (thread.archivedAt !== null) return "archived";
  return null;
}

export const META_PROMOTE_BLOCKER_TEXT: Readonly<Record<MetaPromoteBlocker, string>> = {
  "delegated-child": "Delegated child; only a thread with no parent can be a meta",
  supervised: "Supervised launch; only a thread with no parent can be a meta",
  archived: "Unarchive first",
};
