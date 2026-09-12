import assert from "node:assert/strict";
import test from "node:test";

import {
  ceilToStep,
  compareDecimals,
  floorToStep,
  multiplyDecimals,
  multiplyByRational,
  parseDecimal,
  toDecimalString,
} from "../scripts/bybit-probe/decimal.js";

test("decimal arithmetic normalizes strings without binary floating point", () => {
  assert.equal(toDecimalString(parseDecimal("001.2300")), "1.23");
  assert.equal(
    toDecimalString(
      multiplyDecimals(parseDecimal("1.25"), parseDecimal("2.4")),
    ),
    "3",
  );
  assert.equal(compareDecimals(parseDecimal("10.00"), parseDecimal("10")), 0);
});

test("step rounding is directional at exact boundaries", () => {
  assert.equal(
    toDecimalString(ceilToStep(parseDecimal("1.001"), parseDecimal("0.01"))),
    "1.01",
  );
  assert.equal(
    toDecimalString(floorToStep(parseDecimal("1.019"), parseDecimal("0.01"))),
    "1.01",
  );
  assert.equal(
    toDecimalString(ceilToStep(parseDecimal("5.06"), parseDecimal("0.01"))),
    "5.06",
  );
});

test("rational price factors retain exact decimal results", () => {
  assert.equal(
    toDecimalString(multiplyByRational(parseDecimal("100.00"), 102n, 100n)),
    "102",
  );
  assert.equal(
    toDecimalString(multiplyByRational(parseDecimal("100.00"), 98n, 100n)),
    "98",
  );
});

test("numbers, exponents and trailing characters are rejected", () => {
  for (const value of [1.2 as unknown, "1e-2", "1.2junk", "1."]) {
    assert.throws(() => parseDecimal(value as never), /decimal string/);
  }
});
