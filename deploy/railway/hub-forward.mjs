// Plain TCP on 127.0.0.1:8317 for local clients, TLS to the CLIProxyAPI hub
// through tailscaled's outbound HTTP proxy. Userspace networking has no TUN,
// so this is the only way out to the tailnet; clients need no proxy settings.
import * as NodeNet from "node:net";
import * as NodeStream from "node:stream";
import * as NodeTls from "node:tls";

const hub = new URL(process.env.HUB_URL || "https://omarchy.tail43a582.ts.net:8317");
const target = `${hub.hostname}:${hub.port || 443}`;
const proxyPort = Number(process.env.TS_HTTP_PROXY_PORT || 1055);
const listenPort = Number(process.env.HUB_LOCAL_PORT || 8317);

function refuse(client, reason) {
  const body = JSON.stringify({ error: `hub unreachable: ${reason}` });
  client.end(
    `HTTP/1.1 502 Bad Gateway\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
  );
}

const server = NodeNet.createServer((client) => {
  client.pause();
  let piped = false;
  const tunnel = NodeNet.connect(proxyPort, "127.0.0.1", () =>
    tunnel.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`),
  );
  // A tailnet outage stalls the dial; answer while the client can still retry.
  tunnel.setTimeout(15_000, () => tunnel.destroy(new Error("timed out")));
  client.on("error", () => {});
  client.on("close", () => tunnel.destroy());
  tunnel.on("error", (err) => {
    if (!piped) refuse(client, `tailscale proxy: ${err.code || err.message}`);
  });
  let head = Buffer.alloc(0);
  const onHead = (chunk) => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end < 0) {
      if (head.length > 8192) tunnel.destroy(new Error("oversized CONNECT reply"));
      return;
    }
    tunnel.off("data", onHead);
    tunnel.pause();
    const status = head.toString("latin1", 0, head.indexOf("\r\n"));
    if (!/^HTTP\/1\.[01] 200\b/.test(status)) {
      tunnel.destroy();
      return refuse(client, `tailscale proxy answered ${status.slice(0, 80)}`);
    }
    if (end + 4 < head.length) tunnel.unshift(head.subarray(end + 4));
    const tls = NodeTls.connect({ socket: tunnel, servername: hub.hostname });
    tls.once("error", (err) => refuse(client, `TLS: ${err.code || err.message}`));
    tls.once("secureConnect", () => {
      piped = true;
      tunnel.setTimeout(0);
      tls.removeAllListeners("error");
      client.resume();
      NodeStream.pipeline(client, tls, client, () => {});
    });
  };
  tunnel.on("data", onHead);
});

server.listen(listenPort, "127.0.0.1", () =>
  console.log(`hub forwarder: 127.0.0.1:${listenPort} -> ${target} via tailscale`),
);
