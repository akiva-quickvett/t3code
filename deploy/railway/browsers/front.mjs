// The two public listeners: the Playwright front (token in the query) and the
// CDP front (tokenless for Railway's private network, or a /t/<token>/ path
// prefix from anywhere). Both pipe to loopback upstreams under one session cap
// and idle timeout.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

function tokenEquals(given, token) {
  const bytes = Buffer.from(given);
  return bytes.length === token.length && NodeCrypto.timingSafeEqual(bytes, token);
}

// The token travels as ?token= because Playwright strips query strings from
// the URLs it prints in errors and logs.
export function playwrightTokenMatches(url, token) {
  return tokenEquals(new URLSearchParams(url.split("?")[1] ?? "").get("token") ?? "", token);
}

function isLoopback(address = "") {
  const ip = address.replace(/^::ffff:/, "");
  return ip === "::1" || (NodeNet.isIPv4(ip) && ip.startsWith("127."));
}

// Who may reach Chrome, and at which upstream path. Returns null to refuse.
// With /t/<token>/ any Host may connect (connectOverCDP appends json/version/
// to the URL, so a query token would not survive). Without it, Chrome's own
// DNS-rebinding guard applies: only an IP, localhost or a Railway private
// hostname. Tokenless from loopback is refused because userspace tailscaled
// delivers tailnet connections from 127.0.0.1. No request may carry a browser
// Origin; CDP libraries send none.
export function cdpAccess({ url, host = "", origin, remoteAddress }, token) {
  if (origin !== undefined) return null;
  const prefixed = /^\/t\/([^/]+)(\/.*)$/.exec(url);
  if (prefixed) {
    if (!tokenEquals(prefixed[1], token)) return null;
    return { path: prefixed[2], prefix: `/t/${prefixed[1]}` };
  }
  if (isLoopback(remoteAddress)) return null;
  const name = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.replace(/:[0-9]+$/, "");
  const nameAllowed =
    NodeNet.isIP(name) !== 0 || name === "localhost" || name.endsWith(".railway.internal");
  return nameAllowed ? { path: url, prefix: "" } : null;
}

// run-server launches Chromium's headless shell, which ignores a proxy PAC;
// a channel of "chromium" launches the full browser, which follows it.
export function launchOptionsWithChannel(header, channel) {
  let options;
  try {
    options = JSON.parse(header);
  } catch {}
  return JSON.stringify({ ...(typeof options === "object" ? options : {}), channel });
}

