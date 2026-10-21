# Pod runtime

A pod belongs to a worktree path, not to the thread that created it. Every thread, terminal and
script on that path runs in the pod, so anything that runs a command in a workspace asks
[`WorkspaceExecutionTarget`](../../apps/server/src/pod/WorkspaceExecutionTarget.ts) where to run
it: the terminal manager, the setup-script runner, and the Claude and Codex spawns.
A caller that spawns on the host without asking runs the command against the wrong Docker daemon
and the wrong filesystem view.

Git, checkpoints, diffs and file search stay on the host: the agent container mounts the worktree
and the repository's `.git` at their host paths, so both sides see the same files. Stack commands
(`up`, seeds, compose start, stop and down) run in the agent container as the host user, against the
pod's daemon, so nothing they write in the worktree is root-owned. A provider binary's real
directory mounts under `/opt/t3/provider-bin` at its own host path, after the image's directories
on PATH and never over a system directory, so a host binary maps to exactly one pod path.

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

## Provider sessions

[`PodProviderPlacement`](../../apps/server/src/provider/PodProviderSessionsLive.ts) decides, when
a provider session opens, where it runs. On a pod's worktree Claude and Codex run in the pod.
Other drivers (Cursor runs in the server process, OpenCode serves every directory from one server,
Antigravity is bound to the host) run on the host only when the thread's role preset says
`runsIn: host`, and are refused otherwise: a session on the host would reach the host's Docker
while the worktree's stack lives in the pod. `orchestrator_capabilities` lists each refusal.

A provider that serves many threads from one process (Codex, OpenCode) gets one shared session
per place. The orchestrator names the shared session when it queues a run, which for a new
worktree is before its pod exists, so turn start moves the thread to the shared session of the
place it runs in now (its pod's, or the host's, by the same rules as above) and detaches it from
the old one. The session manager never attaches a thread to a shared session placed elsewhere:
one process cannot run in two places. It reads `runsIn` from the thread's preset itself, so every
path that opens a session places it alike.

The host's `docker exec` client forwards no signal to the process it started, so closing it
leaves the agent and its children running in the container. Each launch therefore marks its
environment with `T3_POD_SESSION` and records its pid, and its end signals every container process
carrying the mark or descending from that pid (TERM, then KILL): the host's process-group kill,
extended to children that left the group (they keep the mark) and to children started with a
cleaned environment, such as Codex's stdio MCP servers (they descend from the launch). A pid
namespace per launch would be tighter, but the agent container is unprivileged and cannot make one.
The stop catches what a session leaves behind, not a session that evades it: one that rewrites its
pid file or its own mark, or double-forks a child with a cleaned environment, can outlive its stop.
It runs as the user, in that pod's agent container only, and ends with the pod's stop or an
agent-container recreate; the next server's sweep matches only marks, so it does not see such a
process either. Closing a session, server shutdown included, waits for the stop script. A server
that crashed never ran its stops, so each running pod is swept once per start of its containers
for marks the current server did not make.

A session in a pod never inherits the server's environment. `docker exec` names only the
instance's own variables, its config-dir variable and the role's context window; inherited
`ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` are stripped even from those. The process also
has the agent container's own environment, as its terminals do: the project's `t3.json` pod `env`
and, in hostname mode, `NODE_EXTRA_CA_CERTS`. The MCP token is
not in that environment either: Claude takes it over its control channel and Codex in its thread
config, so commands the agent runs never see it. A `settings.json` `env` block in the mounted
config dir still overrides the role's context window, as it does on the host.

The agent container mounts the config dirs (and a Claude shared config dir) of the project's
enabled Claude and Codex instances when it is made. A session whose instance's dirs are missing
recreates the agent container from current settings; the daemon, its volume and the stack stay,
and the pod's other sessions are released so their next turn resumes in the new container. It is
refused instead when the new container would still lack the dirs (the instance is not enabled for
the project) or when another session in the pod is mid-turn, which the recreate would end.

## Pod-facing MCP listener

`127.0.0.1` inside a pod is the pod, so pod sessions reach T3 through
[`PodMcpListener`](../../apps/server/src/mcp/PodMcpListener.ts). It must never widen what the
server exposes:

- It binds the pod network's gateway address, only while a pod uses that network, and admits only
  peers in the network's subnet. The port is fixed (17773, below the ephemeral range) so one host
  firewall rule admits pods across restarts; a default-deny INPUT policy drops them otherwise.
  While another program holds it, the listener takes a free port and logs that the rule no longer
  covers it.
- It admits exactly `/mcp` and the signed attachment upload URL, matched on the raw path, and hands
  them to the main server's own routes, so the same bearer check and upload signature apply.
  Pairing, the API, OAuth, webhooks, the preview stream, the relay and the WebSocket answer 404.
- It takes only provider-session tokens; a paired device's OAuth token is refused.

Containers reach it as `host.docker.internal`, which the daemon container maps to the network's
gateway address and the agent container shares through its network namespace. Docker's
`host-gateway` is the default bridge's address, where the listener does not bind. Docker Desktop
for macOS gives containers no route to such an address; a unix-socket listener for it is not built.

The listener keys on the network the pod's daemon joined when it was made, recorded in its
`t3.network` label, since the host alias points at that network's gateway whatever settings now
name. Pods made before these sessions existed lack the alias, the label and the provider-binary
layout, and need a full recreate.

Still open: the default image `docker:27-cli` is Alpine, so glibc-linked provider binaries do not
run in it. Claude's `~/.claude.json` lives outside its config dir and is not mounted.
