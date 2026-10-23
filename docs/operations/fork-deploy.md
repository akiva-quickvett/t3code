# Fork deploy

How a fork build reaches omarchy's live server (`:8443`, tmux session `t3code`, state in
`~/.t3/userdata`): verify it on a canary, then swap it in with a detached script that rolls
back on its own. The scripts are in [`scripts/fork-deploy`](../../scripts/fork-deploy).

## Builds

A build is a checkout of the fork at the build's commit with `vp i` run and the
Mac-built `apps/server/dist` copied in:

```sh
git -C ~/projects/t3code worktree add --detach ~/t3-builds/<id> <commit>
cd ~/t3-builds/<id> && vp i
# from the Mac: vp run --filter @t3tools/web build && vp run --filter t3 build,
# then copy apps/server/dist into ~/t3-builds/<id>/apps/server/dist
```

The bundle keeps native and Cursor packages external (`scripts/lib/cli-external-packages.ts`),
so `bin.mjs` needs the `node_modules` of a checkout beside it. Node resolves them from the
build's real path, which is why `~/t3-builds/current` can be a plain symlink to a build
directory and rollback is a symlink flip. Before the first swap there is no `current`: the
live build is `~/projects/t3code` itself, and rollback returns to it.

## Canary

```sh
scripts/fork-deploy/canary.sh ~/t3-builds/<id> [--projects N] [--threads-per-project N] [--with-secrets]
```

It runs the build's `migrate-dev-db` into `~/.t3-canary` from a read-only snapshot of the live
database, which drops scheduled tasks, pending effects, sessions and auth, so the canary
resumes no live work. It then serves the build on `:8450` in tmux session `t3code-canary`.
Secrets are copied only with `--with-secrets`, when a provider flow is under test. Pair a
browser with `node ~/t3-builds/<id>/apps/server/dist/bin.mjs pair --base-dir ~/.t3-canary`.

A `migrate-dev-db` canary lacks live threads (often the metas) and its threads point at live worktrees: verify on new threads in a scratch project; never message copied threads; raise `--projects/--threads-per-project` to include the metas' home project.

## Swap

Never run the swap from a T3 turn hosted on the server it swaps. Run it from a plain shell
on omarchy (ssh, or a tmux session other than `t3code`). The `t3code` session must have a
single pane, since the scripts stop and start the server by typing into it:

```sh
scripts/fork-deploy/swap.sh ~/t3-builds/<id> --dry-run   # print every step
scripts/fork-deploy/swap.sh ~/t3-builds/<id>
```

It re-runs itself detached (`setsid nohup`) and logs to `~/.t3/deploy/<ts>.log`, then:

1. Refuses if the disk has less than twice `userdata`'s size free.
2. Waits until no run is active, checking the database read-only every 30 s for up to
   30 minutes. A server that stays busy is never stopped: the swap aborts.
3. Stops the server with Ctrl-C through the `t3code` session and waits until the state
   directory's owner lock and the old port are free. It never kills by PID or name.
4. Copies `userdata` to `userdata.bak-<ts>`, only now that nothing writes the database.
5. Points `~/t3-builds/current` at the build (and `previous` at the old one), and starts
   `node <build>/apps/server/dist/bin.mjs serve --tailscale-serve --tailscale-serve-port 8443`
   in a new `t3code` session from a login shell.
6. Waits up to 60 s for the origin in `server-runtime.json` to answer. If it does not, it
   rolls back: stop, move the failed `userdata` to `userdata.failed-<ts>`, put the backup
   back, point `current` at the previous build, start, and check health again.
7. Links the skill (below). A failure here is logged; the build stays live.

If anything fails between the stop and the new build's start (a failed backup copy, for
example), the swap restarts the previous build. If the old server never released its lock,
it starts nothing and logs that the server may not come back; check the `t3code` session.
An automatic rollback leaves `~/t3-builds/previous` as it was before the swap.

Once the new build is verified, delete `userdata.bak-*` and `userdata.failed-*` in `~/.t3`
by hand; the scripts never prune them.

The graceful stop also removes the Tailscale Serve mapping for `:8443` and the next start
adds it again, so the tailnet URL is down only between the two. After a hard kill the mapping
stays and points at a dead port until a server starts.

The environment variables at the top of `scripts/fork-deploy/lib.sh` override every path,
the session name, the serve arguments, the timings and the health URL.

## Rollback

```sh
scripts/fork-deploy/rollback.sh --restore latest     # back to the pre-swap data
scripts/fork-deploy/rollback.sh --keep-data          # previous build on today's data
```

It returns to `~/t3-builds/previous` (or `--to <build>`), runs detached like the swap, and
waits for idle unless `--force`. `--restore latest` logs which backup it picked; check it is
the one from the swap you are undoing. `--restore` replaces `userdata` with a backup and discards
everything since that swap. `--keep-data` runs the old build on the current database, with
the losses below.

With zero migrations the previous build opens the new DB. It rewrites thread and subagent payloads without the new keys and compaction deletes superseded events, so after rollback and re-upgrade: re-promote metas; re-apply organ preset layers (the old build drops `organPresets` from `settings.json` on its next settings write); organ labels on records the old build touched are lost; `keybindings.json` may lose `sidebar.nextNeedsYou` (re-added on next start); while the old build runs, remove `sidebar.nextNeedsYou` from `keybindings.json`, or accept the config warning.

## Skill install

The swap links `~/projects/t3code/.agents/skills/t3-orchestration` as `t3-orchestration` into:

- the `skills` dir of every Claude config dir: `~/.claude`, `$CLAUDE_CONFIG_DIR`, and each
  Claude provider instance's home in `settings.json`, one per account;
- Codex's skills dir (`~/.codex/skills` and each Codex instance's home);
- `~/.agents/skills`.

A real directory already in a link's place is moved to `t3-orchestration.bak-<ts>`. The swap
refuses to start if the skill is missing from the checkout; pass `--no-skills` until it lands.
Run `scripts/fork-deploy/install-skills.sh` on its own to re-link.
