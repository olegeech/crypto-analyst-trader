import { ceilToStep, floorToStep, DecimalValue } from "../shared/decimal.js";
import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";
import { isRecord, requireIdentifier } from "../shared/validation.js";
import {
  createOrderIntent,
  type ProtectionIntent,
  type RoundingDirection,
  type OrderIntent,
} from "./order-intent.js";
import type { InstrumentConstraints } from "../market/instrument-constraints.js";

function roundByDirection(
  value: DecimalValue,
  step: DecimalValue,
  direction: RoundingDirection,
): Result<DecimalValue> {
  return direction === "floor"
    ? floorToStep(value, step)
    : ceilToStep(value, step);
}

function parseDirection(
  value: unknown,
  field: string,
): Result<RoundingDirection> {
  if (value !== "floor" && value !== "ceil") {
    return fail(
      domainError("INVALID_CONSTRAINT", `${field} must be floor or ceil`, {
        field,
      }),
    );
  }
  return ok(value);
}

function parsePositive(value: unknown, field: string): Result<DecimalValue> {
  const result = DecimalValue.fromString(value);
  if (!result.ok) return result;
  if (!result.value.isPositive()) {
    return fail(
      domainError("CONSTRAINT_VIOLATION", `${field} must be positive`, {
        field,
      }),
    );
  }
  return result;
}

function parseProtection(
  input: unknown,
  direction: RoundingDirection,
  constraints: InstrumentConstraints,
): Result<ProtectionIntent | undefined> {
  if (input === undefined) return ok(undefined);
  if (!isRecord(input)) {
    return fail(
      domainError("UNSUPPORTED_CONTRACT", "protection must be one object"),
    );
  }
  const protection: { stopLoss?: DecimalValue; takeProfit?: DecimalValue } = {};
  for (const [key, rawValue] of [
    ["stopLoss", input.stopLoss],
    ["takeProfit", input.takeProfit],
  ] as const) {
    if (rawValue === undefined) continue;
    const parsed = parsePositive(rawValue, key);
    if (!parsed.ok) return parsed;
    const normalized = roundByDirection(
      parsed.value,
      constraints.priceTickSize,
      direction,
    );
    if (!normalized.ok) return normalized;
    protection[key] = normalized.value;
  }
  if (
    protection.stopLoss === undefined &&
    protection.takeProfit === undefined
  ) {
    return fail(
      domainError(
        "PROTECTION_REQUIRED",
        "protection object must contain an exit",
      ),
    );
  }
  return ok(Object.freeze(protection));
}

export function normalizeOrderIntent(
  input: unknown,
  constraints: InstrumentConstraints,
): Result<OrderIntent> {
  if (!isRecord(input)) {
    return fail(domainError("INVALID_VALUE", "order intent must be an object"));
  }
  if ("clientOrderId" in input) {
    return fail(
      domainError(
        "UNSUPPORTED_CONTRACT",
        "execution client-order identity belongs to an attempt, not a semantic intent",
      ),
    );
  }
  if (input.positionMode !== undefined || input.takeProfits !== undefined) {
    return fail(
      domainError(
        "UNSUPPORTED_CONTRACT",
        "hedge and multiple take-profit modes are outside M0",
      ),
    );
  }
  if (input.instrument !== constraints.instrument) {
    return fail(
      domainError(
        "CONSTRAINT_VIOLATION",
        "intent instrument does not match constraints",
      ),
    );
  }
  if (input.orderType !== "limit") {
    return fail(
      domainError(
        "UNSUPPORTED_CONTRACT",
        "only limit intents are in the M0 contract",
      ),
    );
  }
  if (input.side !== "buy" && input.side !== "sell") {
    return fail(domainError("INVALID_VALUE", "intent side is invalid"));
  }
  if (input.positionEffect !== "open" && input.positionEffect !== "close") {
    return fail(
      domainError("INVALID_VALUE", "intent position effect is invalid"),
    );
  }
  const intentId = requireIdentifier(input.intentId, "intentId");
  if (!intentId.ok) return intentId;
  if (!isRecord(input.rounding)) {
    return fail(
      domainError("INVALID_CONSTRAINT", "rounding policy is required"),
    );
  }
  const priceDirection = parseDirection(input.rounding.price, "rounding.price");
  const quantityDirection = parseDirection(
    input.rounding.quantity,
    "rounding.quantity",
  );
  if (!priceDirection.ok) return priceDirection;
  if (!quantityDirection.ok) return quantityDirection;
  const rawPrice = parsePositive(input.price, "price");
  const rawQuantity = parsePositive(input.quantity, "quantity");
  if (!rawPrice.ok) return rawPrice;
  if (!rawQuantity.ok) return rawQuantity;
  const price = roundByDirection(
    rawPrice.value,
    constraints.priceTickSize,
    priceDirection.value,
  );
  const quantity = roundByDirection(
    rawQuantity.value,
    constraints.quantityStep,
    quantityDirection.value,
  );
  if (!price.ok) return price;
  if (!quantity.ok) return quantity;
  if (!price.value.isPositive()) {
    return fail(
      domainError(
        "CONSTRAINT_VIOLATION",
        "normalization produced a non-positive price",
      ),
    );
  }
  if (!quantity.value.isPositive()) {
    return fail(
      domainError(
        "QUANTITY_TOO_SMALL",
        "normalization produced a non-positive quantity",
      ),
    );
  }
  if (quantity.value.compare(constraints.minQuantity) < 0) {
    return fail(
      domainError(
        "QUANTITY_TOO_SMALL",
        "normalized quantity is below the minimum",
      ),
    );
  }
  const notional = price.value.multiply(quantity.value);
  if (
    constraints.minNotional !== undefined &&
    notional.compare(constraints.minNotional) < 0
  ) {
    return fail(
      domainError(
        "NOTIONAL_TOO_SMALL",
        "normalized notional is below the minimum",
      ),
    );
  }
  const protection = parseProtection(
    input.protection,
    priceDirection.value,
    constraints,
  );
  if (!protection.ok) return protection;
  return createOrderIntent({
    intentId: intentId.value,
    instrument: constraints.instrument,
    orderType: "limit",
    side: input.side,
    positionEffect: input.positionEffect,
    price: price.value,
    quantity: quantity.value,
    notional,
    normalization: {
      price: priceDirection.value,
      quantity: quantityDirection.value,
      constraintVersion: constraints.version,
    },
    ...(protection.value === undefined ? {} : { protection: protection.value }),
  });
}
