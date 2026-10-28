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
if (token.length < 16) {
  console.error("BROWSERS_TOKEN must be set to at least 16 characters");
  process.exit(1);
}
const port = Number(process.env.PORT ?? 3000);
const cdpPort = Number(process.env.CDP_PORT ?? 9222);
const maxSessions = Number(process.env.MAX_SESSIONS ?? 4);
const idleMs = Number(process.env.IDLE_TIMEOUT_SECONDS ?? 300) * 1000;
const playwrightUpstream = port + 1;
const cdpUpstream = cdpPort + 1;
let sessions = 0;

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
  "--remote-allow-origins=*",
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
function forward(req, socket, head, upstreamPort, path) {
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

function tokenMatches(url) {
  const given = Buffer.from(new URL(url, "http://x").pathname.slice(1));
  return given.length === token.length && timingSafeEqual(given, token);
}

const playwright = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ sessions, maxSessions }));
  }
  res.writeHead(404).end();
});
playwright.on("upgrade", (req, socket, head) => {
  if (!tokenMatches(req.url)) return refuse(socket, "401 Unauthorized");
  forward(req, socket, head, playwrightUpstream, "/pw");
});

// CDP clients read /json/version first and connect to the URL in it; Chrome
// writes its own loopback address there, so swap in the Host the client used.
const cdp = http.createServer((req, res) => {
  const upstream = http.request(
    {
      host: "127.0.0.1",
      port: cdpUpstream,
      path: req.url,
      method: req.method,
      headers: { host: `127.0.0.1:${cdpUpstream}` },
    },
    (upstreamRes) => {
      const chunks = [];
      upstreamRes.on("data", (chunk) => chunks.push(chunk));
      upstreamRes.on("end", () => {
        const body = Buffer.concat(chunks)
          .toString()
          .replaceAll(`127.0.0.1:${cdpUpstream}`, req.headers.host ?? `localhost:${cdpPort}`);
        res.writeHead(upstreamRes.statusCode ?? 502, {
          "content-type": upstreamRes.headers["content-type"] ?? "application/json",
        });
        res.end(body);
      });
    },
  );
  upstream.on("error", () => res.writeHead(502).end());
  req.pipe(upstream);
});
cdp.on("upgrade", (req, socket, head) => forward(req, socket, head, cdpUpstream, req.url));

playwright.listen(port, "::", () => console.log(`playwright on :${port}, cap ${maxSessions}`));
cdp.listen(cdpPort, "::", () => console.log(`cdp on :${cdpPort}`));
