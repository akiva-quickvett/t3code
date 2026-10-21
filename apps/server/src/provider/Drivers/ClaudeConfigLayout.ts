import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

/**
 * Entries of a Claude config dir that make a session resumable from another
 * config dir, plus user-level config. Claude reads them from its config dir
 * only and writes through the links. Same list as orch's profile sync, so its
 * profiles already have this layout.
 */
export const CLAUDE_SHARED_CONFIG_ENTRIES = [
  "projects",
  "file-history",
  "todos",
  "plans",
  "paste-cache",
  "history.jsonl",
  "settings.json",
  "CLAUDE.md",
  "rules",
  "skills",
  "agents",
  "commands",
  "hooks",
  "plugins",
  "output-styles",
  "keybindings.json",
] as const;

// Claude creates these on first use. Creating them in the shared dir first keeps
// it from later starting a private copy the next start would report as a conflict.
const SHARED_RUNTIME_DIRECTORIES = new Set([
  "projects",
  "file-history",
  "todos",
  "plans",
  "paste-cache",
]);
const SHARED_RUNTIME_FILES = new Set(["history.jsonl"]);

// Something Claude itself leaves in a config dir: a typo or a profile root
// (the parent of its `.claude`) must not receive Claude's directories.
const CONFIG_DIR_MARKERS = [
  "projects",
  "history.jsonl",
  "settings.json",
  ".claude.json",
  ".credentials.json",
];

// The login is replaced by rename, so a link would fork it; .claude.json holds
// the account; the rest is per-process state. None of these may ever be linked.
const PRIVATE_ENTRY_PATTERNS = [
  /^\.credentials\.json$/,
  /^\.claude\.json$/,
  /^sessions$/,
  /^session-env$/,
  /^shell-snapshots$/,
  /^backups$/,
  /^cache$/,
  /^telemetry$/,
  /^jobs$/,
  /^downloads$/,
  /^daemon/,
  /^\.last-/,
  /^gh-pr-status-cache\.json$/,
  /^mcp-needs-auth-cache\.json$/,
];
const LOGIN_ENTRY_NAMES = [".credentials.json", ".claude.json"] as const;

// Records the shared dir T3 Code linked to, so clearing the setting removes
// only links it made. Config dirs linked by other tools have no marker.
const SHARED_CONFIG_MARKER = ".t3code-shared-config";

// Case-insensitive file systems ignore case, and Windows drops trailing dots and spaces.
const canonicalEntryName = (entryName: string): string =>
  entryName.toLowerCase().replace(/[. ]+$/, "");

export const isClaudePrivateConfigEntry = (entryName: string): boolean => {
  const canonical = canonicalEntryName(entryName);
  return PRIVATE_ENTRY_PATTERNS.some((pattern) => pattern.test(canonical));
};

// Separators, `..` and NTFS stream names (`name:stream`) could reach outside the entry.
const isPlainEntryName = (entryName: string): boolean =>
  canonicalEntryName(entryName).length > 0 && !/[/\\:]/.test(entryName);

export interface ClaudeSharedConfigLayout {
  readonly configDir: string;
  readonly sharedConfigDir: string;
}

