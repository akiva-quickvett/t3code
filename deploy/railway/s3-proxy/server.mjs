import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeStream from "node:stream";
import * as NodeURL from "node:url";
import { canonicalQuery, encodeKeyPath, signRequest, uriEncode } from "./sigv4.mjs";

const MAX_LIST_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// S3's own status passes through where it means the same to the caller;
// anything else is a bad gateway. Only S3's error code is kept: its error
// bodies can echo the canonical request, string to sign and access key id.
export class UpstreamError extends HttpError {
  constructor(status, code) {
    super([400, 403, 404, 416].includes(status) ? status : 502, `S3 ${code ?? status}`);
  }
}

async function readBody(res, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of res) {
    size += chunk.length;
    if (size > limit) {
      res.destroy();
      throw new HttpError(502, "S3 response too large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function upstreamError(res) {
  const body =
    res.req.method === "HEAD" ? "" : await readBody(res, MAX_ERROR_BYTES).catch(() => "");
  return new UpstreamError(res.statusCode, /<Code>([A-Za-z0-9.]{1,100})<\/Code>/.exec(body)?.[1]);
}

const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decodeXml = (s) =>
  s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e) =>
    e[0] === "#"
      ? String.fromCodePoint(Number(e[1] === "x" || e[1] === "X" ? `0${e.slice(1)}` : e.slice(1)))
      : (XML_ENTITIES[e] ?? m),
  );
const tag = (xml, name) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1];
// encoding-type=url keys are form-encoded: "+" is a space, a real "+" is %2B.
const decodeKey = (s) => decodeURIComponent(s.replace(/\+/g, " "));

export function parseListXml(xml) {
  // Stores behind S3_ENDPOINT may ignore encoding-type=url and send raw keys.
  const urlEncoded = tag(xml, "EncodingType") === "url";
  const objects = (xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? []).map((block) => ({
    key: (urlEncoded ? decodeKey : (k) => k)(decodeXml(tag(block, "Key") ?? "")),
    size: Number(tag(block, "Size")),
    lastModified: tag(block, "LastModified") ?? null,
    etag: decodeXml(tag(block, "ETag") ?? ""),
  }));
  const truncated = tag(xml, "IsTruncated") === "true";
  const next = tag(xml, "NextContinuationToken");
  return { objects, nextToken: truncated && next ? decodeXml(next) : null };
}

// Where requests go: base is the path prefix before the key ("" for
// virtual-hosted style), so a bucket listing is `base || "/"`.
export function s3Target({ region, bucket, endpoint }) {
  if (endpoint) {
    const url = new URL(endpoint);
    if (url.pathname !== "/" || url.search)
      throw new Error("S3_ENDPOINT must be an origin, like https://host:port");
    const { protocol, hostname, port, host } = url;
    return { protocol, hostname, port, host, base: `/${uriEncode(bucket)}` };
  }
  // Virtual-hosted style, except for dotted names, whose host fails TLS.
  const virtual = !bucket.includes(".");
  const host = virtual ? `${bucket}.s3.${region}.amazonaws.com` : `s3.${region}.amazonaws.com`;
  return {
    protocol: "https:",
    hostname: host,
    port: "",
    host,
    base: virtual ? "" : `/${uriEncode(bucket)}`,
  };
}

