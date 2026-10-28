// AWS Signature Version 4 for S3 requests, header-based, with node:crypto only.
// Reference: https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
import * as NodeCrypto from "node:crypto";

export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const sha256 = (data) => NodeCrypto.createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => NodeCrypto.createHmac("sha256", key).update(data).digest();

// RFC 3986 encoding as S3 expects it: everything but A-Z a-z 0-9 - _ . ~ is
// percent-encoded from its UTF-8 bytes, so a space is %20 and "+" is %2B.
export function uriEncode(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

// An object key as a request path: each segment encoded once (S3 is not
// double-encoded like other services), slashes kept.
export function encodeKeyPath(key) {
  return `/${key.split("/").map(uriEncode).join("/")}`;
}

export function canonicalQuery(params) {
  return params
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

export function amzDate(date) {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/**
 * Returns the headers to send: the given ones plus x-amz-date,
 * x-amz-content-sha256 and authorization. `path` must already be encoded with
 * encodeKeyPath (or be "/"), and must be sent exactly as signed.
 */
export function signRequest({
  method,
  host,
  path,
  query = [],
  headers = {},
  payloadHash = EMPTY_SHA256,
  region,
  accessKeyId,
  secretAccessKey,
  date = new Date(),
}) {
  const stamp = amzDate(date);
  const day = stamp.slice(0, 8);
  const all = { ...headers, host, "x-amz-content-sha256": payloadHash, "x-amz-date": stamp };
  const names = Object.keys(all)
    .map((n) => n.toLowerCase())
    .sort();
  const lower = Object.fromEntries(
    Object.entries(all).map(([n, v]) => [n.toLowerCase(), String(v)]),
  );
  const canonicalHeaders = names
    .map((n) => `${n}:${lower[n].trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    method,
    path,
    canonicalQuery(query),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256(canonicalRequest)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), "s3"), "aws4_request");
  const signature = NodeCrypto.createHmac("sha256", key).update(stringToSign).digest("hex");
  return {
    ...lower,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