function refuse(socket, status) {
  socket.end(
    `HTTP/1.1 ${status}\r\nRetry-After: 1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
  );
}

// Upstreams are `{ host, port }` of the Playwright server and Chrome. `ready()`
// gates /healthz; `tailnet()` adds its status there when the node runs one.
// `playwrightChannel`, when set, is forced on every Playwright launch.
export function createFront({
  token,
  maxSessions,
  idleMs,
  playwrightUpstream,
  cdpUpstream,
  ready,
  tailnet,
  playwrightChannel,
}) {
  let sessions = 0;
  let cdpSessions = 0;
  const cdpUpstreamAddress = `${cdpUpstream.host}:${cdpUpstream.port}`;

  // Pipes an upgraded WebSocket to an upstream. Chrome only accepts a loopback
  // or IP Host, so the Host header is rewritten. Traffic in either direction
  // resets the idle timer.
  function forward(req, socket, head, target, path, { onClose, launchChannel } = {}) {
    if (sessions >= maxSessions) return refuse(socket, "503 Service Unavailable");
    sessions++;
    let released = false;
    let timer;
    const upstream = NodeNet.connect(target.port, target.host);
    const close = () => {
      clearTimeout(timer);
      socket.destroy();
      upstream.destroy();
      if (!released) {
        released = true;
        sessions--;
        onClose?.();
      }
    };
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(close, idleMs);
    };
    upstream.on("connect", () => {
      let raw = `${req.method} ${path} HTTP/1.1\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        const lower = name.toLowerCase();
        if (launchChannel && lower === "x-playwright-launch-options") continue;
        const value = lower === "host" ? `${target.host}:${target.port}` : req.rawHeaders[i + 1];
        raw += `${name}: ${value}\r\n`;
      }
      if (launchChannel) {
        const options = req.headers["x-playwright-launch-options"];
        raw += `x-playwright-launch-options: ${launchOptionsWithChannel(options, launchChannel)}\r\n`;
      }
      upstream.write(`${raw}\r\n`);
      upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    for (const side of [socket, upstream]) {
      side.on("data", touch);
      side.on("close", close);
      side.on("error", close);
    }
    touch();
  }

  function cdpRequest(path, method = "GET") {
    return new Promise((resolve, reject) => {
      const req = NodeHttp.request(
        { ...cdpUpstream, path, method, timeout: 10_000 },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 502,
              headers: res.headers,
              body: Buffer.concat(chunks),
            }),
          );
        },
      );
      req.on("timeout", () => req.destroy(new Error("CDP upstream timed out")));
      req.on("error", reject);
      req.end();
    });
  }

  // Pages a CDP client opened in the shared browser's default context outlive
  // the client. Once no CDP client is left, replace them with one blank page.
  async function resetSharedBrowser() {
    const targets = JSON.parse((await cdpRequest("/json/list")).body.toString());
    const pages = targets.filter((target) => target.type === "page");
    if (cdpSessions > 0) return;
    await cdpRequest("/json/new?about:blank", "PUT");
    // Listed before any new client attached, so none of these are its pages.
    for (const page of pages) await cdpRequest(`/json/close/${page.id}`);
  }
  function cdpClosed() {
    cdpSessions--;
    if (cdpSessions === 0)
      resetSharedBrowser().catch((error) => console.error(`CDP reset failed: ${error.message}`));
  }

  const playwright = NodeHttp.createServer(async (req, res) => {
    if (req.url === "/healthz") {
      const ok = await ready();
      res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
      const health = { ok, sessions, maxSessions };
      if (tailnet) health.tailnet = tailnet();
      return res.end(JSON.stringify(health));
    }
    res.writeHead(404).end();
  });
  playwright.on("upgrade", (req, socket, head) => {
    socket.on("error", () => socket.destroy());
    if (!playwrightTokenMatches(req.url, token)) return refuse(socket, "401 Unauthorized");
    forward(req, socket, head, playwrightUpstream, "/pw", { launchChannel: playwrightChannel });
  });

  const cdpAccessOf = (req) =>
    cdpAccess(
      {
        url: req.url,
        host: req.headers.host,
        origin: req.headers.origin,
        remoteAddress: req.socket.remoteAddress,
      },
      token,
    );

  // CDP clients read /json/version first and connect to the URL in it; Chrome
  // writes its own address there, so swap in the Host (and token prefix) the
  // client used.
  const cdp = NodeHttp.createServer(async (req, res) => {
    const access = cdpAccessOf(req);
    if (!access || (req.method !== "GET" && req.method !== "PUT")) return res.writeHead(403).end();
    try {
      const upstream = await cdpRequest(access.path, req.method);
      const body = upstream.body
        .toString()
        .replaceAll(cdpUpstreamAddress, () => `${req.headers.host}${access.prefix}`);
      res.writeHead(upstream.status, {
        "content-type": upstream.headers["content-type"] ?? "application/json",
      });
      res.end(body);
    } catch {
      res.writeHead(502).end();
    }
  });
  cdp.on("upgrade", (req, socket, head) => {
    socket.on("error", () => socket.destroy());
    const access = cdpAccessOf(req);
    if (!access || !access.path.startsWith("/devtools/")) return refuse(socket, "403 Forbidden");
    if (sessions >= maxSessions) return refuse(socket, "503 Service Unavailable");
    cdpSessions++;
    forward(req, socket, head, cdpUpstream, access.path, { onClose: cdpClosed });
  });

  return { playwright, cdp };
}
