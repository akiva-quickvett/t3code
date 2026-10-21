# Pods

A pod runs a worktree's compose stack in a private Docker daemon, so several threads can each run
the full stack at once with its usual ports and container names. Every terminal and project script
on that worktree runs inside the pod; Git, diffs and checkpoints stay on your machine.

Pods need Docker on the machine running T3 Code. They are off until you turn them on.

Agents on a pod's worktree run in the pod too, with the same login as on your machine, and keep
the T3 Code tools. A provider that cannot run in a pod is refused on a pod's worktree unless the
thread's role preset sets **Runs in → Host**, which runs it on your machine against the same
worktree (useful for read-only reviewers).

| Provider            | In a pod? | Notes                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude, Codex       | yes       |                                                                                                                                                                                                                                                                                                                                                                                                |
| Pi                  | yes       | Its `~/.pi/agent` (or `PI_CODING_AGENT_DIR`) is mounted.                                                                                                                                                                                                                                                                                                                                       |
| Grok                | yes       | Its `~/.grok` (or `GROK_HOME`) is mounted.                                                                                                                                                                                                                                                                                                                                                     |
| ACP Registry agents | yes       | The registry's install is mounted read-only. The agent's own login directory is not, so give it an API key in the instance's environment. Agents installed with `uvx` (Python) cannot run in a pod. A **Local command** given as a bare name runs the pod image's copy of that command, and T3 Code still checks that your machine has it too; on a Mac, only such a command can run in a pod. |
| Cursor              | no        | It runs inside T3 Code itself.                                                                                                                                                                                                                                                                                                                                                                 |
| OpenCode            | no        | One OpenCode server serves every directory.                                                                                                                                                                                                                                                                                                                                                    |
| Antigravity         | no        | Its profiles and installer are tied to your machine.                                                                                                                                                                                                                                                                                                                                           |
| Muse                | no        | T3 Code cannot mount its login, and its own tool sandbox is untested in a container.                                                                                                                                                                                                                                                                                                           |

In a pod a provider gets only the variables set on its instance (**Settings → Providers**), never
those of the machine running T3 Code, so an API key such as `XAI_API_KEY` or a Pi provider key
that you export in your shell must be set on the instance as well. ACP agents reach the T3 Code
tools in a pod over HTTP; an agent that ignores HTTP tool servers, as some ACP adapters do, runs
there without them.

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

The default agent image, `t3.invalid/pod-agent`, is one T3 Code builds on your Docker host the
first time a pod needs it, which takes a few minutes and needs network access once. Its tag is a
digest of its recipe, so an update that changes the image builds it again; earlier builds are
removed once they are over a week old and no pod uses them. It is
Debian-based, with `curl`, `git`, `ssh`, the Docker CLI with compose, and the Claude, Codex, Pi
and Grok CLIs; it holds no credentials, since logins come from the config directories the pod
mounts. On Linux, a provider whose binary path is absolute runs your machine's own install,
mounted read-only; a bare command name runs the image's copy. It takes about 1.8 GB on disk
(0.69 GB compressed), of which the provider CLIs are 1.26 GB.

To use another image, set `podRuntime.defaultImage` in the server settings. A new default applies
to pods created after, and to a pod's agent container when it is recreated: **Recreate pod**, or
the recreate T3 Code does on its own when a session needs something the pod lacks. That recreate
may build the image first, so the session can take minutes to start while the pod chip shows the
pod starting. On Linux, an image without the CLIs can be much smaller when
every provider instance sets an absolute binary path, since T3 Code then mounts your machine's
installs. Such an image needs:

- the Docker CLI with its compose plugin (and buildx, if your stack builds images), which creating
  a pod checks for;
- glibc, to run your machine's provider binaries, and `node` for CLIs installed as Node scripts,
  such as Pi;
- `sh` with the usual tools (`cat`, `cp`, `grep`, `kill`, `sleep`, `test`, `tr`), which T3 Code
  uses to start, stop and set up sessions;
- `curl`, or `nc`, for the firewall check; without either, the check reports nothing;
- `git` and anything your setup and teardown scripts run.

`env` is set for every command in the pod and written to the worktree's `.env`, replacing those
variables and keeping the rest of the file; keep `.env` out of Git. A `.env` that is a symlink, as
some worktree setups make to share the main checkout's, becomes the worktree's own file, so the
shared one never gets this pod's addresses. In its values, `{web.url}` and
`{web.port}` become the `web` service's address and port on the machine running T3 Code. A
placeholder that names no service fails the pod and names the variable.

### Host firewall

On Linux, agents in a pod reach T3 Code on port 17773 of the pod network's gateway. A firewall that drops
incoming traffic by default (ufw, firewalld) drops this too, and the agents then run without the
T3 Code tools. Allow it from the pod network's subnet to its gateway, which
`docker network inspect t3-pods --format '{{(index .IPAM.Config 0).Subnet}} {{(index .IPAM.Config 0).Gateway}}'`
prints (`t3-pods` is the default of `podRuntime.network` in the server settings):

```sh
# ufw
sudo ufw allow from 172.18.0.0/16 to 172.18.0.1 port 17773 proto tcp
# firewalld
sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="172.18.0.0/16" destination address="172.18.0.1" port port="17773" protocol="tcp" accept'
sudo firewall-cmd --reload
```

Replace `172.18.0.0/16` and `172.18.0.1` with your subnet and gateway.

T3 Code checks this from inside each pod when it starts. While the check fails, the pod chip turns
yellow and its menu and **Settings → Diagnostics → Pods** say so. After fixing the firewall, start
a new session in the pod: T3 Code checks again then.

