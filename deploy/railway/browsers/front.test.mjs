import assert from "node:assert/strict";
import { once } from "node:events";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import { describe, it } from "node:test";

import { cdpAccess, createFront, launchOptionsWithChannel, playwrightTokenMatches } from "./front.mjs";

const token = Buffer.from("0123456789abcdef-secret");
const tokenText = token.toString();

describe("playwrightTokenMatches", () => {
  const cases = [
    ["exact token", `/?token=${tokenText}`, true],
    ["token among other params", `/?a=1&token=${tokenText}&b=2`, true],
    ["token with no path", `?token=${tokenText}`, true],
    ["wrong token of the same length", `/?token=${"x".repeat(token.length)}`, false],
    ["token prefix", `/?token=${tokenText.slice(0, -1)}`, false],
    ["token with a suffix", `/?token=${tokenText}x`, false],
    ["no query", "/", false],
    ["empty query", "/?", false],
    ["empty token", "/?token=", false],
    ["token only in the path", `/${tokenText}`, false],
    ["differently named param", `/?t=${tokenText}`, false],
    ["multi-byte token with the same byte length is not equal", `/?token=${"é".repeat(token.length / 2)}`, false],
  ];
  for (const [name, url, expected] of cases)
    it(name, () => assert.equal(playwrightTokenMatches(url, token), expected));

  it("decodes percent-escapes before comparing", () => {
    assert.equal(playwrightTokenMatches(`/?token=${encodeURIComponent("a b&c")}`, Buffer.from("a b&c")), true);
  });
});

