# Pods

A pod runs a worktree's compose stack in a private Docker daemon, so several threads can each run
the full stack at once with its usual ports and container names. Every terminal and project script
on that worktree runs inside the pod; Git, diffs and checkpoints stay on your machine.

Pods need Docker on the machine running T3 Code. They are off until you turn them on.

For now only terminals and project scripts run in the pod; the agent itself still runs on your
machine, so a `docker compose` it runs reaches your own Docker, not the pod's.

## Set up a project

1. Turn on **Settings → General → Pods**, for the environment or one project.
2. Add a `pod` block to the project's `t3.json`:

```json
{
  "pod": {
    "compose": "docker-compose.yml",
    "services": { "web": 3000, "api": 8000 },
    "up": ["docker compose up -d --build"],
    "seeds": ["docker compose exec -T db psql -U app < /seeds/my-repo/dev.sql"],
    "env": { "APP_ENV": "development", "API_URL": "{api.url}" }
  }
}
```

`services` names the ports the stack serves inside the pod; the compose file must publish each one
on all addresses (`"3000:3000"`, not `"127.0.0.1:3000:3000"`). `up` and `seeds` run once, when the pod is created,
in the pod's agent container as you, so files they write stay yours; `up` defaults to
`docker compose up -d`. Seed files go in `~/pods/seeds/<repository folder name>/` and appear in the
pod at `/seeds/<repository folder name>/`. A pod whose creation is interrupted or fails runs `up`
and `seeds` again when you retry it, so write seeds that are safe to repeat.

The agent container's image must have the Docker CLI with its compose plugin; creating a pod checks
for it and says so if the image lacks it. The default, `docker:27-cli`, is minimal: it has no
`git`, no `bash` and no project toolchain, so terminals use `sh` and setup and teardown scripts that
need more fail. Set `podRuntime.defaultImage` in the server settings to an image with `git` and
whatever your scripts run.

`env` is set for every command in the pod and written to the worktree's `.env`, replacing those
variables and keeping the rest of the file; keep `.env` out of Git. A `.env` that is a symlink, as
some worktree setups make to share the main checkout's, becomes the worktree's own file, so the
shared one never gets this pod's addresses. In its values, `{web.url}` and
`{web.port}` become the `web` service's address and port on the machine running T3 Code. A
placeholder that names no service fails the pod and names the variable.

## Start a thread in a pod

In the composer, choose **New worktree**, then **Runtime → Container**. T3 Code creates the
worktree, starts its pod and brings the stack up before the setup script runs, which then runs in
the pod. The first pod pulls its images, which can take a few minutes.

## Manage a pod

The pod chip next to the thread title shows its state. Click it to stop or start the pod, open a
shell in it, recreate it, or remove it. Stopping keeps everything, and starting resumes the stack
as it was. **Recreate pod** deletes the stack's data and builds it again. The same actions are in
the command palette.

When starting or stopping fails, the chip shows the error and offers **Retry**. If Docker refuses
to remove a pod, **Remove anyway** forgets it; whatever Docker kept is then listed as an orphan.

**Settings → Diagnostics → Pods** lists every pod with its memory use, including orphans:
containers labelled for this T3 Code server that no pod owns. T3 Code never deletes orphans on its
own; remove them there.

## Open a pod's services

While a pod runs, each of its `services` is published on a port of the machine running T3 Code,
from 20000 up. Open one from the pod chip or from **Settings → Diagnostics → Pods**: it opens in a
browser tab of the thread, in the browser T3 Code runs on that machine, so it works from any device
you connect with. Running services also appear in the browser panel's list of local servers.

A service keeps its port through stop, start, recreate and T3 Code restarts, until the pod is
removed. If something else holds the port when the pod starts, the start fails and names the port:
free it, then **Retry**. Changes to `services` and `env` in `t3.json` take effect on **Recreate
pod**, which also writes `.env` again.

To reach the services from other tailnet devices directly, set `podRuntime.publishOnTailnet` to
`true` in the server settings. Pods created or recreated after that are also published on this
machine's tailnet address, which Diagnostics shows next to each service.

## Removing a pod's worktree

Removing the worktree, by deleting its thread or by storage cleanup, first runs the project's
teardown script in the pod, then removes the pod, then the worktree. If either step fails, the
worktree is kept: the notice offers **Retry**, then **Remove anyway**, which skips the script and
removes the pod even if Docker refuses. Storage cleanup removes only a pod's worktree whose pod you
stopped, and its results say why it kept the others. Once a pod is removed, its worktree's teardown
script no longer runs at all.
