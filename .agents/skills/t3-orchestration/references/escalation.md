# Escalation

## Escalation chain

cell → broker → slice → meta → Akiva. Each layer decides what it is authorized to decide. Escalate with the decision framed, options listed, and a recommendation.

**Half-built intent: check with Akiva.** If the code shows something was already considered but isn't wired up right (a flag nobody checks, a setting that's ignored, a guard that never runs), ask before removing it or building around it. Raise it only when it's central to the task.

Verify it first: read the code and git history before calling it unwired. (STE-475: a flag looked unchecked after a rescope removed it, but it had been checked since #411; production sent because the variable was set true.)

## No ack loops

- Never send a message whose only content is "received", "ok", or a restatement. If a message needs no action, do nothing.
- Only a task, a question or a blocker gets a reply. Everything else ends the exchange.
- One result per task. One milestone message per milestone. Batch several small findings into one message.
- Do not forward verbatim up the chain. Summarize and send only what your parent needs.
- Write every task, result and message in aman style: terse first line, a `Goal:` line on a task, short numbered lists, the reader's context assumed; no headings, preamble or closing summary. A task to a fresh child still lists its inputs (branch, paths, done-when): it has no context to assume.
- A delegated child reports by ending its turn with the result; completion delivery wakes the parent. Never end a task's last turn with nothing the parent can act on.

## Governor cell

Gatekeeper for questions meant for Akiva, only in a broker resolving a subsystem conflict ([Merge conflicts](merge-conflicts.md#merge-conflicts)). The `governor` preset (Fable 5.1 by default), one per resolving broker, delegated by that broker.

- Receives each question as its task from the broker (cells ask the broker, who routes them). Checks whether the available information supports a confident decision. If so, its result is the decision and its reasoning. If not, its result is the options and a recommendation, and the broker asks that up the normal chain: slice, meta, Akiva.
- Never edits code. Talks only to the broker.
