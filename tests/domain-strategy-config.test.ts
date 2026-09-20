import assert from "node:assert/strict";
import test from "node:test";

import { createStrategyConfig } from "../src/domain/market/strategy-config.js";

test("strategy config is a validated M0 daily contract", () => {
  const result = createStrategyConfig({
    strategyId: "daily-baseline",
    version: "v1",
    cadence: "daily",
    maxOrderNotional: "100",
    requiresProtection: true,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.maxOrderNotional.toString(), "100");
  assert.equal(result.value.cadence, "daily");
});
