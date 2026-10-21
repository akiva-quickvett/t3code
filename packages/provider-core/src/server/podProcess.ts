import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export interface PodProcessSpec {
  /** The host's provider command; the pod runs the copy it mounts or its image ships for it. */
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  /** The process's whole environment: nothing of the server's is inherited. */
  readonly env: Readonly<Record<string, string>>;
}

/** A host command that runs a provider process in a pod's agent container. */
export interface PodProcessLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** The docker CLI's own additions to the host environment; the process receives only the spec's env. */
  readonly env: Readonly<Record<string, string>>;
  /**
   * Ends every process the launch started in the container, children
   * included. Stopping the host's docker CLI does not: it forwards no signal.
   */
  readonly stop: Effect.Effect<void>;
}

export interface ProviderPod {
  readonly podId: string;
  /**
   * Where T3 writes files for the pod's agents: the same path on the host and,
   * read-only, in the pod. Absent where the server keeps none, as in tests.
   */
  readonly fileDir?: string;
  /**
   * Whether a binary installed on the host runs in the pod. A macOS host's
   * binaries do not run in a Linux container; there the image's copies run.
   */
  readonly hostBinariesRun: boolean;
  readonly launch: (spec: PodProcessSpec) => Effect.Effect<PodProcessLaunch>;
}

/**
 * How a pod-capable provider package spawns its process: in the pod for a
 * working directory on a pod's worktree, on the host otherwise. Its default is
 * the host, as without pods. Only drivers whose sessions run in a pod ask it.
 */
export const ProviderPodProcesses = Context.Reference<{
  readonly forCwd: (cwd: string | undefined) => Effect.Effect<ProviderPod | undefined>;
}>("@t3tools/provider-core/server/podProcess/ProviderPodProcesses", {
  defaultValue: () => ({ forCwd: () => Effect.undefined }),
});

/** The set variables of a process environment, as `docker exec` passes them by name. */
export const definedEnvironment = (
  environment: NodeJS.ProcessEnv | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(environment ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

/**
 * A provider process's environment in a pod: the instance's own variables,
 * plus the config-dir variables it resolves from the host's, so the process
 * reads the directory the pod mounts for it. The rest of the server's
 * environment stays out.
 */
export const podInstanceEnvironment = (
  instanceEnvironment: NodeJS.ProcessEnv,
  hostResolvedEnvironment: NodeJS.ProcessEnv,
  configDirVariables: ReadonlyArray<string>,
): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    configDirVariables.flatMap((name) => {
      const value = hostResolvedEnvironment[name];
      return value === undefined ? [] : [[name, value]];
    }),
  ),
  ...instanceEnvironment,
});
