# Pods

A pod runs a worktree's compose stack in a private Docker daemon, so several threads can each run
the full stack at once with its usual ports and container names. Every terminal and project script
on that worktree runs inside the pod; Git, diffs and checkpoints stay on your machine.

Pods need Docker on the machine running T3 Code. They are off until you turn them on.

Claude and Codex agents on a pod's worktree run in the pod too, with the same login as on your
machine, and keep the T3 Code tools. Other providers cannot run in a pod: a thread using one is
refused unless its role preset sets **Runs in → Host**, which runs it on your machine against the
same worktree (useful for read-only reviewers).

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
    "env": { "APP_ENV": "development" }
  }
}
```

`services` names the ports the stack serves. `up` and `seeds` run once, when the pod is created,
in the pod's agent container as you, so files they write stay yours; `up` defaults to
`docker compose up -d`. Seed files go in `~/pods/seeds/<repository folder name>/` and appear in the
pod at `/seeds/<repository folder name>/`. A pod whose creation is interrupted or fails runs `up`
and `seeds` again when you retry it, so write seeds that are safe to repeat.

The agent container's image must have the Docker CLI with its compose plugin; creating a pod checks
for it and says so if the image lacks it. The default, `docker:27-cli`, is minimal: it has no
`git`, no `bash` and no project toolchain, so terminals use `sh` and setup and teardown scripts that
need more fail. Set `podRuntime.defaultImage` in the server settings to an image with `git` and
whatever your scripts run. To run agents in the pod, the image also needs to run the Claude and
Codex CLIs: a glibc-based image (such as a Debian one) with them installed, or with the host's
binaries, which T3 Code mounts when the provider's binary path is absolute.

## Start a thread in a pod

In the composer, choose **New worktree**, then **Runtime → Container**. T3 Code creates the
worktree, starts its pod and brings the stack up before the setup script runs, which then runs in
the pod. The first pod pulls its images, which can take a few minutes.

## Manage a pod

Switching a pod thread to another account of the same provider works mid-thread. If the pod was
made before that account was enabled, T3 Code recreates the pod's agent container to add its
login; the stack keeps running, and other agents in the pod resume on their next turn.

The pod chip next to the thread title shows its state. Click it to stop or start the pod, open a
shell in it, recreate it, or remove it. Stopping keeps everything, and starting resumes the stack
as it was. **Recreate pod** deletes the stack's data and builds it again. The same actions are in
the command palette.

When starting or stopping fails, the chip shows the error and offers **Retry**. If Docker refuses
to remove a pod, **Remove anyway** forgets it; whatever Docker kept is then listed as an orphan.

**Settings → Diagnostics → Pods** lists every pod with its memory use, including orphans:
containers labelled for this T3 Code server that no pod owns. T3 Code never deletes orphans on its
own; remove them there.

## Removing a pod's worktree

Removing the worktree, by deleting its thread or by storage cleanup, first runs the project's
teardown script in the pod, then removes the pod, then the worktree. If either step fails, the
worktree is kept: the notice offers **Retry**, then **Remove anyway**, which skips the script and
removes the pod even if Docker refuses. Storage cleanup removes only a pod's worktree whose pod you
stopped, and its results say why it kept the others. Once a pod is removed, its worktree's teardown
script no longer runs at all.
