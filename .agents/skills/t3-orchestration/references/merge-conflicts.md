# Merge conflicts

Two kinds. A **trivial** conflict is version control only (import order, adjacent additions, moved lines): whoever meets it resolves it in place and moves on. A **subsystem** conflict is semantic: the two sides changed how a subsystem works. It goes to a resolving broker (a [merge broker](#merge-pods), or the live broker that owns the code) whose task names the conflicting branch and review tier 3, and the broker follows these steps in order.

1. **Agree the end state first.** The broker and the slice agree what the features finally do, through the normal channel, before any code changes. Akiva may have worked in the broker's thread directly without the slice knowing; the most recent input from Akiva wins. Raise only high-ROI concerns.
2. **Look for a simpler shape.** One `review-t3-grok` child (`review-t3` when it is unavailable) evaluates the PR's code paths for subsystems the other side introduced that would simplify them. Simplify when such a path makes sense; otherwise adapt the code to the new shape.
3. **Questions go through the governor.** Any question meant for Akiva goes to a `governor` child first ([Governor cell](escalation.md#governor-cell)). It answers from the information available when it can do so confidently; only what it cannot decide moves up the chain.
4. **Tier 3 review** of the changed code paths, before and after ([Tier 3](review.md#tier-3-review); its runs per [Testing](testing.md#testing)).
5. **Report spec changes.** Any code path that changes the spec in a significant way goes in a report: in the broker's result, then the PR body.
6. **Deliver as a PR into the conflicting branch.** The resolution lives on the resolving broker's own branch and reaches the conflicting branch only through a PR into it, never a push onto it. That PR is opened ready, not draft (the draft rule covers only the slice's PR into `<base>`). Simple merge (no code path changed beyond merging code structures): the PR may be merged once it is open; lint and tests do not gate it. Behaviour changes: Akiva reviews and approves the resolution branch first, via the escalation chain.
7. **History rewriting.** When a rebase or another history-altering strategy is the right one, still push the resolution branch and open the PR, with a comment that the rebase is the actual merge strategy, so Akiva can inspect the resolution if something goes wrong.

## Merge pods

A merge broker is a broker whose feature is reconciling other brokers' work. Use one whenever merging a pod branch into the slice branch produces conflicts that are more than mechanical, or when two brokers in the same stage are known to overlap.

- The slice delegates it like any broker, from `origin/<slice-branch>`, named for what it reconciles: branch `pod/<goal>-merge-<a>-<b>`.
- Its task: merge `origin/pod/<goal>-<a>` and `origin/pod/<goal>-<b>` (or whichever branches are named) into its own branch, resolve every conflict so both features work as specified, push, and end with its result per the honesty rule. It owns only the conflict; it does not extend either feature. If the two branches made incompatible design choices, it asks the slice with the options, and the slice decides.
- The slice then merges the merge broker's branch into the slice branch with the normal `--no-ff` merge, which is now clean, and settles all three brokers with `scope: "tree"`, so their pods stop.
- The slice itself resolves conflicts in its worktree only when they are trivial. Anything requiring judgment about behaviour goes to a merge broker; the slice is a manager, not an implementor.
- A subsystem conflict follows [Merge conflicts](#merge-conflicts).
