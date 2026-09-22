import assert from "node:assert/strict";
import test from "node:test";

import { parseDemoEntryInput } from "../src/application/demo-entry-input.js";

test("Demo input requires exactly one explicit take-profit", () => {
  const parsed = parseDemoEntryInput([
    "--symbol",
    "DOGEUSDT",
    "--side",
    "buy",
    "--notional",
    "10",
    "--take-profit-percent",
    "3",
  ]);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.takeProfit.kind, "percent");
    assert.equal(parsed.value.takeProfit.value.toString(), "3");
  }
  assert.equal(
    parseDemoEntryInput([
      "--symbol",
      "DOGEUSDT",
      "--side",
      "buy",
      "--notional",
      "10",
    ]).ok,
    false,
  );
  assert.equal(
    parseDemoEntryInput([
      "--symbol",
      "DOGEUSDT",
      "--side",
      "buy",
      "--notional",
      "10",
      "--take-profit-percent",
      "3",
      "--take-profit-price",
      "0.1",
    ]).ok,
    false,
  );
});

test("Demo input rejects environment and time-in-force selectors before access", () => {
  const result = parseDemoEntryInput(["--environment", "testnet"]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "INVALID_ARGUMENT");
});
