# Browser pool on Railway

Headless Chromium on demand for the T3 Code instance and other services in
`brave-warmth` / `QA Bot`, reached over Railway's private network. A
stand-in for a hosted browser service: swap the URL variables to move.

|                   |                                                                                  |
| ----------------- | -------------------------------------------------------------------------------- |
| Service           | `browsers`, private host `browsers.railway.internal`                             |
| Image             | `mcr.microsoft.com/playwright:v1.60.0-noble`, Chromium only                      |
| Playwright server | port `3000`, `/?token=<BROWSERS_TOKEN>`, one fresh browser per connection        |
| Raw CDP           | port `9222`, one shared browser per replica; tokenless only over Railway's network |
| Tailnet           | optional, `railway-browser[-N]`, also loads `https://*.pods.internal`            |
| Cap               | `MAX_SESSIONS` connections per replica (default 6), then 503                     |
| Idle timeout      | `IDLE_TIMEOUT_SECONDS` with no traffic either way closes a session (default 300) |
| Replicas          | 2, 4 GB memory and 2 vCPU each, restart always, healthcheck `/healthz`           |

## How it works

[`start.sh`](start.sh) passes `BROWSERS_TOKEN` and `TS_AUTHKEY` to
[`entrypoint.mjs`](entrypoint.mjs) on stdin, so no process, browsers included,
has them in its environment. The entrypoint starts `playwright run-server` and
one Chromium with remote debugging, both on loopback, and fronts them
([`front.mjs`](front.mjs)):

- Port `$PORT` accepts WebSocket upgrades only with `?token=<BROWSERS_TOKEN>`
  (401 otherwise). The token is a query parameter because Playwright strips
  query strings from the URLs it prints in errors and logs. `GET /healthz`
  returns 503 until both browsers are listening, then
  `{"ok", "sessions", "maxSessions"}`.
- Port `$CDP_PORT` proxies `/json/*` and `/devtools/*` WebSockets. Chrome only
  accepts a loopback Host, so the front rewrites it and puts the Host the client
  used into the `webSocketDebuggerUrl` it returns, so `connectOverCDP` works
  through `browsers.railway.internal`. Tokenless, it allows only an IP,
  `localhost` or a `*.railway.internal` Host, as Chrome would, and never from
  loopback, where tailnet connections arrive. Under the path prefix
  `/t/<BROWSERS_TOKEN>/` any Host is allowed, from anywhere, and the returned
  URLs keep the prefix. Either way it refuses any request with an `Origin`,
  which blocks DNS rebinding from pages these browsers open. CDP libraries send
  no `Origin`.
- Both ports share one session count. Above `MAX_SESSIONS`, a new connection
  gets `503` with `Retry-After: 1`. The private hostname resolves to every
  replica, so a retry can land on another one.
- If either child exits, the container exits and Railway restarts it.

CDP clients share one browser per replica. Use your own context
(`browser.newContext()`) and close it; pages in the default context, and its
cookies, are visible to the next client. When the last CDP client disconnects,
the front closes every page it left and opens one blank page; cookies in the
default context last until the replica restarts.

## Connect

The `AI Agent Host` service has both URLs as reference variables, so the token
never leaves Railway:

- `BROWSERS_WS_URL` = `ws://${{browsers.RAILWAY_PRIVATE_DOMAIN}}:${{browsers.PORT}}/?token=${{browsers.BROWSERS_TOKEN}}`
- `BROWSERS_CDP_URL` = `http://${{browsers.RAILWAY_PRIVATE_DOMAIN}}:${{browsers.CDP_PORT}}`

Playwright protocol. The client's Playwright version must match the server's
(1.60.0):

```js
import { chromium } from "playwright"; // 1.60.0
const browser = await chromium.connect(process.env.BROWSERS_WS_URL);
const page = await browser.newPage();
await page.goto("https://example.com");
await page.screenshot({ path: "example.png" });
await browser.close(); // the server closes this browser too
```

Raw CDP, for any CDP client (Playwright `connectOverCDP`, Puppeteer, Stagehand,
`@playwright/mcp --cdp-endpoint "$BROWSERS_CDP_URL"`):

```js
const browser = await chromium.connectOverCDP(process.env.BROWSERS_CDP_URL);
const context = await browser.newContext();
// ...
await context.close();
```

T3 Code's own browser panel and HTML renders launch a local Chromium and do
not use these URLs. Agents running in T3 Code inherit both variables, so a
script or `@playwright/mcp` an agent starts can use them.

To move to a hosted browser service, point `BROWSERS_CDP_URL` (or
`BROWSERS_WS_URL`, for a Playwright-protocol service) at it; clients read only
these variables.

## Tailnet

With `TS_AUTHKEY` set, each replica joins the tailnet as `railway-browser`
(Tailscale names the second `railway-browser-1`), so machines on the tailnet
drive its browsers directly, and the browsers load `https://*.pods.internal`
from the pods proxy at home. Without it nothing here changes.