export class ClaudeSharedConfigFileSystemError extends Schema.TaggedError<ClaudeSharedConfigFileSystemError>()(
  "ClaudeSharedConfigFileSystemError",
  {
    operation: Schema.Literals([
      "stat",
      "readLink",
      "readFile",
      "makeDirectory",
      "writeFile",
      "rename",
      "remove",
      "symlink",
    ]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Claude shared config: '${this.operation}' failed for '${this.path}'.`;
  }
}

export class ClaudeSharedConfigMissingError extends Schema.TaggedError<ClaudeSharedConfigMissingError>()(
  "ClaudeSharedConfigMissingError",
  { sharedConfigDir: Schema.String },
) {
  override get message(): string {
    return `Claude shared config path '${this.sharedConfigDir}' is not an existing directory.`;
  }
}

export class ClaudeSharedConfigNotConfigDirError extends Schema.TaggedError<ClaudeSharedConfigNotConfigDirError>()(
  "ClaudeSharedConfigNotConfigDirError",
  { sharedConfigDir: Schema.String },
) {
  override get message(): string {
    return `Claude shared config path '${this.sharedConfigDir}' is not a Claude config directory. Point it at a directory Claude has used, such as ~/.claude.`;
  }
}

export class ClaudeSharedConfigPathConflictError extends Schema.TaggedError<ClaudeSharedConfigPathConflictError>()(
  "ClaudeSharedConfigPathConflictError",
  { configDir: Schema.String, sharedConfigDir: Schema.String },
) {
  override get message(): string {
    return `Claude shared config path '${this.sharedConfigDir}' is this instance's own config directory '${this.configDir}'. Leave it empty or point it at another Claude config directory.`;
  }
}

export class ClaudeSharedConfigPrivateEntryError extends Schema.TaggedError<ClaudeSharedConfigPrivateEntryError>()(
  "ClaudeSharedConfigPrivateEntryError",
  { entryName: Schema.String },
) {
  override get message(): string {
    return `Claude config entry '${this.entryName}' is, or leads to, a login or per-process file, which is never shared.`;
  }
}

export class ClaudeSharedConfigOwnFileSymlinkError extends Schema.TaggedError<ClaudeSharedConfigOwnFileSymlinkError>()(
  "ClaudeSharedConfigOwnFileSymlinkError",
  { path: Schema.String },
) {
  override get message(): string {
    return `'${this.path}' must be this instance's own file, not a symlink.`;
  }
}

export class ClaudeSharedConfigRecordUnreadableError extends Schema.TaggedError<ClaudeSharedConfigRecordUnreadableError>()(
  "ClaudeSharedConfigRecordUnreadableError",
  { path: Schema.String },
) {
  override get message(): string {
    return `T3 Code's record of its shared config links '${this.path}' is unreadable. Delete it and check that the config directory's links point where you expect.`;
  }
}

export class ClaudeSharedConfigEntryConflictError extends Schema.TaggedError<ClaudeSharedConfigEntryConflictError>()(
  "ClaudeSharedConfigEntryConflictError",
  {
    configDir: Schema.String,
    sharedConfigDir: Schema.String,
    entryNames: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    const names = this.entryNames.map((name) => `'${name}'`).join(", ");
    return `Cannot share ${names} from '${this.sharedConfigDir}': '${this.configDir}' already has its own. Merge or move them by hand; T3 Code never replaces them.`;
  }
}

export type ClaudeSharedConfigError =
  | ClaudeSharedConfigFileSystemError
  | ClaudeSharedConfigMissingError
  | ClaudeSharedConfigNotConfigDirError
  | ClaudeSharedConfigPathConflictError
  | ClaudeSharedConfigPrivateEntryError
  | ClaudeSharedConfigOwnFileSymlinkError
  | ClaudeSharedConfigRecordUnreadableError
  | ClaudeSharedConfigEntryConflictError;

type LinkState =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "NotSymlink" }
  | { readonly _tag: "Symlink"; readonly target: string };

type EntryPlan =
  | { readonly _tag: "Keep" }
  | { readonly _tag: "Link" }
  | { readonly _tag: "Relink" }
  | { readonly _tag: "Unlink" }
  | { readonly _tag: "Conflict" };

/** The links T3 Code made, and into which shared dir: only these are ever moved or removed. */
const SharedConfigRecord = Schema.Struct({
  sharedConfigDir: Schema.String,
  linked: Schema.Array(Schema.String),
});
type SharedConfigRecord = typeof SharedConfigRecord.Type;
const decodeSharedConfigRecord = Schema.decodeUnknownOption(
  Schema.fromJsonString(SharedConfigRecord),
);
const encodeSharedConfigRecord = Schema.encodeSync(Schema.fromJsonString(SharedConfigRecord));
const MANAGED_ENTRY_NAMES: ReadonlySet<string> = new Set(CLAUDE_SHARED_CONFIG_ENTRIES);

const fileSystemError =
  (operation: ClaudeSharedConfigFileSystemError["operation"], path: string) =>
  (cause: PlatformError.PlatformError) =>
    new ClaudeSharedConfigFileSystemError({ operation, path, cause });

const isNotSymlinkError = (error: PlatformError.PlatformError): boolean => {
  const cause = error.reason.cause;
  return (
    error.reason._tag === "Unknown" &&
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "EINVAL"
  );
};

