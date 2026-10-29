import assert from "node:assert/strict";
import { once } from "node:events";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import { describe, it } from "node:test";

import { createPodsProxy, pacUrl, socks5Dial } from "./pods-proxy.mjs";

const listen = async (server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
};

describe("pacUrl", () => {
  const pacScript = (address) => {
    const url = pacUrl(address);
    const prefix = "data:application/x-ns-proxy-autoconfig;base64,";
    assert.ok(url.startsWith(prefix));
    return Buffer.from(url.slice(prefix.length), "base64").toString();
  };
  // dnsDomainIs as browsers define it: the host ends with the domain.
  const findProxy = (address) =>
    new Function("dnsDomainIs", `${pacScript(address)}; return FindProxyForURL;`)((host, domain) =>
      host.endsWith(domain),
    );

  it("sends *.pods.internal to the proxy and everything else direct", () => {
    const find = findProxy("127.0.0.1:8080");
    assert.equal(find("https://app-web.pods.internal/", "app-web.pods.internal"), "PROXY 127.0.0.1:8080");
    assert.equal(find("https://a.b.pods.internal/", "a.b.pods.internal"), "PROXY 127.0.0.1:8080");
    assert.equal(find("https://example.com/", "example.com"), "DIRECT");
    assert.equal(find("https://pods.internal.evil.com/", "pods.internal.evil.com"), "DIRECT");
    assert.equal(find("http://localhost/", "localhost"), "DIRECT");
  });

  it("embeds the given proxy address", () => {
    assert.match(pacScript("127.0.0.1:1234"), /PROXY 127\.0\.0\.1:1234/);
  });
});

// A fake SOCKS5 server. `script` receives the accepted socket and the parsed
// request so tests can choose the replies. Requests it saw land in `seen`.
async function fakeSocks(t, reply) {
  const seen = [];
  const sockets = new Set();
  const server = NodeNet.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffered = Buffer.alloc(0);
    let greeted = false;
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (!greeted) {
        if (buffered.length < 3) return;
        seen.push({ greeting: [...buffered.subarray(0, 3)] });
        buffered = buffered.subarray(3);
        greeted = true;
        reply.greeting(socket);
      }
      if (greeted && buffered.length >= 10) {
        const request = buffered.subarray(0, 10);
        seen.push({
          request: [...request.subarray(0, 4)],
          ip: [...request.subarray(4, 8)].join("."),
          port: request.readUInt16BE(8),
        });
        buffered = buffered.subarray(10);
        reply.connect(socket, buffered);
        buffered = Buffer.alloc(0);
      }
    });
  });
  const port = await listen(server);
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return { port, seen, sockets };
}

const ok = Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
const echoAfterConnect = {
  greeting: (socket) => socket.write(Buffer.from([5, 0])),
  connect: (socket) => {
    socket.write(ok);
    socket.on("data", (chunk) => socket.write(chunk));
  },
};

