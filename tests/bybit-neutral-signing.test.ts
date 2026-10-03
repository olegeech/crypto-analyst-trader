import assert from "node:assert/strict";
import test from "node:test";
import { classifyRetCode as neutralRetCode } from "../src/adapters/bybit-v5/response-errors.js";
import {
  buildSignaturePayload,
  hmacSha256,
} from "../src/adapters/bybit-v5/request-signing.js";
import {
  buildSignaturePayload as demoPayload,
  hmacSha256 as demoHmac,
  classifyRetCode as demoRetCode,
} from "../src/adapters/bybit-v5/transport.js";

test("neutral signing preserves the existing Demo byte contract", () => {
  const query = new URLSearchParams({
    cursor: "next+/=",
    category: "linear",
  }).toString();
  const payload = buildSignaturePayload(
    "1672052955758",
    "synthetic-key",
    "5000",
    query,
  );
  assert.equal(
    payload,
    demoPayload("1672052955758", "synthetic-key", "5000", query),
  );
  assert.equal(
    hmacSha256(payload, "synthetic-secret"),
    demoHmac(payload, "synthetic-secret"),
  );
  assert.ok(payload.endsWith("cursor=next%2B%2F%3D&category=linear"));
});

test("neutral classification preserves all existing execution error semantics", () => {
  for (const code of [
    10000, 10016, 10002, 10004, 10003, 33004, 10005, 10010, 10006, 110072,
    110001, 110008, 110010, 10001, 110003, 110007, 110017, 110023, 110094,
    110100, 181017, 99999,
  ]) {
    assert.deepEqual(neutralRetCode(code), demoRetCode(code));
  }
});
