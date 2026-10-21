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
whatever your scripts run. To run agents in the pod, the image also needs to run the Claude and
Codex CLIs: a glibc-based image (such as a Debian one) with them installed, or with the host's
binaries, which T3 Code mounts when the provider's binary path is absolute. Include `curl` too: the
default image has none, and its busybox `wget` cannot reach `*.pods.internal` hostnames.

`env` is set for every command in the pod and written to the worktree's `.env`, replacing those
variables and keeping the rest of the file; keep `.env` out of Git. A `.env` that is a symlink, as
some worktree setups make to share the main checkout's, becomes the worktree's own file, so the
shared one never gets this pod's addresses. In its values, `{web.url}` and
`{web.port}` become the `web` service's address and port on the machine running T3 Code. A
placeholder that names no service fails the pod and names the variable.

### Host firewall

Agents in a pod reach T3 Code on port 17773 of the pod network's gateway. A firewall that drops
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
is pending in orch); busybox tools such as the default image's `wget` give up with `bad address`,
so use an agent image with `curl` or another glibc-based tool for requests to pod hostnames.

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
