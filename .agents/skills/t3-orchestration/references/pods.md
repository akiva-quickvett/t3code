# Pods

## Containerised pods

A project with a `pod` block runs each worktree's `docker compose` stack in its own private Docker daemon, so any number of pods of that project run their full stack at once with unmodified ports and container names. Setup and limits are in the t3code user guide, `docs/user/pods.md`.

- A thread on a pod's worktree runs its provider session, terminals and scripts inside the pod, unless its role preset says `runsIn: host` (`review-t3-grok` does). `podRefusal` in `orchestrator_capabilities` says why a provider can't run there.
- `t3_pod_status` returns the pod's state and its services' URLs (hostnames in hostname mode, else host ports); a broker's result includes the web URL so the slice and Akiva can open the running feature. `t3_pod_stop` and `t3_pod_start` stop and restart a pod without deleting anything. A pod whose threads are all settled or snoozed stops, and starts again when one wakes.
- `docker compose`, `docker ps` and every project command run inside the pod; there `docker` talks to the pod's private daemon, never the host's. The pod's `.env` is templated and never committed.
- A pod runs with model, paid-provider and messaging keys blank or on fake backends unless Akiva approved real ones for that pod. Never print a key's value; check names only.
- Only the pod's worktree is visible inside it; the source checkout's working tree and other worktrees are not.
- **Signing in (steddyfunds.ai).** Every pod's Sign In page has a Dev Login tab with one-click accounts for the seeded users, labelled by role (Admin, Broker; `VITE_DEV_LOGIN_ACCOUNTS` in the pod's environment). Browser checks sign in there by label; agents never type credentials by hand, call auth APIs, mint tokens or edit rows to forge or bypass a session. Playwright e2e tests sign in through `frontend/e2e/helpers/login.ts`, which types the seeded `REACT_APP_*` credentials. A pod that needs another role (underwriter, admin support) adds a local test user for that pod only: create it (`docker compose exec backend python manage.py shell` with `User.objects.create_user(email=..., password=..., role=...)`, or extend `seed_test_users` on the pod branch if the feature needs it), append its entry to `VITE_DEV_LOGIN_ACCOUNTS` in the pod's own `.env` (never committed) and recreate the frontend (`docker compose up -d frontend`). A Playwright spec that signs in as that role reads its `REACT_APP_<ROLE>_EMAIL` and `_PASSWORD` from the same `.env`. The variable is local dev only: never set it for a staging or production build or service.

## Production access

Production is read-only for every agent: database queries inside a transaction-scoped `SET TRANSACTION READ ONLY` (check `SHOW transaction_read_only`; never a session-level SET, see pgbouncer below), logs, and GET-only APIs. The steddyfunds.ai database is Railway project brave-warmth, environment production, service Postgres, reached with `railway ssh --project <id> --environment production --service Postgres` (explicit flags matter outside a linked directory, and names may be refused). Railway has no read-only token, so read-only is by convention, not by credential: read-only transactions, and only read-only MCP tools and queries.

**Never make a shared production connection read-only (pgbouncer).** Production apps reach Postgres through pgbouncer in transaction pooling mode with no reset query, so a session-level setting sticks to a pooled server connection and is handed to app traffic.

1. Never run `SET default_transaction_read_only = on`, `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY` or any other plain `SET` (statement_timeout, search_path, ...) from a production Django shell or any client on the app `DATABASE_URL` (pgbouncer.railway.internal).
2. Read-only research: psql straight on the Postgres service (`railway ssh ... --service Postgres`, `psql "$DATABASE_URL"`), each query in `BEGIN; SET TRANSACTION READ ONLY; ... ROLLBACK`; in a Django shell, scope it to one transaction: `with transaction.atomic(): cursor.execute("SET TRANSACTION READ ONLY")` (or `SET LOCAL`).
3. No `.iterator()` or server-side cursors through pgbouncer ("cursor does not exist").
4. Briefs and research templates say this, never "every session read-only".

Why: on 2026-10-22 a research cell ran `SET default_transaction_read_only = on` in Django shells over railway ssh. Two pooled connections went read-only for ~47 min: ~120 API 500s, failed email-intake steps and lookups, and the LLM runner crashed. It cleared only when pgbouncer retired the connections.

The one exception is a BugBot one-off fix, approved by the authorized person and run once through the approval flow, with an audit record. No other agent writes to production, and no agent runs a fix script any other way. That flow is not ported to T3 yet ([Not ported yet](../SKILL.md#not-ported-yet)).
