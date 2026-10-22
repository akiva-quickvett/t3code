# Orchestrator MCP Server

## Purpose

T3 exposes V2 orchestration through its app-owned MCP endpoint. A provider
agent can use this endpoint to:

- create an app-owned sub-agent on any supported provider instance;
- wait for or poll the sub-agent's durable result;
- cancel an active delegated task; and
- create one or more ordinary top-level T3 threads;
- list a project's threads and incrementally read any thread;
- rename threads, regenerate titles, and link or unlink pull requests;
- send or steer follow-up messages; and
- wait for or interrupt ordinary thread runs.

These are T3 orchestration operations, not provider-native sub-agent APIs.
Delegated tasks always create a T3 child thread and run. The child receives
only the supplied task prompt, plus an optional role instruction supplied in
the same tool call or the instructions of its role preset. Parent conversation
history is not copied into the child.

`ThreadManagementService` is the shared server application boundary for V2
WebSocket commands and MCP. It owns thread lookup, listing, send-mode
selection, durable send postconditions, wait polling, and interrupt selection;
`OrchestratorV2` remains the lower-level command/event processor. Transport
adapters only authenticate, resolve transport-specific inputs, and shape
responses.

## Transport And Authentication

The orchestration tools share the existing authenticated HTTP MCP endpoint:

```text
http://127.0.0.1:<server-port>/mcp
```

The provider-visible server key is `t3-code`. The endpoint registers both the
preview toolkit and the orchestration toolkit.

Before `ProviderSessionManager` opens a new V2 provider session, it asks
`McpSessionRegistry` for a credential scoped to:

- the T3 environment;
- the parent T3 thread;
- the concrete provider instance; and
- the provider session.

The credential grants `preview` and `orchestration` capabilities. Credentials
expire after a maximum lifetime, expire when idle, and are revoked when the
provider session is released. The raw token is not persisted in orchestration
state.

The MCP HTTP server resolves the bearer token and supplies the resulting
`McpInvocationScope` to tool handlers. Orchestration handlers additionally
check the `orchestration` capability before reading or mutating state.

