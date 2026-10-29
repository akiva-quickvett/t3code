// Loopback proxy that carries Chrome's *.pods.internal traffic to the pods
// proxy host over the tailnet. Tailscale cannot resolve pods.internal, so every
// such host is dialled at one IP with the same port; the hostname stays in the
// Host header and the TLS SNI, which the pods proxy routes on.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

export const podsDomain = ".pods.internal";

// Chrome sends only *.pods.internal here; everything else goes direct.
export function pacUrl(proxyAddress) {
  const script = `function FindProxyForURL(url, host) { return dnsDomainIs(host, "${podsDomain}") ? "PROXY ${proxyAddress}" : "DIRECT"; }`;
  return `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(script).toString("base64")}`;
}

// Only the pods proxy's ports, so a page cannot reach the rest of its host.
const podsPorts = new Set([80, 443]);

function isPodsTarget(hostname, port) {
  return hostname.endsWith(podsDomain) && hostname.length > podsDomain.length && podsPorts.has(port);
}

// SOCKS5 CONNECT, no auth, to an IPv4 address (tailscaled's SOCKS5 server).
export function socks5Dial(socksHost, socksPort) {
  return (ip, port) =>
    new Promise((resolve, reject) => {
      const socket = NodeNet.connect(socksPort, socksHost);
      let buffered = Buffer.alloc(0);
      let step = "greeting";
      const fail = (error) => {
        socket.destroy();
        reject(error);
      };
      const closed = () => fail(new Error("SOCKS5 closed during handshake"));
      socket.setTimeout(15_000, () => fail(new Error("SOCKS5 dial timed out")));
      socket.on("error", fail);
      socket.on("close", closed);
      socket.on("connect", () => socket.write(Buffer.from([5, 1, 0])));
      const onData = (chunk) => {
        buffered = Buffer.concat([buffered, chunk]);
        if (step === "greeting") {
          if (buffered.length < 2) return;
          if (buffered[0] !== 5 || buffered[1] !== 0) return fail(new Error("SOCKS5 auth refused"));
          buffered = buffered.subarray(2);
          step = "connect";
          const request = Buffer.alloc(10);
          request.set([5, 1, 0, 1]);
          request.set(ip.split(".").map(Number), 4);
          request.writeUInt16BE(port, 8);
          socket.write(request);
        }
        // A reply to an IPv4 request carries an IPv4 bound address: 10 bytes.
        if (step === "connect" && buffered.length >= 10) {
          if (buffered[1] !== 0) return fail(new Error(`SOCKS5 connect failed (${buffered[1]})`));
          socket.off("data", onData);
          socket.off("error", fail);
          socket.off("close", closed);
          // Holds any bytes behind the reply until the caller reads.
          socket.pause();
          socket.setTimeout(0);
          if (buffered.length > 10) socket.unshift(buffered.subarray(10));
          resolve(socket);
        }
      };
      socket.on("data", onData);
    });
}

// `dial(ip, port)` resolves to a connected socket; tests pass their own.
export function createPodsProxy({ targetIp, dial }) {
  const server = NodeHttp.createServer(async (req, res) => {
    let target;
    try {
      target = new URL(req.url);
    } catch {
      return res.writeHead(400).end();
    }
    const port = Number(target.port || 80);
    if (target.protocol !== "http:" || !isPodsTarget(target.hostname, port))
      return res.writeHead(403).end();
    let socket;
    try {
      socket = await dial(targetIp, port);
    } catch {
      return res.writeHead(502).end();
    }
    // Each request gets its own tunnel, so the upstream connection ends with it.
    const headers = { ...req.headers, connection: "close" };
    delete headers["proxy-connection"];
    delete headers["proxy-authorization"];
    const upstream = NodeHttp.request(
      {
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers,
        createConnection: () => socket,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    // socks5Dial hands the socket over paused; http's parser is attached by now.
    upstream.on("socket", (s) => s.resume());
    upstream.on("error", () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
    req.pipe(upstream);
  });
  server.on("connect", async (req, client, head) => {
    client.on("error", () => client.destroy());
    let hostname, port;
    try {
      // https, so an explicit :80 survives: URL drops only the scheme's default.
      const target = new URL(`https://${req.url}`);
      hostname = target.hostname;
      port = Number(target.port || 443);
    } catch {
      return client.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
    }
    if (!isPodsTarget(hostname, port))
      return client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    let socket;
    try {
      socket = await dial(targetIp, port);
    } catch {
      return client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
    }
    // Chrome may have dropped a preconnect while the dial was in flight.
    if (client.destroyed) return socket.destroy();
    socket.on("error", () => client.destroy());
    client.on("close", () => socket.destroy());
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.write(head);
    client.pipe(socket).pipe(client);
  });
  return server;
}