### macOS and Docker Desktop

With Docker Desktop, on a Mac or on Linux, or any other Docker engine on a Mac, containers run in a
virtual machine whose pod network your machine cannot reach. T3 Code notices that from the engine
and listens for its pods on `127.0.0.1:17773` instead, where the engine's own
`host.docker.internal` arrives; no firewall rule is needed. The engine resolves that name itself,
so when a pod uses resolvers of its own (`podRuntime.dnsServers`, or hostname mode), T3 Code maps
it to Docker's `host-gateway` instead, which Rancher Desktop does not support. Anything running on your machine can
reach that port, so the per-session token is what keeps other programs out, and the listener only
takes requests addressed to `host.docker.internal`.

Your Mac's provider binaries cannot run in the pod's Linux container, so pods there use the CLIs of
the default image whatever binary path an instance sets.

This mode has not yet been confirmed on a real Mac. To check it by hand while T3 Code runs a pod,
`docker run --rm curlimages/curl -s -o /dev/null -w '%{http_code}\n' http://host.docker.internal:17773/mcp`
should print an HTTP status such as 401 or 403, not `000`.

## Start a thread in a pod

In the composer, choose **New worktree**, then **Runtime → Container**. T3 Code creates the
worktree, starts its pod and brings the stack up before the setup script runs, which then runs in
the pod. The first pod pulls its images, which can take a few minutes.

A pod's Docker daemon looks names up through this machine's own upstream DNS servers, since
Docker's DNS on the pods network fails on some machines. If its image pulls still fail with
`server misbehaving`, set `podRuntime.dnsServers` in the server settings to resolvers that work
from containers (for example `["192.168.1.1"]`) and recreate the pod.

## Manage a pod

Switching a pod thread to another account of the same provider works mid-thread. If the pod was
made before that account was enabled, or before that provider could run in pods, T3 Code recreates
the pod's agent container to add what it needs; the stack keeps running, and other agents in the
pod resume on their next turn.

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

## Serve a pod's services on hostnames

Some stacks only work over HTTPS on a real hostname, for example when their CORS, cookies or
WebSocket URLs are built from it. Add `"hostnames": true` to the project's `pod` block and each
service is served at `https://<pod>-<service>.pods.internal` instead of a port: the pod chip,
**Settings → Diagnostics → Pods**, the local servers list and `{web.url}` in `env` all use that
address. `{web.port}` is then 443.

Hostname mode uses the pods proxy that `orch` runs on this machine: a Caddy container
(`pods-proxy`) with its own certificate authority, and DNS servers that answer `*.pods.internal`.
T3 Code adds one route file per pod beside orch's, removes it when the pod stops, and checks every
route with the proxy before reloading it, so a bad route never affects other pods. Set it up once
on the machine running T3 Code:

1. Start the proxy, for example by bringing up any orch pod once.
2. `orch pod host-dns` sends `*.pods.internal` lookups on this machine to the proxy's DNS server.
3. `orch pod trust` adds the proxy's certificate authority to the system trust store, which
   browsers and T3 Code's own browser use. On a distribution whose NSS does not read the system
   store (stock Debian or Ubuntu without p11-kit's `libnssckbi.so`), also import it for your user:
   `certutil -A -d sql:$HOME/.pki/nssdb -n "Caddy Local Authority" -t "C,," -i ~/.local/state/herdr-orch/caddy/root.crt`.
4. If T3 Code uses Tailscale Serve, keep it off port 443: the proxy serves the hostnames to your
   other devices on 443 of this machine's tailnet address, and Tailscale Serve on the same port
   takes it over. Start T3 Code with `--tailscale-serve-port 8443` (or
   `T3CODE_TAILSCALE_SERVE_PORT=8443`), or pick another port when you turn on Tailscale HTTPS in
   **Settings → Connections**. Both that screen and Diagnostics warn while T3 Code's own Tailscale
   Serve uses 443; a serve on 443 set up any other way, such as one `t3 pair` left running, is not
   detected, so check `tailscale serve status`.

T3 Code's route files are named `t3-*.caddy`. `orch pod status` currently lists them as stale
routes; leave them, since they serve running pods and T3 Code removes its own.

Inside the pod, the stack's containers resolve `*.pods.internal` too, and the agent container
trusts the proxy's certificates, so commands there can reach any pod's hostname. Lookups of those
hostnames can take a few seconds, because orch's DNS server does not answer IPv6 lookups yet (a fix
is pending in orch); busybox tools such as `wget` in Alpine-based images give up with
`bad address`, so use `curl`, which the default image has.

If the proxy is missing when a pod is created, the pod still starts on ports and Diagnostics says
why; **Recreate pod** once the proxy is back moves it to hostnames. If only its route cannot be put
in place, Diagnostics says why and its hostnames do not open until the pod starts again with the
route. The proxy's container names, network, domain, routes directory and certificate are orch's
defaults; change them under `podRuntime.hostnameProxy` in the server settings if your setup differs.

## Removing a pod's worktree

Removing the worktree, by deleting its thread or by storage cleanup, first runs the project's
teardown script in the pod, then removes the pod, then the worktree. If either step fails, the
worktree is kept: the notice offers **Retry**, then **Remove anyway**, which skips the script and
removes the pod even if Docker refuses. Storage cleanup removes only a pod's worktree whose pod you
stopped, and its results say why it kept the others. Once a pod is removed, its worktree's teardown
script no longer runs at all.
