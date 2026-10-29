// Joins the tailnet with a userspace tailscaled (Railway has no TUN device).
// State lives in memory: replicas cannot share a volume, so each boot joins
// afresh with the auth key, which should be reusable and ephemeral. Setup and
// the ACL the node needs: README.md.
import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

const socket = "/tmp/tailscale/tailscaled.sock";

// Node's stdin pipe is a socket, which `file:/dev/stdin` cannot open; `cat`
// turns it into a real pipe.
function tailscale(args, { timeout = 90_000, input } = {}) {
  return new Promise((resolve) => {
    const child = NodeChildProcess.execFile(
      "sh",
      ["-c", 'cat | exec tailscale "$@"', "tailscale", `--socket=${socket}`, ...args],
      { timeout },
      (error, stdout) => resolve({ ok: !error, stdout }),
    );
    child.stdin.end(input);
  });
}

async function readStatus() {
  const { ok, stdout } = await tailscale(["status", "--json"], { timeout: 5000 });
  let status;
  try {
    status = ok && JSON.parse(stdout);
  } catch {}
  if (!status) return { state: "Unreachable", ip: null, name: null };
  return {
    state: status.BackendState,
    ip: status.Self?.TailscaleIPs?.find((ip) => ip.includes(".")) ?? null,
    // The MagicDNS label tells replicas apart (railway-browser, railway-browser-1).
    name: status.Self?.DNSName?.split(".")[0] || null,
  };
}

async function join(authKey, hostname) {
  let status;
  for (let i = 0; i < 30; i++) {
    status = await readStatus();
    if (!["Unreachable", "NoState", "Starting"].includes(status.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (status.state !== "NeedsLogin") return;
  // On stdin, never on disk: Chrome runs as the same user and can read files.
  const { ok } = await tailscale(
    [
      "up",
      "--auth-key=file:/dev/stdin",
      `--hostname=${hostname}`,
      "--accept-dns=false",
      "--accept-routes=false",
      "--timeout=60s",
    ],
    { input: authKey },
  );
  if (!ok) console.error("tailscale: up failed (expired, used or untagged auth key?)");
}

// Runs tailscaled for the life of the process, rejoining after a restart.
// Never blocks the browsers; status() is for /healthz.
export function startTailnet({ authKey, hostname, socksAddress }) {
  let current = { state: "Starting", ip: null, name: null };
  const refresh = async () => {
    current = await readStatus();
  };
  const run = () => {
    NodeFs.mkdirSync(NodePath.dirname(socket), { recursive: true });
    const log = NodeFs.openSync("/tmp/tailscale/tailscaled.log", "a");
    const daemon = NodeChildProcess.spawn(
      "tailscaled",
      [
        "--tun=userspace-networking",
        "--state=mem:",
        `--socket=${socket}`,
        `--socks5-server=${socksAddress}`,
      ],
      // The Railway-to-tailnet path drops full 1280-byte packets; TLS stalls.
      { env: { ...process.env, TS_DEBUG_MTU: "1200" }, stdio: ["ignore", log, log] },
    );
    NodeFs.closeSync(log);
    daemon.on("exit", (code, signal) => {
      console.error(`tailscaled exited (${code ?? signal}); restarting in 10 s`);
      current = { state: "Stopped", ip: null, name: null };
      setTimeout(run, 10_000);
    });
    join(authKey, hostname)
      .then(refresh)
      .then(() => console.log(`tailscale: ${current.state} ${current.name ?? ""} ${current.ip ?? ""}`));
  };
  run();
  setInterval(refresh, 30_000).unref();
  return { status: () => current };
}
