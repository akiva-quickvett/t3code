# Pod runtime

A pod belongs to a worktree path, not to the thread that created it. Every thread, terminal and
script on that path runs in the pod, so anything that runs a command in a workspace asks
[`WorkspaceExecutionTarget`](../../apps/server/src/pod/WorkspaceExecutionTarget.ts) where to run
it: the terminal manager, the setup-script runner, and the spawns of every provider that runs in pods.
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

## Following threads

A pod follows the threads on its worktree
([`PodParkingReactor`](../../apps/server/src/orchestration-v2/PodParkingReactor.ts)): once every
one is snoozed or settled with no active or queued run and no pending request, it stops (or, for
snoozes under a `freeze` setting, is paused), and it is marked `parked`. Only a parked pod starts
again on its own when a thread wakes; a pod the user stopped stays stopped until a turn needs it.
It parks only when a thread parked after the pod was last asked to run (its snooze, or its
settle), so a pod the user started from its chip while the threads sleep stays up until one of them
parks again, while threads that re-park during a slow wake's start still stop it. A
start that failed after its containers came up is parked too, so a failed wake the user keeps
snoozed does not hold memory; a failed creation is not, since a stop would hide that Retry builds
its stack.
A pod whose threads were all archived or deleted is left alone: it is the teardown's to remove.

A turn on a pod that is not running waits for it, but not inside the effect worker: a start can take
minutes, longer than an effect's lease and far longer than one of the worker's few slots should be
held. The turn's effect returns, its run stays `starting` (which also keeps the pod from parking),
and the turn starts once the pod runs ([`ProviderTurnStartService`](../../apps/server/src/orchestration-v2/ProviderTurnStartService.ts)).
A server that stops mid-wait recovers the run like any turn cut off while starting. A pod in
`start_failed` or `stop_failed` fails the turn at once: Retry belongs to the pod's banner, and an
automatic retry of a failed creation would rebuild its stack on every wake.

Three orderings keep a stop from cutting live work:

- The pod's sessions are released, as a stop, before the pod stops. A session that died under the
  stop would read as a provider failure, which wakes a snoozed thread and starts the pod again.
- `park` asks whether the threads are still parked, releases the sessions, and asks again, all under
  the pod's state lock, before it records the stop. A turn reads its pod under the same lock after
  its run is recorded as starting, so a turn that began at any point either keeps the pod up or
  finds it stopping and waits.
- A turn on a running pod closes only the sessions opened before the pod's latest start, which died
  with the stop before it. Sessions a sibling turn opened since are kept.

A start resumes exactly what was stopped and never rebuilds: it fails, for the user to Retry or
Recreate, when a recorded container or volume is gone, when a stack container the last stop listed
is gone (`compose start` skips those silently; the list names the compose service containers, not
one-off or `--rm` ones the daemon may drop, lives in the daemon's own volume and is replaced at
every stop; names, unlike ids, survive bringing the stack up again from the shell), when the hostname proxy's DNS server moved from the address the daemon was
pinned to, or when, in hostname mode, the pod's first hostname does not answer through the proxy
from inside the pod. Such a failed start takes its route away but leaves its containers running for
the shell; Stop or Recreate is the user's call. Creation keeps the rule that a route problem only
notes itself on the pod.

While any pod exists, the reactor reads each thread whose run or request changes, and each look at
a pod scans the threads' worktree paths; that is cheap at today's scale, and an index on the
payload's `worktreePath` is the step if it ever is not.

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
a provider session opens, where it runs. On a pod's worktree Claude, Codex, Pi, Grok and ACP
Registry agents run in the pod. Other drivers (Cursor runs in the server process, OpenCode serves
every directory from one server, Antigravity is bound to the host, and Muse's login and its own
tool sandbox are unaccounted for) run on the host only when the thread's role preset says
`runsIn: host`, and are refused otherwise: a session on the host would reach the host's Docker
while the worktree's stack lives in the pod. `orchestrator_capabilities` lists each refusal.