describe("socks5Dial", () => {
  it("sends a no-auth greeting then a CONNECT for the IPv4 and port, and resolves a usable tunnel", async (t) => {
    const socks = await fakeSocks(t, echoAfterConnect);
    const socket = await socks5Dial("127.0.0.1", socks.port)("100.64.1.2", 8443);
    t.after(() => socket.destroy());
    assert.deepEqual(socks.seen, [
      { greeting: [5, 1, 0] },
      { request: [5, 1, 0, 1], ip: "100.64.1.2", port: 8443 },
    ]);
    assert.equal(socket.isPaused(), true);
    const echoed = once(socket, "data");
    socket.resume();
    socket.write("ping");
    assert.equal((await echoed)[0].toString(), "ping");
  });

  it("encodes high ports and octets correctly", async (t) => {
    const socks = await fakeSocks(t, echoAfterConnect);
    const socket = await socks5Dial("127.0.0.1", socks.port)("255.0.128.1", 65535);
    t.after(() => socket.destroy());
    assert.deepEqual(socks.seen[1], { request: [5, 1, 0, 1], ip: "255.0.128.1", port: 65535 });
  });

  it("handles replies split across arbitrary chunk boundaries", async (t) => {
    const socks = await fakeSocks(t, {
      greeting: (socket) => {
        socket.write(Buffer.from([5]));
        setImmediate(() => socket.write(Buffer.from([0])));
      },
      connect: (socket) => {
        for (const byte of ok) socket.write(Buffer.from([byte]));
        socket.on("data", (chunk) => socket.write(chunk));
      },
    });
    const socket = await socks5Dial("127.0.0.1", socks.port)("100.64.0.1", 443);
    t.after(() => socket.destroy());
    const echoed = once(socket, "data");
    socket.resume();
    socket.write("x");
    assert.equal((await echoed)[0].toString(), "x");
  });

  it("delivers bytes the server sent right behind the CONNECT reply", async (t) => {
    const socks = await fakeSocks(t, {
      greeting: (socket) => socket.write(Buffer.from([5, 0])),
      connect: (socket) => socket.write(Buffer.concat([ok, Buffer.from("SERVER-HELLO")])),
    });
    const socket = await socks5Dial("127.0.0.1", socks.port)("100.64.0.1", 443);
    t.after(() => socket.destroy());
    let received = "";
    for await (const chunk of socket) {
      received += chunk;
      if (received.length >= "SERVER-HELLO".length) break;
    }
    assert.equal(received, "SERVER-HELLO");
  });

  it("rejects when the server wants authentication", async (t) => {
    const socks = await fakeSocks(t, { greeting: (socket) => socket.write(Buffer.from([5, 0xff])), connect: () => {} });
    await assert.rejects(socks5Dial("127.0.0.1", socks.port)("100.64.0.1", 443), /SOCKS5 auth refused/);
  });

  it("rejects a reply that is not SOCKS version 5", async (t) => {
    const socks = await fakeSocks(t, { greeting: (socket) => socket.write(Buffer.from([4, 0])), connect: () => {} });
    await assert.rejects(socks5Dial("127.0.0.1", socks.port)("100.64.0.1", 443), /SOCKS5 auth refused/);
  });

  for (const [code, name] of [
    [1, "general failure"],
    [2, "not allowed"],
    [3, "network unreachable"],
    [4, "host unreachable"],
    [5, "connection refused"],
  ])
    it(`rejects a CONNECT reply with status ${code} (${name}) and closes the socket`, async (t) => {
      const socks = await fakeSocks(t, {
        greeting: (socket) => socket.write(Buffer.from([5, 0])),
        connect: (socket) => socket.write(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0])),
      });
      await assert.rejects(socks5Dial("127.0.0.1", socks.port)("100.64.0.1", 443), {
        message: `SOCKS5 connect failed (${code})`,
      });
    });

  it("rejects when the SOCKS server is unreachable", async (t) => {
    const probe = NodeNet.createServer();
    const port = await listen(probe);
    probe.close();
    await once(probe, "close");
    await assert.rejects(socks5Dial("127.0.0.1", port)("100.64.0.1", 443), /ECONNREFUSED/);
  });

  it("rejects when the server hangs up mid-handshake", async (t) => {
    const socks = await fakeSocks(t, { greeting: (socket) => socket.destroy(), connect: () => {} });
    await assert.rejects(socks5Dial("127.0.0.1", socks.port)("100.64.0.1", 443));
  });
});

// ---- createPodsProxy ----

// A stand-in for the pods proxy host: HTTP server that echoes what it saw as JSON,
// plus raw CONNECT-style byte echo on a second server.
async function startProxy(t, { dial } = {}) {
  const dialed = [];
  const host = NodeHttp.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      if (req.url.startsWith("/status/")) {
        res.writeHead(Number(req.url.slice(8)), { "x-upstream": "yes", "content-type": "text/plain" });
        return res.end("status body");
      }
      if (req.url === "/hangup") return req.socket.destroy();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
    });
  });
  const tunnelHost = NodeNet.createServer((socket) => {
    socket.on("error", () => {});
    socket.on("data", (chunk) => socket.write(chunk));
    tunnelHost.sockets.add(socket);
    tunnelHost.closes.push(once(socket, "close"));
    socket.on("close", () => tunnelHost.sockets.delete(socket));
  });
  tunnelHost.sockets = new Set();
  tunnelHost.closes = [];
  const hostPort = await listen(host);
  const tunnelPort = await listen(tunnelHost);
  const proxy = createPodsProxy({
    targetIp: "100.64.9.9",
    dial:
      dial ??
      (async (ip, port) => {
        dialed.push({ ip, port });
        return NodeNet.connect(port === 443 ? tunnelPort : hostPort, "127.0.0.1");
      }),
  });
  const port = await listen(proxy);
  const clients = new Set();
  t.after(() => {
    for (const client of clients) client.destroy();
    for (const socket of tunnelHost.sockets) socket.destroy();
    proxy.closeAllConnections();
    proxy.close();
    host.closeAllConnections();
    host.close();
    tunnelHost.close();
  });
  return { port, dialed, clients, tunnelHost };
}

async function viaProxy(port, target, { method = "GET", headers = {}, body } = {}) {
  const url = new URL(target);
  const req = NodeHttp.request({
    host: "127.0.0.1",
    port,
    method,
    path: target,
    headers: { host: url.host, ...headers },
    agent: false,
  });
  req.end(body);
  const [res] = await once(req, "response");
  const chunks = [];
  for await (const chunk of res) chunks.push(chunk);
  return { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() };
}

