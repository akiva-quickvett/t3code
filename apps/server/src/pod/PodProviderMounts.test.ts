import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  podProviderCommand,
  resolveInstancePodDirectories,
  resolvePodProviderMounts,
  unsafePodConfigDirs,
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

      const mounts = yield* resolvePodProviderMounts(
        settings,
        ProjectId.make("project-1"),
        undefined,
      );
      expect(mounts.configDirs).toEqual(expect.arrayContaining([configDir, sharedDir]));
      expect(yield* resolveInstancePodDirectories(settings, claudeWork, undefined)).toEqual([
        configDir,
        sharedDir,
      ]);
      expect(
        yield* resolveInstancePodDirectories(
          settings,
          ProviderInstanceId.make("missing"),
          undefined,
        ),
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

      expect(yield* podProviderCommand(launcher, undefined)).toBe(
        `/opt/t3/provider-bin${yield* fileSystem.realPath(real)}`,
      );
      expect(yield* podProviderCommand("claude", undefined)).toBe("claude");
      // System directories are not mounted; the image's copy of that name runs.
      expect(yield* podProviderCommand("/usr/bin/claude", undefined)).toBe("claude");
      // A managed install is mounted at its own path.
      expect(yield* podProviderCommand(`${root}/tools/devin/1/devin`, `${root}/tools`)).toBe(
        `${root}/tools/devin/1/devin`,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("pod provider mounts beyond Claude and Codex", () => {
  const instances = (
    entries: Record<string, { readonly driver: string; readonly config: Record<string, unknown> }>,
    environment: Record<string, string> = {},
  ): ServerSettings => {
    const providerInstances: Record<ProviderInstanceId, ProviderInstanceConfig> = {
      // The built-in default Claude instance would mount the home's `.claude.json` too.
      [ProviderInstanceId.make("claudeAgent")]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        enabled: false,
      },
    };
    for (const [id, { driver, config }] of Object.entries(entries))
      providerInstances[ProviderInstanceId.make(id)] = {
        driver: ProviderDriverKind.make(driver),
        enabled: true,
        config,
        environment: Object.entries(environment).map(([name, value]) => ({
          name,
          value,
          sensitive: false,
        })),
      };
    return { ...DEFAULT_SERVER_SETTINGS, providerInstances };
  };

  it.effect(
    "mounts Pi's and Grok's config dirs, a registry agent's install, and .claude.json",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pod-home-" });
        const toolsDir = path.join(home, ".t3", "tools");
        for (const dir of [
          path.join(home, ".pi", "agent"),
          path.join(home, ".grok"),
          path.join(home, ".claude"),
          path.join(toolsDir, "devin"),
          path.join(toolsDir, "chrome-headless-shell"),
        ])
          yield* fileSystem.makeDirectory(dir, { recursive: true });
        yield* fileSystem.writeFileString(path.join(home, ".claude.json"), "{}");
        const settings = instances({
          pi: { driver: "pi", config: {} },
          grok: { driver: "grok", config: {} },
          devin: { driver: "acpRegistry", config: { agentId: "devin" } },
          escape: { driver: "acpRegistry", config: { agentId: "../.." } },
          claude: { driver: "claudeAgent", config: {} },
        });

        const mounts = yield* resolvePodProviderMounts(settings, ProjectId.make("p"), {
          t3Home: path.join(home, ".t3"),
          filesRoot: path.join(home, ".t3", "caches", "pods"),
          toolsDir,
        }).pipe(
          Effect.provideService(HostProcess.HomeDirectory, home),
          Effect.provideService(HostProcess.Environment, {}),
          Effect.provideService(HostProcess.Platform, "linux"),
        );
        expect(mounts.configDirs).toEqual(
          expect.arrayContaining([
            path.join(home, ".pi", "agent"),
            path.join(home, ".grok"),
            path.join(home, ".claude"),
          ]),
        );
        expect(mounts.homeSeeds).toEqual([path.join(home, ".claude.json")]);
        // Only the configured agent's install, never the rest of the cache.
        expect(mounts.toolDirs).toEqual([path.join(toolsDir, "devin")]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves the operator's .claude.json out for an instance with its own config dir", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pod-home-" });
      const configDir = path.join(home, "claude-work");
      yield* fileSystem.makeDirectory(configDir);
      yield* fileSystem.writeFileString(path.join(home, ".claude.json"), "{}");
      const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(HostProcess.HomeDirectory, home),
          Effect.provideService(HostProcess.Environment, {}),
        );

      const viaHomePath = yield* provide(
        resolvePodProviderMounts(
          instances({ claude: { driver: "claudeAgent", config: { homePath: configDir } } }),
          ProjectId.make("p"),
          undefined,
        ),
      );
      const viaEnv = yield* provide(
        resolvePodProviderMounts(
          instances(
            { claude: { driver: "claudeAgent", config: {} } },
            { CLAUDE_CONFIG_DIR: configDir },
          ),
          ProjectId.make("p"),
          undefined,
        ),
      );
      expect(viaHomePath.homeSeeds).toEqual([]);
      expect(viaEnv.homeSeeds).toEqual([]);
      expect(viaEnv.configDirs).toEqual([configDir]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("mounts no host binaries from a macOS host and runs the image's CLIs by name", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pod-mac-" });
      const binary = path.join(root, "bin", "claude");
      yield* fileSystem.makeDirectory(path.dirname(binary));
      yield* fileSystem.writeFileString(binary, "#!/bin/sh\n");
      yield* fileSystem.makeDirectory(path.join(root, "tools", "devin"), { recursive: true });
      const settings = instances({
        claude: { driver: "claudeAgent", config: { binaryPath: binary } },
        devin: { driver: "acpRegistry", config: { agentId: "devin" } },
      });

      const mounts = yield* resolvePodProviderMounts(settings, ProjectId.make("p"), {
        t3Home: root,
        filesRoot: path.join(root, "caches", "pods"),
        toolsDir: path.join(root, "tools"),
      }).pipe(Effect.provideService(HostProcess.Platform, "darwin"));
      expect(mounts.binDirs).toEqual([]);
      expect(mounts.toolDirs).toEqual([]);
      expect(
        yield* podProviderCommand(binary, undefined).pipe(
          Effect.provideService(HostProcess.Platform, "darwin"),
        ),
      ).toBe("claude");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("pod provider mounts for npm-installed CLIs", () => {
  it.effect("mounts the whole package of a Node-script CLI, so its dependencies come along", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // The layout `npm install --global --prefix <root>` makes for Pi.
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pod-npm-" });
      const pkg = path.join(root, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
      const cli = path.join(pkg, "dist", "bundle", "cli.js");
      yield* fileSystem.makeDirectory(path.dirname(cli), { recursive: true });
      yield* fileSystem.makeDirectory(path.join(pkg, "node_modules", "jiti"), { recursive: true });
      yield* fileSystem.writeFileString(path.join(pkg, "package.json"), "{}");
      yield* fileSystem.writeFileString(cli, "#!/usr/bin/env node\n");
      const launcher = path.join(root, "bin", "pi");
      yield* fileSystem.makeDirectory(path.dirname(launcher));
      yield* fileSystem.symlink(cli, launcher);
      const settings: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [ProviderInstanceId.make("pi")]: {
            driver: ProviderDriverKind.make("pi"),
            enabled: true,
            config: { binaryPath: launcher },
          },
        },
      };

      const mounts = yield* resolvePodProviderMounts(settings, ProjectId.make("p"), undefined).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
      );
      const realPkg = yield* fileSystem.realPath(pkg);
      expect(mounts.binDirs).toEqual([realPkg]);
      // The script runs from inside that mount.
      expect(
        yield* podProviderCommand(launcher, undefined).pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
        ),
      ).toBe(`/opt/t3/provider-bin${yield* fileSystem.realPath(cli)}`);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("pod config dir bounds through symlinks", () => {
  it.effect("judges a config dir where its link points, as Docker's bind does", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pod-home-" }),
      );
      const link = path.join(home, "pi-agent");
      yield* fileSystem.symlink(home, link);
      const own = path.join(home, ".pi", "agent");
      yield* fileSystem.makeDirectory(own, { recursive: true });
      const unsafe = (dir: string) =>
        unsafePodConfigDirs(
          {
            ...DEFAULT_SERVER_SETTINGS,
            providerInstances: {
              [ProviderInstanceId.make("pi")]: {
                driver: ProviderDriverKind.make("pi"),
                enabled: true,
                config: {},
                environment: [{ name: "PI_CODING_AGENT_DIR", value: dir, sensitive: false }],
              },
            },
          },
          ProviderInstanceId.make("pi"),
          undefined,
        ).pipe(
          Effect.provideService(HostProcess.HomeDirectory, home),
          Effect.provideService(HostProcess.Environment, {}),
        );
      expect(yield* unsafe(link)).toEqual([link]);
      expect(yield* unsafe(own)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("pod config dir bounds", () => {
  it.effect(
    "never mounts a config dir that is the home, an ancestor of it or the T3 home, or a system dir",
    () =>
      Effect.gen(function* () {
        const home = "/home/dev";
        const hostPaths = {
          t3Home: "/home/dev/.t3",
          filesRoot: "/home/dev/.t3/caches/pods",
          toolsDir: "/home/dev/.t3/tools",
        };
        const piWith = (dir: string): ServerSettings => ({
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [ProviderInstanceId.make("pi")]: {
              driver: ProviderDriverKind.make("pi"),
              enabled: true,
              config: {},
              environment: [{ name: "PI_CODING_AGENT_DIR", value: dir, sensitive: false }],
            },
          },
        });
        const unsafe = (dir: string) =>
          unsafePodConfigDirs(piWith(dir), ProviderInstanceId.make("pi"), hostPaths).pipe(
            Effect.provideService(HostProcess.HomeDirectory, home),
            Effect.provideService(HostProcess.Environment, {}),
          );
        for (const dir of [
          "/",
          "/home",
          home,
          "~",
          "/home/dev/.t3",
          "/etc/pi",
          "/run",
          "/var/run",
          "/proc/self",
          "/sys",
          "/dev",
          "/root/.pi",
          "/boot",
          "/home/dev/.docker",
          "/home/dev/.docker/run",
        ])
          expect(yield* unsafe(dir), dir).not.toEqual([]);
        for (const dir of ["/home/dev/.pi/agent", "/home/dev/.t3/codex-shadow"])
          expect(yield* unsafe(dir), dir).toEqual([]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
