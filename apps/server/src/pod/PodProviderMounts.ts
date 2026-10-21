import {
  ClaudeSettings,
  CodexSettings,
  type ProjectId,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  type ServerSettings,
} from "@t3tools/contracts";
import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { GrokSettings } from "@t3tools/provider-grok/settings";
import { PiSettings } from "@t3tools/provider-pi/settings";
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
import type { PodHostPaths } from "./PodPaths.ts";

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);
const decodePiSettings = Schema.decodeUnknownOption(PiSettings);
const decodeGrokSettings = Schema.decodeUnknownOption(GrokSettings);
const decodeAcpRegistrySettings = Schema.decodeUnknownOption(AcpRegistrySettings);

/**
 * A system directory would bring the host's whole userland, built against the
 * host's libraries, into the pod; a provider installed there is not mounted.
 */
const SYSTEM_DIR = /^\/(usr|bin|sbin|lib|lib32|lib64|etc|opt\/homebrew)(\/|$)/;

interface InstanceMountPaths {
  readonly configDirs: ReadonlyArray<string>;
  readonly homeSeeds: ReadonlyArray<string>;
  readonly codexHomes: ReadonlyArray<string>;
  readonly toolDirs: ReadonlyArray<string>;
  readonly binaries: ReadonlyArray<string>;
}

const NO_MOUNTS: InstanceMountPaths = {
  configDirs: [],
  homeSeeds: [],
  codexHomes: [],
  toolDirs: [],
  binaries: [],
};

/**
 * Only Linux hosts run their installed binaries in a Linux container; a
 * macOS host's would not even load there, so the image's copies run instead.
 */
export const hostBinariesRunInPods = HostProcess.Platform.pipe(
  Effect.map((platform) => platform === "linux"),
);

/** What one instance of a pod-capable driver needs visible in a pod; nothing for other drivers. */
const instanceMountPaths = Effect.fn("instanceMountPaths")(function* (
  instance: ProviderInstanceConfig,
  toolsDir: string | undefined,
) {
  const path = yield* Path.Path;
  const hostEnv = yield* HostProcess.Environment;
  const home = yield* HostProcess.HomeDirectory;
  const instanceEnv = (name: string) =>
    instance.environment?.findLast((variable) => variable.name === name)?.value ?? hostEnv[name];
  const binaries = (binaryPath: string) => (path.isAbsolute(binaryPath) ? [binaryPath] : []);
  const envDir = (name: string, fallback: string) => {
    const value = instanceEnv(name)?.trim();
    return path.resolve(value ? expandHomePath(value, home) : fallback);
  };
  if (instance.driver === "claudeAgent") {
    const config = decodeClaudeSettings(instance.config ?? {});
    if (Option.isNone(config)) return NO_MOUNTS;
    const configDir = instanceEnv("CLAUDE_CONFIG_DIR");
    // A shared config dir's transcripts are reached through links in the
    // config dir, which resolve only where the shared dir is at its own path.
    const sharedConfigDir = yield* resolveClaudeSharedConfigPath(config.value);
    // Claude keeps `.claude.json` inside a config dir it is pointed at, and
    // beside `~/.claude` otherwise: only the default layout needs the home's.
    // It replaces the file by rename, so a bind of it would go stale; the pod
    // gets a copy instead.
    const defaultLayout = config.value.homePath.trim().length === 0 && configDir === undefined;
    return {
      ...NO_MOUNTS,
      configDirs: [
        yield* resolveClaudeHomePath(
          config.value,
          configDir === undefined ? {} : { CLAUDE_CONFIG_DIR: configDir },
        ),
        ...(sharedConfigDir === undefined ? [] : [sharedConfigDir]),
      ],
      homeSeeds: defaultLayout ? [path.join(home, ".claude.json")] : [],
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
      ...NO_MOUNTS,
      codexHomes: [
        layout.sharedHomePath,
        ...(layout.effectiveHomePath === undefined ? [] : [layout.effectiveHomePath]),
      ],
      binaries: binaries(config.value.binaryPath),
    };
  }
  if (instance.driver === "pi") {
    const config = decodePiSettings(instance.config ?? {});
    if (Option.isNone(config)) return NO_MOUNTS;
    return {
      ...NO_MOUNTS,
      configDirs: [envDir("PI_CODING_AGENT_DIR", path.join(home, ".pi", "agent"))],
      binaries: binaries(config.value.binaryPath),
    };
  }
  if (instance.driver === "grok") {
    const config = decodeGrokSettings(instance.config ?? {});
    if (Option.isNone(config)) return NO_MOUNTS;
    return {
      ...NO_MOUNTS,
      configDirs: [envDir("GROK_HOME", path.join(home, ".grok"))],
      binaries: binaries(config.value.binaryPath),
    };
  }
  if (instance.driver === "acpRegistry") {
    const config = decodeAcpRegistrySettings(instance.config ?? {});
    if (Option.isNone(config)) return NO_MOUNTS;
    const agentId = config.value.agentId.trim();
    return {
      ...NO_MOUNTS,
      // The managed cache keeps each agent under its id; other tools there stay out.
      toolDirs:
        config.value.source === "registry" && toolsDir !== undefined && isSafeAgentId(agentId)
          ? [path.join(toolsDir, agentId)]
          : [],
      binaries: binaries(config.value.commandPath),
    };
  }
  return NO_MOUNTS;
});

