import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  CLAUDE_SHARED_CONFIG_ENTRIES,
  isClaudePrivateConfigEntry,
  materializeClaudeSharedConfig,
  unshareClaudeConfig,
} from "./ClaudeConfigLayout.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

const makeLayout = Effect.fn("ClaudeConfigLayout.test.makeLayout")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-claude-config-" });
  const sharedConfigDir = path.join(root, "shared");
  const configDir = path.join(root, "instance");
  yield* fileSystem.makeDirectory(path.join(sharedConfigDir, "skills"), { recursive: true });
  yield* fileSystem.writeFileString(path.join(sharedConfigDir, "settings.json"), "{}");
  yield* fileSystem.writeFileString(path.join(sharedConfigDir, ".credentials.json"), "shared");
  yield* fileSystem.writeFileString(path.join(sharedConfigDir, ".claude.json"), "{}");
  yield* fileSystem.makeDirectory(path.join(sharedConfigDir, "sessions"));
  return { root, configDir, sharedConfigDir };
});

const linkTarget = Effect.fn("ClaudeConfigLayout.test.linkTarget")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readLink(path).pipe(Effect.orElseSucceed(() => undefined));
});

const readRecord = Effect.fn("ClaudeConfigLayout.test.readRecord")(function* (configDir: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fileSystem
    .readFileString(path.join(configDir, ".t3code-shared-config"))
    .pipe(Effect.orElseSucceed(() => "null"));
  return JSON.parse(text) as { sharedConfigDir: string; linked: Array<string> } | null;
});

/** Runs `effect` with one file system operation dying, as if the process stopped there. */
const failingAt = <A, E, R>(operation: "remove" | "symlink", effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* effect.pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fileSystem,
        [operation]: () => Effect.die(`injected ${operation} failure`),
      }),
      Effect.exit,
    );
  });

const listing = Effect.fn("ClaudeConfigLayout.test.listing")(function* (directory: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return (yield* fileSystem
    .readDirectory(directory)
    .pipe(Effect.orElseSucceed(() => []))).toSorted();
});

