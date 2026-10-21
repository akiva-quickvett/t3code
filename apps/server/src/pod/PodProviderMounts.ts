import {
  ClaudeSettings,
  CodexSettings,
  type ProjectId,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  type ServerSettings,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  resolveClaudeHomePath,
  resolveClaudeSharedConfigPath,
} from "../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import { podProviderBinPath, type PodProviderMounts } from "./PodContainerPlan.ts";

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);

/**
 * A system directory would bring the host's whole userland, built against the
 * host's libraries, into the pod; a provider installed there is not mounted.
 */
const SYSTEM_DIR = /^\/(usr|bin|sbin|lib|lib32|lib64|etc|opt\/homebrew)(\/|$)/;

interface InstanceMountPaths {
  readonly configDirs: ReadonlyArray<string>;
  readonly codexHomes: ReadonlyArray<string>;
  readonly binaries: ReadonlyArray<string>;
}

const NO_MOUNTS: InstanceMountPaths = { configDirs: [], codexHomes: [], binaries: [] };

/** What one Claude or Codex instance needs visible in a pod; nothing for other drivers. */
const instanceMountPaths = Effect.fn("instanceMountPaths")(function* (
  instance: ProviderInstanceConfig,
) {
  const path = yield* Path.Path;
  const hostEnv = yield* HostProcess.Environment;
  const instanceEnv = (name: string) =>
    instance.environment?.findLast((variable) => variable.name === name)?.value ?? hostEnv[name];
  const binaries = (binaryPath: string) => (path.isAbsolute(binaryPath) ? [binaryPath] : []);
  if (instance.driver === "claudeAgent") {
    const config = decodeClaudeSettings(instance.config ?? {});
    if (Option.isNone(config)) return NO_MOUNTS;
    const configDir = instanceEnv("CLAUDE_CONFIG_DIR");
    // A shared config dir's transcripts are reached through links in the
    // config dir, which resolve only where the shared dir is at its own path.
    const sharedConfigDir = yield* resolveClaudeSharedConfigPath(config.value);
    return {
      configDirs: [
        yield* resolveClaudeHomePath(
          config.value,
          configDir === undefined ? {} : { CLAUDE_CONFIG_DIR: configDir },
        ),
        ...(sharedConfigDir === undefined ? [] : [sharedConfigDir]),
      ],
      codexHomes: [],
      binaries: binaries(config.value.binaryPath),
    };
  }
  if (instance.driver === "codex") {
    const config = decodeCodexSettings(instance.config ?? {});
    if (Option.isNone(config)) return NO_MOUNTS;
    const codexHome = instanceEnv("CODEX_HOME");
    const layout = yield* resolveCodexHomeLayout(
      config.value.homePath.trim().length === 0 &&
        config.value.shadowHomePath.trim().length === 0 &&
        codexHome !== undefined
        ? { ...config.value, homePath: codexHome }
        : config.value,
    );
    return {
      configDirs: [],
      codexHomes: [
        layout.sharedHomePath,
        ...(layout.effectiveHomePath === undefined ? [] : [layout.effectiveHomePath]),
      ],
      binaries: binaries(config.value.binaryPath),
    };
  }
  return NO_MOUNTS;
});

const existingPaths = (paths: Iterable<string>) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      Effect.filter([...new Set(paths)], (candidate) =>
        fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false)),
      ),
    ),
  );

/**
 * The project's enabled Claude and Codex instances, whose processes can run in
 * a pod: their config dirs with logins (and a Claude shared config dir),
 * Codex's shadow home, and the real directory of an absolute binary path
 * outside system directories. Paths that do not exist are left out, since
 * Docker refuses to bind them.
 */
export const resolvePodProviderMounts = Effect.fn("resolvePodProviderMounts")(function* (
  settings: ServerSettings,
  projectId: ProjectId,
) {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const configDirs: Array<string> = [];
  const codexHomes: Array<string> = [];
  const binaries = new Set<string>();

  for (const [instanceId, instance] of Object.entries(deriveProviderInstanceConfigMap(settings))) {
    if (
      !resolveProjectProviderInstanceEnabled(
        settings,
        projectId,
        instanceId as Parameters<typeof resolveProjectProviderInstanceEnabled>[2],
      )
    )
      continue;
    const paths = yield* instanceMountPaths(instance);
    configDirs.push(...paths.configDirs);
    codexHomes.push(...paths.codexHomes);
    for (const binary of paths.binaries) binaries.add(binary);
  }

  // A launcher symlink points into its real install; that directory is what runs.
  const binDirs = new Set<string>();
  for (const binary of binaries) {
    const real = yield* fileSystem.realPath(binary).pipe(Effect.orElseSucceed(() => null));
    if (real === null) continue;
    const dir = path.dirname(real);
    if (!SYSTEM_DIR.test(dir)) binDirs.add(dir);
  }
  return {
    configDirs: yield* existingPaths(configDirs),
    codexHomes: yield* existingPaths(codexHomes),
    binDirs: [...binDirs],
  } satisfies PodProviderMounts;
});

/**
 * The directories one instance's sessions need inside its pod's agent
 * container; an agent container made before the instance existed lacks them.
 */
export const resolveInstancePodDirectories = Effect.fn("resolveInstancePodDirectories")(function* (
  settings: ServerSettings,
  instanceId: ProviderInstanceId,
) {
  const instance = deriveProviderInstanceConfigMap(settings)[instanceId];
  if (instance === undefined) return [];
  const paths = yield* instanceMountPaths(instance);
  return yield* existingPaths([...paths.configDirs, ...paths.codexHomes]);
});

/**
 * The command that runs a host provider binary in the agent container. A bare
 * name is looked up on the container's PATH; an installed binary runs from
 * where the pod mounts its real directory; one in a system directory is not
 * mounted, so the image's copy at the same path runs.
 */
export const podProviderCommand = Effect.fn("podProviderCommand")(function* (command: string) {
  const path = yield* Path.Path;
  if (!path.isAbsolute(command)) return command;
  const fileSystem = yield* FileSystem.FileSystem;
  const real = yield* fileSystem.realPath(command).pipe(Effect.orElseSucceed(() => command));
  return SYSTEM_DIR.test(path.dirname(real)) ? command : podProviderBinPath(real);
});
