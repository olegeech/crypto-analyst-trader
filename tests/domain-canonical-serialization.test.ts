import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalSerialize,
  hashCanonical,
} from "../src/domain/identity/canonical-serialization.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";
import { createOperatorMainnetQuote } from "../src/domain/execution/operator-mainnet-test-plan.js";

test("canonical serialization sorts keys, normalizes Unicode and decimals", () => {
  const first = DecimalValue.fromString("001.2300");
  const second = DecimalValue.fromString("1.23");
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  const left = canonicalSerialize({
    z: "e\u0301",
    decimal: first.value,
    nested: { b: 2, a: true },
  });
  const right = canonicalSerialize({
    nested: { a: true, b: 2 },
    decimal: second.value,
    z: "é",
  });
  assert.equal(left.ok, true);
  assert.equal(right.ok, true);
  if (left.ok && right.ok) assert.equal(left.value, right.value);
});

test("canonical identity distinguishes omitted fields from explicit null", () => {
  const omitted = canonicalSerialize({ present: "value" });
  const explicitNull = canonicalSerialize({ present: "value", optional: null });
  assert.equal(omitted.ok, true);
  assert.equal(explicitNull.ok, true);
  if (!omitted.ok || !explicitNull.ok) return;
  assert.notEqual(omitted.value, explicitNull.value);
  assert.equal(canonicalSerialize({ optional: undefined }).ok, false);
});

test("reserved decimal tags cannot be forged by plain objects", () => {
  const forged = canonicalSerialize({ value: { $decimal: "1" } });
  assert.equal(forged.ok, false);
});

test("hashes are version-independent values with a stable SHA-256 prefix", () => {
  const first = hashCanonical({ value: "1" });
  const second = hashCanonical({ value: "1" });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.value, second.value);
  assert.match(first.value, /^sha256:[0-9a-f]{64}$/u);
});

test("operator quote canonical identity binds attribution, provider time and price facts", () => {
  const source = {
    symbol: "DOGEUSDT",
    exchange: "bybit",
    environment: "mainnet",
    category: "linear",
    origin: "https://api.bybit.com",
    observedAt: "2026-10-22T10:00:00.000Z",
    collectionStartedAt: "2026-10-22T09:59:59.990Z",
    collectionCompletedAt: "2026-10-22T10:00:00.010Z",
    bid: "0.0886",
    ask: "0.0887",
    last: "0.08865",
  };
  const first = createOperatorMainnetQuote(source);
  const repeated = createOperatorMainnetQuote({ ...source });
  const changedOrigin = createOperatorMainnetQuote({
    ...source,
    origin: "https://api-testnet.bybit.com",
  });
  assert.equal(first.ok, true);
  assert.equal(repeated.ok, true);
  assert.equal(changedOrigin.ok, false);
  if (first.ok && repeated.ok) {
    assert.equal(first.value.contentHash, repeated.value.contentHash);
    const canonical = canonicalSerialize(first.value);
    assert.equal(canonical.ok, true);
    assert.match(first.value.contentHash, /^sha256:[0-9a-f]{64}$/u);
  }
});