export function createS3Client({ accessKeyId, secretAccessKey, region, bucket, endpoint }) {
  const target = s3Target({ region, bucket, endpoint });
  target.client = target.protocol === "http:" ? NodeHttp : NodeHttps;

  function request(method, key, query = [], headers = {}) {
    const path = key === undefined ? target.base || "/" : target.base + encodeKeyPath(key);
    const signed = signRequest({
      method,
      host: target.host,
      path,
      query,
      headers,
      region,
      accessKeyId,
      secretAccessKey,
    });
    const qs = canonicalQuery(query);
    return new Promise((resolve, reject) => {
      const req = target.client.request(
        {
          method,
          hostname: target.hostname,
          port: target.port || undefined,
          path: qs ? `${path}?${qs}` : path,
          headers: signed,
          timeout: 30_000,
        },
        (res) => {
          // Backpressure from a slow client stalls this socket; allow for it.
          res.socket.setTimeout(300_000);
          resolve(res);
        },
      );
      req.on("timeout", () => req.destroy(new Error("S3 request timed out")));
      req.on("error", reject);
      req.end();
    });
  }

  return {
    async list({ prefix, limit, token }) {
      const query = [
        ["list-type", "2"],
        ["encoding-type", "url"],
        ["max-keys", String(limit)],
      ];
      if (prefix) query.push(["prefix", prefix]);
      if (token) query.push(["continuation-token", token]);
      const res = await request("GET", undefined, query);
      if (res.statusCode !== 200) throw await upstreamError(res);
      return parseListXml(await readBody(res, MAX_LIST_BYTES));
    },
    async object(method, key, range) {
      const res = await request(method, key, [], range ? { range } : {});
      if (res.statusCode !== 200 && res.statusCode !== 206) throw await upstreamError(res);
      return res;
    },
  };
}

const digest = (s) => NodeCrypto.createHash("sha256").update(s).digest();

export function createKeyChecker(keys) {
  const digests = keys.map(digest);
  return (header) => {
    const match = /^Bearer (.+)$/.exec(header ?? "");
    if (!match) return false;
    const candidate = digest(match[1]);
    return digests.some((d) => NodeCrypto.timingSafeEqual(d, candidate));
  };
}

