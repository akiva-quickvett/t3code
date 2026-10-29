// Browser pool front for Railway. Runs `playwright run-server` (a fresh
// Chromium per connection) and one shared headless Chromium for raw CDP, both
// on loopback, and fronts them on all interfaces with a session cap, an idle
// timeout and a token. With TS_AUTHKEY it also joins the tailnet and routes
// *.pods.internal there. Setup and clients: README.md.
import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { chromium } from "playwright";
import { createFront } from "./front.mjs";
import { createPodsProxy, pacUrl, socks5Dial } from "./pods-proxy.mjs";
import { startTailnet } from "./tailnet.mjs";

// start.sh hands the secrets over on stdin, one per line, and keeps them out
// of every process's environment.
const [tokenLine = "", authKey = ""] = NodeFs.readFileSync(0, "utf8").split("\n");
const token = Buffer.from(tokenLine);
if (token.length < 16) {
  console.error("BROWSERS_TOKEN must be set to at least 16 characters (start.sh passes it on stdin)");
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
// Userspace tailscaled delivers tailnet connections to 127.0.0.1, so internal
// listeners that can bind elsewhere stay off it. Chrome's debugging port
// cannot: it always binds 127.0.0.1 (README: Tailnet).
const internalHost = "127.0.0.2";
const playwrightUpstream = { host: internalHost, port: port + 1 };
const cdpUpstream = { host: "127.0.0.1", port: cdpPort + 1 };
const socks = { host: internalHost, port: 1055 };
const podsProxy = { host: internalHost, port: 1056 };

// The tailnet and pods routing are optional: a bad setting logs and turns
// them off, never stops the browsers.
const tailnet = authKey
  ? startTailnet({ authKey, hostname: "railway-browser", socksAddress: `${socks.host}:${socks.port}` })
  : undefined;
const podsHostIp = process.env.PODS_HOST_IP ?? "";
if (podsHostIp && !NodeNet.isIPv4(podsHostIp))
  console.error("PODS_HOST_IP is not an IPv4 address; *.pods.internal stays off");
const podsRouting = Boolean(tailnet && NodeNet.isIPv4(podsHostIp));

// Chrome reads its trusted roots from the user's NSS database.
function trustPodsCa(pem) {
  const dir = NodePath.join(NodeOs.homedir(), ".pki/nssdb");
  NodeFs.mkdirSync(dir, { recursive: true });
  const certutil = (args, input) =>
    NodeChildProcess.execFileSync("certutil", ["-d", `sql:${dir}`, ...args], { input, stdio: "pipe" });
  try {
    if (!NodeFs.existsSync(NodePath.join(dir, "cert9.db"))) certutil(["-N", "--empty-password"]);
    certutil(["-A", "-t", "C,,", "-n", "pods-internal"], pem.replaceAll("\\n", "\n"));
  } catch (error) {
    const reason = error.stderr?.toString().split("\n")[0] || error.message;
    console.error(`PODS_CA_PEM not trusted (${reason}); pods HTTPS will fail`);
  }
}
if (podsRouting) {
  if (process.env.PODS_CA_PEM) trustPodsCa(process.env.PODS_CA_PEM);
  // Chromium on Linux reads a PAC URL from auto_proxy; both browsers inherit it.
  process.env.auto_proxy = pacUrl(`${podsProxy.host}:${podsProxy.port}`);
  createPodsProxy({ targetIp: podsHostIp, dial: socks5Dial(socks.host, socks.port) }).listen(
    podsProxy.port,
    podsProxy.host,
    () => console.log(`*.pods.internal -> ${podsHostIp} via the tailnet`),
  );
}

const children = [];
function start(command, args) {
  const child = NodeChildProcess.spawn(command, args, { stdio: ["ignore", "inherit", "inherit"] });
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

start(NodeURL.fileURLToPath(new URL("node_modules/.bin/playwright", import.meta.url)), [
  "run-server",
  "--host",
  playwrightUpstream.host,
  "--port",
  String(playwrightUpstream.port),
  "--path",
  "/pw",
]);
start(chromium.executablePath(), [
  "--headless=new",
  `--remote-debugging-port=${cdpUpstream.port}`,
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--disable-background-networking",
  "--user-data-dir=/tmp/cdp-profile",
  "about:blank",
]);

let ready = false;
function upstreamsReady() {
  if (ready) return Promise.resolve(true);
  const probe = ({ host, port }) =>
    new Promise((resolve) => {
      const socket = NodeNet.connect(port, host, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
  return Promise.all([probe(playwrightUpstream), probe(cdpUpstream)]).then(
    (ok) => (ready = ok.every(Boolean)),
  );
}

const { playwright, cdp } = createFront({
  token,
  maxSessions,
  idleMs,
  playwrightUpstream,
  cdpUpstream,
  ready: upstreamsReady,
  tailnet: tailnet?.status,
  playwrightChannel: podsRouting ? "chromium" : undefined,
});
playwright.listen(port, "::", () => console.log(`playwright on :${port}, cap ${maxSessions}`));
cdp.listen(cdpPort, "::", () => console.log(`cdp on :${cdpPort}`));
