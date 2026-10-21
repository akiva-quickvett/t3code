import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { renderPodEnv, writePodDotEnv } from "./PodEnv.ts";

const web = { name: "web", port: 20000, url: "http://127.0.0.1:20000" };

describe("pod env placeholders", () => {
  it.effect("fills url and port placeholders and leaves other braces alone", () =>
    Effect.gen(function* () {
      expect(
        yield* renderPodEnv(
          { ORIGIN: "{web.url}", HMR: "{web.port}", JSON: '{"a":{b}}', PLAIN: "x" },
          [web],
        ),
      ).toEqual({ ORIGIN: web.url, HMR: "20000", JSON: '{"a":{b}}', PLAIN: "x" });
    }),
  );

  it.effect("fails near misses rather than passing them through as literals", () =>
    Effect.gen(function* () {
      for (const placeholder of ["{Web.url}", "{web.URL}", "{web_app.url}", "{web.constructor}"]) {
        const error = yield* renderPodEnv({ ORIGIN: placeholder }, [web]).pipe(Effect.flip);
        expect(error.message).toContain(`pod.env ORIGIN: ${placeholder}`);
      }
    }),
  );

  it.effect("names the variable and the fix for an unknown field", () =>
    Effect.gen(function* () {
      const error = yield* renderPodEnv({ ORIGIN: "{web.host}" }, [web]).pipe(Effect.flip);
      expect(error.message).toBe(
        "pod.env ORIGIN: {web.host} is not a known placeholder; use {web.url} or {web.port}.",
      );
    }),
  );
});

describe("pod .env file", () => {
  it.effect("quotes what compose would misread and refuses line breaks", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const worktree = yield* fileSystem.makeTempDirectoryScoped();
      yield* writePodDotEnv(worktree, { A: "two words", B: `it's "x"`, C: "a=b,c" });
      expect(yield* fileSystem.readFileString(`${worktree}/.env`)).toBe(
        `A='two words'\nB="it's \\"x\\""\nC=a=b,c\n`,
      );
      const error = yield* writePodDotEnv(worktree, { D: "one\ntwo" }).pipe(Effect.flip);
      expect(error.message).toBe("pod.env D: a value with a line break cannot go in .env.");
      const dollar = yield* writePodDotEnv(worktree, { E: "it's $HOME" }).pipe(Effect.flip);
      expect(dollar.message).toBe(
        "pod.env E: a value with both ' and $ cannot go in .env as written.",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("replaces a symlinked .env with its own file and never writes the shared one", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const main = yield* fileSystem.makeTempDirectoryScoped();
      const worktree = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.writeFileString(`${main}/.env`, "SHARED=1\nAPI_URL=main\n");
      yield* fileSystem.chmod(`${main}/.env`, 0o600);
      yield* fileSystem.symlink(`${main}/.env`, `${worktree}/.env`);
      yield* writePodDotEnv(worktree, { API_URL: "http://127.0.0.1:20001" });
      expect(yield* fileSystem.readFileString(`${main}/.env`)).toBe("SHARED=1\nAPI_URL=main\n");
      expect(yield* fileSystem.readLink(`${worktree}/.env`).pipe(Effect.option)).toEqual(
        Option.none(),
      );
      expect(yield* fileSystem.readFileString(`${worktree}/.env`)).toBe(
        "SHARED=1\nAPI_URL=http://127.0.0.1:20001\n",
      );
      // The shared file's secrets stay owner-only in the copy.
      expect((yield* fileSystem.stat(`${worktree}/.env`)).mode & 0o777).toBe(0o600);
      expect(yield* fileSystem.readDirectory(worktree)).toEqual([".env"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("writes nothing when the pod sets no variables", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const worktree = yield* fileSystem.makeTempDirectoryScoped();
      yield* writePodDotEnv(worktree, {});
      expect(yield* fileSystem.exists(`${worktree}/.env`)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
