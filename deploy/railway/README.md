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
  home directories below, gives anything not owned by `t3` back to `t3`,
  starts Tailscale and the hub forwarder when configured
  ([Hub over Tailscale](#hub-over-tailscale)), and starts
  `t3 serve --host 0.0.0.0 --port $PORT ~/work` as `t3`.
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
`/`, restart policy always, the limits above. The server itself needs no
variables; the others on the service are for the hub, the Railway proxies and
the S3 proxy.

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
- `~/.tailscale`: the node's Tailscale identity and `tailscaled.log`
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

## Hub over Tailscale

Claude Code in this instance can run on the CLIProxyAPI hub at home
(`omarchy`), so agents use the accounts logged in there instead of signing in
from a datacenter IP. The hub is reached over Tailscale; nothing about it is
public.

What runs, as `t3`, once the node has joined the tailnet:

- `tailscaled` in userspace mode (Railway has no TUN device), with its state on
  the volume, so the node keeps its identity across redeploys. It offers an
  HTTP proxy on `127.0.0.1:1055` and SOCKS5 on `127.0.0.1:1056`.
- [`hub-forward.mjs`](hub-forward.mjs) on `127.0.0.1:8317`: plain HTTP for
  local clients, forwarded over TLS to `HUB_URL` through that proxy, so nothing
  else needs proxy settings. When the hub cannot be reached it answers 502 with
  the reason, after at most 15 seconds.

Variables on `AI Agent Host`:

| Variable           | Value                                                     |
| ------------------ | --------------------------------------------------------- |
| `TS_AUTHKEY`       | Tailscale auth key, used only for the first join (sealed) |
| `HUB_URL`          | `https://omarchy.tail43a582.ts.net:8317` (the default)    |
| `HUB_ACCESS_TOKEN` | The hub's access key (sealed)                             |

At boot the entrypoint waits up to about 90 seconds for the node to come up.
If `HUB_ACCESS_TOKEN` is set and the node is up, it gives the server, and so
every agent, `ANTHROPIC_AUTH_TOKEN` (the access key),
`ANTHROPIC_BASE_URL=http://127.0.0.1:8317` and
`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`, and adds
`"promptCacheTtl": "1h"` to `~/.claude/settings.json` unless that key is
already set (through the hub, Claude Code would otherwise fall back to a 5
minute cache). Otherwise it leaves all three unset, so Claude Code uses its
own login as before. The deploy log says which: `hub: on` or `hub: off (...)`
with the reason. The choice holds until the next boot; a hub or tailnet outage
after that shows up in agents as a 502 from the forwarder. Never set
`ANTHROPIC_AUTH_TOKEN` on the service itself: Claude Code would send it to
Anthropic. `TS_AUTHKEY` and `HUB_ACCESS_TOKEN` never reach the server or
agents under their own names. Once the node has joined, the auth key can
expire or be removed.

To make the auth key, in the Tailscale admin console:

1. In **Access controls**, define the tag and let it reach only the hub's port.
   Replace the hub's address and keep your other rules; a default rule that
   lets `*` reach `*` would also cover `tag:qa-bot`, so narrow it to your
   users (`autogroup:member`):

   ```json
   "tagOwners": { "tag:qa-bot": ["autogroup:admin"] },
   "hosts": { "omarchy": "100.x.y.z" },
   "grants": [
     { "src": ["autogroup:member"], "dst": ["*"], "ip": ["*"] },
     { "src": ["tag:qa-bot"], "dst": ["omarchy"], "ip": ["tcp:8317"] }
   ]
   ```

2. In **Settings → Keys**, generate an auth key: reusable off, ephemeral off,
   tag `tag:qa-bot`. Tagged nodes do not expire.
3. Set it as `TS_AUTHKEY` on the service (sealed) and redeploy. The node joins
   as `qa-bot-t3` with shields up, so nothing on the tailnet can connect to it.

Check it from a shell in the instance (`railway ssh`, then `su - t3`):

```bash
tailscale status
curl -s 127.0.0.1:8317/v1/models -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN"
```

`su -` starts a clean environment, so set `ANTHROPIC_AUTH_TOKEN` there by hand,
or expect a 401 from the hub: that still proves the path. A JSON 502 names the
broken hop. The deploy log has one `tailscale:` line per boot with the node's
state; tailscaled's own log is `~/.tailscale/tailscaled.log`. `NeedsLogin` in
that line means the auth key was missing, used or expired: set a fresh one and
redeploy.

To roll back, delete `HUB_ACCESS_TOKEN` and redeploy: Claude Code goes back to
its own login, and the node stays on the tailnet doing nothing. The
`promptCacheTtl` setting stays; on a Claude subscription 1 hour is the default
anyway. To leave the tailnet too, also delete `TS_AUTHKEY`, remove
`~/.tailscale` and remove the machine in the admin console.

## Limits

- No Docker: Railway has none, so T3 pods and anything else that needs a Docker
  daemon do not work here.
- No sudo. `t3 browser setup` cannot install Chrome's libraries, so browser
  tabs and HTML renders may not start.
- Fork builds report the `dev` telemetry channel. Set the service variable
  `T3CODE_TELEMETRY_ENABLED=false` to turn analytics off.