/**
 * What a binary needs mounted: its own directory, or for a script inside an
 * npm package, such as Pi's `dist/bundle/cli.js`, the whole package, whose
 * dependencies live beside it.
 */
const installDir = (path: Path.Path, real: string) => {
  for (let dir = path.dirname(real); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const parent = path.dirname(dir);
    const inNodeModules =
      path.basename(parent) === "node_modules" ||
      (path.basename(parent).startsWith("@") &&
        path.basename(path.dirname(parent)) === "node_modules");
    if (inNodeModules) return dir;
  }
  return path.dirname(real);
};

/**
 * Host trees no provider keeps its login in, whose read-write bind would hand
 * the pod the machine: `/run` and `/var` hold the Docker socket, `/proc`,
 * `/sys` and `/dev` the kernel's own.
 */
const HOST_ONLY_DIR = /^\/(var|run|proc|sys|dev|root|boot|srv|mnt|media)(\/|$)/;

/**
 * A config dir is mounted read-write, so one that is `/`, a system or host
 * dir, the home itself or anything holding it or the T3 home would hand the
 * pod far more than a provider's login. Judged where it really is, since
 * Docker's bind follows a symlink.
 */
const unsafeConfigDir = (hostPaths: PodHostPaths | undefined) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const real = (dir: string) =>
      fileSystem.realPath(dir).pipe(Effect.orElseSucceed(() => path.resolve(dir)));
    const home = yield* real(yield* HostProcess.HomeDirectory);
    const guarded = [home, ...(hostPaths === undefined ? [] : [yield* real(hostPaths.t3Home)])];
    // Docker's own config: its registry logins and, with Docker Desktop, its socket.
    const docker = path.join(home, ".docker");
    const within = (dir: string, root: string) => dir === root || dir.startsWith(`${root}/`);
    const hostTree = (dir: string) =>
      dir === path.parse(dir).root || SYSTEM_DIR.test(dir) || HOST_ONLY_DIR.test(dir);
    return (dir: string) =>
      real(dir).pipe(
        Effect.map((resolved) => {
          if (within(resolved, docker)) return true;
          // The home or the T3 home, or a tree holding either.
          if (guarded.some((kept) => within(kept, resolved))) return true;
          // A home may itself live under /root, /var or /srv on a server, so
          // what is inside it or the T3 home is the provider's own.
          if (guarded.some((kept) => resolved.startsWith(`${kept}/`))) return false;
          // Both as written and as resolved: macOS's /var and /etc are links
          // into /private, which neither pattern names.
          return hostTree(resolved) || hostTree(path.resolve(dir));
        }),
      );
  });

/** The instance's config dirs that a pod must not mount; placement refuses it while any is. */
export const unsafePodConfigDirs = Effect.fn("unsafePodConfigDirs")(function* (
  settings: ServerSettings,
  instanceId: ProviderInstanceId,
  hostPaths: PodHostPaths | undefined,
) {
  const instance = deriveProviderInstanceConfigMap(settings)[instanceId];
  if (instance === undefined) return [];
  const paths = yield* instanceMountPaths(instance, hostPaths?.toolsDir);
  return yield* Effect.filter(
    [...paths.configDirs, ...paths.codexHomes],
    yield* unsafeConfigDir(hostPaths),
  );
});

/** A registry agent id becomes a path segment; anything that could leave the cache is ignored. */
const isSafeAgentId = (agentId: string) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(agentId);