const readLinkState = (fileSystem: FileSystem.FileSystem, linkPath: string) =>
  fileSystem.readLink(linkPath).pipe(
    Effect.map((target): LinkState => ({ _tag: "Symlink", target })),
    Effect.catchTags({
      PlatformError: (cause) => {
        if (cause.reason._tag === "NotFound") return Effect.succeed<LinkState>({ _tag: "Missing" });
        if (isNotSymlinkError(cause)) return Effect.succeed<LinkState>({ _tag: "NotSymlink" });
        return Effect.fail(fileSystemError("readLink", linkPath)(cause));
      },
    }),
  );

const realPathOrUndefined = (fileSystem: FileSystem.FileSystem, path: string) =>
  fileSystem.realPath(path).pipe(Effect.orElseSucceed(() => undefined));

const isSameEntry = Effect.fn("ClaudeConfigLayout.isSameEntry")(function* (
  fileSystem: FileSystem.FileSystem,
  linkPath: string,
  targetPath: string,
) {
  const resolvedTarget = yield* realPathOrUndefined(fileSystem, targetPath);
  return (
    resolvedTarget !== undefined &&
    (yield* realPathOrUndefined(fileSystem, linkPath)) === resolvedTarget
  );
});

const exists = (fileSystem: FileSystem.FileSystem, path: string) =>
  fileSystem.exists(path).pipe(Effect.mapError(fileSystemError("stat", path)));

/** Refuses a planted symlink, which a read or write would follow, e.g. into a login. */
const refuseSymlink = Effect.fn("ClaudeConfigLayout.refuseSymlink")(function* (
  fileSystem: FileSystem.FileSystem,
  path: string,
) {
  if ((yield* readLinkState(fileSystem, path))._tag === "Symlink") {
    return yield* new ClaudeSharedConfigOwnFileSymlinkError({ path });
  }
});

const markerPathOf = (path: Path.Path, configDir: string) =>
  path.join(configDir, SHARED_CONFIG_MARKER);

const readSharedConfigRecord = Effect.fn("ClaudeConfigLayout.readSharedConfigRecord")(function* (
  configDir: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const markerPath = markerPathOf(path, configDir);
  yield* refuseSymlink(fileSystem, markerPath);
  const text = yield* fileSystem.readFileString(markerPath).pipe(
    Effect.map(Option.some),
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(Option.none<string>())
          : Effect.fail(fileSystemError("readFile", markerPath)(cause)),
    }),
  );
  if (Option.isNone(text)) return Option.none<SharedConfigRecord>();
  // Treating a torn record as absent would forget links it lists, leaving them for good.
  const record = decodeSharedConfigRecord(text.value);
  if (Option.isNone(record)) {
    return yield* new ClaudeSharedConfigRecordUnreadableError({ path: markerPath });
  }
  return Option.some<SharedConfigRecord>({
    sharedConfigDir: record.value.sharedConfigDir,
    linked: record.value.linked.filter((entryName) => MANAGED_ENTRY_NAMES.has(entryName)),
  });
});

const writeSharedConfigRecord = Effect.fn("ClaudeConfigLayout.writeSharedConfigRecord")(function* (
  configDir: string,
  record: SharedConfigRecord,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const markerPath = markerPathOf(path, configDir);
  if (record.linked.length === 0) {
    return yield* fileSystem
      .remove(markerPath, { force: true })
      .pipe(Effect.mapError(fileSystemError("remove", markerPath)));
  }
  // A rename never leaves a torn record, and replaces a symlink instead of following it;
  // `wx` refuses to write through anything planted at the temporary path.
  const temporaryPath = `${markerPath}.tmp`;
  yield* fileSystem
    .remove(temporaryPath, { force: true })
    .pipe(Effect.mapError(fileSystemError("remove", temporaryPath)));
  yield* fileSystem
    .writeFileString(temporaryPath, `${encodeSharedConfigRecord(record)}\n`, { flag: "wx" })
    .pipe(Effect.mapError(fileSystemError("writeFile", temporaryPath)));
  yield* fileSystem
    .rename(temporaryPath, markerPath)
    .pipe(Effect.mapError(fileSystemError("rename", markerPath)));
});

/** A recorded link into `sharedConfigDir`, as T3 Code made it. */
const isRecordedLink = (
  path: Path.Path,
  record: Option.Option<SharedConfigRecord>,
  link: string,
  linkState: LinkState,
  entryName: string,
) =>
  Option.isSome(record) &&
  record.value.linked.includes(entryName) &&
  linkState._tag === "Symlink" &&
  path.resolve(path.dirname(link), linkState.target) ===
    path.join(record.value.sharedConfigDir, entryName);

