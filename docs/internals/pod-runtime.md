# Pod runtime

A pod belongs to a worktree path, not to the thread that created it. Every thread, terminal and
script on that path runs in the pod, so anything that runs a command in a workspace asks
[`WorkspaceExecutionTarget`](../../apps/server/src/pod/WorkspaceExecutionTarget.ts) where to run
it. Today that is the terminal manager and the setup-script runner; provider sessions join them.
A caller that spawns on the host without asking runs the command against the wrong Docker daemon
and the wrong filesystem view.

Git, checkpoints, diffs and file search stay on the host: the agent container mounts the worktree
and the repository's `.git` at their host paths, so both sides see the same files. Stack commands
(`up`, seeds, compose start, stop and down) run in the agent container as the host user, against the
pod's daemon, so nothing they write in the worktree is root-owned. Provider binaries mount at
pod-private paths after the image's own on PATH, never over a system directory.

The `docker` CLI on the host reads `DOCKER_*`, `PATH` and `HOME` from its own environment, so a
container's values for those names are passed inline and never reach the CLI's environment
([`ContainerDriver`](../../apps/server/src/pod/ContainerDriver.ts)); otherwise the agent's
`DOCKER_HOST`, which is the pod's inner daemon, would redirect the host CLI.

## Lifecycle

[`PodRuntimeService`](../../apps/server/src/pod/PodRuntimeService.ts) keeps a small event journal
and projection of its own (`pod_runtime_events`, `pod_runtimes`), committed together, and runs
Docker only after the commit. A transitional state (`creating`, `starting`, `stopping`,
`removing`) is the durable intent; a server that dies mid-operation settles it at startup from
what Docker reports, into the state Docker shows or the failure state whose Retry finishes the job.
The allowed requests per state are [`POD_RUNTIME_REQUESTS`](../../packages/contracts/src/podRuntime.ts),
shared with clients so they offer only what the server accepts.

## Ownership

Everything a pod creates carries `t3.pod` and `t3.environment` labels, and its names carry the
environment's id. Reconcile, orphan listing and removal act only on objects carrying both labels
with this environment's id; anything else on the daemon, including another T3 server's pods, is
invisible to them, and a pod record copied into another server's database cannot address these
containers by name. `migrate-dev-db` drops pod records anyway. Orphans are listed, never removed
without an explicit Remove.

A pod's worktree is never removed past a failed teardown: the teardown script runs in the pod, then
the pod is removed, and only then the worktree. Removing again retries; `skipPodTeardown` ("Remove
anyway") skips the script and forgets the pod even if Docker refuses. A path whose pod was already
removed never runs its teardown script on the host, where it would act on the host's Docker.
Storage cleanup skips a worktree unless its pod was stopped on purpose: a failed pod may still have
containers running. Host worktrees keep the log-and-proceed teardown policy.

Pod RPCs are listed in `WsRpcGroup`, which carries the scope middleware, and again in
`PodRuntimeRpcGroup` ([rpc.ts](../../packages/contracts/src/rpc.ts)); the server omits them from
its core handler layer and serves them from their own, as it does chat channels, because the core
layer's type sits at the checker's limit. `RpcAuthorization.test.ts` fails for any RPC without the
scope middleware.

## Before provider sessions run in pods

Two things the default setup does not yet give a provider process. A provider binary mounts by its
real directory, so a launcher symlink's name (a native Claude install resolves to
`.../claude/versions/<version>`) is not on the pod's PATH. And `docker:27-cli` is Alpine, so
glibc-linked provider binaries do not run in it. Spawning providers in pods has to settle both.
