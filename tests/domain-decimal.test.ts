import assert from "node:assert/strict";
import test from "node:test";

import {
  DecimalValue,
  RoundingMode,
  ceilToStep,
  floorToStep,
  parseDecimal,
} from "../src/domain/shared/decimal.js";

test("domain decimals normalize equivalent strings without binary floating point", () => {
  const first = parseDecimal("0.1");
  const second = parseDecimal("0.2");
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;

  assert.equal(first.value.add(second.value).toString(), "0.3");
  const normalized = parseDecimal("001.2300");
  assert.equal(normalized.ok, true);
  if (normalized.ok) assert.equal(normalized.value.toString(), "1.23");
  const negativeZero = parseDecimal("-0.0000");
  assert.equal(negativeZero.ok, true);
  if (negativeZero.ok) assert.equal(negativeZero.value.toString(), "0");
  assert.equal(first.value, first.value);
});

test("authoritative construction accepts only decimal strings", () => {
  for (const value of [
    1.2,
    "",
    "1e-2",
    "1.",
    "+1",
    "-",
    "NaN",
    "Infinity",
    "1.2junk",
  ] as unknown[]) {
    const result = parseDecimal(value);
    assert.equal(result.ok, false, String(value));
    if (!result.ok) assert.equal(result.error.code, "INVALID_DECIMAL");
  }
});

test("directional step rounding is explicit and rejects non-positive steps", () => {
  const value = parseDecimal("1.019");
  const step = parseDecimal("0.01");
  assert.equal(value.ok, true);
  assert.equal(step.ok, true);
  if (!value.ok || !step.ok) return;

  const floored = floorToStep(value.value, step.value);
  const ceiled = ceilToStep(value.value, step.value);
  assert.equal(floored.ok, true);
  assert.equal(ceiled.ok, true);
  if (floored.ok) assert.equal(floored.value.toString(), "1.01");
  if (ceiled.ok) assert.equal(ceiled.value.toString(), "1.02");
  assert.equal(
    value.value.roundToScale(2, RoundingMode.HALF_UP).toString(),
    "1.02",
  );

  const zero = parseDecimal("0");
  assert.equal(zero.ok, true);
  if (!zero.ok) return;
  const invalid = floorToStep(value.value, zero.value);
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.code, "INVALID_DECIMAL");
});

test("step rounding never floors above a high-precision input", () => {
  const value = parseDecimal(`0.${"9".repeat(1001)}`);
  const step = parseDecimal("1");
  assert.equal(value.ok, true);
  assert.equal(step.ok, true);
  if (!value.ok || !step.ok) return;
  const floored = floorToStep(value.value, step.value);
  assert.equal(floored.ok, true);
  if (floored.ok) assert.equal(floored.value.toString(), "0");
});

test("directional rounding is mathematical for negative values too", () => {
  const value = parseDecimal("-1.019");
  const step = parseDecimal("0.01");
  assert.equal(value.ok, true);
  assert.equal(step.ok, true);
  if (!value.ok || !step.ok) return;
  const floored = floorToStep(value.value, step.value);
  const ceiled = ceilToStep(value.value, step.value);
  assert.equal(floored.ok, true);
  assert.equal(ceiled.ok, true);
  if (floored.ok) assert.equal(floored.value.toString(), "-1.02");
  if (ceiled.ok) assert.equal(ceiled.value.toString(), "-1.01");
});

test("division and rounding policies do not leak through a shared constructor", () => {
  const one = DecimalValue.fromString("1");
  const three = DecimalValue.fromString("3");
  assert.equal(one.ok, true);
  assert.equal(three.ok, true);
  if (!one.ok || !three.ok) return;

  const result = one.value.divide(three.value, 6, RoundingMode.DOWN);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.toString(), "0.333333");
  assert.equal(one.value.add(one.value).toString(), "2");
  const normalized = DecimalValue.fromString("1.2300");
  assert.equal(normalized.ok, true);
  if (normalized.ok) assert.equal(normalized.value.toString(), "1.23");
});

test("square root is exact-decimal, bounded, and uses the requested rounding", () => {
  const zero = parseDecimal("0");
  const exactSquare = parseDecimal("2.25");
  const irrational = parseDecimal("2");
  const halfwaySquare = parseDecimal("1.52399025");
  assert.equal(zero.ok, true);
  assert.equal(exactSquare.ok, true);
  assert.equal(irrational.ok, true);
  assert.equal(halfwaySquare.ok, true);
  if (!zero.ok || !exactSquare.ok || !irrational.ok || !halfwaySquare.ok) {
    return;
  }

  const zeroRoot = zero.value.squareRoot(18, RoundingMode.HALF_EVEN);
  const exactRoot = exactSquare.value.squareRoot(18, RoundingMode.HALF_EVEN);
  const approximateRoot = irrational.value.squareRoot(
    18,
    RoundingMode.HALF_EVEN,
  );
  const halfEvenRoot = halfwaySquare.value.squareRoot(
    3,
    RoundingMode.HALF_EVEN,
  );
  const halfUpRoot = halfwaySquare.value.squareRoot(3, RoundingMode.HALF_UP);
  assert.equal(zeroRoot.ok, true);
  assert.equal(exactRoot.ok, true);
  assert.equal(approximateRoot.ok, true);
  assert.equal(halfEvenRoot.ok, true);
  assert.equal(halfUpRoot.ok, true);
  if (
    !zeroRoot.ok ||
    !exactRoot.ok ||
    !approximateRoot.ok ||
    !halfEvenRoot.ok ||
    !halfUpRoot.ok
  ) {
    return;
  }

  assert.equal(zeroRoot.value.toString(), "0");
  assert.equal(exactRoot.value.toString(), "1.5");
  assert.equal(approximateRoot.value.toString(), "1.414213562373095049");
  assert.equal(halfEvenRoot.value.toString(), "1.234");
  assert.equal(halfUpRoot.value.toString(), "1.235");

  const negative = parseDecimal("-1");
  assert.equal(negative.ok, true);
  if (negative.ok) {
    const invalid = negative.value.squareRoot(18, RoundingMode.HALF_EVEN);
    assert.equal(invalid.ok, false);
    if (!invalid.ok) assert.equal(invalid.error.code, "INVALID_DECIMAL");
  }
});
