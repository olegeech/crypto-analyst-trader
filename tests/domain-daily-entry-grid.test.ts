import assert from "node:assert/strict";
import test from "node:test";
import { compileDailyEntryGrid } from "../src/domain/planning/daily-entry-grid.js";
import { prepareDailyPlanningInputs } from "../src/domain/planning/daily-planning-inputs.js";
import { dailyInputFixture } from "./fixtures/daily-planning-policy-fixtures.js";
import { requireDailyFixture } from "./fixtures/daily-planning-evidence-fixtures.js";
import { fixtureDecimal } from "./fixtures/data-quality-fixtures.js";
import { createPlanningPolicy } from "../src/domain/planning/planning-policy.js";

test("multilevel grid preserves unequal budgets, distinct prices and stable identities", () => {
  const raw = dailyInputFixture();
  // Non-calibrated test policy, not a runtime trading preset.
  const planningPolicy = requireDailyFixture(
    createPlanningPolicy({
      ...raw.planningPolicy,
      levels: [
        {
          atrOffset: "0.25",
          allocationWeight: "0.3",
          takeProfitAtrDistance: "0.75",
        },
        {
          atrOffset: "1.25",
          allocationWeight: "0.7",
          takeProfitAtrDistance: "1.5",
        },
      ],
    }),
  );
  const input = requireDailyFixture(
    prepareDailyPlanningInputs({ ...raw, planningPolicy }),
  );
  const seed = `sha256:${"b".repeat(64)}`;
  const grid = requireDailyFixture(
    compileDailyEntryGrid(input, "ADD_LONG", seed),
  );
  assert.equal(grid.length, 2);
  assert.deepEqual(
    grid.map((leg) => ({
      index: leg.index,
      budget: leg.allocation.toString(),
      price: leg.intent.price.toString(),
      quantity: leg.intent.quantity.toString(),
      notional: leg.intent.notional.toString(),
      takeProfit: leg.intent.protection?.takeProfit?.toString(),
    })),
    [
      {
        index: 0,
        budget: "30",
        price: "101",
        quantity: "0.29",
        notional: "29.29",
        takeProfit: "104",
      },
      {
        index: 1,
        budget: "70",
        price: "97",
        quantity: "0.72",
        notional: "69.84",
        takeProfit: "103",
      },
    ],
  );
  for (const leg of grid) {
    assert.ok(leg.intent.notional.compare(leg.allocation) <= 0);
    assert.equal(leg.timeInForce, "GTC");
    assert.match(leg.legId, /^daily-leg:sha256:[a-f0-9]{64}$/);
    assert.match(leg.intent.intentId, /^daily-intent:sha256:[a-f0-9]{64}$/);
  }
  const total = grid[0]!.intent.notional.add(grid[1]!.intent.notional);
  assert.equal(total.toString(), "99.13");
  assert.ok(total.compare(input.allocation) <= 0);
  assert.equal(grid[0]!.allocation.add(grid[1]!.allocation).toString(), "100");
  assert.equal(new Set(grid.map((leg) => leg.legId)).size, 2);
  assert.equal(new Set(grid.map((leg) => leg.intent.intentId)).size, 2);
  assert.deepEqual(
    requireDailyFixture(compileDailyEntryGrid(input, "ADD_LONG", seed)),
    grid,
  );
});

test("ADD grid floors entries/quantities, preserves ceiled TP and fixed GTC", () => {
  const input = requireDailyFixture(
    prepareDailyPlanningInputs(dailyInputFixture()),
  );
  const grid = compileDailyEntryGrid(
    input,
    "ADD_LONG",
    `sha256:${"a".repeat(64)}`,
  );
  assert.ok(grid.ok);
  const leg = grid.value[0]!;
  assert.equal(leg.intent.price.toString(), "102");
  assert.equal(leg.intent.quantity.toString(), "0.98");
  assert.equal(leg.intent.notional.toString(), "99.96");
  assert.equal(leg.intent.protection?.takeProfit?.toString(), "106");
  assert.equal(leg.intent.protection?.stopLoss, undefined);
  assert.equal(leg.timeInForce, "GTC");
  assert.equal(leg.intent.side, "buy");
  assert.equal(leg.intent.positionEffect, "open");
  assert.ok(Object.isFrozen(leg));
  assert.deepEqual(
    compileDailyEntryGrid(input, "ADD_LONG", `sha256:${"a".repeat(64)}`),
    grid,
  );
});
test("grid is atomic and does not compile HOLD/REDUCE or missing static bounds", () => {
  const input = requireDailyFixture(
    prepareDailyPlanningInputs(dailyInputFixture()),
  );
  for (const direction of ["HOLD_LONG", "REDUCE_LONG"] as const)
    assert.equal(
      compileDailyEntryGrid(input, direction, `sha256:${"a".repeat(64)}`).ok,
      false,
    );
  const legacy = requireDailyFixture(
    prepareDailyPlanningInputs(dailyInputFixture(false)),
  );
  assert.equal(
    compileDailyEntryGrid(legacy, "ADD_LONG", `sha256:${"a".repeat(64)}`).ok,
    false,
  );
  assert.equal(
    compileDailyEntryGrid(input, "ADD_LONG", "not-a-hash").ok,
    false,
  );
});

