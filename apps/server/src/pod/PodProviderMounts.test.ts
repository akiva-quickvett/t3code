import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  podProviderCommand,
  resolveInstancePodDirectories,
  resolvePodProviderMounts,
} from "./PodProviderMounts.ts";

const claudeWork = ProviderInstanceId.make("claude_work");

const settingsWith = (config: Record<string, string>): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: {
    [claudeWork]: { driver: ProviderDriverKind.make("claudeAgent"), config },
  },
});

describe("pod provider mounts", () => {
  it.effect("mounts a Claude instance's shared config dir beside its config dir", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pod-mounts-" });
      const configDir = path.join(root, "claude-work");
      const sharedDir = path.join(root, "claude-shared");
      yield* fileSystem.makeDirectory(configDir);
      yield* fileSystem.makeDirectory(sharedDir);
      const settings = settingsWith({ homePath: configDir, sharedConfigPath: sharedDir });

      const mounts = yield* resolvePodProviderMounts(settings, ProjectId.make("project-1"));
      expect(mounts.configDirs).toEqual(expect.arrayContaining([configDir, sharedDir]));
      expect(yield* resolveInstancePodDirectories(settings, claudeWork)).toEqual([
        configDir,
        sharedDir,
      ]);
      expect(
        yield* resolveInstancePodDirectories(settings, ProviderInstanceId.make("missing")),
      ).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("runs a host binary from where the pod mounts its real directory", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pod-bin-" });
      const real = path.join(root, "versions", "2.1.150");
      yield* fileSystem.makeDirectory(path.dirname(real));
      yield* fileSystem.writeFileString(real, "#!/bin/sh\n");
      const launcher = path.join(root, "claude");
      yield* fileSystem.symlink(real, launcher);

      expect(yield* podProviderCommand(launcher)).toBe(
        `/opt/t3/provider-bin${yield* fileSystem.realPath(real)}`,
      );
      expect(yield* podProviderCommand("claude")).toBe("claude");
      // System directories are not mounted; the image's copy at that path runs.
      expect(yield* podProviderCommand("/usr/bin/env")).toBe("/usr/bin/env");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
