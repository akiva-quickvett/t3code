import type { PodRuntimeId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";

/**
 * Host directories of T3's own that pods see. Without them (tests that do not
 * care) a pod mounts neither, and Pi cannot run in one.
 */
export interface PodHostPaths {
  /** The T3 home, which no pod may mount whole. */
  readonly t3Home: string;
  /** Inside it, the provider homes T3 manages, such as Codex's shadow homes: all a config dir there may be. */
  readonly providerHomesDir: string;
  /** One directory per pod for files T3 writes for its agents, read-only in the pod. */
  readonly filesRoot: string;
  /** The managed binary cache, where ACP Registry agents install under their id. */
  readonly toolsDir: string;
}

export const PodPaths = Context.Reference<PodHostPaths | undefined>("t3/pod/PodPaths", {
  defaultValue: () => undefined,
});

export const podFilesDir = (filesRoot: string, podId: PodRuntimeId) => `${filesRoot}/${podId}`;

export const layer = Layer.effect(
  PodPaths,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return {
      t3Home: config.baseDir,
      // CodexManagedHome and the provider auth flows keep them under `<state>/providers`.
      providerHomesDir: path.join(config.stateDir, "providers"),
      filesRoot: path.join(config.providerStatusCacheDir, "pods"),
      // AcpRegistrySupport installs under `<T3 home>/tools`.
      toolsDir: path.join(config.baseDir, "tools"),
    };
  }),
);