describe("createPodsProxy: plain HTTP", () => {
  it("dials the target IP and forwards the origin-form path and query, keeping the pod hostname as Host", async (t) => {
    const proxy = await startProxy(t);
    const res = await viaProxy(proxy.port, "http://app-web.pods.internal:80/some/path?x=1&y=2", {
      headers: { host: "app-web.pods.internal:80" },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(proxy.dialed, [{ ip: "100.64.9.9", port: 80 }]);
    const seen = JSON.parse(res.body);
    assert.equal(seen.url, "/some/path?x=1&y=2");
    assert.equal(seen.method, "GET");
    assert.equal(seen.headers.host, "app-web.pods.internal:80");
  });

  it("defaults to port 80", async (t) => {
    const proxy = await startProxy(t);
    const res = await viaProxy(proxy.port, "http://app-web.pods.internal/");
    assert.deepEqual(proxy.dialed, [{ ip: "100.64.9.9", port: 80 }]);
    assert.equal(JSON.parse(res.body).headers.host, "app-web.pods.internal");
  });

  it("forwards the method and body", async (t) => {
    const proxy = await startProxy(t);
    const res = await viaProxy(proxy.port, "http://app-web.pods.internal/api", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "9" },
      body: '{"a":"b"}',
    });
    const seen = JSON.parse(res.body);
    assert.equal(seen.method, "POST");
    assert.equal(seen.body, '{"a":"b"}');
  });

  it("drops proxy headers, forces Connection: close, keeps the rest", async (t) => {
    const proxy = await startProxy(t);
    const res = await viaProxy(proxy.port, "http://app-web.pods.internal/", {
      headers: {
        "proxy-connection": "keep-alive",
        "proxy-authorization": "Basic c2VjcmV0",
        "x-custom": "kept",
        cookie: "a=b",
      },
    });
    const { headers } = JSON.parse(res.body);
    assert.equal(headers["proxy-connection"], undefined);
    assert.equal(headers["proxy-authorization"], undefined);
    assert.equal(headers.connection, "close");
    assert.equal(headers["x-custom"], "kept");
    assert.equal(headers.cookie, "a=b");
  });

  it("relays the upstream status, headers and body", async (t) => {
    const proxy = await startProxy(t);
    for (const status of [201, 302, 404, 500]) {
      const res = await viaProxy(proxy.port, `http://app-web.pods.internal/status/${status}`);
      assert.equal(res.status, status);
      assert.equal(res.headers["x-upstream"], "yes");
      assert.equal(res.body, "status body");
    }
  });

  it("answers 502 when the upstream drops the connection before responding", async (t) => {
    const proxy = await startProxy(t);
    const res = await viaProxy(proxy.port, "http://app-web.pods.internal/hangup");
    assert.equal(res.status, 502);
  });

  it("answers 502 when the dial fails", async (t) => {
    const proxy = await startProxy(t, {
      dial: async () => {
        throw new Error("SOCKS5 connect failed (5)");
      },
    });
    assert.equal((await viaProxy(proxy.port, "http://app-web.pods.internal/")).status, 502);
  });

  describe("refusals dial nothing", () => {
    const refused = [
      ["a public host", "http://example.com/"],
      ["a lookalike suffix", "http://app.pods.internal.evil.com/"],
      ["a bare domain without a subdomain", "http://pods.internal/"],
      ["an IP address", "http://100.64.9.9/"],
      ["a host merely containing the domain", "http://notpods.internal/"],
      ["https", "https://app-web.pods.internal/"],
      ["port 8080", "http://app-web.pods.internal:8080/"],
      ["port 22", "http://app-web.pods.internal:22/"],
      ["ftp", "ftp://app-web.pods.internal/"],
    ];
    for (const [name, target] of refused)
      it(`403 for ${name}`, async (t) => {
        const proxy = await startProxy(t);
        const res = await viaProxy(proxy.port, target);
        assert.equal(res.status, 403);
        assert.deepEqual(proxy.dialed, []);
      });

    it("403 for a bare .pods.internal host", async (t) => {
      const proxy = await startProxy(t);
      const res = await viaProxy(proxy.port, "http://.pods.internal/", { headers: { host: ".pods.internal" } });
      assert.equal(res.status, 403);
      assert.deepEqual(proxy.dialed, []);
    });

    it("400 for a request that is not in absolute form", async (t) => {
      const proxy = await startProxy(t);
      const req = NodeHttp.request({ host: "127.0.0.1", port: proxy.port, path: "/just/a/path", agent: false });
      req.end();
      const [res] = await once(req, "response");
      res.resume();
      assert.equal(res.statusCode, 400);
      assert.deepEqual(proxy.dialed, []);
    });
  });

  it("matches the pods domain case-insensitively", async (t) => {
    const proxy = await startProxy(t);
    const res = await viaProxy(proxy.port, "http://App-Web.PODS.Internal/");
    assert.equal(res.status, 200);
  });
});