Provider packages cannot see the pod runtime, so they spawn through
[`ProviderPodProcesses`](../../packages/provider-core/src/server/podProcess.ts), a provider-core
reference the server implements over the same launch and stop as Claude and Codex. Only drivers
that run in pods ask it, so a host-only driver never lands in a pod by accident: the shared ACP
adapter does so only for flavors that set `runsInPods`. Adapters read it when they are built, as
Codex does, because sessions open from the session manager's context, which does not carry it.

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
not in that environment either: Claude takes it over its control channel, Codex in its thread
config, and ACP agents in the `http` MCP server of `session/new`, so commands the agent runs never
see it. Pi is the exception, since its T3 extension reads `T3_MCP_URL` and `T3_MCP_BEARER_TOKEN`:
they are in that one launch's `docker exec` environment, never the container's. These drivers'
environments are the instance's own, so a provider key set there passes, unlike the credentials
stripped from Claude's. ACP agents get an `http` server, which some adapters (codex-acp, pi-acp)
ignore; those run in a pod without T3's tools unless they take MCP over ACP. ACP's stdio MCP
bridge is T3's own host binary, which a pod cannot run; T3's MCP-over-ACP bridge runs on the host
and calls the server's own endpoint (`hostEndpoint`), not the pod listener's. A `settings.json`
`env` block in the mounted config dir still overrides the role's context window, as it does on the
host.

The agent container mounts the config dirs of the project's enabled instances when it is made:
Claude's (with a shared config dir, and in the default layout `~/.claude.json`, which Claude keeps
beside `~/.claude` rather than in it), Codex's homes, Pi's agent dir and Grok's home. Of the T3
home it mounts only two directories, read-only: each configured ACP Registry agent's managed
install under `tools/` (at its own path, created before the agent installs, since an install
refers to itself by absolute path), and the pod's own `caches/pods/<pod>`, where T3 writes files its agents
read, such as Pi's extension. A macOS host's provider binaries cannot run in a Linux container, so
there none are mounted and the image's CLIs run by name. A session whose instance's dirs are missing
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
`host-gateway` is the default bridge's address, where the listener does not bind.

An engine in a VM (Docker Desktop anywhere, any engine on macOS;
[`selectPodMcpTransport`](../../apps/server/src/pod/PodMcpTransport.ts) decides from the host
platform and `docker info`) keeps the gateway inside the VM, out of the host's reach. There the
engine's own `host.docker.internal` is dialed from the host itself, so one listener binds
127.0.0.1, the daemon container sets no alias of its own (the gateway is inside the VM) unless it
uses resolvers of its own, which replace the engine's answer for that name, and then maps it to
Docker's `host-gateway`, and the
subnet check gives way to the token: every peer is loopback, so any local process can connect. The
listener then also requires the `host.docker.internal` Host header, which a browser page that
rebinds its own name to 127.0.0.1 cannot send. A unix socket bind-mounted from the host was the
alternative; it does not reliably cross Docker Desktop's VM, and provider MCP clients take only a
URL, so each session would need a relay in the pod.

A host firewall that drops the pod network is invisible otherwise: agents just run without T3's
tools. So once per start of a pod's containers, and again when a session is placed while the last
result was blocked, the placement probes the listener from the agent container and records the
result on the pod's snapshot (`mcpListener`, optional, so stock clients and servers skip it). Nothing
polls.

The listener keys on the network the pod's daemon joined when it was made, recorded in its
`t3.network` label, since the host alias points at that network's gateway whatever settings now
name. Pods made before these sessions existed lack the alias, the label and the provider-binary
layout, and need a full recreate.

The default agent image is [built by T3](../../apps/server/src/pod/PodAgentImage.ts) on the Docker
host rather than pulled, under a `.invalid` name, which never resolves (RFC 2606), so a missing
build can never pull someone else's image in its place.
