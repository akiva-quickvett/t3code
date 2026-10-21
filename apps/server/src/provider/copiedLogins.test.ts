import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { makeCopiedLoginDetector, stampCopiedLogin } from "./copiedLogins.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

const claude = ProviderDriverKind.make("claudeAgent");

const makeInstances = Effect.fn("copiedLogins.test.makeInstances")(function* (
  logins: Record<string, string | undefined>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-copied-login-" });
  const instances = yield* Effect.forEach(Object.entries(logins), ([name, login]) =>
    Effect.gen(function* () {
      const loginFilePath = path.join(root, name, ".credentials.json");
      yield* fileSystem.makeDirectory(path.dirname(loginFilePath));
      if (login !== undefined) yield* fileSystem.writeFileString(loginFilePath, login);
      return {
        instanceId: ProviderInstanceId.make(name),
        driverKind: claude,
        enabled: true,
        loginFilePath,
      };
    }),
  );
  return { root, instances };
});

const sorted = (ids: ReadonlySet<string>) => [...ids].toSorted();

it.layer(NodeServices.layer)("copiedLogins", (it) => {
  describe("makeCopiedLoginDetector", () => {
    it.effect("flags only enabled instances whose login files are byte-identical", () =>
      Effect.gen(function* () {
        const detect = yield* makeCopiedLoginDetector;
        const { instances } = yield* makeInstances({
          work: '{"token":"a"}',
          personal: '{"token":"a"}',
          other: '{"token":"b"}',
          keychain: undefined,
          disabled: '{"token":"b"}',
        });
        const [work, personal, other, keychain, disabled] = instances;

        const copied = yield* detect([
          work!,
          personal!,
          other!,
          keychain!,
          { ...disabled!, enabled: false },
        ]);

        expect(sorted(copied)).toEqual(["personal", "work"]);
      }).pipe(Effect.scoped),
    );

    it.effect("treats instances reaching one login file as one login", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const detect = yield* makeCopiedLoginDetector;
        const { root, instances } = yield* makeInstances({ work: '{"token":"a"}' });
        const work = instances[0]!;
        const alias = path.join(root, "alias");
        if (symlinksSupported) yield* fileSystem.symlink(path.join(root, "work"), alias);

        const copied = yield* detect([
          work,
          { ...work, instanceId: ProviderInstanceId.make("same-dir") },
          ...(symlinksSupported
            ? [
                {
                  ...work,
                  instanceId: ProviderInstanceId.make("linked-dir"),
                  loginFilePath: path.join(alias, ".credentials.json"),
                },
              ]
            : []),
        ]);

        expect(copied.size).toBe(0);
      }).pipe(Effect.scoped),
    );

    it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32" || process.getuid?.() === 0)(
      "keeps the last result while a login file cannot be read, and clears it once it is gone",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const detect = yield* makeCopiedLoginDetector;
          const { instances } = yield* makeInstances({
            work: '{"token":"a"}',
            personal: '{"token":"a"}',
          });
          const [work, personal] = instances;
          expect(sorted(yield* detect(instances))).toEqual(["personal", "work"]);

          yield* fileSystem.writeFileString(personal!.loginFilePath, '{"token":"rotated"}');
          yield* fileSystem.chmod(personal!.loginFilePath, 0o000);
          expect(sorted(yield* detect(instances))).toEqual(["personal", "work"]);

          yield* fileSystem.remove(personal!.loginFilePath);
          expect((yield* detect([work!, personal!])).size).toBe(0);
        }).pipe(Effect.scoped),
    );
  });

  it("stamps and clears the flag without exposing anything else", () => {
    const provider = { instanceId: ProviderInstanceId.make("work") } as ServerProvider;
    const copied = new Set([provider.instanceId]);

    const stamped = stampCopiedLogin(provider, copied);
    expect(stamped.copiedLogin).toBe(true);
    expect(stampCopiedLogin(stamped, copied)).toBe(stamped);
    expect("copiedLogin" in stampCopiedLogin(stamped, new Set())).toBe(false);
    expect(stampCopiedLogin(provider, new Set())).toBe(provider);
  });
});
