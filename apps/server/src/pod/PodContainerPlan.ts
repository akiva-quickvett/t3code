import type { PodRuntimeId } from "@t3tools/contracts";

import type { PodContainerMount, PodContainerSpec } from "./ContainerDriver.ts";

export const POD_LABEL = "t3.pod";
export const POD_ENVIRONMENT_LABEL = "t3.environment";
const POD_ROLE_LABEL = "t3.role";

export const DIND_IMAGE = "docker:27-dind";
/** Inside the shared network namespace only; nothing outside the pod reaches it. */
export const POD_DOCKER_HOST = "tcp://127.0.0.1:2375";
const DIND_DATA_DIR = "/var/lib/docker";
const SEEDS_ROOT = "/seeds";
const PROVIDER_BIN_ROOT = "/opt/t3/provider-bin";
/** Docker Desktop's own name for the host, so a URL that names it means the same everywhere. */
export const POD_HOST_ALIAS = "host.docker.internal";

/**
 * Where a host provider directory is mounted in the agent container: under a
 * pod-private root, at its own host path, so a host binary maps to one pod path.
 */
export const podProviderBinPath = (hostPath: string) => `${PROVIDER_BIN_ROOT}${hostPath}`;

/**
 * Credentials the host may hold for itself. A pod's agents use the login in the
 * mounted config dir instead; an inherited key would silently bill the API.
 */
export const POD_STRIPPED_ENV_KEYS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

export interface PodProviderMounts {
  /** Provider config dirs with their logins, mounted read-write as directories. */
  readonly configDirs: ReadonlyArray<string>;
  /** Codex's shared home and, with an auth overlay, its shadow home. */
  readonly codexHomes: ReadonlyArray<string>;
  /** Real directories of provider binaries, mounted read-only at pod-private paths. */
  readonly binDirs: ReadonlyArray<string>;
}

export interface PodPlanInput {
  readonly podId: PodRuntimeId;
  readonly environmentId: string;
  readonly image: string;
  readonly network: string;
  readonly worktreePath: string;
  /** The source checkout's `.git`, which a linked worktree's objects and refs live in. */
  readonly gitCommonDir: string;
  readonly homeDirectory: string;
  readonly user: { readonly uid: number; readonly gid: number } | null;
  readonly providerMounts: PodProviderMounts;
  readonly gitConfigPath: string | null;
  readonly ghConfigDir: string | null;
  /** `~/pods/seeds/<repository folder>`, seen at `/seeds/<repository folder>` as orch pods do. */
  readonly seeds: { readonly dir: string; readonly name: string } | null;
  /** `env` from the project's t3.json pod block. */
  readonly podEnv: Readonly<Record<string, string>>;
}

export interface PodPlan {
  readonly volume: { readonly name: string; readonly labels: Readonly<Record<string, string>> };
  readonly dind: PodContainerSpec;
  readonly agent: PodContainerSpec;
}

/**
 * Names carry the owning environment, so a pod record copied into another
 * server's database (a dev copy of real data) can never address this server's
 * containers by name.
 */
export const podContainerNames = (podId: PodRuntimeId, environmentId: string) => {
  const stem = `t3-${environmentId
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 8)
    .toLowerCase()}-${podId}`;
  return { dind: `${stem}-dind`, agent: `${stem}-agent`, volume: `${stem}-dockerlib` };
};

const bind = (path: string, readOnly: boolean): PodContainerMount => ({
  type: "bind",
  source: path,
  target: path,
  readOnly,
});

/** Without the stripped credentials, whatever supplied them. */
export const podSafeEnv = (env: Readonly<Record<string, string>>): Record<string, string> => {
  const stripped = new Set<string>(POD_STRIPPED_ENV_KEYS);
  return Object.fromEntries(Object.entries(env).filter(([key]) => !stripped.has(key)));
};

/**
 * The agent container sees the worktree and the repository's `.git` at the same
 * absolute paths as the host, so Git, checkpoints and diffs stay on the host.
 * Nothing else of the host is mounted: not the T3 home, other threads' state,
 * `/tmp`, multiplexer sockets or other profiles' transcripts.
 */
export const planPod = (input: PodPlanInput): PodPlan => {
  const names = podContainerNames(input.podId, input.environmentId);
  const labels = (role: string) => ({
    [POD_LABEL]: input.podId,
    [POD_ENVIRONMENT_LABEL]: input.environmentId,
    [POD_ROLE_LABEL]: role,
  });
  const seeds: ReadonlyArray<PodContainerMount> =
    input.seeds === null
      ? []
      : [
          {
            type: "bind",
            source: input.seeds.dir,
            target: `${SEEDS_ROOT}/${input.seeds.name}`,
            readOnly: true,
          },
        ];
  const user = input.user === null ? undefined : `${input.user.uid}:${input.user.gid}`;

  const dind: PodContainerSpec = {
    name: names.dind,
    image: DIND_IMAGE,
    labels: labels("dind"),
    init: true,
    // Docker-in-Docker cannot run its daemon otherwise.
    privileged: true,
    network: { mode: "bridge", name: input.network },
    mounts: [
      { type: "volume", source: names.volume, target: DIND_DATA_DIR, readOnly: false },
      // Compose resolves bind mounts on the daemon's side, so the daemon needs the worktree too.
      bind(input.worktreePath, false),
      ...seeds,
    ],
    env: { DOCKER_TLS_CERTDIR: "" },
    command: ["--host=unix:///var/run/docker.sock", `--host=${POD_DOCKER_HOST}`],
    // The agent container shares this network namespace and its hosts file;
    // the alias is how its agents reach T3's pod-facing MCP listener.
    hostAlias: POD_HOST_ALIAS,
  };

  // Pod-private targets after the image's own directories, so a host binary
  // never shadows or hides one the image ships.
  const providerBins = input.providerMounts.binDirs.map((dir) => ({
    dir,
    target: podProviderBinPath(dir),
  }));
  const binPath = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"]
    .concat(providerBins.map((bin) => bin.target))
    .join(":");
  const agent: PodContainerSpec = {
    name: names.agent,
    image: input.image,
    labels: labels("agent"),
    init: true,
    privileged: false,
    network: { mode: "container", container: names.dind },
    mounts: [
      // The host home path exists only as the parents of the binds below; this
      // makes it writable for shells and tools, and forgets it on stop.
      { type: "tmpfs", source: "", target: input.homeDirectory, readOnly: false },
      bind(input.worktreePath, false),
      bind(input.gitCommonDir, false),
      ...input.providerMounts.configDirs.map((dir) => bind(dir, false)),
      ...input.providerMounts.codexHomes.map((dir) => bind(dir, false)),
      ...providerBins.map((bin): PodContainerMount => ({
        type: "bind",
        source: bin.dir,
        target: bin.target,
        readOnly: true,
      })),
      ...(input.gitConfigPath === null ? [] : [bind(input.gitConfigPath, true)]),
      ...(input.ghConfigDir === null ? [] : [bind(input.ghConfigDir, true)]),
      ...seeds,
    ],
    env: podSafeEnv({
      ...input.podEnv,
      HOME: input.homeDirectory,
      PATH: binPath,
      DOCKER_HOST: POD_DOCKER_HOST,
      LANG: "C.UTF-8",
    }),
    ...(user === undefined ? {} : { user }),
    workdir: input.worktreePath,
    command: ["sleep", "infinity"],
  };

  return { volume: { name: names.volume, labels: labels("volume") }, dind, agent };
};
