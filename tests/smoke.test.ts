import assert from "node:assert/strict";
import test from "node:test";

import { initialExecutionScope, systemName } from "../src/index.js";

test("declares the initial product boundary", () => {
  assert.equal(systemName, "Crypto Analyst Trader");
  assert.deepEqual(initialExecutionScope, {
    exchange: "BYBIT",
    market: "USDT_LINEAR_PERPETUAL",
    cadence: "DAILY",
    positionMode: "ONE_WAY",
  });
});