/**
 * Read-only: refuses a shared entry that is a broken link or leads to a login
 * or per-process file, since Claude writes through the link and seeding writes to it.
 */
const checkSharedEntry = Effect.fn("ClaudeConfigLayout.checkSharedEntry")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  target: string,
  entryName: string,
) {
  const state = yield* readLinkState(fileSystem, target);
  if (state._tag === "Missing") return false;
  const resolved = yield* realPathOrUndefined(fileSystem, target);
  if (
    resolved === undefined ||
    isClaudePrivateConfigEntry(path.basename(resolved)) ||
    (state._tag === "Symlink" && isClaudePrivateConfigEntry(path.basename(state.target)))
  ) {
    return yield* new ClaudeSharedConfigPrivateEntryError({ entryName });
  }
  return true;
});

/** Read-only: what linking one entry takes. */
const planEntry = Effect.fn("ClaudeConfigLayout.planEntry")(function* (
  layout: ClaudeSharedConfigLayout,
  record: Option.Option<SharedConfigRecord>,
  entryName: string,
): Effect.fn.Return<EntryPlan, ClaudeSharedConfigError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.join(layout.sharedConfigDir, entryName);
  const link = path.join(layout.configDir, entryName);
  const state = yield* readLinkState(fileSystem, link);
  const recordedLink = isRecordedLink(path, record, link, state, entryName);
  const targetExists = yield* checkSharedEntry(fileSystem, path, target, entryName);
  if (
    !targetExists &&
    !SHARED_RUNTIME_DIRECTORIES.has(entryName) &&
    !SHARED_RUNTIME_FILES.has(entryName)
  ) {
    // Shared config files the shared dir lacks stay absent rather than dangling.
    return recordedLink ? { _tag: "Unlink" } : { _tag: "Keep" };
  }
  if (state._tag === "Missing") return { _tag: "Link" };
  if (state._tag === "Symlink" && path.resolve(path.dirname(link), state.target) === target) {
    return { _tag: "Keep" };
  }
  if (recordedLink) return { _tag: "Relink" };
  // A link through another spelling of the shared path, or a mounted or linked
  // config dir, already reaches the shared entry.
  return (yield* isSameEntry(fileSystem, link, target)) ? { _tag: "Keep" } : { _tag: "Conflict" };
});
/**
 * Links the instance's config dir to the shared one. Every entry is checked
 * first: a missing one becomes a symlink, a correct one is left alone, one
 * T3 Code linked to a previous shared dir is moved, and anything else is a
 * conflict that is reported with nothing changed.
 */