// CONNECT through the proxy with raw sockets, resolving the status line.
function connect(proxy, target, trailing = "") {
  const socket = NodeNet.connect(proxy.port, "127.0.0.1");
  proxy.clients.add(socket);
  socket.on("error", () => {});
  let text = "";
  const head = new Promise((resolve) => {
    socket.on("data", function onData(chunk) {
      text += chunk.toString("latin1");
      const end = text.indexOf("\r\n\r\n");
      if (end !== -1) {
        socket.off("data", onData);
        resolve({ statusLine: text.slice(0, text.indexOf("\r\n")), rest: text.slice(end + 4) });
      }
    });
  });
  socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n${trailing}`);
  return { socket, head, closed: once(socket, "close") };
}

describe("createPodsProxy: CONNECT", () => {
  it("establishes a tunnel to the target IP and pipes bytes both ways", async (t) => {
    const proxy = await startProxy(t);
    const tunnel = connect(proxy, "app-web.pods.internal:443");
    assert.equal((await tunnel.head).statusLine, "HTTP/1.1 200 Connection Established");
    assert.deepEqual(proxy.dialed, [{ ip: "100.64.9.9", port: 443 }]);
    const echoed = once(tunnel.socket, "data");
    tunnel.socket.write("tls-client-hello");
    assert.equal((await echoed)[0].toString(), "tls-client-hello");
    const again = once(tunnel.socket, "data");
    tunnel.socket.write("second");
    assert.equal((await again)[0].toString(), "second");
  });

  it("dials port 443 for an explicit :443 and when the target has no port, and 80 for :80", async (t) => {
    const proxy = await startProxy(t);
    for (const target of ["app-web.pods.internal:443", "app-web.pods.internal", "app-web.pods.internal:80"]) {
      const tunnel = connect(proxy, target);
      assert.equal((await tunnel.head).statusLine, "HTTP/1.1 200 Connection Established");
    }
    assert.deepEqual(proxy.dialed.map((d) => d.port), [443, 443, 80]);
  });

  it("forwards bytes sent in the same packet as the CONNECT request", async (t) => {
    const proxy = await startProxy(t);
    const tunnel = connect(proxy, "app-web.pods.internal:443", "EARLY-BYTES");
    const { rest } = await tunnel.head;
    let received = rest;
    if (!received.includes("EARLY-BYTES")) {
      const [chunk] = await once(tunnel.socket, "data");
      received += chunk.toString();
    }
    assert.ok(received.includes("EARLY-BYTES"));
  });

  it("closes the upstream when the client goes away", async (t) => {
    const proxy = await startProxy(t);
    const tunnel = connect(proxy, "app-web.pods.internal:443");
    await tunnel.head;
    assert.equal(proxy.tunnelHost.closes.length, 1);
    tunnel.socket.destroy();
    await Promise.all(proxy.tunnelHost.closes);
  });

  it("closes the client when the upstream goes away", async (t) => {
    const proxy = await startProxy(t);
    const tunnel = connect(proxy, "app-web.pods.internal:443");
    await tunnel.head;
    for (const socket of proxy.tunnelHost.sockets) socket.destroy();
    await tunnel.closed;
  });

  for (const target of [
    "example.com:443",
    "app.pods.internal.evil.com:443",
    "pods.internal:443",
    "100.64.9.9:443",
    "notpods.internal:443",
    "app-web.pods.internal:22",
    "app-web.pods.internal:8080",
    "app-web.pods.internal:0",
    "app-web.pods.internal:4430",
  ])
    it(`403 and no dial for ${target}`, async (t) => {
      const proxy = await startProxy(t);
      const tunnel = connect(proxy, target);
      assert.equal((await tunnel.head).statusLine, "HTTP/1.1 403 Forbidden");
      await tunnel.closed;
      assert.deepEqual(proxy.dialed, []);
    });

  it("502 when the dial fails", async (t) => {
    const proxy = await startProxy(t, {
      dial: async () => {
        throw new Error("unreachable");
      },
    });
    const tunnel = connect(proxy, "app-web.pods.internal:443");
    assert.equal((await tunnel.head).statusLine, "HTTP/1.1 502 Bad Gateway");
    await tunnel.closed;
  });

  for (const target of ["[", "a:b:c", "x.pods.internal:99999", "/"])
    it(`400 and no dial for the malformed CONNECT target ${JSON.stringify(target)}`, async (t) => {
      const proxy = await startProxy(t);
      const tunnel = connect(proxy, target);
      assert.equal((await tunnel.head).statusLine, "HTTP/1.1 400 Bad Request");
      await tunnel.closed;
      assert.deepEqual(proxy.dialed, []);
      // The proxy still serves afterwards.
      assert.equal((await viaProxy(proxy.port, "http://app-web.pods.internal/")).status, 200);
    });
});
