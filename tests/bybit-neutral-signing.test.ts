import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSignaturePayload,
  hmacSha256,
} from "../src/adapters/bybit-v5/request-signing.js";
import {
  buildSignaturePayload as demoPayload,
  hmacSha256 as demoHmac,
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