function intParam(params, name, { def, min, max }) {
  const raw = params.get(name);
  if (raw === null) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

// S3 itself does not resolve dot segments, but anything in between might, and
// an allowed-prefix check is only sound on keys that cannot climb out of it.
function checkKey(key, what) {
  if (key.startsWith("/")) throw new HttpError(400, `${what} must not start with "/"`);
  if (key.split("/").some((s) => s === "." || s === ".."))
    throw new HttpError(400, `${what} must not contain "." or ".." segments`);
  if (/[\u0000-\u001f\u007f]/.test(key))
    throw new HttpError(400, `${what} must not contain control characters`);
  if (Buffer.byteLength(key) > 1024) throw new HttpError(400, `${what} is longer than 1024 bytes`);
}

// Only these reach the caller, and only as printable ASCII, so object metadata
// (x-amz-meta-*, content-disposition, ...) never does.
const PASSED_HEADERS = [
  "content-type",
  "content-length",
  "etag",
  "last-modified",
  "content-range",
  "accept-ranges",
];

export function createApp({ s3, apiKeys, allowedPrefixes = [] }) {
  const isAuthorized = createKeyChecker(apiKeys);
  const allowed = (key) =>
    allowedPrefixes.length === 0 || allowedPrefixes.some((p) => key.startsWith(p));

  async function list(params) {
    const prefix = params.get("prefix") ?? "";
    checkKey(prefix, "prefix");
    if (!allowed(prefix)) throw new HttpError(403, "prefix is outside the allowed prefixes");
    const limit = intParam(params, "limit", { def: 100, min: 1, max: 1000 });
    // Tokens are base64 and never hold a space: a "+" pasted unencoded comes back.
    const token = params.get("token")?.replaceAll(" ", "+");
    if (token && token.length > 2048) throw new HttpError(400, "token too long");
    return s3.list({ prefix, limit, token });
  }

  async function object(req, res, rawKey) {
    let key;
    try {
      key = decodeURIComponent(rawKey);
    } catch {
      throw new HttpError(400, "Malformed object key encoding");
    }
    if (!key) throw new HttpError(400, "Missing object key");
    checkKey(key, "key");
    if (!allowed(key)) throw new HttpError(403, "key is outside the allowed prefixes");
    const range = req.headers.range;
    if (range !== undefined && !/^bytes=(\d+-\d*|-\d+)$/.test(range)) {
      throw new HttpError(400, "Range must be a single bytes=start-end, start- or -suffix");
    }
    const upstream = await s3.object(req.method, key, range);
    // The caller left while S3 answered; nothing would ever drain this response.
    if (res.destroyed) return upstream.destroy();
    const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
    for (const name of PASSED_HEADERS) {
      const value = upstream.headers[name];
      if (typeof value === "string" && /^[\x20-\x7e]*$/.test(value)) headers[name] = value;
    }
    headers["content-type"] ??= "application/octet-stream";
    res.writeHead(upstream.statusCode, headers);
    if (req.method === "HEAD") {
      upstream.resume();
      return res.end();
    }
    NodeStream.pipeline(upstream, res, () => {});
  }

  return async function handle(req, res) {
    const send = (status, body, extra = {}) => {
      res.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...extra,
      });
      res.end(JSON.stringify(body));
    };
    try {
      // The raw target, not new URL(): WHATWG parsing would resolve "..",
      // "%2e%2e" and backslashes in keys before they are checked.
      const q = req.url.indexOf("?");
      const path = q === -1 ? req.url : req.url.slice(0, q);
      const params = new URLSearchParams(q === -1 ? "" : req.url.slice(q + 1));
      if (path === "/health") return send(200, { ok: true });
      if (req.method !== "GET" && req.method !== "HEAD") {
        throw Object.assign(new HttpError(405, "Read-only proxy: only GET and HEAD are allowed"), {
          allow: true,
        });
      }
      if (!isAuthorized(req.headers.authorization))
        throw new HttpError(401, "Missing or invalid API key");
      if (path === "/v1/objects") return send(200, await list(params));
      if (path.startsWith("/v1/objects/"))
        return await object(req, res, path.slice("/v1/objects/".length));
      throw new HttpError(404, "Unknown endpoint");
    } catch (err) {
      if (res.headersSent) return res.destroy();
      if (err instanceof HttpError)
        return send(err.status, { error: err.message }, err.allow ? { allow: "GET, HEAD" } : {});
      console.error(`request failed: ${err.message}`);
      return send(502, { error: "S3 unreachable" });
    }
  };
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function main() {
  const bucket = required("S3_BUCKET");
  const region = required("AWS_REGION");
  const apiKeys = (process.env.PROXY_API_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  if (!apiKeys.length) throw new Error("PROXY_API_KEYS is not set");
  if (apiKeys.some((k) => k.length < 32))
    throw new Error("Each proxy API key must be at least 32 characters");
  const allowedPrefixes = (process.env.S3_ALLOWED_PREFIXES ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (allowedPrefixes.some((p) => !p.endsWith("/")))
    throw new Error("Each S3_ALLOWED_PREFIXES entry must end with /");
  const s3 = createS3Client({
    accessKeyId: required("AWS_ACCESS_KEY_ID"),
    secretAccessKey: required("AWS_SECRET_ACCESS_KEY"),
    region,
    bucket,
    endpoint: process.env.S3_ENDPOINT || undefined,
  });
  try {
    await s3.list({ prefix: allowedPrefixes[0] ?? "", limit: 1 });
  } catch (err) {
    throw new Error(`S3 check failed for bucket ${bucket} in ${region}: ${err.message}`, {
      cause: err,
    });
  }
  console.log(
    `Read-only S3 proxy for bucket ${bucket} in ${region}${allowedPrefixes.length ? `, ${allowedPrefixes.length} allowed prefixes` : ""}`,
  );

  const port = Number(process.env.PORT ?? 8080);
  const server = NodeHttp.createServer(createApp({ s3, apiKeys, allowedPrefixes }));
  server.listen(port, "::", () => console.log(`Listening on :${port}`));
  // Let downloads in flight finish; the service's draining time delays SIGKILL past this.
  process.on("SIGTERM", () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}

if (import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
