import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { ThreadEnvMode, WorktreeSubmodules } from "./environment.ts";
import { ProjectScriptIcon } from "./project.ts";
import type { ProjectScopedServerSettingKey, ServerSettings } from "./settings.ts";

export const T3_PROJECT_FILE_NAME = "t3.json";

export const T3_PROJECT_FILE_SCHEMA_URL = "https://t3.codes/schema/t3.json";

const T3_PROJECT_FILE_PATH_MAX_LENGTH = 512;
const T3_PROJECT_FILE_MAX_SCRIPTS = 50;

// Annotations go on the encoded (string) side so they survive into the
// published JSON Schema; decoding still trims and re-validates non-emptiness.
const trimmedNonEmpty = (annotations: { readonly description: string }, maxLength?: number) => {
  const annotated = Schema.String.annotate(annotations);
  const encoded =
    maxLength === undefined
      ? annotated.check(Schema.isNonEmpty())
      : annotated.check(Schema.isNonEmpty(), Schema.isMaxLength(maxLength));
  return encoded.pipe(Schema.decodeTo(encoded, SchemaTransformation.trim()));
};

export const T3ProjectFileScript = Schema.Struct({
  name: trimmedNonEmpty({
    description: "Display name for the script, shown in the T3 Code scripts menu.",
  }),
  command: trimmedNonEmpty({
    description: "Shell command executed in a T3 Code terminal at the project root.",
  }),
  icon: Schema.optionalKey(
    ProjectScriptIcon.annotate({
      description: 'Icon shown next to the script in the scripts menu. Defaults to "play".',
    }),
  ),
  runOnWorktreeCreate: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When true, the script runs automatically after a worktree is created for a new thread.",
    }),
  ),
  runOnSettle: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When true, the script runs in the thread's worktree each time the thread settles, for example to delete build output. Threads without their own worktree skip it.",
    }),
  ),
  runOnWorktreeRemove: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When true, the script runs in a thread's worktree just before T3 Code removes that worktree, for example to stop containers the setup script started. Removal waits for it up to a timeout, then proceeds even if it fails.",
    }),
  ),
  async: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Only for runOnWorktreeCreate scripts. When true (the default), the agent starts while the script is still running. Set false to hold the agent until the script exits.",
    }),
  ),
  previewUrl: Schema.optionalKey(
    trimmedNonEmpty({
      description:
        "URL opened in the in-app browser preview when this script runs. Only honored on the desktop build.",
    }),
  ),
  autoOpenPreview: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When true, automatically open the preview panel at `previewUrl` the moment the script starts.",
    }),
  ),
}).annotate({
  description: "A project script that team members can import into T3 Code.",
});
export type T3ProjectFileScript = typeof T3ProjectFileScript.Type;

const T3_PROJECT_FILE_POD_MAX_ENTRIES = 50;

const POD_SERVICE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const POD_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** Set by T3 Code in the pod, or read by Docker to find its daemon. */
const POD_RESERVED_ENV_NAMES = new Set([
  "PATH",
  "HOME",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
]);

const quotedKey = (key: string) => JSON.stringify(key.slice(0, 64));
const CREDENTIALED_URL = /^[a-z][a-z0-9+.-]*:\/\/[^/@]*@/i;

/** Names every bad key, so a typo fails the pod block instead of vanishing. */
const checkPodKeys = (
  record: Readonly<Record<string, unknown>>,
  noun: string,
  problem: (key: string) => string | null,
) => {
  const keys = Object.keys(record);
  if (keys.length > T3_PROJECT_FILE_POD_MAX_ENTRIES)
    return `At most ${T3_PROJECT_FILE_POD_MAX_ENTRIES} ${noun}s.`;
  for (const key of keys) {
    const reason = problem(key);
    if (reason !== null) return `${quotedKey(key)} is not a valid ${noun} name: ${reason}`;
  }
  return true;
};

