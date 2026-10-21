import {
  ClaudeSettings,
  CodexSettings,
  type ProjectId,
  resolveProjectProviderInstanceEnabled,
  type ServerSettings,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import type { PodProviderMounts } from "./PodContainerPlan.ts";

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);

/**
 * A system directory would bring the host's whole userland, built against the
 * host's libraries, into the pod; a provider installed there is not mounted.
 */
const SYSTEM_DIR = /^\/(usr|bin|sbin|lib|lib32|lib64|etc|opt\/homebrew)(\/|$)/;

/**
 * The project's enabled Claude and Codex instances, whose processes can run in
 * a pod: their config dirs with logins, Codex's shadow home, and the real
 * directory of an absolute binary path outside system directories. Paths that
 * do not exist are left out, since Docker refuses to bind them.
 */
export const resolvePodProviderMounts = Effect.fn("resolvePodProviderMounts")(function* (
  settings: ServerSettings,
  projectId: ProjectId,
) {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const hostEnv = yield* HostProcess.Environment;
  const configDirs = new Set<string>();
  const codexHomes = new Set<string>();
  const binaries = new Set<string>();
  const addBinary = (binaryPath: string) => {
    if (path.isAbsolute(binaryPath)) binaries.add(binaryPath);
  };

  for (const [instanceId, instance] of Object.entries(deriveProviderInstanceConfigMap(settings))) {
    if (
      !resolveProjectProviderInstanceEnabled(
        settings,
        projectId,
        instanceId as Parameters<typeof resolveProjectProviderInstanceEnabled>[2],
      )
    )
      continue;
    const instanceEnv = (name: string) =>
      instance.environment?.findLast((variable) => variable.name === name)?.value ?? hostEnv[name];
    if (instance.driver === "claudeAgent") {
      const config = decodeClaudeSettings(instance.config ?? {});
      if (Option.isNone(config)) continue;
      const configDir = instanceEnv("CLAUDE_CONFIG_DIR");
      configDirs.add(
        yield* resolveClaudeHomePath(
          config.value,
          configDir === undefined ? {} : { CLAUDE_CONFIG_DIR: configDir },
        ),
      );
      addBinary(config.value.binaryPath);
    } else if (instance.driver === "codex") {
      const config = decodeCodexSettings(instance.config ?? {});
      if (Option.isNone(config)) continue;
      const codexHome = instanceEnv("CODEX_HOME");
      const layout = yield* resolveCodexHomeLayout(
        config.value.homePath.trim().length === 0 &&
          config.value.shadowHomePath.trim().length === 0 &&
          codexHome !== undefined
          ? { ...config.value, homePath: codexHome }
          : config.value,
      );
      codexHomes.add(layout.sharedHomePath);
      if (layout.effectiveHomePath !== undefined) codexHomes.add(layout.effectiveHomePath);
      addBinary(config.value.binaryPath);
    }
  }

  const existing = (paths: ReadonlySet<string>) =>
    Effect.filter([...paths], (candidate) =>
      fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false)),
    );
  // A launcher symlink points into its real install; that directory is what runs.
  const binDirs = new Set<string>();
  for (const binary of binaries) {
    const real = yield* fileSystem.realPath(binary).pipe(Effect.orElseSucceed(() => null));
    if (real === null) continue;
    const dir = path.dirname(real);
    if (!SYSTEM_DIR.test(dir)) binDirs.add(dir);
  }
  return {
    configDirs: yield* existing(configDirs),
    codexHomes: yield* existing(codexHomes),
    binDirs: [...binDirs],
  } satisfies PodProviderMounts;
});
