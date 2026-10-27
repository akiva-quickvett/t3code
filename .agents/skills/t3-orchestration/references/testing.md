# Testing

The goal is to limit blocking unit testing, which saves CPU and wall time, and to keep each pod's iteration rate high. Lint and unit tests are delegated to scouts at every level (implementor, broker, merge broker, slice), never run inline. Suites the repository's cloud CI covers run there, and scouts skip them. The one blocking run is at the gate: [Testing](../SKILL.md#testing).

- **Test split.** Code and tests are written by different cells. (On STE-342, implementors spent 41h, 33% of their working time, on tests and builds.)
  1. Code implementors write no tests and run no suites; a few targeted checks to learn behaviour are fine (2 workers).
  2. Test-implementors ([below](#test-implementor-cell), up to 3 per pod) write the unit tests and fixtures, covering every reasonable scenario. They edit only test paths, in commits separate from code; any other change goes back to the code implementor.
  3. When a subsystem is ready to test, the code implementor sends the broker an aman-style brief for it with `t3_thread_send`: key details, assumptions and micro-decisions from its own context, focus areas. Not the test cases: the test-implementor reads the same code. The broker delegates a test-implementor with that brief verbatim.
  4. Scouts, not code implementors, run suites: async, failures only.
  5. The broker routes each failure: test wrong → the test-implementor that wrote it; code wrong → the code implementor; unclear → the test-implementor, which says which.
  6. A broker task says `Tests: none` when nothing in it is worth a unit test (prose, config); then no test-implementor runs.
- **Tests never gate iteration.** The implementor keeps building, and the tier review loop runs as normal. Reviewers review the code and the tests' content, and never hold a round because tests have not run yet. A failing or incomplete test area does not stall the pod: it goes to a test-implementor, or the broker asks the slice for a separate test-fix broker, which works in parallel under the normal pod rules.
- **Targeted, at most 2 workers.** Every local run names the exact files, modules or test ids that cover the change (`pytest backend/apps/x/tests/test_y.py::TestZ`, `vp test run src/foo/bar.test.ts`), never a whole app or the whole suite "to be safe". A task to a test-implementor or scout lists those targets. Every local run uses at most 2 workers:

  | Runner                         | Cap                             |
  | ------------------------------ | ------------------------------- |
  | pytest                         | `-n 2`, never `-n auto`         |
  | vitest, `vp test run`          | `--maxWorkers=2 --minWorkers=1` |
  | jest                           | `--maxWorkers=2`                |
  | Django `test`                  | `--parallel 2`                  |
  | Playwright (local passes only) | `--workers=2`                   |
  | `python -m unittest`           | one process                     |

  If a repo's config or script sets more workers, override it on the command line; never edit the repo's config for it.

- **Background scout runs.** A lint or test run is a `delegate_task` to a scout (or a follow-up to an idle one). Work continues while it runs (implementation, review, rebase, commit, push, the next step). The scout ends its turn with the failures, and the broker routes them per Test split for the next push. Several scouts may run independent targets concurrently and alongside review; runs that share a DB, port, or build output run one after another. A failing scout run gates no result, no merge, and no rebase (a rebase is clean when its conflicts are resolved). If an issue turns up after the PR merged, fix it in another PR: that is the accepted path, not an incident.
- **Scratch space.** Write scratch and test output under `$TMPDIR` when it is set, never into the repository; a shared `/tmp` (a tmpfs on Akiva's omarchy host) fills up from per-run build directories.
- **Browser runs stay local.** Screenshots and dev-server passes run in the worktree or its pod, one browser run at a time on the host.
- **Lint last, preferred.** Code first. Lint and format run once at the end, by a scout with auto-fix, whose fixes the broker commits on the pod branch. In a multi-broker slice, the slice sends one live broker that follow-up after the brokers are merged; it rebases onto the slice branch and then lints. The lint commit may land after the slice's result, after the PR is ready, or as a follow-up PR. No lint or auto-format after each change, commit, review round, rebase, or conflict step. Implementors do not lint while working, and reviewers do not reopen a round over lint-only findings.
- **Honesty rule.** Every result and the PR body say plainly what did and did not run on the tip (with links where CI ran), and the result.

## Test-implementor cell

Writes the pod's unit tests and fixtures ([Test split](#testing)). Up to 3 live per pod, delegated by the broker one per subsystem brief, in the broker's checkout.

- Works from the brief in its task, and from the code itself; covers every reasonable scenario, not just the ones the brief names. A question about the code goes to the broker.
- Edits only test paths and fixtures. A change anywhere else goes back to the code implementor: ask the broker with the failing case.
- Runs only the targets it writes, at most 2 workers; full suites run on scouts or CI.
- Triages the failures routed to it: fixes a wrong test, or tells the broker the code is wrong.
- Follows [Code style](code-style.md#code-style). Does not commit. Ends its turn with the tests added and how to run them.
