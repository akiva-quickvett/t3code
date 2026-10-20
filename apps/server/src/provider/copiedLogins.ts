import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import type { ProviderInstance } from "@t3tools/provider-core/server/driver";

type LoginInstance = Pick<
  ProviderInstance,
  "instanceId" | "driverKind" | "enabled" | "loginFilePath"
>;

interface StoredLogin {
  readonly realPath: string;
  readonly version: string;
  readonly bytes: Uint8Array;
}

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

/**
 * Finds enabled instances of one driver whose stored login files are separate
 * but byte-identical, a copied login. The bytes are compared here and never
 * leave the server. A login is read only when its file changed, and a failed read
 * keeps the last one, so Claude replacing the file mid-refresh flips nothing.
 * Instances without a login file (a keychain login) are skipped.
 */
export const makeCopiedLoginDetector = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const stored = new Map<ProviderInstanceId, StoredLogin>();

  const readLogin = Effect.fn("copiedLogins.readLogin")(function* (
    instanceId: ProviderInstanceId,
    loginFilePath: string,
  ) {
    const previous = stored.get(instanceId);
    const info = yield* fileSystem.stat(loginFilePath).pipe(Effect.result);
    if (info._tag === "Failure") {
      if (info.failure.reason._tag !== "NotFound") return previous;
      stored.delete(instanceId);
      return undefined;
    }
    const realPath = yield* fileSystem.realPath(loginFilePath).pipe(Effect.option);
    if (Option.isNone(realPath)) return previous;
    const version = `${Option.getOrUndefined(info.success.mtime)?.getTime()}:${info.success.size}`;
    if (previous?.realPath === realPath.value && previous.version === version) return previous;
    const bytes = yield* fileSystem.readFile(loginFilePath).pipe(Effect.option);
    if (Option.isNone(bytes)) return previous;
    const login = { realPath: realPath.value, version, bytes: bytes.value };
    stored.set(instanceId, login);
    return login;
  });

  return Effect.fn("copiedLogins.detect")(function* (
    instances: Iterable<LoginInstance>,
  ): Effect.fn.Return<ReadonlySet<ProviderInstanceId>> {
    const candidates = Array.from(instances).filter(
      (instance) => instance.enabled && instance.loginFilePath !== undefined,
    );
    const candidateIds = new Set(candidates.map((instance) => instance.instanceId));
    for (const instanceId of stored.keys()) {
      if (!candidateIds.has(instanceId)) stored.delete(instanceId);
    }
    if (candidates.length < 2) return new Set();
    const logins = yield* Effect.forEach(candidates, (instance) =>
      readLogin(instance.instanceId, instance.loginFilePath!).pipe(
        Effect.map((login) => ({ instance, login })),
      ),
    );
    const copied = new Set<ProviderInstanceId>();
    for (const [index, left] of logins.entries()) {
      for (const right of logins.slice(index + 1)) {
        if (
          left.login !== undefined &&
          right.login !== undefined &&
          left.login.bytes.length > 0 &&
          left.instance.driverKind === right.instance.driverKind &&
          // One file reached by two instances is one login, not a copy.
          left.login.realPath !== right.login.realPath &&
          sameBytes(left.login.bytes, right.login.bytes)
        ) {
          copied.add(left.instance.instanceId);
          copied.add(right.instance.instanceId);
        }
      }
    }
    return copied;
  });
});

export const stampCopiedLogin = (
  provider: ServerProvider,
  copied: ReadonlySet<ProviderInstanceId>,
): ServerProvider => {
  if (copied.has(provider.instanceId)) {
    return provider.copiedLogin === true ? provider : { ...provider, copiedLogin: true };
  }
  if (provider.copiedLogin === undefined) return provider;
  const { copiedLogin: _copiedLogin, ...rest } = provider;
  return rest;
};
