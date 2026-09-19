import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalSerialize,
  hashCanonical,
} from "../src/domain/identity/canonical-serialization.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";

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
