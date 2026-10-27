import { useAtomValue } from "@effect/atom-react";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../../state/server";

// One list for the view toggle, its shortcut, menu and palette entries, the
// tabs and next-needs-you's `mergeOrchestrationOrders`, so they never disagree.
// Kept by reference while unchanged, so config churn re-renders nothing.
const orchestrationEnvironmentIdsAtom = (() => {
  let previous: ReadonlyArray<EnvironmentId> = [];
  return Atom.make((get) => {
    const configs = get(environmentServerConfigsAtom);
    const next = Array.from(enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))).filter(
      (environmentId) =>
        configs.get(environmentId)?.environment.capabilities.orchestrationMetas === true,
    );
    if (next.length === previous.length && next.every((id, index) => id === previous[index])) {
      return previous;
    }
    previous = next;
    return next;
  }).pipe(Atom.withLabel("web-orchestration-environment-ids"));
})();

/** Empty when no enabled environment has metas, which hides the Orchestration view. */
export function useOrchestrationEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return useAtomValue(orchestrationEnvironmentIdsAtom);
}

/** For handlers outside React: the same list the header toggle reads. */
export function readOrchestrationEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return appAtomRegistry.get(orchestrationEnvironmentIdsAtom);
}
