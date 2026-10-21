import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/**
 * Anything shaped like `{<name>.<field>}`, near misses such as `{Web.URL}`
 * included, so a typo fails rather than reaching the stack as a literal.
 * Other braces in a value are left alone.
 */
const PLACEHOLDER = /\{([A-Za-z_][\w-]*)\.([A-Za-z_]\w*)\}/g;

export interface PodEnvService {
  readonly name: string;
  readonly hostPort: number;
  readonly url: string;
}

const FIELDS: ReadonlyMap<string, (service: PodEnvService) => string> = new Map([
  ["url", (service: PodEnvService) => service.url],
  ["port", (service: PodEnvService) => String(service.hostPort)],
]);

export class PodEnvError extends Schema.TaggedError<PodEnvError>()("PodEnvError", {
  variable: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return `pod.env ${this.variable}: ${this.detail}`;
  }
}

const describeServices = (services: ReadonlyArray<PodEnvService>) =>
  services.length === 0
    ? "the pod publishes no services"
    : `services: ${services.map((service) => service.name).join(", ")}`;

/**
 * Fills `{web.url}`-style placeholders from the pod's published services. An
 * unknown service or field fails the whole render, so a typo never reaches
 * the stack as a literal.
 */
export const renderPodEnv = (
  env: Readonly<Record<string, string>>,
  services: ReadonlyArray<PodEnvService>,
  /** Services t3.json declares that the pod does not publish yet. */
  unpublished: ReadonlySet<string> = new Set(),
): Effect.Effect<Record<string, string>, PodEnvError> =>
  Effect.gen(function* () {
    const byName = new Map(services.map((service) => [service.name, service]));
    const rendered: Record<string, string> = {};
    for (const [variable, template] of Object.entries(env)) {
      for (const [placeholder, name, field] of template.matchAll(PLACEHOLDER)) {
        if (!byName.has(name!))
          return yield* new PodEnvError({
            variable,
            detail: unpublished.has(name!)
              ? `${placeholder} names service ${name}, which is new in t3.json; Recreate the pod to publish it.`
              : `${placeholder} names no pod service (${describeServices(services)}).`,
          });
        if (!FIELDS.has(field!))
          return yield* new PodEnvError({
            variable,
            detail: `${placeholder} is not a known placeholder; use {${name}.url} or {${name}.port}.`,
          });
      }
      rendered[variable] = template.replace(PLACEHOLDER, (_match, name: string, field: string) =>
        FIELDS.get(field)!(byName.get(name)!),
      );
    }
    return rendered;
  });

const PLAIN_VALUE = /^[A-Za-z0-9_./:@,+=-]*$/;

/** Compose's `.env` syntax: single quotes are literal; double quotes take `\` escapes. */
const dotEnvValue = (variable: string, value: string) => {
  if (/[\r\n]/.test(value))
    return Effect.fail(
      new PodEnvError({ variable, detail: "a value with a line break cannot go in .env." }),
    );
  if (PLAIN_VALUE.test(value)) return Effect.succeed(value);
  if (!value.includes("'")) return Effect.succeed(`'${value}'`);
  // Compose interpolates `$` inside double quotes, the only quotes left for a `'`.
  if (value.includes("$"))
    return Effect.fail(
      new PodEnvError({
        variable,
        detail: "a value with both ' and $ cannot go in .env as written.",
      }),
    );
  return Effect.succeed(`"${value.replace(/[\\"]/g, (char) => `\\${char}`)}"`);
};

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/**
 * Sets the pod's variables in `.env`, keeping every other line as it was, so
 * compose's interpolation and `env_file` see the same values as the pod's
 * commands. Nothing is written when the pod sets no variables.
 *
 * A symlinked `.env`, as worktree setup scripts make to share the main
 * checkout's, is never written through: this pod's ports would land in every
 * checkout sharing it. A file of this pod's own, with the shared file's mode
 * (it may hold secrets), is renamed over the link, so `.env` is never missing.
 */
export const writePodDotEnv = (worktreePath: string, env: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const entries = Object.entries(env);
    if (entries.length === 0) return;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(worktreePath, ".env");
    const lines: Record<string, string> = {};
    for (const [variable, value] of entries)
      lines[variable] = `${variable}=${yield* dotEnvValue(variable, value)}`;
    const linkTarget = yield* fileSystem.readLink(file).pipe(Effect.option);
    const exists = yield* fileSystem.exists(file);
    const existing = exists ? (yield* fileSystem.readFileString(file)).split(/\r?\n/) : [];
    if (existing.at(-1) === "") existing.pop();
    const written = new Set<string>();
    const kept = existing.flatMap((line) => {
      const variable = ASSIGNMENT.exec(line)?.[1];
      if (variable === undefined || lines[variable] === undefined) return [line];
      if (written.has(variable)) return [];
      written.add(variable);
      return [lines[variable]];
    });
    const added = entries.flatMap(([variable]) =>
      written.has(variable) ? [] : [lines[variable]!],
    );
    const content = `${[...kept, ...added].join("\n")}\n`;
    if (Option.isNone(linkTarget)) return yield* fileSystem.writeFileString(file, content);
    yield* Effect.logInfo("replacing a symlinked .env with the pod's own copy", {
      file,
      target: linkTarget.value,
    });
    // A link to nowhere has no mode to keep; owner-only is the safe default.
    const mode = exists ? (yield* fileSystem.stat(file)).mode & 0o777 : 0o600;
    // One pod per worktree and its operations run one at a time, so the name is free.
    const replacement = path.join(worktreePath, ".env.t3-pod.tmp");
    yield* fileSystem.writeFileString(replacement, "", { mode });
    yield* fileSystem.chmod(replacement, mode);
    yield* fileSystem.writeFileString(replacement, content);
    yield* fileSystem.rename(replacement, file);
  });