A session that runs in a pod gets the same credential with the endpoint
`http://host.docker.internal:<pod-listener-port>/mcp`, the pod-facing listener
that serves only `/mcp` and attachment uploads
([pod runtime](../internals/pod-runtime.md#pod-facing-mcp-listener)). There, ACP
agents get it as an `http` server in `session/new|load|fork`, since T3's stdio
bridge is a host binary, and Pi in its own process's environment only.

## Provider Injection

### Codex V2

Codex app-server receives the remote MCP server in each thread's config:

```text
mcp_servers.t3-code.url = "http://127.0.0.1:<port>/mcp"
mcp_servers.t3-code.http_headers.Authorization = "Bearer <provider-session-token>"
```

The token stays out of the app-server's environment, so the commands Codex
runs never inherit it.

### Claude Agent SDK V2

Claude receives an HTTP MCP server in its query options:

```ts
{
  mcpServers: {
    "t3-code": {
      type: "http",
      url: "http://127.0.0.1:<port>/mcp",
      headers: {
        Authorization: "Bearer <provider-session-token>",
      },
    },
  },
  allowedTools: [
    // existing allowed tools
    "mcp__t3-code__*",
  ],
}
```

The adapter logs only whether MCP configuration exists; it does not log the
server headers or token.

### Cursor Agent SDK V2

Cursor receives the same authenticated HTTP MCP endpoint through the SDK's
`mcpServers` agent and send options. The adapter passes the authorization header
to the SDK but projects only redacted option metadata into protocol diagnostics.

### Grok ACP V2

Grok receives the authenticated HTTP MCP endpoint through the ACP
`session/new`, `session/load`, and `session/fork` `mcpServers` field. The shared
ACP adapter owns standard protocol behavior; the Grok flavor adds xAI extension
requests such as structured user questions.

ACP does not define native subagents or active steering. Grok therefore uses
orchestrator-owned child threads and implements steering through
cancel-and-restart. Its current driver also lacks `session/fork`, so app forks
use portable context transfer. These are orchestrator policies, not
provider-specific MCP tools.

### ACP Registry V2

The `acpRegistry` driver is the generic flavor of the same shared ACP adapter.
Each provider instance names an agent from the official ACP Registry. Settings
searches the registry through the connected server, then prepares a compatible
distribution before persisting the provider instance. Binary distributions use
a managed, versioned cache; declared checksums are verified when present.
Version-pinned `npx` packages install globally through `npm`; `uvx` packages use
`uv tool install`. ACP launches the resulting global command directly, so the
same command is available for terminal authentication. A local executable may
override the installed command without changing the registry-declared arguments
or environment.

Search, preparation, provider status, and session startup share one
server-scoped catalog service. This keeps platform selection and registry
validation identical across settings and runtime use. Catalog inspection never
starts an ACP process, probes models, or performs authentication. The managed
provider snapshot creates a disposable `session/new` through the normal provider
refresh lifecycle, using success as the authentication-readiness proof and
projecting advertised models into the snapshot. Terminal-only login remains a
manual operation on the connected server.

Capabilities such as session loading, session forking, models, modes, and MCP
transport are enabled only when the selected agent advertises them. Missing
features degrade through V2 policy: steering uses interrupt-and-restart,
forking uses portable context when native `session/fork` is unavailable, and
subagents use orchestrator-owned child threads. Registry agents do not receive
provider-specific extensions; those remain in flavors such as Grok.

### Pi V2

T3 keeps a provider-session HTTP bridge even when Pi supports native MCP.
`mcp.json` entries override native registrations, and native MCP's default
60-second request timeout can interrupt long-running T3 tools. The bridge owns
the injected endpoint and credential and forwards Pi's cancellation signal.

When a provider session credential exists, the adapter writes a T3-owned
extension into the server cache and spawns
`pi --mode rpc --extension <cache>/pi-t3-mcp-extension.ts` with:

```text
T3_MCP_URL=http://127.0.0.1:<port>/mcp
T3_MCP_BEARER_TOKEN=<provider-session-token>
```

The extension preserves public names under `mcp__t3-code__` for saved loadouts
and tool selectors. Modern Pi also receives hidden `mcp__t3_code__` aliases,
which reserve the normalized namespace against configured MCP servers without
adding declarations or search results. On Pi 0.99+,
`orchestrator_capabilities`, `delegate_task`, and `task_status` remain directly
available; optional tools are discovered through Pi's builtin `tool_search`.
On older Pi or without builtin search, all tools remain directly available.
The bridge calls the original MCP tool name over HTTP. Follow-up requests send
`mcp-protocol-version: 2025-06-18`; Effect's MCP transport returns 400
without it. The first turn of a session also receives the shared T3
orchestration instructions.

Pi keeps ownership of native extension discovery. T3 does not replace Pi's
`subagent` tool or reproduce Pi's package and project-trust loader. Durable
delegation goes through the namespaced T3 MCP `delegate_task` tool and the
shared orchestration child-thread lifecycle. When Pi's example `subagent`
extension is installed, the adapter observes its documented `details.results`
shape and projects task cards with no child thread id. Unknown result shapes
remain ordinary dynamic tool output.

### Provider Support

A provider instance can run child tasks when its live `ProviderInstance`
exposes a V2 `orchestrationAdapter` — the same registration the orchestrator
resolves when a `delegated_task.request` executes. That covers Codex, Claude
Agent SDK, Cursor Agent SDK, Grok, generic registry agents over ACP, OpenCode,
OpenCode 2, Pi, Antigravity, and any future driver that builds an adapter.
Capability discovery still reports other registered provider instances, but
marks them unavailable for orchestration when no adapter resolves. This keeps
provider selection model-visible without allowing a request that cannot run.

## Tool Surface

The server exposes these orchestration tools.

### `orchestrator_capabilities`

Returns:

- the inherited provider instance and model;
- the parent runtime and interaction modes;
- registered provider instances and advertised models;
- whether each provider can run a child task, and its `headroom`: `ok`, `low`,
  `unknown` (its last limit check failed), or `exhausted`;
- the role presets in effect for the caller's project: id, label, model target,
  `runsIn`, the roles it may delegate to (advisory), and why one cannot start
  here. Instructions stay on the server; and
- feature flags for polling, cancellation, batch thread creation,
  `t3_usage_limits`, `t3_usage_thread_tree` (`usageThreadTree`), and supervised
  wakes (`supervisedWakes`), the last two missing on older servers.

Unavailable providers include model-visible constraints such as missing V2
adapter support, disabled state, missing executable, or missing authentication.

### `t3_usage_limits`

Read-only. Returns one row per enabled provider instance, optionally filtered by
`driver` or `instanceId`: label, plan, `checkedAt`, windows (kind, label, used
percent, reset time), `status` (`ok`, `stale`, or `unavailable` with
`unsupported` or `probeFailed`), and `headroom` (`ok`, `low`, `unknown` for
`probeFailed`, `exhausted`; `ok` for `unsupported`). It projects the same snapshots
as Usage → Limits and never carries email, credential fingerprints, hub
details, or reset-credit ids. It starts no probe unless `refresh: true`, which
re-checks only instances not checked or attempted in the last five minutes. Headroom thresholds
come from the server's `usageHeadroom` setting.

### `t3_usage_thread_tree`

Read-only. Takes `threadId` and returns the estimated tokens and cost of that
thread and every thread it launched or delegated to, transitively: supervised
threads through `lineage.supervisorThreadId` and subagents through their parent;
forks are separate trees. It returns totals, `rootThreadId` (the top of the
tree the thread belongs to), `sinceDay`, and one row per thread, depth-first
from the requested one: `threadId`, `parentThreadId`, `depth`, `title`,
`preset`, `tokens`, `costUsd`, and `unpricedRecords`, capped at 200 rows with
`omittedThreads` counting the rest (totals include them). Costs reuse the Usage
summary's prices and overrides; unpriced usage is counted and left out of
`costUsd`. A record is matched to the thread whose provider thread first opened
its native session, so it counts once; a Claude fork's copy of its source's
history stays with the source session. Usage whose history names no session or
another session id than the thread's (possible for Cursor and Antigravity) is
not included. An unknown or deleted thread fails with
`thread_not_found`. It carries no account, credential, or hub details.

### `delegate_task`

Creates a T3-owned child thread and immediately dispatches the supplied task
prompt.

```ts
type DelegateTaskInput = {
  task: string;
  target?: {
    providerInstanceId?: string;
    driverKind?: string;
    model?: string;
  };
  title?: string;
  role?: "implementation" | "research" | "review" | "design" | "test" | "general";
  preset?: string; // role preset id
  isolation?: "shared" | "worktree";
  branch?: string; // worktree only
  baseRef?: string; // worktree only
  mode?: "async" | "wait";
  timeoutMs?: number;
  clientRequestId?: string;
  runtimeMode?: "inherit" | "approval-required" | "auto-accept-edits" | "full-access";
  interactionMode?: "inherit" | "plan" | "default";
};
```

Provider, model, runtime mode, and interaction mode inherit from the parent
when omitted. A driver-only target inherits the parent's provider instance
when it can run child tasks, and otherwise selects an available instance of
that driver; an explicit `providerInstanceId` is honored exactly and fails
when unavailable. Selecting a different provider without a model uses that
provider's first advertised model.

`preset` names a role preset (case and padding are forgiven). It supplies the
target, runtime and interaction modes, isolation, and the child's role; any
field passed explicitly wins. A target that names a provider instance or driver
replaces the preset's; one that names only a model keeps the preset's provider,
and the preset's model options apply only to the preset's own model. Options the
model does not offer are dropped rather than refused. A preset's modes never
exceed the caller's: a broader one runs at the caller's mode, while an explicit
mode is checked as before. An unknown id is `invalid_request` and lists the known
ids; a preset whose provider or model is unavailable fails as an explicit target
would. The child records the preset id and a label snapshot. Its instructions,
skills and allowed child roles are read when each turn starts: Claude gets them in its system prompt, Codex as turn
context, and other providers as a prefix to the provider's prompt on the first
turn of a provider thread and again after the role changes. None of these appear
in the timeline. `contextWindow` applies to Claude only.

A provider runs a runtime mode it does not offer as `approval-required`, so a
child would ask for approval on every command. `orchestrator_capabilities`
lists `runtimeModes` only for a provider that offers some of the modes, and
omits it for a provider that offers all of them. When the target lists
`runtimeModes`, an explicit `runtimeMode` outside that list is refused, and an
inherited mode steps down to the broadest mode the target offers.

`isolation: "worktree"` gives the child its own checkout, prepared like a
`t3_thread_launch` worktree before the child starts. Without `baseRef` it starts
from the parent checkout's `HEAD` commit. `baseRef` is checked before the task
is accepted and kept by name, so the new branch records it as its pull request
base: `origin/<branch>` must exist on origin and is fetched (again in
preparation, as `startFromOrigin` does); any other ref must resolve in the
project's repository, and a remote-tracking ref is pinned to its commit so the
new branch never tracks it. `branch` names the new branch. A name
`git check-ref-format --branch` rejects, a reserved temporary worktree name, an
existing branch, or one that clashes with a branch path (`a` beside `a/b`) is
refused rather than reused. Without `branch` the branch gets a temporary name
that is renamed from the task, as for any new worktree thread. Both fields are
refused for shared isolation. A retry with the same `clientRequestId` replays
the accepted task without fetching, validating, or creating anything again.

Each delegated review round uses a new `delegate_task` call with the original brief,
prior findings, responses, and unresolved objections. Track each round by its own `taskId` and use
a distinct `clientRequestId` per round, stable across retries of that round.
`childThreadId` is backing storage, not a target for another review round through
`t3_thread_send`.

Sending to `childThreadId` continues the same child session instead. Once the original
task has its result, a parent `t3_thread_send` that starts a turn there (or restarts a
turn without a task) records a follow-up task, returns its `taskId`, and wakes the parent
once when that turn ends, the same way an async task does. The original result does not
change. The wake is the cost: a follow-up the parent does not care about still starts one
parent turn, which should end without replying. Only the parent's own sends and the
user's messages in the child record follow-ups; notifications, scheduled runs, and
restart continuations never do.

Delegation requires an active parent run owned by the MCP credential's
provider session. The request becomes the V2 command
`delegated_task.request`.

`mode: "async"` returns the current durable state immediately.
`mode: "wait"` waits for the task result, including nested work and completion follow-ups, or until
the timeout expires. A wait timeout does not cancel the child; the result sets
`waitTimedOut: true`, and the caller can continue with `task_status`. A pending blocking
question also ends the wait with `hasPendingQuestion: true` and `waitTimedOut: false`.
If `hasPendingQuestion`, pass `threadId=childThreadId` to `t3_pending_request_list`,
`t3_pending_request_read` (with `requestId`) and `t3_pending_request_respond`, or ask
the user; the task's completion still wakes this thread. Async questions and approvals
do not end the wait.

```ts
type DelegateTaskResult = {
  taskId: string;
  childThreadId: string;
  childRunId: string | null;
  childNodeId: string;
  status: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted";
  workState: "working" | "waiting_for_children" | "result_available";
  hasPendingChildRuns: boolean;
  providerInstanceId: string;
  model: string | null;
  summary: string | null;
  resultContextTransferId: string | null;
  latestTerminalRunId: string | null;
  latestTerminalStatus: "completed" | "failed" | "cancelled" | "interrupted" | null;
  latestTerminalSummary: string | null;
  latestTerminalResultContextTransferId: string | null;
  hasPendingQuestion: boolean;
  waitTimedOut: boolean;
};
```

### `task_status`

Reads a delegated task from the parent thread's durable projection. A task ID
from another parent thread is rejected. `childRunId` identifies the original
run. `workState` distinguishes active work, a finished turn waiting for children,
and an available result. The task remains nonterminal until its known work
finishes. Its published `summary` and result transfer then remain stable across
later follow-ups. `hasPendingChildRuns` reports later queued or executing turns;
`latestTerminal*` exposes later executed, non-monitor results without replacing
the published task result.

### `task_cancel`

Stops the child thread with the internal `thread.stop` command, then stops every
task the child delegated, and disposes automatic parent delivery. Like a user Stop,
`thread.stop` interrupts the running turn, holds queued turns, and ends pull request
watches. Unlike a user Stop, cancelling also releases the stopped threads' provider
sessions, and the next message to one of them resumes it. A shared Codex or
OpenCode process stays up for its other threads. A nonterminal task with no interruptible run is rejected. A terminal task
returns its existing status, and its child thread still stops, including later
runs and watch wakes. Published task results remain available. It accepts an
optional cancellation reason. A supervised thread's task is the exception: see
[Supervised Threads](#supervised-threads).

### `create_threads`

Creates between one and twenty ordinary top-level T3 threads:

```ts
type CreateThreadsInput = {
  threads: Array<{
    prompt?: string;
    title?: string;
    target?: {
      providerInstanceId?: string;
      driverKind?: string;
      model?: string;
    };
    preset?: string; // as for delegate_task, without isolation
    runtimeMode?: "inherit" | "approval-required" | "auto-accept-edits" | "full-access";
    interactionMode?: "inherit" | "plan" | "default";
  }>;
  clientRequestId?: string;
};
```

Each entry independently resolves provider, model, and modes. The new threads
inherit the parent's project, branch, and worktree path, but they have no
sub-agent lineage. Entries with a prompt immediately dispatch a run; entries
without a prompt remain idle.

### `t3_thread_launch`

Launches one ordinary top-level thread through the app's launch service. Use an
explicit `workspaceStrategy` to create a new worktree (`worktree` with `baseRef`),
attach an existing checkout (`existing_worktree` with `worktreePath`), or use the
project root (`root`, also the default). The thread is bound to that workspace
before the agent starts. Creating a worktree in the task prompt does not update
this binding.

Pass the task in `message`. Project, model, and modes inherit when omitted;
workspace does not. `preset` starts the thread with a role preset's model, modes,
and role, under the same rules as `delegate_task`. `scratch: true` launches without
a project, in a folder of its own under the environment's Scratch project. For
stacked PRs, use the parent branch as `baseRef` with `startFromOrigin: false`. The
new thread may not run with broader runtime or interaction modes than the caller.
`create_threads` remains the batch option for a shared checkout.

A retry with the same `clientRequestId` in the same provider session replays the
accepted launch and returns the same thread, with the preset and supervisor it was
created with. The retry is checked again before it replays, so it fails if the
preset, base ref, or provider is gone by then; find the existing thread with
`t3_thread_list`. Without a `clientRequestId`, inspect existing threads after a
failed or lost response before launching again.

`supervise: true` makes the caller the thread's supervisor
(`lineage.supervisorThreadId`, see [Supervised Threads](#supervised-threads)), and
combines with `preset`. It needs a calling T3 thread and a message, and the result
adds the `taskId` of the first run.

### `t3_thread_list`

Lists durable thread shells in one project, newest first: `projectId` when
given, else the calling thread's project. Callers can filter by title, run
status, and whether app-owned sub-agent threads are included. Results are
bounded and offset-paginated. Deleted threads are never listed.

### `t3_thread_read`

Reads the durable state, recent runs, and visible timeline of any thread in
the environment by thread ID. A deleted thread returns `thread_not_found`. The
default `messages` view returns user messages, assistant
messages, and proposed plans. The `activity` view also returns summarized tool,
reasoning, checkpoint, handoff, and runtime-request items. Large item text is
bounded and reports whether it was truncated. `afterPosition` and
`nextPosition` support incremental reads.

Thread and message results include required `createdBy` and `creationSource`
provenance. MCP-created threads and user-role messages use `createdBy: "agent"`
and `creationSource: "mcp"`; provider output uses `creationSource: "provider"`.
Actor and ingress are separate so agent-authored user-role messages remain
distinguishable from human-authored messages.

Agents mention another thread as `[title](t3-thread://v1/<threadId>)`. The
link carries only the id, which resolves in the environment of the message that
holds it. Clients show the thread's current title rather than the label, so a
rename never leaves a stale link.

List and read results report a thread's `rolePreset` when it has one, and
`snoozed` and `snoozedUntil`, and
`t3_thread_list` filters on `snoozed`. The server's `isSnoozed` follows the
client's `effectiveSnoozed`, so agents and the sidebar agree: a snoozed thread
wakes early when it has a pending request, fails, or completes after the snooze.
`t3_thread_list` also gives the `pod` a thread's worktree runs in, with its
state and whether its threads' snooze stopped it. `t3_thread_organize` snoozes
and wakes the whole agent tree unless `scope` is `thread`, as the sidebar's
Snooze does; it is the same `thread.snooze` command with `scope: "tree"`.

### `t3_thread_update`

Updates metadata for the calling thread or any other thread in the environment.
The typed actions are `rename`, `regenerate_title`, `link_pull_request`, and
`unlink_pull_request`. A link input supplies the repository, number, and URL;
the server records the target thread's project ID. Branch and workspace changes
are outside this tool.

The result includes the command ID and durable event sequence together with the
resultant title, title-regeneration marker, and linked pull request. Reusing a
`clientRequestId` for the same action and thread replays the same command
receipt. Thread list and read results expose the linked pull request, and thread
detail also exposes an in-flight title regeneration.

### `t3_thread_send`

Sends a message to any ordinary or delegated thread in the environment:

- `auto` starts an idle thread, steers a fully active turn, or queues behind a
  turn that is not yet steerable;
- `queue` creates a separate follow-up run after active work;
- `steer` requires a steerable active provider turn; and
- `restart` requires an active provider turn and uses the orchestrator's
  interrupt-and-restart path.

The target runtime and interaction modes may not be broader than the caller's.
Stable command and message IDs are derived from `clientRequestId` for
idempotent retries, so a retried follow-up records one task and one wake. A send to the
caller's delegated or supervised child that starts a turn returns that turn's `taskId`.

### `t3_thread_wait`

Waits for a selected run to become `completed`, `failed`, `cancelled`,
`interrupted`, or `rolled_back`. Without `runId`, it pins the latest run at call
time; an idle thread returns immediately. A timeout reports the latest durable
status and does not cancel work.

### `t3_thread_interrupt`

Interrupts a selected active run through the normal V2 `run.interrupt` command.
Without `runId`, it selects the newest interruptible run. A terminal run is
returned unchanged, and a thread with no active provider turn returns
`no_active_run`.

## Delegated Task Lifecycle

The MCP server is a command ingress into V2. It does not call provider adapters
directly.

```text
provider model
  -> MCP tools/call delegate_task
  -> authenticated OrchestratorMcpService
  -> shared ThreadManagementService
  -> V2 delegated_task.request command
  -> child thread + child run
  -> parent app_owned subagent projection
  -> parent/child execution nodes
  -> consumed subagent_spawn context transfer
  -> normal provider effect and runtime ingestion
  -> child run reaches a terminal state
  -> parent subagent/node/turn item finalized
  -> consumed subagent_result context transfer
  -> wait result or later task_status result
```

The child thread has lineage relationship `subagent` and points back to the
parent node. The parent gets an `app_owned` sub-agent projection and a
sub-agent turn item so the existing debug UI can render progress.

Terminal provider events trigger finalization. The event stream first replays
persisted events and then follows live events, so finalization also runs after
a server restart. An existing `subagent_result` transfer makes finalization
idempotent.

Users rarely watch child threads, so a child question would otherwise go
unanswered. When a child opens a pending `user_input` request, the parent gets
a notification message telling it to answer with the pending request tools or
ask the user. The message says whether the child is blocked or, for a Codex
async question, still working. If the question is answered or dismissed before
the notification starts a turn, that queued turn is cancelled. Approvals are not
routed, because those tools cannot answer them.
A parent still blocked in a `delegate_task` wait gets the blocking question
through that wait instead.
If the provider cuts that wait short, a still-pending live question wakes the
parent when its launching run completes, fails, or waits for post-turn work.
Stopping or interrupting the parent prevents this catch-up.

A failed run exposes its provider error before any progress text. Successful
results use the latest assistant content from the final work turn.

## Supervised Threads

A supervised thread is an ordinary top-level thread: it shows in the sidebar, has its
own composer, watches its own pull requests, and runs its own delegated tasks. Its lineage
has no parent and only adds `supervisorThreadId`, the launcher. It is not a subagent, so
the launcher has no node or card for it, and stopping the launcher does not stop it.

Each run the launcher starts there, from the launch message on, is an app-owned task on
the launcher, bound to the run by `delegatedTaskId` and marked `supervised`. Unlike a
delegated child there is no original task covering later work, so a message the user
types in the supervised thread, or a turn its own notifications start, records nothing.
In `t3_thread_send`, `auto` from the supervisor queues rather than steer into a turn no
task tracks, so the send still wakes it; with `supervisedWakes` off it steers as before.

Finalization and completion delivery are the delegated-task path unchanged: the
`subagent_result` transfer deduplicates replays and restarts, and the wake is a delegated
completion notification read with `task_status`. A child question from a tracked run
wakes the launcher like a delegated task's question does.

The supervised thread keeps running whatever happens to the launcher, so its wakes are
handled apart from a delegated child's:

- A turn Stop or interrupt on the launcher holds them. They move to the run the user
  continues with (their next message from a client, or Resume) and are delivered from it.
- `thread.stop`, archive, or delete of the launcher disposes them.
- `task_cancel` on such a task removes the run it tracks only while that run is queued, and
  drops its wake. A running turn is left to finish: interrupting it would close its own
  delegated tasks' wakes while their work kept going.

The `supervisedWakes` server setting (on by default) is the switch. Off, `supervise` and
`thread.create` with a supervisor are refused, and sends to existing supervised threads
record no new tasks; wakes already recorded still arrive. Delegated-task follow-ups are
unaffected.

## Policy And Idempotency

- A child runtime mode may stay equal to or become narrower than the parent
  mode. It may not escalate privileges.
- A child interaction mode may stay equal to or narrow from `default` to
  `plan`. It may not escalate from `plan` to `default`.
- Thread tools take any thread in the environment as a target. For a thread
  caller, list and search cover one project: its own unless `projectId` is given.
- A tool that changes another thread needs the calling thread's live run, and
  the target's runtime and interaction modes may not be broader than the
  caller's. This is the same privilege ceiling as child creation.
- Provider instances must be enabled, installed, available, authenticated, and
  backed by a V2 adapter.
- A requested model must be advertised by the selected provider when the
  provider publishes a model list.
- `clientRequestId` derives stable command, thread, and message IDs within the
  provider session. Retrying the same call returns the same durable work.
- Calls without `clientRequestId` receive a generated request key and create
  new work.

Expected denials use the typed `OrchestratorMcpFailure` result:

```text
capability_denied
parent_not_active
provider_unavailable
model_unavailable
runtime_mode_escalation_denied
interaction_mode_escalation_denied
task_not_found
task_not_cancellable
thread_not_found
run_not_found
thread_not_sendable
thread_not_interruptible
invalid_request
orchestration_error
```

## Code Ownership

- Shared schemas: `packages/contracts/src/orchestratorMcp.ts` and
  `packages/contracts/src/threadMetadataMcp.ts`
- MCP services: `apps/server/src/mcp/OrchestratorMcpService.ts` and the focused
  `apps/server/src/mcp/ThreadMetadataMcpService.ts`
- Tool definitions and handlers:
  `apps/server/src/mcp/toolkits/orchestrator/`
- HTTP registration and authentication:
  `apps/server/src/mcp/McpHttpServer.ts`
- Credential lifecycle: `apps/server/src/mcp/McpSessionRegistry.ts`
- Provider injection:
  `apps/server/src/orchestration-v2/ProviderSessionManager.ts` and V2 adapters
- Durable delegated-task command and finalization:
  `apps/server/src/orchestration-v2/Orchestrator.ts`

## Verification

The integration test uses the real MCP toolkit registration, V2 orchestrator,
SQL persistence, event ingestion, projections, and checkpoints. Only the
external provider adapters are deterministic test implementations.

Coverage includes:

- capability discovery;
- cross-provider delegated completion;
- prompt-only child context;
- parent and child lineage projections;
- spawn and result context transfers;
- async status polling;
- cancellation;
- batch ordinary-thread creation;
- thread listing and timeline reads, including another project's threads;
- ordinary-thread send, wait, steering, and interruption;
- inheritance and per-thread provider overrides; and
- idempotent retries.

Provider adapter tests separately verify Codex, Claude, Cursor, Grok, and ACP
Registry behavior and MCP injection. The provider-session manager test verifies
that credentials exist before an adapter opens and are revoked when it closes.
