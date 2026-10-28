# Browser pool on Railway

Headless Chromium on demand for the T3 Code instance and other services in
`brave-warmth` / `QA Bot`, reached over Railway's private network. A
stand-in for a hosted browser service: swap the URL variables to move.

|                   |                                                                                  |
| ----------------- | -------------------------------------------------------------------------------- |
| Service           | `browsers`, private host `browsers.railway.internal`                             |
| Image             | `mcr.microsoft.com/playwright:v1.60.0-noble`, Chromium only                      |
| Playwright server | port `3000`, `/?token=<BROWSERS_TOKEN>`, one fresh browser per connection        |
| Raw CDP           | port `9222`, private only, one shared browser per replica                        |
| Cap               | `MAX_SESSIONS` connections per replica (default 6), then 503                     |
| Idle timeout      | `IDLE_TIMEOUT_SECONDS` with no traffic either way closes a session (default 300) |
| Replicas          | 2, 4 GB memory and 2 vCPU each, restart always, healthcheck `/healthz`           |

## How it works

[`entrypoint.mjs`](entrypoint.mjs) starts `playwright run-server` and one
Chromium with remote debugging, both on loopback, and fronts them:

- Port `$PORT` accepts WebSocket upgrades only with `?token=<BROWSERS_TOKEN>`
  (401 otherwise). The token is a query parameter because Playwright strips
  query strings from the URLs it prints in errors and logs. `GET /healthz`
  returns 503 until both browsers are listening, then
  `{"ok", "sessions", "maxSessions"}`.
- Port `$CDP_PORT` proxies `/json/*` and `/devtools/*` WebSockets. Chrome only
  accepts a loopback Host, so the front rewrites it and puts the Host the client
  used into the `webSocketDebuggerUrl` it returns, so `connectOverCDP` works
  through `browsers.railway.internal`. In Chrome's place it allows only an IP,
  `localhost` or a `*.railway.internal` Host, and refuses any request with an
  `Origin`, which blocks DNS rebinding from pages these browsers open. CDP
  libraries send no `Origin`.
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
