# Code review

Review runs at the pod's tier: nothing runs beyond what the tier says. Tiers 0-5; each inherits the guidance of the tiers below it. The implementor always has the final say: the reviewer reasons with it and may be overridden. The implementor states why, the broker lists each override in its result, and the slice records them in the PR body. Lower tiers are less authoritative, so the implementor may disagree with them more readily. Reviewers flag high-ROI issues; no nits unless they hurt readability. A handoff's `Emphasis` line names task-specific focus (e.g. "state updates must not reset the canvas"). Round caps and declining a finding: [Review loops](../SKILL.md#review-loops).

## Choosing the tier

The tier comes from Akiva, via meta in the slice handoff, via the slice in each broker handoff. When none was given, the slice picks one per broker from the task's complexity and risk and names it in the handoff; it never overrides an explicit tier. Tiers 4 and 5 only on Akiva's explicit request.

## Reviewer set (tiers 1-3)

Tiers 1-3 run the same pair together, on one brief that carries the adversarial focus and the checklist. Each round is one reviewer set round carrying that tier's pass (tier 2: scouts on the code paths; tier 3: UI, risk and failure points through scouts). The broker runs the pass's scouts once and shares the results with every member.

| Member   | Preset                                                                                                            | Runs                                           |
| -------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| first    | `review-t3`                                                                                                       | every round                                    |
| second   | `review-t3-grok`, labelled "Reviewer (tier 3, second)"; Opus 5.5 by default, an environment layer may retarget it | every round it is available                    |
| fallback | `review-t1`                                                                                                       | the second's slot, only when the second is out |

The preset picks the model only; the task's `Review tier` is the pod's. The implementor's model does not change.

1. Before each round, read `review-t3-grok` in `orchestrator_capabilities` → `rolePresets`. An `unavailableReason`, its provider's `headroom` not `ok`, or a failed delegate means it is out for that round: `review-t1` takes its slot on the same brief, and the result says which members ran. Never wait for it.
2. The brief stays adversarial for every member, whoever fills the second slot.
3. The broker merges and de-duplicates the findings before routing them to the implementor.
4. Severity is high, med or low. A round with nothing above low ends the whole review: the implementor fixes the lows with no re-review.
5. The `review-t3-council` organ preset is this set plus two scouts ([Organs](../SKILL.md#organs)).

## Checklist (every tier)

- Simplicity, DRY, genericization, [Code style](code-style.md#code-style): flag AI-slop verbosity.
- Genericize repeats: when the same small pattern repeats across new code (e.g. an inline plural ternary, a bytes-to-MB formatter), extract one generic, simple helper in the shared utils instead of repeating it; don't extract one-off uses, and leave pre-existing repeats alone unless touched.
- Frontend: no needless re-renders; use the existing libraries and frameworks, not hand-rolled solutions.
- Reuse existing subsystems; a domain-named one (e.g. `PlaidMagicLinks`) may deserve a generic extension instead of a parallel copy.
- Side-effect analysis: trace what else reads, writes, or depends on the touched code (callers, status sets, hooks, tasks, frontend consumers, tests, migrations), including required follow-on changes, races, and anything that argues against the change. It applies to review findings before they are applied, not only to the original code. Write a note listing each as handled or knowingly accepted. Side effects are not blockers; they must be known, not discovered later.
- Clean code: no dead code, leftovers, debug output, or unused dependencies. Lint-only findings are left to the lint run ([Testing](testing.md#testing)).
- Input sanitizing at the boundary: validate or normalize every user and LLM-produced value (structured outputs, extracted fields, tool-call arguments, classifier labels) before it reaches the DB, an external API, a file path, a shell, HTML, or money math. User input is strict: reject with a clear message. LLM output is untrusted but handled permissively: auto-fix rather than reject (strip, normalize types, map near-miss enums, drop unknown keys, fall back to a default or null, retry once on a schema mismatch such as the model echoing the schema), log what was repaired, and fail only when a required value cannot be recovered; then fail that item, not the whole batch or thread. Repair fixes shape only: it never loosens the path, shell, HTML, or money checks, and a money value is never defaulted.
- Code design: think like a framework or library author (the C# platform mindset, written idiomatically for the language at hand). Prefer data-driven, dynamic execution: enum-keyed objects whose sub-objects define each variant's behaviour, factories, generic and derived types. Avoid magic objects unless they earn their place. This pays off most in large projects and shared subsystems; for a small, isolated change, flag missing structure only where it will clearly be reused.
- One source of truth: no duplicated state computation or hand-kept copies; derive inverse maps and lists at runtime. The backend owns business logic and defaults; the frontend renders what it is given.
- Computed over stored state: store the minimum that cannot drift (e.g. the last step, not the current one) and compute the rest, so state stays serializable, resumable, and self-correcting.
- UI captures: no screenshot may be presented as current if its sources changed since it was taken.
- Frontend animation is CSS-first; when JS is needed it only drives CSS variables, the way a CPU feeds a shader its uniforms.

## Tier 0 Review

No review. The implementor's result, with the honesty rule ([Testing](testing.md#testing)), is the bar.

Agents:

- none beyond the implementor

## Tier 1 Review

The general code review; nearly everything in flight should use it. The implementor and the reviewers go back and forth until they reach consensus. The implementor can still override a reviewer if it feels strongly enough.

Agents:

- implementor: writes the code, answers each finding, has the final say
- the [reviewer set](#reviewer-set-tiers-1-3): reasons with the implementor, never edits code

Capabilities:

- diffs against the target, figures out what changed and what the task's scope is
- receives the big picture context, since it may impact the design
- runs the whole [checklist](#checklist-every-tier)

Guidance:

- focus on making the changes simple. Flag AI slop: verbose code, ignoring DRY, bad genericization, not following Code style
- for frontend code, no re-renders. Use the existing libraries and frameworks instead of hand-rolling
- tiers 2 and 3 add their pass to each reviewer set round; tier 4 keeps this checklist in flight through its general reviewer; tier 5 runs a reviewer set round first

## Tier 2 Review

Now the code paths are exercised, not just read.

Agents:

- implementor
- the reviewer set: each round carries the tier 2 pass
- scouts: run the code paths and fixtures the reviewers ask for

Capabilities:

- leverages scouts or code fixtures to exercise the code paths
- can write benchmarking fixtures for the hot paths

Guidance:

- evaluate the hot paths. Make sure they are performant, don't cause re-renders, and make sense in general
- confirm each side effect is handled or knowingly accepted, by a scout or fixture where practical, not just by reading. This confirmation applies to every tier 2 and above, even when a higher tier skips running tier 2 itself

## Tier 3 Review

More emphasis on UI, and the risk points and failure points are evaluated.

Agents:

- implementor
- the reviewer set: each round carries the tier 3 pass
- scouts: as in tier 2, for side-effect confirmation and UI checks

What runs: reviewer set rounds with the tier 3 pass. Tier 2's pass doesn't run, only its side-effect confirmation.

Capabilities:

- everything from tier 1 and the tier 2 side-effect confirmation
- drives the UI through scouts (T3's preview tools, or a headless browser in a pod) where the change has one

Guidance:

- look for risk points, failure points, and big picture conflicts with the rest of the system
- every member stays adversarial, as at every tier; it still reasons with the implementor and doesn't outrank it

## Tier 4 Review

A bit more effort than tier 3, adding a socratic reviewer. Only when Akiva asks for it.

Agents:

- implementor
- general reviewer (`review-t4`): runs the tier 1 loop and the tier 4 pass
- socratic reviewer (a second `review-t4`, told it is socratic)
- scouts: as in tier 2

What runs: tier 1 in flight; once the implementor and the reviewer reach consensus, jump straight to tier 4. Tiers 2 and 3 don't run. Since the lower steps aren't as high quality, the implementor can disagree with their decisions more readily.

Capabilities:

- everything from the tiers below, including side-effect confirmation
- the socratic reviewer only asks questions; it doesn't file fixes

Guidance:

- the socratic reviewer asks questions to figure out how to make the code better, and whether things can be simpler
- the general reviewer folds the answers into its findings

## Tier 5 Review

The heaviest review. Only when Akiva asks for it.

Agents:

- implementor
- test planner (`review-t5`): writes the full testing plan first
- council of three `review-t5`: general, adversarial and socratic
- scouts: run the test plan and the side-effect confirmation

What runs: the test plan, then a passing tier 3 round (the reviewer set, whose handoff says `Review tier: 3`), then the council. Tier 2 is skipped.

Capabilities:

- part 1 is the testing plan
- part 2 is the council review

Guidance:

- the council reviews the other reviewers' work before evaluating the implementor's, to check whether each critique was valid or the implementor's approach was better
- each council member keeps its own lens: the general one runs the checklist, the adversarial one tries to break it, the socratic one asks how it could be simpler

Tiers 1-3 (and tier 5's tier 3 step) run the reviewer set; tiers 4-5 otherwise run the cells they name.