What runs, as `pwuser`, from [`tailnet.mjs`](tailnet.mjs) and
[`pods-proxy.mjs`](pods-proxy.mjs):

- `tailscaled` in userspace mode (Railway has no TUN device) with its state in
  memory: replicas cannot share a volume, so every boot joins afresh. Use a
  reusable, ephemeral, tagged key; offline nodes then drop off on their own, and
  a replica logs out when Railway stops it. `TS_DEBUG_MTU=1200`, since the
  Railway path drops full 1280-byte packets and TLS handshakes stall.
- Chrome, the shared CDP browser and every Playwright browser, gets a PAC that
  sends `*.pods.internal` to a proxy on `127.0.0.2:1056` and everything else
  direct. The proxy dials `PODS_HOST_IP` on the same port, 80 or 443 only,
  through tailscaled's SOCKS5 (`127.0.0.2:1055`); the hostname stays in the
  Host header and TLS SNI.
  `PODS_CA_PEM` goes into `pwuser`'s NSS database, so Chrome trusts the pods
  proxy's certificates. Chromium's headless shell ignores a PAC, so Playwright
  launches use full Chromium (`channel: "chromium"`), about twice the memory
  per browser.
- `/healthz` adds `"tailnet": {"state", "ip", "name"}`.

From the tailnet, with `<ip>` from `tailscale status`:

- Playwright: `ws://<ip>:3000/?token=<BROWSERS_TOKEN>`, as above.
- CDP: `http://<ip>:9222/t/<BROWSERS_TOKEN>/`, for any CDP client:
  `chromium.connectOverCDP("http://<ip>:9222/t/<token>/")`. Playwright strips
  only query strings from the URLs in its errors, so this one shows the token:
  keep such errors out of shared logs.

Variables on `browsers`:

| Variable       | Value                                                                  |
| -------------- | ---------------------------------------------------------------------- |
| `TS_AUTHKEY`   | Tailscale auth key, reusable, ephemeral, tagged (sealed)               |
| `PODS_HOST_IP` | Tailnet IPv4 of the pods proxy host                                    |
| `PODS_CA_PEM`  | The pods proxy's root certificate, PEM                                 |

Tailscale delivers tailnet connections to `127.0.0.1:<port>` inside the
container, for any port. The Playwright server, SOCKS5 and the pods proxy
listen on `127.0.0.2` out of reach, and the front refuses tokenless CDP from
loopback, but Chrome's own debugging port (`CDP_PORT + 1`) always binds
`127.0.0.1` and has no auth. The ACL must therefore limit who reaches the node
to ports 3000 and 9222, and let the node reach only the pods proxy:

```json
"tagOwners": { "tag:railway-browser": ["autogroup:admin"] },
"hosts": { "omarchy": "100.x.y.z" },
"grants": [
  { "src": ["autogroup:member"], "dst": ["tag:railway-browser"], "ip": ["tcp:3000", "tcp:9222"] },
  { "src": ["tag:railway-browser"], "dst": ["omarchy"], "ip": ["tcp:80", "tcp:443"] }
]
```

A rule that lets members reach `*` on every port also covers the tag; narrow it
so the tag gets only the grant above.

## Public access

Off by default. To reach the Playwright server from another machine, add a
public domain for port 3000 (**Settings → Networking**); clients then use
`wss://<domain>/?token=<BROWSERS_TOKEN>`. The token is the only guard, so never
publish the CDP port, and an edge proxy may log query strings: rotate the token
if the domain stays up. Read the token with
`railway variables --service browsers --environment "QA Bot"`; rotate it by
setting a new value and redeploying.

## Scale

Railway does not autoscale on load. Change the replica count with the public
API, then redeploy (a deployment keeps the count it started with). The count
lives in `multiRegionConfig`; the older `numReplicas` field is ignored.

```bash
railway api 'mutation($c: JSON!) { serviceInstanceUpdate(
  serviceId: "2025c4bc-03f5-401c-baed-2153048146eb",
  environmentId: "911f4fa2-ae51-4ea3-8f14-09bf2c27d5aa",
  input: { multiRegionConfig: $c }) }' \
  --variables '{"c": {"us-west2": {"numReplicas": 3}}}'
railway redeploy --service browsers --environment "QA Bot" --yes
```

Sizing: a replica idles at about 0.45 GB (the front, the Playwright server and
the shared CDP browser). Each Playwright browser on a simple page adds about
110-170 MB; heavy apps use several times that. At the 4 GB limit, 6 sessions
leave room for heavy pages. Raise `MAX_SESSIONS` with the memory limit.

## Deploy

Builds from this directory (root directory `/deploy/railway/browsers`) on
pushes to the branch the `AI Agent Host` service also builds from; the watch
pattern limits it to changes here. To upgrade Playwright, change the image tag
and the `playwright` version in the [`Dockerfile`](Dockerfile) together, with
the repo's own Playwright version.