it.layer(NodeServices.layer)("ClaudeConfigLayout", (it) => {
  describe("materializeClaudeSharedConfig", () => {
    it.effect.skipIf(!symlinksSupported)(
      "links shared entries with absolute targets and seeds what Claude creates on first use",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const layout = yield* makeLayout();

          yield* materializeClaudeSharedConfig(layout);

          for (const entry of ["projects", "file-history", "history.jsonl", "settings.json"]) {
            expect(yield* linkTarget(path.join(layout.configDir, entry))).toBe(
              path.join(layout.sharedConfigDir, entry),
            );
          }
          expect(
            yield* fileSystem.readFileString(path.join(layout.sharedConfigDir, "history.jsonl")),
          ).toBe("");
          // Config files the shared dir lacks are not linked as dangling links.
          expect(yield* linkTarget(path.join(layout.configDir, "CLAUDE.md"))).toBeUndefined();
          for (const entry of [".credentials.json", ".claude.json", "sessions"]) {
            expect(yield* fileSystem.exists(path.join(layout.configDir, entry))).toBe(false);
          }
        }).pipe(Effect.scoped),
    );

    it.effect.skipIf(!symlinksSupported)(
      "leaves an already linked config dir untouched, including links spelled differently",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const layout = yield* makeLayout();
          yield* fileSystem.makeDirectory(layout.configDir);
          const relativeSkills = path.relative(
            layout.configDir,
            path.join(layout.sharedConfigDir, "skills"),
          );
          yield* fileSystem.symlink(relativeSkills, path.join(layout.configDir, "skills"));
          yield* materializeClaudeSharedConfig(layout);
          const before = yield* listing(layout.configDir);

          yield* materializeClaudeSharedConfig(layout);

          expect(yield* listing(layout.configDir)).toEqual(before);
          expect(yield* linkTarget(path.join(layout.configDir, "skills"))).toBe(relativeSkills);
        }).pipe(Effect.scoped),
    );

    it.effect.skipIf(!symlinksSupported)(
      "reports every real entry or wrong link as a conflict and changes nothing",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const layout = yield* makeLayout();
          const elsewhere = path.join(layout.root, "elsewhere");
          yield* fileSystem.makeDirectory(path.join(layout.configDir, "projects"), {
            recursive: true,
          });
          yield* fileSystem.writeFileString(
            path.join(layout.configDir, "projects", "session.jsonl"),
            "own",
          );
          yield* fileSystem.makeDirectory(elsewhere);
          yield* fileSystem.symlink(elsewhere, path.join(layout.configDir, "skills"));
          const instanceBefore = yield* listing(layout.configDir);
          const sharedBefore = yield* listing(layout.sharedConfigDir);

          const error = yield* Effect.flip(materializeClaudeSharedConfig(layout));

          expect(error._tag).toBe("ClaudeSharedConfigEntryConflictError");
          expect(error._tag === "ClaudeSharedConfigEntryConflictError" && error.entryNames).toEqual(
            ["projects", "skills"],
          );
          expect(yield* listing(layout.configDir)).toEqual(instanceBefore);
          expect(yield* listing(layout.sharedConfigDir)).toEqual(sharedBefore);
          expect(
            yield* fileSystem.readFileString(
              path.join(layout.configDir, "projects", "session.jsonl"),
            ),
          ).toBe("own");
          expect(yield* linkTarget(path.join(layout.configDir, "skills"))).toBe(elsewhere);
        }).pipe(Effect.scoped),
    );

    it.effect.skipIf(!symlinksSupported)(
      "moves only its own links when the shared path changes",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const layout = yield* makeLayout();
          const nextShared = path.join(layout.root, "next-shared");
          yield* fileSystem.makeDirectory(nextShared);
          yield* fileSystem.writeFileString(path.join(nextShared, "settings.json"), "{}");
          yield* materializeClaudeSharedConfig(layout);

          yield* materializeClaudeSharedConfig({ ...layout, sharedConfigDir: nextShared });

          expect(yield* linkTarget(path.join(layout.configDir, "projects"))).toBe(
            path.join(nextShared, "projects"),
          );
          // The new shared dir has no skills, so the old link goes rather than lingering.
          expect(yield* fileSystem.exists(path.join(layout.configDir, "skills"))).toBe(false);
        }).pipe(Effect.scoped),
    );

    it.effect("refuses a shared path that is the instance's own config dir", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const layout = yield* makeLayout();

        const same = yield* Effect.flip(
          materializeClaudeSharedConfig({
            configDir: layout.sharedConfigDir,
            sharedConfigDir: layout.sharedConfigDir,
          }),
        );
        expect(same._tag).toBe("ClaudeSharedConfigPathConflictError");

        if (symlinksSupported) {
          const alias = path.join(layout.root, "alias");
          yield* fileSystem.symlink(layout.sharedConfigDir, alias);
          const aliased = yield* Effect.flip(
            materializeClaudeSharedConfig({
              configDir: alias,
              sharedConfigDir: layout.sharedConfigDir,
            }),
          );
          expect(aliased._tag).toBe("ClaudeSharedConfigPathConflictError");
        }
      }).pipe(Effect.scoped),
    );

    it.effect("fails without touching anything when the shared dir is missing", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const layout = yield* makeLayout();

        const error = yield* Effect.flip(
          materializeClaudeSharedConfig({
            ...layout,
            sharedConfigDir: path.join(layout.root, "missing"),
          }),
        );

        expect(error._tag).toBe("ClaudeSharedConfigMissingError");
        expect(yield* fileSystem.exists(layout.configDir)).toBe(false);
      }).pipe(Effect.scoped),
    );

    it.effect("refuses a directory Claude has never used, such as a profile root", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const layout = yield* makeLayout();
        const profileRoot = path.join(layout.root, "profile");
        yield* fileSystem.makeDirectory(path.join(profileRoot, ".claude"), { recursive: true });

        const error = yield* Effect.flip(
          materializeClaudeSharedConfig({ ...layout, sharedConfigDir: profileRoot }),
        );

        expect(error._tag).toBe("ClaudeSharedConfigNotConfigDirError");
        expect(yield* listing(profileRoot)).toEqual([".claude"]);
        expect(yield* fileSystem.exists(layout.configDir)).toBe(false);
      }).pipe(Effect.scoped),
    );
  });

  describe("record of its own links", () => {
    it.effect.skipIf(!symlinksSupported)(
      "keeps links it did not make when the setting is cleared",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const layout = yield* makeLayout();
          // A profile orch already linked to the same shared dir.
          yield* fileSystem.makeDirectory(layout.configDir);
          yield* fileSystem.symlink(
            path.join(layout.sharedConfigDir, "skills"),
            path.join(layout.configDir, "skills"),
          );

          yield* materializeClaudeSharedConfig(layout);
          expect((yield* readRecord(layout.configDir))?.linked).not.toContain("skills");
          yield* unshareClaudeConfig(layout.configDir);

          expect(yield* listing(layout.configDir)).toEqual(["skills"]);
        }).pipe(Effect.scoped),
    );

    it.effect.skipIf(!symlinksSupported)(
      "writes no record when every entry was already linked",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const layout = yield* makeLayout();
          yield* materializeClaudeSharedConfig(layout);
          const linked = yield* listing(layout.configDir);
          yield* fileSystem.remove(path.join(layout.configDir, ".t3code-shared-config"));

          yield* materializeClaudeSharedConfig(layout);

          expect(yield* readRecord(layout.configDir)).toBeNull();
          expect(yield* listing(layout.configDir)).toEqual(
            linked.filter((name) => name !== ".t3code-shared-config"),
          );
        }).pipe(Effect.scoped),
    );

    it.effect.skipIf(!symlinksSupported)(
      "keeps the old record until the old links are gone when moving to another shared dir",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const layout = yield* makeLayout();
          const nextShared = path.join(layout.root, "next-shared");
          yield* fileSystem.makeDirectory(nextShared);
          yield* fileSystem.writeFileString(path.join(nextShared, "settings.json"), "{}");
          yield* materializeClaudeSharedConfig(layout);
          const moved = { ...layout, sharedConfigDir: nextShared };

          const removeFailed = yield* failingAt("remove", materializeClaudeSharedConfig(moved));
          expect(removeFailed._tag).toBe("Failure");
          expect((yield* readRecord(layout.configDir))?.sharedConfigDir).toBe(
            layout.sharedConfigDir,
          );

          const symlinkFailed = yield* failingAt("symlink", materializeClaudeSharedConfig(moved));
          expect(symlinkFailed._tag).toBe("Failure");
          // Nothing points into the old dir any more, and the record names the new one.
          for (const entry of yield* listing(layout.configDir)) {
            const target = yield* linkTarget(path.join(layout.configDir, entry));
            expect(target?.startsWith(layout.sharedConfigDir) ?? false).toBe(false);
          }
          expect((yield* readRecord(layout.configDir))?.sharedConfigDir).toBe(nextShared);

          yield* materializeClaudeSharedConfig(moved);
          expect(yield* linkTarget(path.join(layout.configDir, "projects"))).toBe(
            path.join(nextShared, "projects"),
          );
          yield* unshareClaudeConfig(layout.configDir);
          expect(yield* listing(layout.configDir)).toEqual([]);
        }).pipe(Effect.scoped),
    );

    it.effect.skipIf(!symlinksSupported)(
      "stops on a torn record instead of forgetting the links it lists",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const layout = yield* makeLayout();
          yield* materializeClaudeSharedConfig(layout);
          const recordPath = path.join(layout.configDir, ".t3code-shared-config");
          yield* fileSystem.writeFileString(recordPath, '{"sharedConfigDir":');
          const before = yield* listing(layout.configDir);

          const error = yield* Effect.flip(materializeClaudeSharedConfig(layout));
          yield* unshareClaudeConfig(layout.configDir);

          expect(error._tag).toBe("ClaudeSharedConfigRecordUnreadableError");
          expect(yield* listing(layout.configDir)).toEqual(before);
          expect(yield* fileSystem.readFileString(recordPath)).toBe('{"sharedConfigDir":');
        }).pipe(Effect.scoped),
    );

    it.effect.skipIf(!symlinksSupported)(
      "never writes the record through a link planted at its temporary path",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const layout = yield* makeLayout();
          const login = path.join(layout.root, "login", ".credentials.json");
          yield* fileSystem.makeDirectory(path.dirname(login), { recursive: true });
          yield* fileSystem.writeFileString(login, "secret");
          yield* fileSystem.makeDirectory(layout.configDir);
          yield* fileSystem.symlink(
            login,
            path.join(layout.configDir, ".t3code-shared-config.tmp"),
          );

          yield* materializeClaudeSharedConfig(layout);

          expect(yield* fileSystem.readFileString(login)).toBe("secret");
          expect((yield* readRecord(layout.configDir))?.sharedConfigDir).toBe(
            layout.sharedConfigDir,
          );
        }).pipe(Effect.scoped),
    );

    it.effect.skipIf(!symlinksSupported)("refuses a record that is a symlink", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const layout = yield* makeLayout();
        const login = path.join(layout.root, "login", ".credentials.json");
        yield* fileSystem.makeDirectory(path.dirname(login), { recursive: true });
        yield* fileSystem.writeFileString(login, "secret");
        yield* fileSystem.makeDirectory(layout.configDir);
        yield* fileSystem.symlink(login, path.join(layout.configDir, ".t3code-shared-config"));

        const shared = yield* Effect.flip(materializeClaudeSharedConfig(layout));
        const unshared = yield* Effect.flip(unshareClaudeConfig(layout.configDir));

        expect(shared._tag).toBe("ClaudeSharedConfigOwnFileSymlinkError");
        expect(unshared._tag).toBe("ClaudeSharedConfigOwnFileSymlinkError");
        expect(yield* fileSystem.readFileString(login)).toBe("secret");
      }).pipe(Effect.scoped),
    );
  });

  describe("unshareClaudeConfig", () => {
    it.effect.skipIf(!symlinksSupported)(
      "removes only the links it made once the setting is cleared",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const layout = yield* makeLayout();
          yield* materializeClaudeSharedConfig(layout);
          // Linked by hand after sharing began: not T3 Code's to remove.
          yield* fileSystem.symlink(
            path.join(layout.root, "own-hooks"),
            path.join(layout.configDir, "hooks"),
          );

          yield* unshareClaudeConfig(layout.configDir);

          expect(yield* listing(layout.configDir)).toEqual(["hooks"]);
          expect(yield* listing(path.join(layout.sharedConfigDir, "projects"))).toEqual([]);
        }).pipe(Effect.scoped),
    );

    it.effect("does nothing when the config dir cannot be read, as before sharing existed", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const layout = yield* makeLayout();
        const notADirectory = path.join(layout.root, "file");
        yield* fileSystem.writeFileString(notADirectory, "");

        yield* unshareClaudeConfig(notADirectory);
      }).pipe(Effect.scoped),
    );

    it.effect.skipIf(!symlinksSupported)("leaves a config dir linked by another tool alone", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const layout = yield* makeLayout();
        yield* fileSystem.makeDirectory(layout.configDir);
        yield* fileSystem.symlink(
          path.join(layout.sharedConfigDir, "skills"),
          path.join(layout.configDir, "skills"),
        );

        yield* unshareClaudeConfig(layout.configDir);

        expect(yield* linkTarget(path.join(layout.configDir, "skills"))).toBe(
          path.join(layout.sharedConfigDir, "skills"),
        );
      }).pipe(Effect.scoped),
    );
  });

  describe("login guard", () => {
    it("never lists a private entry as shared", () => {
      expect(CLAUDE_SHARED_CONFIG_ENTRIES.filter(isClaudePrivateConfigEntry)).toEqual([]);
      for (const entry of [
        ".credentials.json",
        ".claude.json",
        "sessions",
        "session-env",
        "shell-snapshots",
        "backups",
        "cache",
        "telemetry",
        "jobs",
        "daemon.lock",
        "daemon",
        ".last-cleanup",
        ".Credentials.json",
        ".CLAUDE.JSON",
        ".credentials.json.",
        ".credentials.json ",
      ]) {
        expect(isClaudePrivateConfigEntry(entry)).toBe(true);
      }
    });

    it.effect.each([
      ".credentials.json",
      ".claude.json",
      ".Credentials.json",
      ".CLAUDE.json",
      ".credentials.json.",
      ".credentials.json ",
      "settings.json:stream",
      "sessions",
      "daemon.log",
      ".last-update-result.json",
      "../.credentials.json",
      "projects/../.credentials.json",
      "..",
    ])("refuses an edited shared list containing %s before touching anything", (hostile) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const layout = yield* makeLayout();

        const error = yield* Effect.flip(
          materializeClaudeSharedConfig(layout, ["projects", hostile, "settings.json"]),
        );

        expect(error._tag).toBe("ClaudeSharedConfigPrivateEntryError");
        expect(yield* fileSystem.exists(layout.configDir)).toBe(false);
      }).pipe(Effect.scoped),
    );

    it.effect.skipIf(!symlinksSupported)("refuses a shared entry that leads to a login file", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const layout = yield* makeLayout();
        const keybindings = path.join(layout.sharedConfigDir, "keybindings.json");
        yield* fileSystem.symlink(
          path.join(layout.sharedConfigDir, ".credentials.json"),
          keybindings,
        );

        const error = yield* Effect.flip(materializeClaudeSharedConfig(layout));

        expect(error._tag).toBe("ClaudeSharedConfigPrivateEntryError");
        expect(yield* fileSystem.exists(layout.configDir)).toBe(false);
      }).pipe(Effect.scoped),
    );

    describe.skipIf(!symlinksSupported)("planted links", () => {
      it.effect.each(["absolute", "relative", "existing"] as const)(
        "never seeds or links through a shared entry planted as a %s link to a login",
        (kind) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const layout = yield* makeLayout();
            const loginDir = path.join(layout.root, "other");
            const login = path.join(loginDir, ".credentials.json");
            yield* fileSystem.makeDirectory(loginDir);
            if (kind === "existing") yield* fileSystem.writeFileString(login, "secret");
            yield* fileSystem.symlink(
              kind === "relative" ? path.join("..", "other", ".credentials.json") : login,
              path.join(layout.sharedConfigDir, "history.jsonl"),
            );

            const error = yield* Effect.flip(materializeClaudeSharedConfig(layout));

            expect(error._tag).toBe("ClaudeSharedConfigPrivateEntryError");
            expect(yield* listing(loginDir)).toEqual(
              kind === "existing" ? [".credentials.json"] : [],
            );
            if (kind === "existing") expect(yield* fileSystem.readFileString(login)).toBe("secret");
            expect(yield* fileSystem.exists(layout.configDir)).toBe(false);
          }).pipe(Effect.scoped),
      );
    });

    it.effect.skipIf(!symlinksSupported)("refuses a broken link in the shared dir", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const layout = yield* makeLayout();
        yield* fileSystem.symlink(
          path.join(layout.root, "missing", "keybindings.json"),
          path.join(layout.sharedConfigDir, "keybindings.json"),
        );

        const error = yield* Effect.flip(materializeClaudeSharedConfig(layout));

        expect(error._tag).toBe("ClaudeSharedConfigPrivateEntryError");
        expect(yield* fileSystem.exists(layout.configDir)).toBe(false);
      }).pipe(Effect.scoped),
    );

    it.effect.skipIf(!symlinksSupported)("refuses an instance whose login is a symlink", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const layout = yield* makeLayout();
        yield* fileSystem.makeDirectory(layout.configDir);
        yield* fileSystem.symlink(
          path.join(layout.sharedConfigDir, ".credentials.json"),
          path.join(layout.configDir, ".credentials.json"),
        );

        const error = yield* Effect.flip(materializeClaudeSharedConfig(layout));

        expect(error._tag).toBe("ClaudeSharedConfigOwnFileSymlinkError");
        expect(yield* fileSystem.exists(path.join(layout.configDir, "projects"))).toBe(false);
      }).pipe(Effect.scoped),
    );
  });
});
