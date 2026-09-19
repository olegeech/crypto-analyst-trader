import assert from "node:assert/strict";
import test from "node:test";

import { createInstrumentConstraints } from "../src/domain/market/instrument-constraints.js";
import { normalizeOrderIntent } from "../src/domain/planning/normalize-order-intent.js";
import { createOrderIntent } from "../src/domain/planning/order-intent.js";
import { parseDecimal } from "../src/domain/shared/decimal.js";

const constraints = createInstrumentConstraints({
  instrument: "DOGEUSDT",
  priceTickSize: "0.0001",
  quantityStep: "1",
  minQuantity: "1",
  minNotional: "5",
});

test("order intents are normalized before risk and preserve the rounding policy", () => {
  assert.equal(constraints.ok, true);
  if (!constraints.ok) return;
  const result = normalizeOrderIntent(
    {
      intentId: "intent-1",
      instrument: "DOGEUSDT",
      orderType: "limit",
      side: "buy",
      positionEffect: "open",
      price: "0.08876",
      quantity: "57.2",
      rounding: { price: "floor", quantity: "floor" },
    },
    constraints.value,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.price.toString(), "0.0887");
  assert.equal(result.value.quantity.toString(), "57");
  assert.equal(result.value.normalization.price, "floor");
  assert.equal(result.value.notional.toString(), "5.0559");
});

test("invalid minimum quantity, notional and unsupported M0 modes fail closed", () => {
  assert.equal(constraints.ok, true);
  if (!constraints.ok) return;
  const tooSmall = normalizeOrderIntent(
    {
      intentId: "intent-2",
      instrument: "DOGEUSDT",
      orderType: "limit",
      side: "buy",
      positionEffect: "open",
      price: "0.0887",
      quantity: "0.5",
      rounding: { price: "floor", quantity: "floor" },
    },
    constraints.value,
  );
  assert.equal(tooSmall.ok, false);
  if (!tooSmall.ok) assert.equal(tooSmall.error.code, "QUANTITY_TOO_SMALL");

  const unsupported = normalizeOrderIntent(
    {
      intentId: "intent-3",
      instrument: "DOGEUSDT",
      orderType: "limit",
      positionMode: "hedge",
      side: "buy",
      positionEffect: "open",
      price: "0.0887",
      quantity: "57",
      rounding: { price: "floor", quantity: "floor" },
      takeProfits: ["0.09", "0.091"],
    },
    constraints.value,
  );
  assert.equal(unsupported.ok, false);
  if (!unsupported.ok)
    assert.equal(unsupported.error.code, "UNSUPPORTED_CONTRACT");
});

test("execution client-order identity cannot enter semantic intent identity", () => {
  assert.equal(constraints.ok, true);
  if (!constraints.ok) return;
  const result = normalizeOrderIntent(
    {
      intentId: "intent-client-id",
      clientOrderId: "exchange-id-must-be-on-attempt",
      instrument: "DOGEUSDT",
      orderType: "limit",
      side: "buy",
      positionEffect: "open",
      price: "0.0887",
      quantity: "57",
      rounding: { price: "floor", quantity: "floor" },
    },
    constraints.value,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "UNSUPPORTED_CONTRACT");
});

test("direct order-intent construction validates the constraint version", () => {
  const price = parseDecimal("0.0887");
  const quantity = parseDecimal("57");
  assert.equal(price.ok, true);
  assert.equal(quantity.ok, true);
  if (!price.ok || !quantity.ok) return;
  const result = createOrderIntent({
    intentId: "intent-invalid-version",
    instrument: "DOGEUSDT",
    orderType: "limit",
    side: "buy",
    positionEffect: "open",
    price: price.value,
    quantity: quantity.value,
    notional: price.value.multiply(quantity.value),
    normalization: {
      price: "floor",
      quantity: "floor",
      constraintVersion: "",
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "INVALID_CONSTRAINT");
});

test("direct order-intent construction rejects an empty protection object", () => {
  const price = parseDecimal("0.0887");
  const quantity = parseDecimal("57");
  assert.equal(price.ok, true);
  assert.equal(quantity.ok, true);
  if (!price.ok || !quantity.ok) return;
  const result = createOrderIntent({
    intentId: "intent-empty-protection",
    instrument: "DOGEUSDT",
    orderType: "limit",
    side: "buy",
    positionEffect: "open",
    price: price.value,
    quantity: quantity.value,
    notional: price.value.multiply(quantity.value),
    normalization: {
      price: "floor",
      quantity: "floor",
      constraintVersion: "v1",
    },
    protection: {},
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "PROTECTION_REQUIRED");
});