test("fractional sizing and protection rounding never increase allocated notional", () => {
  const base = requireDailyFixture(
    prepareDailyPlanningInputs(dailyInputFixture()),
  );
  const input = {
    ...base,
    atr: fixtureDecimal("0.333"),
    allocation: fixtureDecimal("20"),
    ticker: {
      ...base.ticker,
      bid: fixtureDecimal("10.07"),
      ask: fixtureDecimal("10.07"),
    },
    constraints: {
      ...base.constraints,
      priceTickSize: fixtureDecimal("0.05"),
      quantityStep: fixtureDecimal("0.3"),
      minQuantity: fixtureDecimal("0.3"),
    },
  };
  const grid = requireDailyFixture(
    compileDailyEntryGrid(input, "ADD_LONG", `sha256:${"a".repeat(64)}`),
  );
  assert.equal(grid[0]!.intent.price.toString(), "10");
  assert.equal(grid[0]!.intent.quantity.toString(), "1.8");
  assert.equal(grid[0]!.intent.protection?.takeProfit?.toString(), "10.35");
  assert.equal(grid[0]!.intent.notional.toString(), "18");
});

test("duplicate normalized prices and any invalid leg reject the entire grid", () => {
  const base = requireDailyFixture(
    prepareDailyPlanningInputs(dailyInputFixture()),
  );
  const policy = requireDailyFixture(
    createPlanningPolicy({
      ...base.planningPolicy,
      levels: [
        { atrOffset: "1", allocationWeight: "0.5", takeProfitAtrDistance: "1" },
        {
          atrOffset: "1.001",
          allocationWeight: "0.5",
          takeProfitAtrDistance: "1",
        },
      ],
    }),
  );
  const seed = `sha256:${"a".repeat(64)}`;
  assert.equal(
    compileDailyEntryGrid(
      { ...base, atr: fixtureDecimal("0.01"), planningPolicy: policy },
      "ADD_LONG",
      seed,
    ).ok,
    false,
  );
  const two = requireDailyFixture(
    createPlanningPolicy({
      ...policy,
      levels: [policy.levels[0], { ...policy.levels[1], atrOffset: "100" }],
    }),
  );
  assert.equal(
    compileDailyEntryGrid({ ...base, planningPolicy: two }, "ADD_LONG", seed)
      .ok,
    false,
  );
  for (const patch of [
    { allocation: fixtureDecimal("0.1") },
    { atr: fixtureDecimal("0") },
    { constraints: { ...base.constraints, maxPrice: fixtureDecimal("105") } },
    {
      constraints: {
        ...base.constraints,
        maxLimitQuantity: fixtureDecimal("0.5"),
      },
    },
  ]) {
    assert.equal(
      compileDailyEntryGrid({ ...base, ...patch }, "ADD_LONG", seed).ok,
      false,
    );
  }
});

test("exact static minimum and maximum boundaries are inclusive", () => {
  const base = requireDailyFixture(
    prepareDailyPlanningInputs(dailyInputFixture()),
  );
  const input = {
    ...base,
    allocation: fixtureDecimal("102"),
    constraints: {
      ...base.constraints,
      minPrice: fixtureDecimal("102"),
      maxPrice: fixtureDecimal("106"),
      minQuantity: fixtureDecimal("1"),
      minNotional: fixtureDecimal("102"),
      maxLimitQuantity: fixtureDecimal("1"),
    },
  };
  assert.ok(
    compileDailyEntryGrid(input, "ADD_LONG", `sha256:${"a".repeat(64)}`).ok,
  );
});
