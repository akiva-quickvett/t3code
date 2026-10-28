# s3-readonly-proxy

A small, zero-dependency, read-only HTTP proxy in front of one S3 bucket. Agents
use it to list and download objects without ever holding an AWS credential.

## Why

An AWS key in an agent's environment is a key the agent can use for anything
its IAM policy allows, and it is hard to tell later what it touched. So the key
lives only in this proxy, which can list and read one bucket and nothing else.
Agents get proxy API keys instead, and you can revoke those at any time without
touching IAM.

## Security model and caveats

- **The proxy is only as safe as keeping AWS credentials away from agents.**
  Agent machines must not have `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` or an
  `~/.aws` profile for this account.
- **Give the proxy a read-only IAM key.** The proxy only ever sends
  `ListObjectsV2`, `GetObject` and `HeadObject` to the bucket in `S3_BUCKET`, but
  the IAM policy is what actually limits the key. It needs `s3:ListBucket` on
  the bucket and `s3:GetObject` on its objects, nothing more:

  ```json
  {
    "Version": "2012-10-17",
    "Statement": [
      { "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::BUCKET" },
      { "Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::BUCKET/*" }
    ]
  }
  ```

  Without `s3:ListBucket`, S3 answers 403 instead of 404 for missing keys. With
  `S3_ALLOWED_PREFIXES`, you can narrow both statements to those prefixes too.

- **Read-only by construction.** Only `GET` and `HEAD` are accepted, and the
  proxy has no upload, delete, copy or presign path. Requests are signed with
  SigV4 in `sigv4.mjs`, using `node:crypto` only.
- **Prefixes.** With `S3_ALLOWED_PREFIXES`, listing and reading anything outside
  them returns 403. Matching is plain string prefix matching, so end each prefix
  with `/` (`reports/`, not `reports`); the proxy refuses to start otherwise.
  Keys starting with `/` or containing a `.` or `..` segment are refused with
  400, so a key cannot climb out of a prefix. Such keys still show up in
  listings, but cannot be fetched.
- **What reaches agents.** Object bytes, plus only `Content-Type`,
  `Content-Length`, `ETag`, `Last-Modified`, `Content-Range` and `Accept-Ranges`,
  and only as printable ASCII. User metadata (`x-amz-meta-*`) and
  `Content-Disposition` are dropped. S3 error bodies are reduced to their error
  code (`{"error":"S3 NoSuchKey"}`), because some of them echo the request and
  the access key id.
- **Streaming.** Objects are piped through, never buffered, so size has no
  effect on the proxy's memory. Listings are capped at 1000 keys per page.
- **Proxy keys** must be at least 32 characters. They are compared in constant
  time. `/health` is the only unauthenticated endpoint, and it returns nothing
  but `{"ok":true}`.
- **Logs** show the bucket and region at startup and errors without keys,
  signatures or object keys.

## Deploying on Railway

1. Create an IAM user (or role) with the policy above and an access key.
2. Deploy this directory as a service. The `Dockerfile` builds it, and
   `railway.json` sets the `/health` healthcheck and restart policy. Give it no
   public domain; agents in the same Railway environment reach it on its
   private domain.
3. Set the service variables:

   | Variable                | Value                                                                |
   | ----------------------- | -------------------------------------------------------------------- |
   | `AWS_ACCESS_KEY_ID`     | The IAM access key id                                                |
   | `AWS_SECRET_ACCESS_KEY` | Its secret                                                           |
   | `AWS_REGION`            | The bucket's region, such as `us-east-1`                             |
   | `S3_BUCKET`             | The bucket name                                                      |
   | `S3_ENDPOINT`           | Optional, for S3-compatible stores (`https://host:port`, path-style) |
   | `S3_ALLOWED_PREFIXES`   | Optional, comma-separated key prefixes, each ending in `/`           |
   | `PROXY_API_KEYS`        | Comma-separated proxy keys, each ≥ 32 characters                     |
   | `PORT`                  | Optional, default 8080                                               |

   Generate a key with:

   ```sh
   openssl rand -hex 32
   ```

At startup the proxy lists one key (under the first allowed prefix, if set),
logs `Read-only S3 proxy for bucket <bucket> in <region>`, and exits with a
non-zero code if that fails. A failed deploy usually means a bad key, region or
policy; the log line names S3's error code.

**Rotating keys:** set `PROXY_API_KEYS` to `old,new`, move agents over to the new
key, then remove the old one. Rotate the AWS key in IAM, then update the two
`AWS_` variables.

## API

Send `Authorization: Bearer <proxy key>` on every request except `/health`.
Object keys go in the path, percent-encoded (`a%20b.txt`; a literal `+` may stay
as is). Query values are form-encoded, so write a `+` in a prefix as `%2B`.
Errors are JSON: `{"error": "..."}`.

| Endpoint                 | Notes                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `GET /health`            | No auth                                                                            |
| `GET /v1/objects`        | `prefix`, `limit` (1–1000, default 100), `token` (the previous page's `nextToken`) |
| `GET /v1/objects/<key>`  | The object's bytes. `Range: bytes=start-end` returns 206 with `Content-Range`      |
| `HEAD /v1/objects/<key>` | Headers only                                                                       |

A listing looks like:

```json
{
  "objects": [
    {
      "key": "reports/2026-10.pdf",
      "size": 48213,
      "lastModified": "2026-10-01T10:00:00.000Z",
      "etag": "\"9b2c…\""
    }
  ],
  "nextToken": null
}
```

```sh
curl -H "Authorization: Bearer $S3_PROXY_KEY" "$S3_PROXY_URL/v1/objects?prefix=reports/&limit=20"
curl -H "Authorization: Bearer $S3_PROXY_KEY" -o out.pdf "$S3_PROXY_URL/v1/objects/reports/2026-10.pdf"
curl -H "Authorization: Bearer $S3_PROXY_KEY" -H "Range: bytes=0-1023" "$S3_PROXY_URL/v1/objects/reports/2026-10.pdf"
```

## Local development

```sh
npm test
```

The tests use `node:test`. The signing tests check `sigv4.mjs` against AWS's
published examples and against botocore on keys with spaces, `+`, unicode and
reserved characters; the server tests run against a fake S3 endpoint, so they
need no network access or AWS key. To run the server locally, set the variables
above and run `npm start`.