const existingPaths = (paths: Iterable<string>) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      Effect.filter([...new Set(paths)], (candidate) =>
        fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false)),
      ),
    ),
  );

/**
 * The project's enabled instances whose processes can run in a pod: their
 * config dirs with logins (and a Claude shared config dir or `.claude.json`),
 * Codex's shadow home, an ACP Registry agent's managed install, and the real
 * directory of an absolute binary path outside system directories, which only
 * a Linux host can run there. Paths that do not exist are left out, since
 * Docker refuses to bind them.
 */
export const resolvePodProviderMounts = Effect.fn("resolvePodProviderMounts")(function* (
  settings: ServerSettings,
  projectId: ProjectId,
  /** T3's own directories; registry agents get no mount without them. */
  hostPaths: PodHostPaths | undefined,
) {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const toolsDir = hostPaths?.toolsDir;
  const unsafe = yield* unsafeConfigDir(hostPaths);
  const configDirs: Array<string> = [];
  const homeSeeds: Array<string> = [];
  const codexHomes: Array<string> = [];
  const toolDirs: Array<string> = [];
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
    const paths = yield* instanceMountPaths(instance, toolsDir);
    // Placement refuses such an instance with the reason; nothing of it is mounted.
    if ((yield* Effect.filter([...paths.configDirs, ...paths.codexHomes], unsafe)).length > 0)
      continue;
    configDirs.push(...paths.configDirs);
    homeSeeds.push(...paths.homeSeeds);
    codexHomes.push(...paths.codexHomes);
    toolDirs.push(...paths.toolDirs);
    for (const binary of paths.binaries) binaries.add(binary);
  }

  // A launcher symlink points into its real install; that directory is what runs.
  const binDirs = new Set<string>();
  if (yield* hostBinariesRunInPods) {
    for (const binary of binaries) {
      const real = yield* fileSystem.realPath(binary).pipe(Effect.orElseSucceed(() => null));
      if (real === null) continue;
      const dir = installDir(path, real);
      if (!SYSTEM_DIR.test(dir)) binDirs.add(dir);
    }
  }
  return {
    configDirs: yield* existingPaths(configDirs),
    homeSeeds: yield* existingPaths(homeSeeds),
    codexHomes: yield* existingPaths(codexHomes),
    // Not filtered by existence: the registry installs an agent on its first
    // session, after the container is made, and the pod must see it then.
    toolDirs: (yield* hostBinariesRunInPods) ? [...new Set(toolDirs)] : [],
    binDirs: [...binDirs],
  } satisfies PodProviderMounts;
});

/**
 * The directories, as the agent container sees them, that one instance's
 * sessions need there; an agent container made before the instance existed
 * lacks them.
 */
export const resolveInstancePodDirectories = Effect.fn("resolveInstancePodDirectories")(function* (
  settings: ServerSettings,
  instanceId: ProviderInstanceId,
  hostPaths: PodHostPaths | undefined,
) {
  const instance = deriveProviderInstanceConfigMap(settings)[instanceId];
  if (instance === undefined) return [];
  const paths = yield* instanceMountPaths(instance, hostPaths?.toolsDir);
  const toolDirs = (yield* hostBinariesRunInPods) ? paths.toolDirs : [];
  return [...(yield* existingPaths([...paths.configDirs, ...paths.codexHomes])), ...toolDirs];
});

/**
 * The command that runs a host provider binary in the agent container. A bare
 * name is looked up on the container's PATH; an installed binary runs from
 * where the pod mounts its real directory, and a managed install from its own
 * path; one in a system directory is not mounted, so the image's copy of that
 * name runs. A host whose binaries cannot run in the pod mounts none, so its
 * command runs as a bare name.
 */
export const podProviderCommand = Effect.fn("podProviderCommand")(function* (
  command: string,
  /** The managed binary cache, which pods mount at its own path. */
  toolsDir: string | undefined,
) {
  const path = yield* Path.Path;
  if (!path.isAbsolute(command)) return command;
  if (!(yield* hostBinariesRunInPods)) return path.basename(command);
  if (toolsDir !== undefined && command.startsWith(`${toolsDir}/`)) return command;
  const fileSystem = yield* FileSystem.FileSystem;
  const real = yield* fileSystem.realPath(command).pipe(Effect.orElseSucceed(() => command));
  // The image keeps its copies elsewhere (npm's in /usr/local/bin), so look it up by name.
  return SYSTEM_DIR.test(path.dirname(real)) ? path.basename(command) : podProviderBinPath(real);
});