describe("cdpAccess", () => {
  const remote = "10.0.0.5";
  const access = (request) => cdpAccess({ remoteAddress: remote, ...request }, token);

  describe("token path prefix", () => {
    it("strips the prefix and reports it", () => {
      assert.deepEqual(access({ url: `/t/${tokenText}/json/version`, host: "evil.example" }), {
        path: "/json/version",
        prefix: `/t/${tokenText}`,
      });
    });
    it("keeps the query of the stripped path", () => {
      assert.deepEqual(access({ url: `/t/${tokenText}/json/new?about:blank`, host: "x" }), {
        path: "/json/new?about:blank",
        prefix: `/t/${tokenText}`,
      });
    });
    it("allows any Host, and loopback peers", () => {
      const url = `/t/${tokenText}/devtools/browser/abc`;
      assert.ok(access({ url, host: "public.example.com" }));
      assert.ok(access({ url, host: undefined }));
      assert.ok(cdpAccess({ url, host: "x", remoteAddress: "127.0.0.1" }, token));
    });
    it("refuses a wrong token, even from a private Host", () => {
      const wrong = "x".repeat(token.length);
      assert.equal(access({ url: `/t/${wrong}/json/version`, host: "browsers.railway.internal" }), null);
    });
    it("does not fall through to the tokenless rules when the token is wrong", () => {
      assert.equal(access({ url: "/t/short/json/version", host: "127.0.0.1:9222" }), null);
    });
    it("refuses a shorter or longer token", () => {
      for (const given of [tokenText.slice(0, -1), `${tokenText}x`])
        assert.equal(access({ url: `/t/${given}/json/version`, host: "browsers.railway.internal" }), null);
    });
    it("treats an empty token segment as no prefix: public Hosts are refused", () => {
      assert.equal(access({ url: "/t//json/version", host: "evil.example" }), null);
    });
    it("keeps a trailing slash in the stripped path (connectOverCDP appends json/version/)", () => {
      assert.deepEqual(access({ url: `/t/${tokenText}/json/version/`, host: "x" }), {
        path: "/json/version/",
        prefix: `/t/${tokenText}`,
      });
    });
    it("treats a prefix with no path after it as no prefix: public Hosts are refused", () => {
      assert.equal(access({ url: `/t/${tokenText}`, host: "evil.example" }), null);
    });
    it("refuses a token in the middle of the path", () => {
      assert.equal(access({ url: `/x/t/${tokenText}/json`, host: "evil.example" }), null);
    });
  });

  describe("tokenless", () => {
    const allowed = [
      "10.0.0.5:9222",
      "10.0.0.5",
      "browsers.railway.internal",
      "browsers.railway.internal:9222",
      "a.b.railway.internal:9222",
      "localhost",
      "localhost:9222",
      "[fd12::1]:9222",
      "[fd12::1]",
    ];
    for (const host of allowed)
      it(`allows Host ${host}`, () =>
        assert.deepEqual(access({ url: "/json/version", host }), { path: "/json/version", prefix: "" }));

    const refused = [
      "evil.example.com",
      "evil.example.com:9222",
      "railway.internal.evil.com",
      "xrailway.internal",
      "railway.internal",
      "fd12::1",
      "",
    ];
    for (const host of refused)
      it(`refuses Host ${JSON.stringify(host)}`, () => assert.equal(access({ url: "/json/version", host }), null));

    it("refuses a missing Host", () => assert.equal(access({ url: "/json/version" }), null));

    it("passes the url through untouched, query included", () => {
      assert.equal(access({ url: "/json/new?about:blank", host: "10.0.0.5" }).path, "/json/new?about:blank");
    });
  });

  describe("loopback peers (tailnet connections arrive from 127.0.0.1)", () => {
    for (const remoteAddress of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"])
      it(`refuses tokenless from ${remoteAddress}`, () =>
        assert.equal(cdpAccess({ url: "/json/version", host: "127.0.0.1:9222", remoteAddress }, token), null));

    for (const remoteAddress of ["10.0.0.5", "::ffff:10.0.0.5", "fd12::1", "128.0.0.1", undefined])
      it(`does not treat ${remoteAddress} as loopback`, () =>
        assert.ok(cdpAccess({ url: "/json/version", host: "10.0.0.5", remoteAddress }, token)));
  });

  describe("Origin", () => {
    it("refuses any request carrying an Origin, even with a valid token", () => {
      assert.equal(access({ url: `/t/${tokenText}/json/version`, host: "x", origin: "https://evil.example" }), null);
    });
    it("refuses an empty Origin header", () => {
      assert.equal(access({ url: "/json/version", host: "10.0.0.5", origin: "" }), null);
    });
    it("refuses Origin: null (sandboxed pages)", () => {
      assert.equal(access({ url: "/json/version", host: "10.0.0.5", origin: "null" }), null);
    });
  });
});

describe("launchOptionsWithChannel", () => {
  const parse = (header) => JSON.parse(launchOptionsWithChannel(header, "chromium"));

  it("adds the channel to existing options", () => {
    assert.deepEqual(parse('{"headless":true,"args":["--x"]}'), { headless: true, args: ["--x"], channel: "chromium" });
  });
  it("overrides a channel the client chose", () => {
    assert.deepEqual(parse('{"channel":"chrome","headless":false}'), { channel: "chromium", headless: false });
  });
  it("starts from nothing when the header is missing", () => {
    assert.deepEqual(parse(undefined), { channel: "chromium" });
  });
  for (const [name, header] of [
    ["malformed JSON", "{nope"],
    ["empty string", ""],
    ["null", "null"],
    ["a string", '"str"'],
    ["a number", "5"],
  ])
    it(`replaces ${name} with just the channel`, () => assert.deepEqual(parse(header), { channel: "chromium" }));

  it("turns an array into just the channel's wrapper object, not an array", () => {
    assert.equal(Array.isArray(parse("[1,2]")), false);
    assert.equal(parse("[1,2]").channel, "chromium");
  });
});

// ---- createFront over real sockets with loopback fake upstreams ----

const listen = async (server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
};

// An upstream that records requests and upgrades, answers 101, then echoes.
function fakeUpstream() {
  const upgrades = [];
  const requests = [];
  const sockets = new Set();
  const waiters = [];
  const routes = new Map();
  const server = NodeHttp.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    const route = routes.get(req.url.split("?")[0]) ?? routes.get(req.url);
    // Routes run up to their first await before waiters re-check.
    if (route) route(req, res);
    else res.writeHead(404).end();
    for (const waiter of waiters.splice(0)) waiter();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
      for (const waiter of waiters.splice(0)) waiter();
    });
  });
  server.on("upgrade", (req, socket, head) => {
    upgrades.push({ method: req.method, url: req.url, headers: req.headers, rawHeaders: req.rawHeaders, head });
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    if (head.length > 0) socket.write(head);
    socket.on("data", (chunk) => socket.write(chunk));
    // Like Chrome: answer the front's FIN with our own, so the session ends.
    socket.on("end", () => socket.end());
    socket.on("error", () => {});
    for (const waiter of waiters.splice(0)) waiter();
  });
  return {
    server,
    upgrades,
    requests,
    routes,
    sockets,
    // Resolves once `predicate()` holds, re-checked after every request, upgrade or socket close.
    until(predicate) {
      return new Promise((resolve) => {
        const check = () => (predicate() ? resolve() : waiters.push(check));
        check();
      });
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

async function startFront(t, options = {}) {
  const playwrightUp = fakeUpstream();
  const cdpUp = fakeUpstream();
  const playwrightPort = await listen(playwrightUp.server);
  const cdpPort = await listen(cdpUp.server);
  const front = createFront({
    token,
    maxSessions: 6,
    idleMs: 60_000,
    playwrightUpstream: { host: "127.0.0.1", port: playwrightPort },
    cdpUpstream: { host: "127.0.0.1", port: cdpPort },
    ready: async () => true,
    ...options,
  });
  const frontPorts = { playwright: await listen(front.playwright), cdp: await listen(front.cdp) };
  const clients = new Set();
  t.after(async () => {
    for (const client of clients) client.destroy();
    front.playwright.closeAllConnections();
    front.cdp.closeAllConnections();
    front.playwright.close();
    front.cdp.close();
    await playwrightUp.close();
    await cdpUp.close();
  });
  return { front, ports: frontPorts, playwrightUp, cdpUp, clients, cdpPort, playwrightPort };
}

// Sends a raw HTTP request and resolves the status line + headers as soon as
// they arrive, keeping the socket for tunnelled traffic.
function rawRequest(ctx, port, requestLine, headers = {}) {
  const socket = NodeNet.connect(port, "127.0.0.1");
  ctx.clients.add(socket);
  socket.on("error", () => {});
  let text = "";
  let resolveHead;
  const head = new Promise((resolve) => (resolveHead = resolve));
  socket.on("data", (chunk) => {
    text += chunk.toString("latin1");
    const end = text.indexOf("\r\n\r\n");
    if (end !== -1 && resolveHead) {
      const [statusLine, ...lines] = text.slice(0, end).split("\r\n");
      resolveHead({
        status: Number(statusLine.split(" ")[1]),
        headers: Object.fromEntries(lines.map((line) => line.split(/:\s*/, 2)).map(([k, v]) => [k.toLowerCase(), v])),
      });
      text = text.slice(end + 4);
      resolveHead = undefined;
    }
  });
  const lines = Object.entries({ Host: `127.0.0.1:${port}`, ...headers }).map(([k, v]) => `${k}: ${v}\r\n`);
  socket.write(`${requestLine} HTTP/1.1\r\n${lines.join("")}\r\n`);
  return { socket, head, closed: once(socket, "close") };
}

const upgradeHeaders = { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" };
const upgrade = (ctx, port, path, headers = {}) =>
  rawRequest(ctx, port, `GET ${path}`, { ...upgradeHeaders, ...headers });

async function httpGet(port, path, { method = "GET", headers = {} } = {}) {
  const req = NodeHttp.request({ host: "127.0.0.1", port, path, method, headers, agent: false });
  req.end();
  const [res] = await once(req, "response");
  const chunks = [];
  for await (const chunk of res) chunks.push(chunk);
  return { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() };
}

const echoes = async (client, text) => {
  const reply = once(client.socket, "data");
  client.socket.write(text);
  const [chunk] = await reply;
  assert.equal(chunk.toString(), text);
};

describe("createFront: Playwright front", () => {
  it("serves /healthz with the session counts", async (t) => {
    const ctx = await startFront(t, { maxSessions: 4 });
    const res = await httpGet(ctx.ports.playwright, "/healthz");
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /application\/json/);
    assert.deepEqual(JSON.parse(res.body), { ok: true, sessions: 0, maxSessions: 4 });
  });

  it("reports 503 when the browsers are not ready", async (t) => {
    const ctx = await startFront(t, { ready: async () => false });
    const res = await httpGet(ctx.ports.playwright, "/healthz");
    assert.equal(res.status, 503);
    assert.equal(JSON.parse(res.body).ok, false);
  });

  it("includes the tailnet status when a node runs one", async (t) => {
    const ctx = await startFront(t, { tailnet: () => ({ state: "Running", ip: "100.64.0.1" }) });
    const health = JSON.parse((await httpGet(ctx.ports.playwright, "/healthz")).body);
    assert.deepEqual(health.tailnet, { state: "Running", ip: "100.64.0.1" });
  });

  it("omits tailnet from /healthz when there is none", async (t) => {
    const ctx = await startFront(t);
    assert.equal("tailnet" in JSON.parse((await httpGet(ctx.ports.playwright, "/healthz")).body), false);
  });

  it("answers 404 to any other plain request", async (t) => {
    const ctx = await startFront(t);
    assert.equal((await httpGet(ctx.ports.playwright, "/")).status, 404);
    assert.equal((await httpGet(ctx.ports.playwright, `/?token=${tokenText}`)).status, 404);
  });

  it("refuses an upgrade with a missing or wrong token as 401 and never dials upstream", async (t) => {
    const ctx = await startFront(t);
    for (const path of ["/", "/?token=nope", `/?token=${"x".repeat(token.length)}`]) {
      const res = await upgrade(ctx, ctx.ports.playwright, path).head;
      assert.equal(res.status, 401);
      assert.equal(res.headers["retry-after"], "1");
    }
    assert.equal(ctx.playwrightUp.upgrades.length, 0);
  });

  it("forwards a valid upgrade to /pw with the Host rewritten and pipes both ways", async (t) => {
    const ctx = await startFront(t);
    const client = upgrade(ctx, ctx.ports.playwright, `/?token=${tokenText}`, { Host: "browsers.railway.internal:3000" });
    assert.equal((await client.head).status, 101);
    await echoes(client, "hello over the tunnel");
    const [seen] = ctx.playwrightUp.upgrades;
    assert.equal(seen.url, "/pw");
    assert.equal(seen.headers.host, `127.0.0.1:${ctx.playwrightPort}`);
    assert.equal(seen.headers["sec-websocket-key"], upgradeHeaders["Sec-WebSocket-Key"]);
  });

  it("passes the launch options through untouched without a channel", async (t) => {
    const ctx = await startFront(t);
    const options = '{"headless":true}';
    const client = upgrade(ctx, ctx.ports.playwright, `/?token=${tokenText}`, { "X-Playwright-Launch-Options": options });
    await client.head;
    assert.equal(ctx.playwrightUp.upgrades[0].headers["x-playwright-launch-options"], options);
  });

  it("forces the channel into the launch options, replacing the client's header", async (t) => {
    const ctx = await startFront(t, { playwrightChannel: "chromium" });
    const client = upgrade(ctx, ctx.ports.playwright, `/?token=${tokenText}`, {
      "X-Playwright-Launch-Options": '{"headless":true,"channel":"chrome"}',
    });
    await client.head;
    const [seen] = ctx.playwrightUp.upgrades;
    assert.deepEqual(JSON.parse(seen.headers["x-playwright-launch-options"]), { headless: true, channel: "chromium" });
    const sent = seen.rawHeaders.filter((name) => name.toLowerCase() === "x-playwright-launch-options");
    assert.equal(sent.length, 1);
  });

  it("forces the channel even when the client sent no launch options", async (t) => {
    const ctx = await startFront(t, { playwrightChannel: "chromium" });
    await upgrade(ctx, ctx.ports.playwright, `/?token=${tokenText}`).head;
    assert.deepEqual(JSON.parse(ctx.playwrightUp.upgrades[0].headers["x-playwright-launch-options"]), {
      channel: "chromium",
    });
  });

  it("counts open sessions in /healthz and frees them on close", async (t) => {
    const ctx = await startFront(t);
    const sessionsNow = async () => JSON.parse((await httpGet(ctx.ports.playwright, "/healthz")).body).sessions;
    const client = upgrade(ctx, ctx.ports.playwright, `/?token=${tokenText}`);
    await client.head;
    assert.equal(await sessionsNow(), 1);
    client.socket.destroy();
    await client.closed;
    await ctx.playwrightUp.until(() => ctx.playwrightUp.sockets.size === 0);
    assert.equal(await sessionsNow(), 0);
  });

  it("answers 503 with Retry-After beyond maxSessions, then admits again after a close", async (t) => {
    const ctx = await startFront(t, { maxSessions: 2 });
    const open = () => upgrade(ctx, ctx.ports.playwright, `/?token=${tokenText}`);
    const first = open();
    const second = open();
    await Promise.all([first.head, second.head]);
    const refused = await open().head;
    assert.equal(refused.status, 503);
    assert.equal(refused.headers["retry-after"], "1");
    assert.equal(ctx.playwrightUp.upgrades.length, 2);

    first.socket.destroy();
    // The front frees the slot before it destroys the upstream socket, so once Chrome's side is gone the slot is free.
    await ctx.playwrightUp.until(() => ctx.playwrightUp.sockets.size === 1);
    assert.equal((await open().head).status, 101);
  });

  it("does not leak a slot when the upstream cannot be reached", async (t) => {
    const ctx = await startFront(t, { maxSessions: 1 });
    await ctx.playwrightUp.close();
    for (let attempt = 0; attempt < 3; attempt++) {
      const client = upgrade(ctx, ctx.ports.playwright, `/?token=${tokenText}`);
      const outcome = await Promise.race([client.head.then((head) => head.status), client.closed.then(() => "closed")]);
      assert.equal(outcome, "closed");
    }
  });

  it("closes a session that is idle for idleMs, both ends", async (t) => {
    const ctx = await startFront(t, { idleMs: 40 });
    const client = upgrade(ctx, ctx.ports.playwright, `/?token=${tokenText}`);
    await client.head;
    await client.closed;
    await ctx.playwrightUp.until(() => ctx.playwrightUp.sockets.size === 0);
  });

  it("closes the client when the upstream hangs up", async (t) => {
    const ctx = await startFront(t);
    const client = upgrade(ctx, ctx.ports.playwright, `/?token=${tokenText}`);
    await client.head;
    for (const socket of ctx.playwrightUp.sockets) socket.destroy();
    await client.closed;
  });

  it("forwards bytes that arrive in the same packet as the upgrade request", async (t) => {
    const ctx = await startFront(t);
    const socket = NodeNet.connect(ctx.ports.playwright, "127.0.0.1");
    ctx.clients.add(socket);
    const lines = Object.entries({ Host: "x", ...upgradeHeaders }).map(([k, v]) => `${k}: ${v}\r\n`);
    const echoed = new Promise((resolve) => {
      let text = "";
      socket.on("data", (chunk) => {
        text += chunk.toString();
        if (text.includes("EARLY-BYTES")) resolve(text);
      });
    });
    socket.write(`GET /?token=${tokenText} HTTP/1.1\r\n${lines.join("")}\r\nEARLY-BYTES`);
    assert.match(await echoed, /^HTTP\/1\.1 101[^]*EARLY-BYTES$/);
  });
});

describe("createFront: CDP front", () => {
  const versionBody = (port) =>
    JSON.stringify({
      Browser: "Chrome/1",
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/abc`,
    });

  function withVersionRoute(ctx) {
    ctx.cdpUp.routes.set("/json/version", (_req, res) => {
      res.writeHead(200, { "content-type": "application/json; charset=UTF-8" });
      res.end(versionBody(ctx.cdpPort));
    });
  }

  it("refuses tokenless requests from loopback (the tailnet arrives from 127.0.0.1)", async (t) => {
    const ctx = await startFront(t);
    withVersionRoute(ctx);
    assert.equal((await httpGet(ctx.ports.cdp, "/json/version")).status, 403);
    assert.equal(ctx.cdpUp.requests.length, 0);
  });

  it("proxies /json/version under the token prefix and rewrites the debugger URL to the client's Host and prefix", async (t) => {
    const ctx = await startFront(t);
    withVersionRoute(ctx);
    const res = await httpGet(ctx.ports.cdp, `/t/${tokenText}/json/version`, {
      headers: { host: "browsers.example.com:9222" },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /application\/json/);
    assert.equal(
      JSON.parse(res.body).webSocketDebuggerUrl,
      `ws://browsers.example.com:9222/t/${tokenText}/devtools/browser/abc`,
    );
    const [seen] = ctx.cdpUp.requests;
    assert.equal(seen.url, "/json/version");
    assert.equal(seen.headers.host, `127.0.0.1:${ctx.cdpPort}`);
  });

  it("serves /json/version/ with a trailing slash and rewrites the debugger URL", async (t) => {
    const ctx = await startFront(t);
    ctx.cdpUp.routes.set("/json/version/", (_req, res) => res.end(versionBody(ctx.cdpPort)));
    const res = await httpGet(ctx.ports.cdp, `/t/${tokenText}/json/version/`, { headers: { host: "h.example:9222" } });
    assert.equal(res.status, 200);
    assert.equal(
      JSON.parse(res.body).webSocketDebuggerUrl,
      `ws://h.example:9222/t/${tokenText}/devtools/browser/abc`,
    );
  });

  it("rewrites every occurrence of the upstream address", async (t) => {
    const ctx = await startFront(t);
    ctx.cdpUp.routes.set("/json/list", (_req, res) =>
      res.end(`127.0.0.1:${ctx.cdpPort} and again 127.0.0.1:${ctx.cdpPort} $& $1`),
    );
    const res = await httpGet(ctx.ports.cdp, `/t/${tokenText}/json/list`, { headers: { host: "h.example:1" } });
    assert.equal(res.body, `h.example:1/t/${tokenText} and again h.example:1/t/${tokenText} $& $1`);
  });

  it("passes upstream status codes and bodies through", async (t) => {
    const ctx = await startFront(t);
    ctx.cdpUp.routes.set("/json/close/gone", (_req, res) => res.writeHead(500).end("No such target id"));
    const res = await httpGet(ctx.ports.cdp, `/t/${tokenText}/json/close/gone`);
    assert.equal(res.status, 500);
    assert.equal(res.body, "No such target id");
  });

  it("defaults the content type to JSON", async (t) => {
    const ctx = await startFront(t);
    ctx.cdpUp.routes.set("/json/x", (_req, res) => res.removeHeader("content-type") || res.end("{}"));
    const res = await httpGet(ctx.ports.cdp, `/t/${tokenText}/json/x`);
    assert.ok(res.headers["content-type"]);
  });

  it("allows PUT (json/new) and forwards the method", async (t) => {
    const ctx = await startFront(t);
    ctx.cdpUp.routes.set("/json/new", (_req, res) => res.end("{}"));
    const res = await httpGet(ctx.ports.cdp, `/t/${tokenText}/json/new?about:blank`, { method: "PUT" });
    assert.equal(res.status, 200);
    assert.deepEqual(ctx.cdpUp.requests.map((r) => [r.method, r.url]), [["PUT", "/json/new?about:blank"]]);
  });

  it("refuses methods other than GET and PUT", async (t) => {
    const ctx = await startFront(t);
    withVersionRoute(ctx);
    for (const method of ["POST", "DELETE", "PATCH"])
      assert.equal((await httpGet(ctx.ports.cdp, `/t/${tokenText}/json/version`, { method })).status, 403);
    assert.equal(ctx.cdpUp.requests.length, 0);
  });

  it("refuses a wrong token prefix and any request with an Origin", async (t) => {
    const ctx = await startFront(t);
    withVersionRoute(ctx);
    const wrong = "x".repeat(token.length);
    assert.equal((await httpGet(ctx.ports.cdp, `/t/${wrong}/json/version`)).status, 403);
    assert.equal(
      (await httpGet(ctx.ports.cdp, `/t/${tokenText}/json/version`, { headers: { origin: "https://evil.example" } }))
        .status,
      403,
    );
    assert.equal(ctx.cdpUp.requests.length, 0);
  });

  it("answers 502 when Chrome is unreachable", async (t) => {
    const ctx = await startFront(t);
    await ctx.cdpUp.close();
    assert.equal((await httpGet(ctx.ports.cdp, `/t/${tokenText}/json/version`)).status, 502);
  });

  describe("websocket upgrades", () => {
    it("forwards /devtools/ under the prefix to Chrome with the prefix stripped and the Host rewritten", async (t) => {
      const ctx = await startFront(t);
      const client = upgrade(ctx, ctx.ports.cdp, `/t/${tokenText}/devtools/browser/abc`, { Host: "anything.example" });
      assert.equal((await client.head).status, 101);
      await echoes(client, "cdp frame");
      const [seen] = ctx.cdpUp.upgrades;
      assert.equal(seen.url, "/devtools/browser/abc");
      assert.equal(seen.headers.host, `127.0.0.1:${ctx.cdpPort}`);
    });

    it("refuses an upgrade that is not under /devtools/", async (t) => {
      const ctx = await startFront(t);
      for (const path of [`/t/${tokenText}/json/version`, `/t/${tokenText}/`, `/t/${tokenText}/devtools`])
        assert.equal((await upgrade(ctx, ctx.ports.cdp, path).head).status, 403);
      assert.equal(ctx.cdpUp.upgrades.length, 0);
    });

    it("refuses an upgrade with a wrong token, an Origin, or tokenless from loopback", async (t) => {
      const ctx = await startFront(t);
      const wrong = "x".repeat(token.length);
      assert.equal((await upgrade(ctx, ctx.ports.cdp, `/t/${wrong}/devtools/browser/a`).head).status, 403);
      assert.equal((await upgrade(ctx, ctx.ports.cdp, "/devtools/browser/a").head).status, 403);
      const withOrigin = upgrade(ctx, ctx.ports.cdp, `/t/${tokenText}/devtools/browser/a`, {
        Origin: "https://evil.example",
      });
      assert.equal((await withOrigin.head).status, 403);
      assert.equal(ctx.cdpUp.upgrades.length, 0);
    });

    it("shares the session cap with the Playwright front", async (t) => {
      const ctx = await startFront(t, { maxSessions: 1 });
      const playwright = upgrade(ctx, ctx.ports.playwright, `/?token=${tokenText}`);
      await playwright.head;
      const refused = await upgrade(ctx, ctx.ports.cdp, `/t/${tokenText}/devtools/browser/a`).head;
      assert.equal(refused.status, 503);
      assert.equal(refused.headers["retry-after"], "1");
      assert.equal(ctx.cdpUp.upgrades.length, 0);
      // A refused CDP attempt must not count as a CDP client: no reset runs when it ends.
      assert.equal(ctx.cdpUp.requests.length, 0);
    });

    it("lets CDP sessions fill the cap seen by the Playwright front", async (t) => {
      const ctx = await startFront(t, { maxSessions: 1 });
      ctx.cdpUp.routes.set("/json/list", (_req, res) => res.end("[]"));
      ctx.cdpUp.routes.set("/json/new", (_req, res) => res.end("{}"));
      const cdp = upgrade(ctx, ctx.ports.cdp, `/t/${tokenText}/devtools/browser/a`);
      await cdp.head;
      assert.equal((await upgrade(ctx, ctx.ports.playwright, `/?token=${tokenText}`).head).status, 503);
    });

    it("closes an idle CDP session", async (t) => {
      const ctx = await startFront(t, { idleMs: 40 });
      ctx.cdpUp.routes.set("/json/list", (_req, res) => res.end("[]"));
      ctx.cdpUp.routes.set("/json/new", (_req, res) => res.end("{}"));
      const client = upgrade(ctx, ctx.ports.cdp, `/t/${tokenText}/devtools/browser/a`);
      await client.head;
      await client.closed;
    });
  });

  describe("shared browser reset", () => {
    const pages = [
      { id: "P1", type: "page" },
      { id: "W1", type: "service_worker" },
      { id: "P2", type: "page" },
    ];

    function routesForReset(ctx, { list = pages } = {}) {
      ctx.cdpUp.routes.set("/json/list", (_req, res) => res.end(JSON.stringify(list)));
      ctx.cdpUp.routes.set("/json/new", (_req, res) => res.end("{}"));
      ctx.cdpUp.routes.set("/json/close/P1", (_req, res) => res.end("Target is closing"));
      ctx.cdpUp.routes.set("/json/close/P2", (_req, res) => res.end("Target is closing"));
    }
    const seenUrls = (ctx) => ctx.cdpUp.requests.map((r) => `${r.method} ${r.url}`);

    it("replaces the left-over pages with one blank page once the last CDP client leaves", async (t) => {
      const ctx = await startFront(t);
      routesForReset(ctx);
      const client = upgrade(ctx, ctx.ports.cdp, `/t/${tokenText}/devtools/browser/a`);
      await client.head;
      assert.deepEqual(seenUrls(ctx), []);
      client.socket.destroy();
      await ctx.cdpUp.until(() => seenUrls(ctx).includes("GET /json/close/P2"));
      assert.deepEqual(seenUrls(ctx), [
        "GET /json/list",
        "PUT /json/new?about:blank",
        "GET /json/close/P1",
        "GET /json/close/P2",
      ]);
    });

    it("opens the blank page before closing the old ones, and closes only pages", async (t) => {
      const ctx = await startFront(t);
      routesForReset(ctx);
      const client = upgrade(ctx, ctx.ports.cdp, `/t/${tokenText}/devtools/browser/a`);
      await client.head;
      client.socket.destroy();
      await ctx.cdpUp.until(() => seenUrls(ctx).length === 4);
      const urls = seenUrls(ctx);
      assert.ok(urls.indexOf("PUT /json/new?about:blank") < urls.indexOf("GET /json/close/P1"));
      assert.equal(urls.some((url) => url.includes("W1")), false);
    });

    it("waits for the last of several CDP clients", async (t) => {
      const ctx = await startFront(t);
      routesForReset(ctx);
      const path = `/t/${tokenText}/devtools/browser/a`;
      const first = upgrade(ctx, ctx.ports.cdp, path);
      const second = upgrade(ctx, ctx.ports.cdp, path);
      await Promise.all([first.head, second.head]);
      first.socket.destroy();
      await first.closed;
      await ctx.cdpUp.until(() => ctx.cdpUp.sockets.size === 1);
      assert.deepEqual(seenUrls(ctx), []);
      second.socket.destroy();
      await ctx.cdpUp.until(() => seenUrls(ctx).includes("GET /json/close/P2"));
      assert.equal(seenUrls(ctx).filter((url) => url.startsWith("PUT /json/new")).length, 1);
    });

    it("resets once per client departure even if both ends report close", async (t) => {
      const ctx = await startFront(t);
      routesForReset(ctx);
      const client = upgrade(ctx, ctx.ports.cdp, `/t/${tokenText}/devtools/browser/a`);
      await client.head;
      for (const socket of ctx.cdpUp.sockets) socket.destroy();
      await ctx.cdpUp.until(() => seenUrls(ctx).includes("GET /json/close/P2"));
      client.socket.destroy();
      await client.closed;
      assert.equal(seenUrls(ctx).filter((url) => url.startsWith("PUT /json/new")).length, 1);
    });

    it("does not reset for a Playwright session", async (t) => {
      const ctx = await startFront(t);
      routesForReset(ctx);
      const client = upgrade(ctx, ctx.ports.playwright, `/?token=${tokenText}`);
      await client.head;
      client.socket.destroy();
      await client.closed;
      await ctx.playwrightUp.until(() => ctx.playwrightUp.sockets.size === 0);
      assert.deepEqual(seenUrls(ctx), []);
    });

    it("skips the reset when a new client attached while the page list was being fetched", async (t) => {
      const ctx = await startFront(t);
      routesForReset(ctx);
      let releaseFirstList;
      const firstListReleased = new Promise((resolve) => (releaseFirstList = resolve));
      let listCalls = 0;
      ctx.cdpUp.routes.set("/json/list", async (_req, res) => {
        if (listCalls++ === 0) await firstListReleased;
        res.end(JSON.stringify(pages));
      });
      const path = `/t/${tokenText}/devtools/browser/a`;
      const first = upgrade(ctx, ctx.ports.cdp, path);
      await first.head;
      first.socket.destroy();
      await ctx.cdpUp.until(() => listCalls === 1);
      const second = upgrade(ctx, ctx.ports.cdp, path);
      await second.head;
      ctx.cdpUp.routes.set("/json/version", (_req, res) => res.end("{}"));
      releaseFirstList();
      // A round trip through the front, behind the released list response.
      await httpGet(ctx.ports.cdp, `/t/${tokenText}/json/version`);
      assert.deepEqual(seenUrls(ctx).filter((url) => url.startsWith("PUT")), []);
      second.socket.destroy();
      await ctx.cdpUp.until(() => seenUrls(ctx).includes("GET /json/close/P2"));
      assert.equal(seenUrls(ctx).filter((url) => url.startsWith("PUT /json/new")).length, 1);
      assert.equal(listCalls, 2);
    });

    it("logs and survives an unreadable page list", async (t) => {
      const ctx = await startFront(t);
      ctx.cdpUp.routes.set("/json/list", (_req, res) => res.end("not json"));
      let logged;
      const loggedOnce = new Promise((resolve) => (logged = resolve));
      t.mock.method(console, "error", (message) => logged(message));
      const client = upgrade(ctx, ctx.ports.cdp, `/t/${tokenText}/devtools/browser/a`);
      await client.head;
      client.socket.destroy();
      assert.match(await loggedOnce, /^CDP reset failed: /);
      assert.equal(seenUrls(ctx).some((url) => url.startsWith("PUT")), false);
    });

    it("logs and survives Chrome being down during the reset", async (t) => {
      const ctx = await startFront(t);
      let logged;
      const loggedOnce = new Promise((resolve) => (logged = resolve));
      t.mock.method(console, "error", (message) => logged(message));
      const client = upgrade(ctx, ctx.ports.cdp, `/t/${tokenText}/devtools/browser/a`);
      await client.head;
      await ctx.cdpUp.close();
      client.socket.destroy();
      assert.match(await loggedOnce, /^CDP reset failed: /);
    });
  });
});
