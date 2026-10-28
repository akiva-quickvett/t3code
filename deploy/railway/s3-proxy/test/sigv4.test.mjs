import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { canonicalQuery, encodeKeyPath, signRequest } from "../sigv4.mjs";

const signature = (headers) => headers.authorization.split("Signature=")[1];

// The S3 examples in AWS's SigV4 documentation ("Examples: Signature
// Calculations in AWS Signature Version 4", header-based auth).
NodeTest.test("matches AWS's published S3 examples", () => {
  const aws = {
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    date: new Date("2013-05-24T00:00:00Z"),
    region: "us-east-1",
    host: "examplebucket.s3.amazonaws.com",
  };
  const object = signRequest({
    ...aws,
    method: "GET",
    path: "/test.txt",
    headers: { range: "bytes=0-9" },
  });
  NodeAssert.equal(
    signature(object),
    "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  );
  NodeAssert.match(
    object.authorization,
    /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,/,
  );
  const list = signRequest({
    ...aws,
    method: "GET",
    path: "/",
    query: [
      ["max-keys", "2"],
      ["prefix", "J"],
    ],
  });
  NodeAssert.equal(
    signature(list),
    "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
  );
});

// Expected values from botocore 1.40 S3SigV4Auth on the same requests.
NodeTest.test(
  "matches botocore on keys with spaces, plus signs, unicode and reserved characters",
  () => {
    const creds = {
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      date: new Date("2026-10-28T12:00:00Z"),
    };
    const cases = [
      {
        name: "space, plus, unicode, !*'()",
        req: {
          method: "GET",
          host: "examplebucket.s3.us-east-1.amazonaws.com",
          path: encodeKeyPath("dir/a b+c ü (1)!*'.txt"),
          headers: { range: "bytes=0-9" },
          region: "us-east-1",
        },
        want: "f047455d0a33d818e51d2120e7c1f63c27c6d975337c52dd0ac9d86cdad9a879",
      },
      {
        name: "CJK, astral emoji, unreserved",
        req: {
          method: "HEAD",
          host: "examplebucket.s3.eu-west-2.amazonaws.com",
          path: encodeKeyPath("日本/😀~x_y-z.bin"),
          region: "eu-west-2",
        },
        want: "b8d0c69cfbc5f1d86b8eb9c04705fa73f2c2490d2d6a0a0335ee97badc9e5c84",
      },
      {
        name: "list query with reserved characters",
        req: {
          method: "GET",
          host: "examplebucket.s3.us-east-1.amazonaws.com",
          path: "/",
          query: [
            ["list-type", "2"],
            ["encoding-type", "url"],
            ["max-keys", "100"],
            ["prefix", "x/y z+ü"],
            ["continuation-token", "1ab+c/="],
          ],
          region: "us-east-1",
        },
        want: "741ef43a4f93ceb6245894ce3c156106a06f71dd366381a994d1c68990d50d67",
      },
      {
        name: "path style",
        req: {
          method: "GET",
          host: "s3.us-east-1.amazonaws.com",
          path: `/my.bucket${encodeKeyPath("k ey")}`,
          region: "us-east-1",
        },
        want: "8ae7f473a6c4d2d0281e6d8a6f7e9e6d01b3ee12eafa75df2dd8abc3941be420",
      },
    ];
    for (const { name, req, want } of cases)
      NodeAssert.equal(signature(signRequest({ ...creds, ...req })), want, name);
  },
);

NodeTest.test("encodes key paths once per segment and queries fully", () => {
  NodeAssert.equal(encodeKeyPath("a b+c/ü/x%y"), "/a%20b%2Bc/%C3%BC/x%25y");
  NodeAssert.equal(encodeKeyPath("dir//file"), "/dir//file");
  NodeAssert.equal(
    canonicalQuery([
      ["prefix", "a/b c"],
      ["list-type", "2"],
    ]),
    "list-type=2&prefix=a%2Fb%20c",
  );
});
