import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import {
  type PodHostnamePreparation,
  PodHostnameRouter,
  type PodRoute,
} from "../PodHostnameRouter.ts";

/** The host's hostname proxy, in memory: tests never write a route file or reload a proxy. */
export const makeFakePodHostnameRouter = (
  options: { readonly tailscaleServeOnProxyPort?: boolean } = {},
) => {
  /** Route files in place, by stem. */
  const routes = new Map<string, ReadonlyArray<PodRoute>>();
  const calls: Array<string> = [];
  let preparation: PodHostnamePreparation = { type: "ready", dnsAddress: "172.21.0.2" };
  let installFailure: string | null = null;
  let pruneGate: Deferred.Deferred<void> | null = null;

  const router = PodHostnameRouter.of({
    resolve: (settings) => settings,
    prepare: () => Effect.sync(() => (calls.push("prepare"), preparation)),
    install: ({ stem, routes: wanted }) =>
      Effect.sync(() => {
        calls.push(`install ${stem}`);
        if (installFailure !== null) return installFailure;
        routes.set(stem, wanted);
        return null;
      }),
    uninstall: ({ stem }) =>
      Effect.sync(() => {
        calls.push(`uninstall ${stem}`);
        routes.delete(stem);
        return null;
      }),
    prune: ({ prefix, keep }) =>
      Effect.gen(function* () {
        calls.push(`prune ${prefix}`);
        if (pruneGate !== null) yield* Deferred.await(pruneGate);
        const kept = yield* keep;
        for (const stem of routes.keys())
          if (stem.startsWith(prefix) && !kept.has(stem)) routes.delete(stem);
      }),
    tailscaleServeOnProxyPort: options.tailscaleServeOnProxyPort ?? false,
  });

  return {
    router,
    routes,
    calls,
    prepareAs: (next: PodHostnamePreparation) => {
      preparation = next;
    },
    /** Prune waits for this before it reads what to keep, as if another pod's work fell in between. */
    holdPrune: (gate: Deferred.Deferred<void>) => {
      pruneGate = gate;
    },
    failInstall: (reason: string | null) => {
      installFailure = reason;
    },
  };
};

export type FakePodHostnameRouter = ReturnType<typeof makeFakePodHostnameRouter>;
