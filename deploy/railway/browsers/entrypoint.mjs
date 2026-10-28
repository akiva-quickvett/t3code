// Browser pool front for Railway. Runs `playwright run-server` (a fresh
// Chromium per connection) and one shared headless Chromium for raw CDP, both
// on loopback, and fronts them on all interfaces with a session cap, an idle
// timeout and, for Playwright, a token. Setup and clients: README.md.
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const token = Buffer.from(process.env.BROWSERS_TOKEN ?? "");
delete process.env.BROWSERS_TOKEN;
if (token.length < 16) {
  console.error("BROWSERS_TOKEN must be set to at least 16 characters");
  process.exit(1);
}
function positiveInt(name, fallback) {
  const value = process.env[name] ?? String(fallback);
  if (!/^[1-9][0-9]*$/.test(value)) {
    console.error(`${name} must be a positive integer`);
    process.exit(1);
  }
  return Number(value);
}
const port = positiveInt("PORT", 3000);
const cdpPort = positiveInt("CDP_PORT", 9222);
const maxSessions = positiveInt("MAX_SESSIONS", 6);
const idleMs = positiveInt("IDLE_TIMEOUT_SECONDS", 300) * 1000;
const playwrightUpstream = port + 1;
const cdpUpstream = cdpPort + 1;
let sessions = 0;
let cdpSessions = 0;

const children = [];
function start(command, args) {
  const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"] });
  child.on("exit", (code, signal) => {
    console.error(`${command} exited (${code ?? signal}); stopping so Railway restarts us`);
    stop(1);
  });
  children.push(child);
}
function stop(code) {
  for (const child of children) child.kill("SIGTERM");
  process.exit(code);
}
process.on("SIGTERM", () => stop(0));

start(fileURLToPath(new URL("node_modules/.bin/playwright", import.meta.url)), [
  "run-server",
  "--host",
  "127.0.0.1",
  "--port",
  String(playwrightUpstream),
  "--path",
  "/pw",
]);
start(chromium.executablePath(), [
  "--headless=new",
  `--remote-debugging-port=${cdpUpstream}`,
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--disable-background-networking",
  "--user-data-dir=/tmp/cdp-profile",
  "about:blank",
]);

function refuse(socket, status) {
  socket.end(`HTTP/1.1 ${status}\r\nRetry-After: 1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
}

// Pipes an upgraded WebSocket to a loopback upstream. Chrome only accepts a
// loopback or IP Host, so the Host header is rewritten. Traffic in either
// direction resets the idle timer.
function forward(req, socket, head, upstreamPort, path, onClose) {
  if (sessions >= maxSessions) return refuse(socket, "503 Service Unavailable");
  sessions++;
  let released = false;
  let timer;
  const upstream = net.connect(upstreamPort, "127.0.0.1");
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
      const value = name.toLowerCase() === "host" ? `127.0.0.1:${upstreamPort}` : req.rawHeaders[i + 1];
      raw += `${name}: ${value}\r\n`;
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

// The token travels as ?token= because Playwright strips query strings from
// the URLs it prints in errors and logs.
function tokenMatches(url) {
  const given = Buffer.from(new URLSearchParams(url.split("?")[1] ?? "").get("token") ?? "");
  return given.length === token.length && timingSafeEqual(given, token);
}

// Chrome's own DNS-rebinding guard: only an IP, localhost, or a Railway private
// hostname, and no browser Origin (CDP libraries send none).
function cdpAllowed(req) {
  const host = req.headers.host ?? "";
  const name = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.replace(/:[0-9]+$/, "");
  const nameAllowed = net.isIP(name) !== 0 || name === "localhost" || name.endsWith(".railway.internal");
  return nameAllowed && req.headers.origin === undefined;
}

let ready = false;
function upstreamsReady() {
  if (ready) return Promise.resolve(true);
  const probe = (upstreamPort) =>
    new Promise((resolve) => {
      const socket = net.connect(upstreamPort, "127.0.0.1", () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
  return Promise.all([probe(playwrightUpstream), probe(cdpUpstream)]).then((ok) => (ready = ok.every(Boolean)));
}

function cdpRequest(path, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: cdpUpstream, path, method, timeout: 10_000 },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 502, headers: res.headers, body: Buffer.concat(chunks) }));
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
  if (cdpSessions === 0) resetSharedBrowser().catch((error) => console.error(`CDP reset failed: ${error.message}`));
}

const playwright = http.createServer(async (req, res) => {
  if (req.url === "/healthz") {
    const ok = await upstreamsReady();
    res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok, sessions, maxSessions }));
  }
  res.writeHead(404).end();
});
playwright.on("upgrade", (req, socket, head) => {
  socket.on("error", () => socket.destroy());
  if (!tokenMatches(req.url)) return refuse(socket, "401 Unauthorized");
  forward(req, socket, head, playwrightUpstream, "/pw");
});

// CDP clients read /json/version first and connect to the URL in it; Chrome
// writes its own loopback address there, so swap in the Host the client used.
const cdp = http.createServer(async (req, res) => {
  if (!cdpAllowed(req) || req.method !== "GET" && req.method !== "PUT") return res.writeHead(403).end();
  try {
    const upstream = await cdpRequest(req.url, req.method);
    const body = upstream.body.toString().replaceAll(`127.0.0.1:${cdpUpstream}`, () => req.headers.host);
    res.writeHead(upstream.status, { "content-type": upstream.headers["content-type"] ?? "application/json" });
    res.end(body);
  } catch {
    res.writeHead(502).end();
  }
});
cdp.on("upgrade", (req, socket, head) => {
  socket.on("error", () => socket.destroy());
  if (!cdpAllowed(req) || !req.url.startsWith("/devtools/")) return refuse(socket, "403 Forbidden");
  if (sessions >= maxSessions) return refuse(socket, "503 Service Unavailable");
  cdpSessions++;
  forward(req, socket, head, cdpUpstream, req.url, cdpClosed);
});

playwright.listen(port, "::", () => console.log(`playwright on :${port}, cap ${maxSessions}`));
cdp.listen(cdpPort, "::", () => console.log(`cdp on :${cdpPort}`));