export const materializeClaudeSharedConfig = Effect.fn("materializeClaudeSharedConfig")(function* (
  layout: ClaudeSharedConfigLayout,
  entries: ReadonlyArray<string> = CLAUDE_SHARED_CONFIG_ENTRIES,
): Effect.fn.Return<void, ClaudeSharedConfigError, FileSystem.FileSystem | Path.Path> {
  // Checked before any filesystem access, so an edited list cannot link a login.
  const privateEntry = entries.find(
    (entryName) => !isPlainEntryName(entryName) || isClaudePrivateConfigEntry(entryName),
  );
  if (privateEntry !== undefined) {
    return yield* new ClaudeSharedConfigPrivateEntryError({ entryName: privateEntry });
  }
  if (layout.configDir === layout.sharedConfigDir) {
    return yield* new ClaudeSharedConfigPathConflictError(layout);
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sharedType = yield* fileSystem.stat(layout.sharedConfigDir).pipe(
    Effect.map((info) => info.type),
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(undefined)
          : Effect.fail(fileSystemError("stat", layout.sharedConfigDir)(cause)),
    }),
  );
  if (sharedType !== "Directory") {
    return yield* new ClaudeSharedConfigMissingError({ sharedConfigDir: layout.sharedConfigDir });
  }
  const markers = yield* Effect.forEach(CONFIG_DIR_MARKERS, (marker) =>
    exists(fileSystem, path.join(layout.sharedConfigDir, marker)),
  );
  if (!markers.includes(true)) {
    return yield* new ClaudeSharedConfigNotConfigDirError({
      sharedConfigDir: layout.sharedConfigDir,
    });
  }
  if (yield* isSameEntry(fileSystem, layout.configDir, layout.sharedConfigDir)) {
    return yield* new ClaudeSharedConfigPathConflictError(layout);
  }
  for (const entryName of LOGIN_ENTRY_NAMES) {
    yield* refuseSymlink(fileSystem, path.join(layout.configDir, entryName));
  }

  const record = yield* readSharedConfigRecord(layout.configDir);
  const plans = yield* Effect.forEach(entries, (entryName) =>
    planEntry(layout, record, entryName).pipe(Effect.map((plan) => ({ entryName, plan }))),
  );
  const conflicts = plans.filter(({ plan }) => plan._tag === "Conflict");
  if (conflicts.length > 0) {
    return yield* new ClaudeSharedConfigEntryConflictError({
      ...layout,
      entryNames: conflicts.map(({ entryName }) => entryName),
    });
  }

  // Old links go while the record still names them, the new record is written
  // before new links, so an interrupted run leaves every T3 Code link recorded.
  for (const { entryName, plan } of plans) {
    if (plan._tag !== "Relink" && plan._tag !== "Unlink") continue;
    const link = path.join(layout.configDir, entryName);
    yield* fileSystem.remove(link).pipe(Effect.mapError(fileSystemError("remove", link)));
  }
  const makeDirectory = (directory: string) =>
    fileSystem
      .makeDirectory(directory, { recursive: true })
      .pipe(Effect.mapError(fileSystemError("makeDirectory", directory)));
  yield* makeDirectory(layout.configDir);
  const stillLinked =
    Option.isSome(record) && record.value.sharedConfigDir === layout.sharedConfigDir
      ? record.value.linked
      : [];
  yield* writeSharedConfigRecord(layout.configDir, {
    sharedConfigDir: layout.sharedConfigDir,
    linked: plans
      .filter(
        ({ entryName, plan }) =>
          plan._tag === "Link" ||
          plan._tag === "Relink" ||
          (plan._tag === "Keep" && stillLinked.includes(entryName)),
      )
      .map(({ entryName }) => entryName),
  });

  for (const { entryName, plan } of plans) {
    const target = path.join(layout.sharedConfigDir, entryName);
    if (SHARED_RUNTIME_DIRECTORIES.has(entryName)) yield* makeDirectory(target);
    // `wx` never follows or replaces what appeared since the checks.
    if (SHARED_RUNTIME_FILES.has(entryName)) {
      yield* fileSystem.writeFileString(target, "", { flag: "wx" }).pipe(
        Effect.catchTags({
          PlatformError: (cause) =>
            cause.reason._tag === "AlreadyExists"
              ? Effect.void
              : Effect.fail(fileSystemError("writeFile", target)(cause)),
        }),
      );
    }
    if (plan._tag !== "Link" && plan._tag !== "Relink") continue;
    const link = path.join(layout.configDir, entryName);
    yield* fileSystem.symlink(target, link).pipe(Effect.mapError(fileSystemError("symlink", link)));
  }
});

/**
 * Undoes a previous share once the setting is cleared: removes only the links
 * T3 Code recorded making. Links made by hand or by orch are left alone.
 */
export const unshareClaudeConfig = Effect.fn("unshareClaudeConfig")(function* (
  configDir: string,
): Effect.fn.Return<
  void,
  ClaudeSharedConfigFileSystemError | ClaudeSharedConfigOwnFileSymlinkError,
  FileSystem.FileSystem | Path.Path
> {
  // Runs on every start with the field empty: an unreadable config dir must not
  // make the instance unavailable over a feature it never used.
  const record = yield* readSharedConfigRecord(configDir).pipe(
    Effect.catchTags({
      ClaudeSharedConfigFileSystemError: () => Effect.succeed(Option.none()),
      ClaudeSharedConfigRecordUnreadableError: () => Effect.succeed(Option.none()),
    }),
  );
  if (Option.isNone(record)) return;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const entryName of record.value.linked) {
    const link = path.join(configDir, entryName);
    const state = yield* readLinkState(fileSystem, link);
    if (isRecordedLink(path, record, link, state, entryName)) {
      yield* fileSystem.remove(link).pipe(Effect.mapError(fileSystemError("remove", link)));
    }
  }
  yield* writeSharedConfigRecord(configDir, { ...record.value, linked: [] });
});
