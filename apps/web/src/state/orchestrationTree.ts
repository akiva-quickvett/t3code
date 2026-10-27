import { createOrchestrationTreeAtoms } from "@t3tools/client-runtime/state/orchestration-tree";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "./server";
import { environmentShell } from "./shell";
import { environmentThreadShells } from "./threads";

export const environmentConnectedAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    Option.exists(
      AsyncResult.value(get(environmentCatalog.stateAtom(environmentId))),
      (connection) => connection.phase === "connected",
    ),
  ).pipe(Atom.withLabel(`web-orchestration-environment-connected:${environmentId}`)),
);

export const orchestrationTree = createOrchestrationTreeAtoms({
  environmentThreadsAtom: environmentThreadShells.environmentThreadsAtom,
  environmentShellStatusAtom: environmentShell.statusAtom,
  environmentConnectedAtom,
  now: () => new Date().toISOString(),
});

/** Stock servers have no metas, so their clients keep only the chat view. */
export function readEnvironmentSupportsOrchestrationMetas(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .orchestrationMetas === true
  );
}
