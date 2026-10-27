# Planning

## Parallelization plan

The slice's first job on any goal is a plan that gets as many brokers working at once as the dependency structure allows. Before cutting anything, decompose the goal into stages:

- **Stage 0, foundation.** Framework-type work the rest depends on: architecture, data model and migrations, shared interfaces and types, base classes, API contracts, scaffolding, shared utilities. This is the code other brokers build _against_. Often one broker, occasionally two or three if the groundwork splits cleanly (e.g. backend schema and frontend design-system primitives).
- **Stage 1..n, features.** Everything that builds on the foundation. Each stage holds as many brokers as there are independent deliverables; a stage only exists because its brokers need something from an earlier stage merged first. Most goals have one feature stage; use more only when a feature depends on another feature's code, not just on the foundation.
- **Final stage, integration** when needed: wiring, end-to-end flows, docs, cleanup that touches everything.

Rules for the plan:

- Within a stage, every broker runs to its result without waiting on another. There is no limit on the number of brokers in a stage; the limit is ownership, not count.
- Across stages, the dependency is code merged into the slice branch. Stage k+1 brokers are delegated only after every stage k broker they depend on has been merged and pushed, so their worktrees start from the foundation they need. Brokers that depend on only part of a stage may start as soon as that part lands.
- Do not wait to start the foundation. Delegate stage 0 within your first turns; use the time it runs to write the stage 1 handoffs, and hand stage 1 brokers a precise contract (the foundation's signatures, endpoints, schema) rather than a description.
- Write the plan as a list of stages, each broker with its deliverable, size in points, owned files, contract at its edges, and the brokers it depends on. Send it to meta once with `t3_thread_send`, and again when reality changes the cut.

## Designating pods

Maximize parallelism. Every broker should be able to run to its result without waiting on another broker in the same stage.

- Cut along ownership boundaries, not task lists: a broker owns a set of files/modules and one deliverable in one repository. Two brokers that would edit the same files are one broker, or they are in different stages, or the overlap is accepted and a [merge broker](merge-conflicts.md#merge-pods) resolves it. A multi-repo goal gets separate brokers per repository; the slice carries the cross-repo contract.
- Cut by deliverable, not by size: a large deliverable stays one broker with more implementors ([Pod broker](#pod-broker)), not several brokers. Delegate a whole stage at once when its inputs are ready.
- Size each broker in points in the plan (Linear estimate: 1 2 3 5 8 13 21): under 5 is a solo pod; at 13+ its broker may propose 2 implementors, at 21+ 3.
- **Solo pods.** The broker writes the code itself, on the implementor's rules, and delegates no implementor. It keeps its commit and push authority and its other children: scouts, test-implementors and reviewers. Its handoff is the broker one plus "you write the code yourself; spawn no implementor". (Brokers were 35.8% of STE-342's active time.)
- Each broker's handoff names the repository, its stage, the files it owns, what it builds on from earlier stages, and the contract it must honor at its edges (function signatures, API shape, schema) so brokers can build against each other without talking to each other.
- Name brokers by deliverable (`email-parser`, `email-ui`), not by layer or by person.

Conflicts between brokers are acceptable and are not a reason to serialize work. If two brokers would touch adjacent code and separating them would cost more parallelism than the conflict is worth, run them in parallel anyway and plan a merge broker for the result.

## Pod broker

The broker is the pod's head: it owns one feature end to end, routes every cell's question and result, and decides what the slice needs to hear. Cells never learn the slice's identity. Its role rules are in [broker](../SKILL.md#broker); these are the large-pod and solo details.

- **Solo.** Without an implementor you write the code yourself: the implementor's code rules and the Test split apply ([Testing](testing.md#testing)), and you delegate each test brief yourself.
- **Multiple implementors.** At 13+ points propose 2 implementors, at 21+ 3, to the slice (a question with the split); delegate them once it approves.
  1. Plan which implementor owns which features and files/modules. Shared files (models, migrations, routes, types) get one owner.
  2. Before they start, write the interfaces between them in `CONTRACTS.md`, commit and push it on the pod branch (their worktrees start from `origin/pod/<goal>-<feature>`), and remove it in your last commit before your result.
  3. Each implementor gets its own worktree: `delegate_task` with `isolation: "worktree"`, `branch: "pod/<goal>-<feature>.wt<n>"`, `baseRef: "origin/pod/<goal>-<feature>"`. Commit its work there and merge it into the pod branch (`--no-ff` or rebase, never squash). It sends a subsystem's test brief only once that is merged.
  4. Test-implementors work in your checkout. Before merging a `.wt<n>` branch, commit your checkout's work and the pending tests in separate commits; merge only while the test-implementors are idle, and name what landed in your next task to them. After each merge, merge the pod branch into every other implementor's branch while its implementor is idle.
  5. Conflicts between implementors come to you as questions; your answer is final. Product calls go to the slice.
- Keep the implementors, test-implementors and reviewers between rounds and reuse them with follow-ups rather than delegating new ones. Scouts live only while a stage needs them.

## Cross-pod coordination

Brokers never talk to each other. All coordination is routed through the slice:

- A broker that needs something another broker owns asks the slice. The slice answers from what it knows, or sends the owning broker a follow-up, then answers with the result.
- A broker that changes a shared contract tells the slice with one `t3_thread_send`; the slice decides which other brokers need a follow-up to adapt.
- The slice keeps the dependency picture. If two brokers keep needing each other, the slice merges them, re-cuts the boundary, or lets both finish and reconciles with a merge broker, whichever loses the least parallelism.

## Cross-slice coordination

Slices are independent by default and merge first-come-first-served; the later PR rebases onto the base branch after the earlier one lands. Meta is the only agent that sees all goals, so it owns dependencies between them:

- When two goals interact (slice A refactors a module slice B's feature will use), send both a follow-up naming the dependency and the merge order: A lands first; B builds as far as it can independently and adapts to A's pattern rather than the old one.
- Slices never talk to each other. Meta relays what changes scope or order, and answers what it can from both sides.

## Merging and upstreaming

- On a broker's result: in the slice worktree, `git fetch origin && git merge --no-ff origin/pod/<goal>-<feature>`, `git push`, and have the checks run on a live broker's scouts, non-blocking ([Testing](testing.md#testing)). Trivial conflicts are resolved there; non-trivial ones are aborted (`git merge --abort`) and handed to a [merge broker](merge-conflicts.md#merge-pods), whose branch is merged instead. Only the slice touches the slice branch; nobody touches the base branch.
- A merged stage unblocks the next: as soon as the last broker a stage k+1 broker depends on is merged and pushed, delegate that broker. Do not hold a stage until every broker of the previous stage lands if the dependency is only partial.
- After every merge, send each live broker whose files or contracts are affected a rebase follow-up (`t3_thread_send`): rebase onto the slice branch, resolve conflicts, scouts rerun its checks in the background, report when the rebase is clean. Brokers not affected are left alone. Each follow-up wakes you when it ends ([Wakes](../SKILL.md#wakes)).
- Long-running brokers receive this follow-up after every merge so they never drift far from the slice branch; the last broker to land should have a trivial merge.
- The base branch is folded in only when the PR conflicts with it (`gh pr view --json mergeable`) or Akiva asks: `git fetch origin && git rebase origin/<base>` in the slice worktree, `git push --force-with-lease`, then a rebase follow-up to every live broker. Base changes reach brokers through the slice branch, never directly. If that rebase conflicts on already-merged broker code, send a live broker the resolution (delegate a small broker only if none is live) rather than editing in the slice worktree; a subsystem conflict follows [Merge conflicts](merge-conflicts.md#merge-conflicts).
- Broker lifetime. A single-broker slice keeps that broker, cells included (idle scouts excepted), until the merge. Review comments, CI fixes, and rebases go to it as follow-ups, so its context and running stack are reused. In a multi-broker slice, settle each broker (`t3_thread_organize({threadId, action: "settle", scope: "tree"})`, so its pod stops) once it is merged and no other broker's work depends on it, but keep the last live broker for follow-ups. Never re-delegate a broker just to start from a clean branch; send it a rebase follow-up instead.
