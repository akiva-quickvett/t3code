import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeHttp from "node:http";
import { createApp, createS3Client, parseListXml, s3Target } from "../server.mjs";

const KEY = "k".repeat(40);
const requests = [];
let releaseStream;
const streamReleased = new Promise((resolve) => (releaseStream = resolve));

const LIST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult><Name>bkt</Name><EncodingType>url</EncodingType><IsTruncated>true</IsTruncated>
<Contents><Key>reports/a+b%2Bc+%C3%BC.pdf</Key><LastModified>2026-10-01T10:00:00.000Z</LastModified><ETag>&quot;abc123&quot;</ETag><Size>42</Size><StorageClass>STANDARD</StorageClass><Owner><ID>owner-id</ID></Owner></Contents>
<Contents><Key>reports/x.txt</Key><LastModified>2026-10-02T10:00:00.000Z</LastModified><ETag>&quot;def&quot;</ETag><Size>7</Size></Contents>
<NextContinuationToken>tok+/=&amp;1</NextContinuationToken></ListBucketResult>`;

// Stands in for S3 behind S3_ENDPOINT (path-style), recording what it was sent.
const fakeS3 = NodeHttp.createServer((req, res) => {
  requests.push({ method: req.method, url: req.url, headers: req.headers });
  const path = req.url.split("?")[0];
  if (path === "/bkt") {
    res.writeHead(200, { "content-type": "application/xml" });
    return res.end(LIST_XML);
  }
  if (path === "/bkt/reports/a%20b%2Bc%20%C3%BC.pdf") {
    const headers = {
      "content-type": "application/pdf",
      etag: '"abc123"',
      "last-modified": "Wed, 01 Oct 2026 10:00:00 GMT",
      "accept-ranges": "bytes",
      "x-amz-meta-owner": "someone",
      "content-disposition": "inline; filename=evil.html",
      "set-cookie": "s=1",
    };
    if (req.headers.range === "bytes=0-3") {
      res.writeHead(206, { ...headers, "content-length": "4", "content-range": "bytes 0-3/10" });
      return res.end(req.method === "HEAD" ? undefined : "0123");
    }
    res.writeHead(200, { ...headers, "content-length": "10" });
    return res.end(req.method === "HEAD" ? undefined : "0123456789");
  }
  if (path === "/bkt/reports/unicode-type") {
    res.writeHead(200, { "content-type": "text/plain; name=ü", "content-length": "2" });
    return res.end("ok");
  }
  if (path === "/bkt/reports/stream.bin") {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.write("first-");
    return streamReleased.then(() => res.end("second"));
  }
  if (path === "/bkt/reports/denied") {
    res.writeHead(403, { "content-type": "application/xml" });
    return res.end(
      "<Error><Code>SignatureDoesNotMatch</Code><AWSAccessKeyId>AKIDLEAK</AWSAccessKeyId><StringToSign>AWS4-HMAC-SHA256 leak</StringToSign></Error>",
    );
  }
  res.writeHead(404, { "content-type": "application/xml" });
  res.end(
    req.method === "HEAD"
      ? undefined
      : "<Error><Code>NoSuchKey</Code><Key>reports/missing</Key></Error>",
  );
});

let proxy;
let base;
NodeTest.before(async () => {
  await new Promise((r) => fakeS3.listen(0, "127.0.0.1", r));
  const s3 = createS3Client({
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "secret",
    region: "us-east-1",
    bucket: "bkt",
    endpoint: `http://127.0.0.1:${fakeS3.address().port}`,
  });
  proxy = NodeHttp.createServer(createApp({ s3, apiKeys: [KEY], allowedPrefixes: ["reports/"] }));
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${proxy.address().port}`;
});
NodeTest.after(() => {
  proxy.close();
  fakeS3.close();
});

const call = (path, { key = KEY, method = "GET", headers = {} } = {}) =>
  fetch(base + path, {
    method,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
  });
const lastRequest = () => requests.at(-1);
// fetch() resolves dot segments before sending; this sends the target as is.
const rawStatus = (path) =>
  new Promise((resolve, reject) => {
    const { hostname, port } = new URL(base);
    const req = NodeHttp.request(
      { hostname, port, path, headers: { authorization: `Bearer ${KEY}` } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.end();
  });

NodeTest.test("health needs no auth and reveals nothing", async () => {
  const res = await call("/health", { key: null });
  NodeAssert.equal(res.status, 200);
  NodeAssert.deepEqual(await res.json(), { ok: true });
});

NodeTest.test("rejects missing or wrong keys", async () => {
  NodeAssert.equal((await call("/v1/objects?prefix=reports/", { key: null })).status, 401);
  NodeAssert.equal((await call("/v1/objects?prefix=reports/", { key: "wrong" })).status, 401);
});

NodeTest.test("allows only GET and HEAD, before touching S3", async () => {
  const before = requests.length;
  for (const method of ["PUT", "POST", "DELETE", "PATCH", "OPTIONS"]) {
    const res = await call("/v1/objects/reports/x.txt", { method });
    NodeAssert.equal(res.status, 405, method);
    NodeAssert.equal(res.headers.get("allow"), "GET, HEAD");
  }
  NodeAssert.equal(requests.length, before);
});

NodeTest.test("lists objects trimmed to key, size, lastModified and etag", async () => {
  const res = await call("/v1/objects?prefix=reports/&limit=2&token=prev%2Btok");
  NodeAssert.equal(res.status, 200);
  NodeAssert.deepEqual(await res.json(), {
    objects: [
      {
        key: "reports/a b+c ü.pdf",
        size: 42,
        lastModified: "2026-10-01T10:00:00.000Z",
        etag: '"abc123"',
      },
      { key: "reports/x.txt", size: 7, lastModified: "2026-10-02T10:00:00.000Z", etag: '"def"' },
    ],
    nextToken: "tok+/=&1",
  });
  NodeAssert.equal(
    lastRequest().url,
    "/bkt?continuation-token=prev%2Btok&encoding-type=url&list-type=2&max-keys=2&prefix=reports%2F",
  );
  NodeAssert.match(
    lastRequest().headers.authorization,
    /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/s3\/aws4_request, /,
  );
});

NodeTest.test("validates list parameters", async () => {
  NodeAssert.equal((await call("/v1/objects?prefix=reports/&limit=0")).status, 400);
  NodeAssert.equal((await call("/v1/objects?prefix=reports/&limit=1001")).status, 400);
  NodeAssert.equal((await call("/v1/objects?prefix=reports/&limit=abc")).status, 400);
  NodeAssert.equal(
    (await call(`/v1/objects?prefix=reports/&token=${"t".repeat(2049)}`)).status,
    400,
  );
});

NodeTest.test("streams an object with only safe headers, encoding the key once", async () => {
  const res = await call("/v1/objects/reports/a%20b+c%20%C3%BC.pdf");
  NodeAssert.equal(res.status, 200);
  NodeAssert.equal(await res.text(), "0123456789");
  NodeAssert.equal(lastRequest().url, "/bkt/reports/a%20b%2Bc%20%C3%BC.pdf");
  NodeAssert.equal(res.headers.get("content-type"), "application/pdf");
  NodeAssert.equal(res.headers.get("content-length"), "10");
  NodeAssert.equal(res.headers.get("etag"), '"abc123"');
  NodeAssert.equal(res.headers.get("last-modified"), "Wed, 01 Oct 2026 10:00:00 GMT");
  NodeAssert.equal(res.headers.get("x-content-type-options"), "nosniff");
  for (const name of ["x-amz-meta-owner", "content-disposition", "set-cookie"])
    NodeAssert.equal(res.headers.get(name), null, name);
});

NodeTest.test("drops non-ASCII header values from object metadata", async () => {
  const res = await call("/v1/objects/reports/unicode-type");
  NodeAssert.equal(res.headers.get("content-type"), "application/octet-stream");
  NodeAssert.equal(await res.text(), "ok");
});

NodeTest.test("passes Range through and keeps 206", async () => {
  const res = await call("/v1/objects/reports/a%20b%2Bc%20%C3%BC.pdf", {
    headers: { range: "bytes=0-3" },
  });
  NodeAssert.equal(res.status, 206);
  NodeAssert.equal(res.headers.get("content-range"), "bytes 0-3/10");
  NodeAssert.equal(await res.text(), "0123");
  NodeAssert.equal(lastRequest().headers.range, "bytes=0-3");
  NodeAssert.match(
    lastRequest().headers.authorization,
    /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,/,
  );
  NodeAssert.equal(
    (await call("/v1/objects/reports/x.txt", { headers: { range: "bytes=0-1,4-5" } })).status,
    400,
  );
  NodeAssert.equal(
    (await call("/v1/objects/reports/x.txt", { headers: { range: "lines=1-2" } })).status,
    400,
  );
});

NodeTest.test("HEAD returns the object's headers without a body", async () => {
  const res = await call("/v1/objects/reports/a%20b%2Bc%20%C3%BC.pdf", { method: "HEAD" });
  NodeAssert.equal(res.status, 200);
  NodeAssert.equal(res.headers.get("content-length"), "10");
  NodeAssert.equal(lastRequest().method, "HEAD");
  NodeAssert.equal((await call("/v1/objects/reports/missing", { method: "HEAD" })).status, 404);
});

NodeTest.test("streams without buffering the whole object", async () => {
  const res = await call("/v1/objects/reports/stream.bin");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  // S3 has sent only the first part and is waiting; it must already be here.
  NodeAssert.equal(decoder.decode((await reader.read()).value), "first-");
  releaseStream();
  let rest = "";
  for (let r = await reader.read(); !r.done; r = await reader.read())
    rest += decoder.decode(r.value);
  NodeAssert.equal(rest, "second");
});

NodeTest.test(
  "refuses traversal, leading slashes and keys outside the allowed prefixes",
  async () => {
    const before = requests.length;
    for (const path of [
      "/v1/objects/reports/../secret",
      "/v1/objects/reports/..",
      "/v1/objects/reports/%2e%2e/secret",
      "/v1/objects/reports/./x",
      "/v1/objects//reports/x",
      "/v1/objects/%2Freports/x",
      "/v1/objects/reports/a%0Ab",
      "/v1/objects/reports/%E0%A4%A",
      "/v1/objects/",
    ]) {
      NodeAssert.equal(await rawStatus(path), 400, path);
    }
    NodeAssert.equal((await call("/v1/objects/other/x")).status, 403);
    NodeAssert.equal((await call("/v1/objects/reportsX")).status, 403);
    NodeAssert.equal((await call("/v1/objects?prefix=")).status, 403);
    NodeAssert.equal((await call("/v1/objects?prefix=other/")).status, 403);
    NodeAssert.equal(await rawStatus("/v1/objects?prefix=reports/../"), 400);
    NodeAssert.equal(requests.length, before);
  },
);

NodeTest.test("S3 errors keep the code and drop the body", async () => {
  const denied = await call("/v1/objects/reports/denied");
  NodeAssert.equal(denied.status, 403);
  const text = await denied.text();
  NodeAssert.deepEqual(JSON.parse(text), { error: "S3 SignatureDoesNotMatch" });
  NodeAssert.doesNotMatch(text, /AKID|StringToSign/);
  const missing = await call("/v1/objects/reports/missing");
  NodeAssert.equal(missing.status, 404);
  NodeAssert.deepEqual(await missing.json(), { error: "S3 NoSuchKey" });
});

NodeTest.test("leaves keys raw when the store ignored encoding-type=url", () => {
  const xml =
    "<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>r/a+b 100%</Key><Size>1</Size></Contents></ListBucketResult>";
  NodeAssert.equal(parseListXml(xml).objects[0].key, "r/a+b 100%");
});

NodeTest.test("targets virtual-hosted AWS, path-style for dotted buckets, and S3_ENDPOINT", () => {
  const rows = [
    [
      { region: "us-east-1", bucket: "media" },
      { protocol: "https:", host: "media.s3.us-east-1.amazonaws.com", base: "" },
    ],
    [
      { region: "eu-west-2", bucket: "my.media" },
      { protocol: "https:", host: "s3.eu-west-2.amazonaws.com", base: "/my.media" },
    ],
    [
      { region: "auto", bucket: "media", endpoint: "http://minio.internal:9000" },
      { protocol: "http:", host: "minio.internal:9000", base: "/media" },
    ],
  ];
  for (const [input, want] of rows) {
    const { protocol, host, base } = s3Target(input);
    NodeAssert.deepEqual({ protocol, host, base }, want, input.bucket);
  }
  NodeAssert.throws(
    () => s3Target({ region: "x", bucket: "b", endpoint: "https://host/path" }),
    /must be an origin/,
  );
});