export const T3ProjectFilePod = Schema.Struct({
  compose: Schema.optionalKey(
    trimmedNonEmpty(
      {
        description:
          'Worktree-relative path to the compose file the pod runs (e.g. "docker-compose.yml"). Defaults to Docker Compose\'s own lookup.',
      },
      T3_PROJECT_FILE_PATH_MAX_LENGTH,
    ),
  ),
  services: Schema.Record(
    Schema.String,
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
  )
    .annotate({
      description:
        'Services the stack serves, by lowercase name and inner port (e.g. {"web": 3000}). T3 Code links to them from the pod chip.',
    })
    .check(
      Schema.makeFilter((services) =>
        checkPodKeys(services, "service", (key) =>
          POD_SERVICE_NAME.test(key)
            ? null
            : "use a lowercase letter, then letters, digits or '-'.",
        ),
      ),
    ),
  up: Schema.optionalKey(
    Schema.Array(trimmedNonEmpty({ description: "A shell command run inside the pod." }))
      .annotate({
        description:
          'Commands that bring the stack up inside the pod, in order. Defaults to "docker compose up -d".',
      })
      .check(Schema.isMaxLength(T3_PROJECT_FILE_POD_MAX_ENTRIES)),
  ),
  seeds: Schema.optionalKey(
    Schema.Array(trimmedNonEmpty({ description: "A shell command run inside the pod." }))
      .annotate({ description: "Commands that load seed data once the stack is up, in order." })
      .check(Schema.isMaxLength(T3_PROJECT_FILE_POD_MAX_ENTRIES)),
  ),
  env: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.String.check(Schema.isMaxLength(4_096)))
      .annotate({
        description:
          "Environment variables set for every command inside the pod and written to the worktree's .env. {<service>.url} and {<service>.port} become that service's address on the host (e.g. \"{web.url}\"). PATH, HOME, DOCKER_HOST, DOCKER_CONTEXT and DOCKER_CONFIG are T3 Code's.",
      })
      .check(
        Schema.makeFilter((env) =>
          checkPodKeys(env, "variable", (key) =>
            !POD_ENV_NAME.test(key)
              ? "use letters, digits and '_', not starting with a digit."
              : POD_RESERVED_ENV_NAMES.has(key)
                ? "T3 Code sets it in the pod."
                : /_proxy$/i.test(key) && CREDENTIALED_URL.test(env[key] ?? "")
                  ? "a proxy URL with credentials would show in the host's process list."
                  : null,
          ),
        ),
      ),
  ),
  hostnames: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Serve the services on https://<pod>-<service> hostnames instead of ports.",
    }),
  ),
}).annotate({
  description:
    "Run threads that ask for a container in a pod: a private Docker daemon running this repository's compose stack, with the agent container on its network.",
});
export type T3ProjectFilePod = typeof T3ProjectFilePod.Type;

export const T3ProjectFile = Schema.Struct({
  $schema: Schema.optionalKey(
    Schema.String.annotate({
      description: `URL of the JSON Schema for this file, typically "${T3_PROJECT_FILE_SCHEMA_URL}".`,
    }),
  ),
  iconPath: Schema.optionalKey(
    trimmedNonEmpty(
      {
        description:
          'Workspace-relative path to the project icon (e.g. "assets/logo.svg"). Checked before T3 Code\'s built-in icon locations.',
      },
      T3_PROJECT_FILE_PATH_MAX_LENGTH,
    ),
  ),
  defaultThreadEnvMode: Schema.optionalKey(
    ThreadEnvMode.annotate({
      description:
        'Where new threads start for this repository: "worktree" for a fresh git worktree, "local" for the current checkout. A per-project setting in T3 Code overrides this; when neither is set, the global default applies.',
    }),
  ),
  worktreeSubmodules: Schema.optionalKey(
    WorktreeSubmodules.annotate({
      description:
        'How new worktrees populate git submodules: "recursive" (the default) initializes nested submodules too, "top-level" initializes only those declared by this repository, and "none" leaves every submodule empty for a setup script to handle. A project or environment setting in T3 Code overrides this.',
    }),
  ),
  scripts: Schema.optionalKey(
    Schema.Array(T3ProjectFileScript)
      .annotate({
        description: "Project scripts shared with everyone who opens this repository in T3 Code.",
      })
      .check(Schema.isMaxLength(T3_PROJECT_FILE_MAX_SCRIPTS)),
  ),
  pod: Schema.optionalKey(T3ProjectFilePod),
}).annotate({
  title: "T3 project file",
  description:
    "Checked-in project configuration for T3 Code (t3.json at the repository root). See https://t3.codes for documentation.",
});
export type T3ProjectFile = typeof T3ProjectFile.Type;

/**
 * A key here must be nullable on `ServerSettings` (null means inherit) so both
 * the project override and the environment value can defer to the file; `field`
 * names the t3.json field carrying the same value and `builtIn` is what applies
 * when every tier is unset.
 */
export const PROJECT_FILE_BACKED_SETTINGS = {
  defaultThreadEnvMode: { field: "defaultThreadEnvMode", builtIn: "local" },
  worktreeSubmodules: { field: "worktreeSubmodules", builtIn: "recursive" },
} as const satisfies {
  // `providerInstances` is scoped per project but overrides field by field
  // rather than replacing a whole `ServerSettings` value (see its doc comment
  // in settings.ts), so it cannot be file-backed and is excluded here.
  readonly [K in ProjectScopedServerSettingKey & keyof ServerSettings]?: {
    readonly field: {
      readonly [F in keyof T3ProjectFile]: T3ProjectFile[F] extends
        | Exclude<ServerSettings[K], null>
        | undefined
        ? F
        : never;
    }[keyof T3ProjectFile];
    readonly builtIn: Exclude<ServerSettings[K], null>;
  };
};
export type ProjectFileBackedSettingKey = keyof typeof PROJECT_FILE_BACKED_SETTINGS;

export type ResolvedServerSettings = Omit<ServerSettings, ProjectFileBackedSettingKey> & {
  readonly [K in ProjectFileBackedSettingKey]: Exclude<ServerSettings[K], null>;
};
