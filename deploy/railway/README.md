# T3 Code on Railway

A cloud dev machine running T3 Code from this repository's source, reached from a
browser at its Railway domain. The server user's home lives on a volume, so the
T3 database, provider logins, SSH keys and checked-out repositories survive
redeploys.

|                       |                                                          |
| --------------------- | -------------------------------------------------------- |
| Project / environment | `brave-warmth` / `QA Bot`                                |
| Service               | `AI Agent Host` (private host `t3code.railway.internal`) |
| URL                   | https://t3code-qa-bot.up.railway.app                     |
| Volume                | `t3code-volume`, 50 GB, mounted at `/home/t3`            |
| Limits                | 8 GB memory, 4 vCPU (ceilings; billing is by actual use) |
| Restart policy        | always                                                   |

## How it works

- [`Dockerfile`](Dockerfile) builds the server and web client from source with
  `vp` (Node and pnpm at the versions `package.json` pins), then copies the
  workspace into a slim runtime image with git, gh, ripgrep, curl, jq,
  openssh-client, pnpm, Claude Code, and Python 3.13 with pip, venv and uv
  (both pinned in the Dockerfile). It copies `.env.example` to
  `.env` before building, so T3 Connect's public identifiers are baked in as in
  release builds.
- [`entrypoint.sh`](entrypoint.sh) runs as root on every boot: it copies
  `.bashrc` and `.profile` into the home only if they are missing, creates the
  home directories below, gives anything not owned by `t3` back to `t3`, and
  starts `t3 serve --host 0.0.0.0 --port $PORT ~/work` as `t3`.
- `t3 serve` prints a fresh admin pairing token, its URL and a QR code at every
  start. The entrypoint strips all three from stdout, so the deploy logs show
  `Token: [redacted]`. Pairing links come from `t3 pair` instead.
- The browser origin check is same-origin, so the Railway domain needs no extra
  configuration. Unpaired requests get 401.
- `t3` on `PATH` always runs as the `t3` user, even from a root shell, so it
  never leaves root-owned files in `~/.t3`.
- Never set `T3CODE_DEV_AUTH_TOKEN` on this service: `t3 serve` would print
  that long-lived token at every start instead of a one-time one.

Service settings (not in a config file): Dockerfile path
`deploy/railway/Dockerfile` (also set as `RAILWAY_DOCKERFILE_PATH`), healthcheck
`/`, restart policy always, the limits above. No other variables are set; the
server needs none.

## Pair a browser

Pairing tokens are one-time, expire after five minutes, and are passwords: keep
them out of chat, tickets and screenshots.

```bash
railway ssh --project brave-warmth --environment "QA Bot" --service "AI Agent Host"
t3 pair
```

`t3 pair` prints a `Pairing URL` with the container's internal address and a
`Token`. Open this in your browser, with the printed token:

```
https://t3code-qa-bot.up.railway.app/pair#token=<Token>
```

`railway ssh` lands as root, and root's own home is not on the volume. For
anything but `t3 pair`, run `su - t3` first, or files end up root-owned under
`/home/t3` or lost in `/root` on the next deploy. The login shell also drops
the `RAILWAY_API_TOKEN` that `railway ssh` puts in its session, so nothing you
start there, an agent included, holds a Railway credential.

Each new browser or device needs its own `t3 pair`. Revoke sessions with
`t3 auth session list` and `t3 auth session revoke <id>`, or in
**Settings → Connections**.

## First-time setup inside the instance

Open a terminal in the T3 web app (it runs bash as `t3` in `~/work`):

```bash
claude                     # then /login; the login is saved under ~/.claude
gh auth login              # saved under ~/.config/gh
git config --global user.name "…"
git config --global user.email "…"
ssh-keygen -t ed25519      # optional; keys stay in ~/.ssh
t3 connect                 # optional: T3 Connect sign-in
```

After `t3 connect`, restart the server so it picks up the link:
`railway restart --service "AI Agent Host" --environment "QA Bot"`.

To work on this repo in the instance, install the Vite+ CLI into your home,
where it persists: `curl -fsSL https://vite.plus | bash`.

## What persists

Everything under `/home/t3`, which is the volume:

- `~/.t3`: T3 Code's database, settings, secrets and logs (`T3CODE_HOME`
  default)
- `~/.claude` and `~/.claude.json`: Claude Code login and settings
- `~/.config` (gh, git), `~/.local` (user-installed tools, on `PATH` through
  `~/.local/bin`), `~/.ssh`, `~/.gitconfig`
- `~/work`: repositories and the server's working directory

Anything outside `/home/t3` (apt packages, global npm packages) resets on every
deploy. Install user tools under `~/.local` instead. uv's cache and any Python
versions `uv python install` adds go to `~/.cache/uv` and `~/.local/share/uv`,
so they persist; the system `python3` refuses `pip install` outside a venv, so
use `uv venv` or `python3 -m venv`.

## Deploy and update

The service builds from GitHub `akiva-quickvett/t3code` on every push to its
source branch (**Settings → Source**). That is `pod/ste-545-t3-hosted`, upstream
T3 Code `main` plus this directory, until this directory lands on `main`; then
switch the source branch to `main`. To move to a newer upstream, update the
source branch and push.

To deploy an unpushed tree by hand, upload the committed files only:

```bash
git archive HEAD | tar -x -C /path/to/empty-dir --exclude=.repos
railway up /path/to/empty-dir --path-as-root \
  --project brave-warmth --environment "QA Bot" --service "AI Agent Host"
```

Claude Code installs at image build time. Railway caches that layer, so to pick
up a new release set the service variable `CLAUDE_CODE_VERSION` to the version
you want (it is passed to the build as an argument) and redeploy.

A deploy stops the old container before the new one mounts the volume, so
expect a minute of downtime and dropped WebSockets; clients reconnect on their
own. Running agent turns are interrupted.

## Roll back

In the dashboard, open the service's **Deployments**, choose an earlier
successful deployment and **Rollback**. The volume is not rolled back. T3 Code
migrates its database forward on start, so an older server may refuse a
database a newer one already migrated; roll back across releases only with a
volume backup (**Volume → Backups**) taken before the upgrade.

## Costs

Railway bills by use: memory, CPU, volume storage and egress (see
[railway.com/pricing](https://railway.com/pricing)). An idle server uses a few
hundred MB of memory and almost no CPU; agent turns add a few GB while they run.
The 50 GB volume is billed on what is used, not its size. Expect roughly
$5-15 a month idle, more with heavy agent use. The 8 GB and 4 vCPU limits cap
the worst case; raise them in **Settings → Resources** if agents run out of
memory.

## Railway status for agents

Agents read status, deployments, logs and metrics of `brave-warmth` production
and staging through two read-only proxies in `QA Bot`
([railway-readonly-proxy](https://github.com/akiva-quickvett/railway-readonly-proxy)),
so this instance never holds a Railway credential. `railway-proxy-prod` and
`railway-proxy-stg` each hold a project token for one environment; this service
gets their private URLs and proxy keys as reference variables:

```bash
curl -H "Authorization: Bearer $RAILWAY_PROXY_PROD_KEY" "$RAILWAY_PROXY_PROD_URL/v1/overview"
curl -H "Authorization: Bearer $RAILWAY_PROXY_PROD_KEY" \
  "$RAILWAY_PROXY_PROD_URL/v1/logs/steddy-backend?limit=50&filter=@level:error"
curl -H "Authorization: Bearer $RAILWAY_PROXY_STG_KEY" \
  "$RAILWAY_PROXY_STG_URL/v1/services/steddy-backend/metrics?minutes=60"
```

Endpoints and parameters are in the proxy's README. Never `railway login` or set
`RAILWAY_TOKEN` in this instance. To rotate a key, set the proxy's
`PROXY_API_KEYS` to a single new key and redeploy this service; the reference
variable carries the whole value, so a comma-separated pair would break it.

## Limits

- No Docker: Railway has none, so T3 pods and anything else that needs a Docker
  daemon do not work here.
- No sudo. `t3 browser setup` cannot install Chrome's libraries, so browser
  tabs and HTML renders may not start.
- Fork builds report the `dev` telemetry channel. Set the service variable
  `T3CODE_TELEMETRY_ENABLED=false` to turn analytics off.
