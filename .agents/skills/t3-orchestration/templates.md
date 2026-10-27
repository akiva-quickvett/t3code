# Handoff templates

The handoff is the `message` of `t3_thread_launch`, the `task` of `delegate_task`, or the `goal` of `start_organ`. Fill every `<...>`. The preset already tells the child its role and points it to the skill, so a handoff carries only the work. A child starts with no copy of your conversation: put everything it needs in the handoff. Aman style: a `Goal:` line, inputs (branch, paths, done-when) as a short list, rules by skill section, not restated.

## Common footer (all roles)

```
Report up by ending your turn with your result; for a milestone mid-work, one t3_thread_send to me. Ask with your ask-the-user tool when you need a decision. Do not ack. Never poll or sleep: delegate async and end your turn.
```

## slice (meta, `t3_thread_launch`)

```
Goal: <TICKET or label>: <one-line title>. Repository: <owner/name>, base <base>. Slice branch: <slice-branch> (this thread's worktree).
Request: <what Akiva asked for, in full, with acceptance criteria>.
Review tier: <0-5, or "unspecified": pick each broker's tier from its complexity and risk>.
<if related goal> Related: <other slice> is <relationship>; merge order <...>. Ask me, not it.
<if no features.supervisedWakes> Meta thread: <threadId>. Report results and questions with t3_thread_send to it.
<if auto-merge applies> Auto-merge: yes, into <base>, once review is clean and the gate passed.
Open the draft PR, link and watch it, plan, then delegate stage 0. Check t3_usage_limits before each broker.
<common footer>
```

## broker (slice, `delegate_task`)

```
Goal: <feature, one line>.

1. Repository <owner/name>. Branch pod/<goal>-<feature> from origin/<slice-branch>.
2. Feature: <description and acceptance criteria>. Size: <points>.
3. Stage <0 foundation | n feature | integration>. Builds on: <signatures, endpoints, schema already merged, or "nothing, you are the foundation">.
4. Owns: <files/modules>. Contracts: <at the edges>. Other brokers exist; ask me for anything outside your ownership.
5. Review tier <0-5>. Emphasis: <focus, or none>.
6. Tests: <default (Test split) | none>. Gate run: <the PR's CI | one scout run of <packages>' full suites, 2 workers>.
7. <if resolving a subsystem conflict> Conflicting branch: <branch>. Agreed end state: <...>. Follow Merge conflicts.
8. <if solo> You write the code yourself; spawn no implementor.
9. <if design locks> Design: <pause each lock for Akiva | autonomous run approved; decision log at <path>>.
Commit and push the pod branch yourself; do not merge.
<common footer>
```

## implementor (broker)

```
Goal: <feature, one line>.

1. Worktree <path>. <several implementors> Own worktree on pod/<goal>-<feature>.wt<n>; contracts in CONTRACTS.md; the others own <...>.
2. Feature: <description>. Owns: <files/areas>. Done when: <acceptance criteria>.
Code only: no tests, no suites. Each subsystem ready to test: t3_thread_send me its brief (key details, assumptions, micro-decisions, focus areas). Do not commit. End your turn with what you changed and what you ran.
<common footer>
```

## test-implementor (broker, one per subsystem brief)

```
Goal: tests for <subsystem> of <feature>.

1. Worktree <path>. Code owner: <implementor thread>.
2. Brief: <the implementor's brief, verbatim>.
3. Test paths: <dirs/globs you may edit>. Run with: <runner, 2 workers>.
Tests and fixtures only, every reasonable scenario. Anything outside test paths: ask me with the failing case. Do not commit. End your turn with the tests added and how to run them.
<common footer>
```

## scout (broker)

```
<Run: <exact test or lint targets>, at most 2 workers. | Check: <integration instructions, URL, account role>. | Capture: <flows and states>, with preview_open, preview_resize and preview_snapshot; save under <dir>.>
Return distilled results: what ran, what you skipped, each failure with its output; no output for what passed.
<common footer>
```

## research (broker or planning slice)

```
Investigate: <question or area>. Constraints: <...>. End with options, trade-offs and a ranked recommendation.
<common footer>
```

## designer (broker or slice, usually the `design` organ)

Round 1 is this brief as the `start_organ` goal. Round 2 is one `delegate_task` per designer with `organ: {id: <organId>, round: 2}`: this brief, plus the other designer's draft to critique; the decider's task adds the last line.

```
Goal: <what must be designed, one line>.

1. Inputs: <spec, code paths, constraints, mockups>.
2. Locks to decide: <list>.
3. Mode: <pause each lock for Akiva | autonomous run approved: decide each lock, log it to <decision log path>>.
For each lock: options, decision, rejected alternatives and why, side-effect note, dependent tasks.
<round 2> Other designer's draft: <draft>. Critique it against yours. <decider only> You decide; produce the one result.
<common footer>
```

## review-t1 … review-t5, review-t3-grok (broker, one `delegate_task` per reviewer per round)

```
Review tier <n>, round <k> of <cap>. Run git diff origin/<slice-branch> in <worktree> (working tree, uncommitted changes included). Task scope: <what the feature is meant to do>. Emphasis: <focus, or none>.
<tiers 4-5> Your part: <general | socratic | test planner | council: general, adversarial or socratic>. Tiers 1-3, every member: adversarial focus and the checklist; run tier 1 plus the pass of tier <n> (review-t1); the preset picks your model only. No nits unless they hurt readability.
<round 2+> Prior findings: <list>. Implementor's answers and declines (one-line reasons): <list>. Still open: <list>.
<merge conflict> Review the changed code paths before and after the resolution.
<common footer>
```

## Organ start brief

The `goal` of `start_organ({presetId, goal, cells?, clientRequestId})`. Every cell gets the whole goal through the preset's goal template; the first 500 characters label the organ. Cells that need a different part (a council's lenses) are added with their own task: `delegate_task` with `organ: {id: <organId>, round: 1}`.

```
<one-line summary of the organ's goal, under 500 characters>

1. Worktree <path>. Branch <branch>. <round 1 of <cap>, for review or council organs>
2. Inputs: <brief, diff range, spec, paths>. Done when: <...>.
3. <role-specific lines from that role's template above>
<common footer>
```

## Round brief

The `task` of each next-round cell: `delegate_task({preset: <role>, task, mode: "async", clientRequestId: <organ>-r<k>-<n>, organ: {id: <organId>, round: <k>}})`, the same `round` on every cell of the round.

```
<one-line summary>. Round <k> of <cap> of organ <organId>.

1. Original brief: <the round 1 brief, in full>.
2. Prior findings: <list>. Answers and declines (one-line reasons): <list>. Still open: <list>.
3. Changed since round <k-1>: <commit range or summary>.
4. <at the cap> Last round: the <broker | slice> decides what stays open.
<common footer>
```

## governor (broker, merge conflicts only)

```
Conflicting branch: <branch>. Agreed end state: <what the features finally do>.
Question: <one question meant for Akiva, with the facts you have>.
<common footer>
```

## ticket (anyone, a fresh `delegate_task` per ticket)

```
<File | Comment on <STE-n> | Attach <PR url> to <STE-n>>: <content, or the facts to write up>. Screenshots: <paths, or none>. Labels/priority/assignee: <or defaults>.
End with every Linear id and URL you created or touched.
```

## investigator (bugbot, one per issue)

```
Issue: <ISSUE> (<link>). Report: <summary, with attachment paths>. Worktree: this one, from origin/staging; never push.
End with the root cause, the repository the fix belongs in, the bugfix task link and a 3-5 line summary for the person.
<common footer>
```
