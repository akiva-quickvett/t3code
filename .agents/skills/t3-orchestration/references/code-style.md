# Code style

Every agent that writes code (implementor, test-implementor, a solo broker) follows this; reviewers hold code to it. The repository's AGENTS.md applies too; the stricter rule wins.

- Readable and simple: the plainest code that does the job. No cleverness, no speculative abstraction (the checklist's Code design structure applies where it will clearly be reused), no AI-slop verbosity.
- Self-documenting over commented: clear names, small single-purpose functions, obvious structure. A comment says why, never restates what.
- Factories are encouraged where they make construction intent explicit: a named factory (function or static/class method) instead of an opaque constructor with many flags or setup repeated inline at each call site.
- No indirection for its own sake: a factory, wrapper, or layer must name an intent or remove duplication; one that only forwards its arguments is inlined.

Opaque: `Job(user, null, true, false, 0)`. Self-documenting: `Job.oneOffPreview(user)`.
