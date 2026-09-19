import { isDecimalValue } from "../shared/decimal.js";
import type { DecimalValue } from "../shared/decimal.js";
import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";
import { requireIdentifier, requireSafeText } from "../shared/validation.js";

export type OrderSide = "buy" | "sell";
export type PositionEffect = "open" | "close";
export type RoundingDirection = "floor" | "ceil";

export interface ProtectionIntent {
  readonly stopLoss?: DecimalValue;
  readonly takeProfit?: DecimalValue;
}

export interface OrderIntent {
  readonly intentId: string;
  readonly instrument: string;
  readonly orderType: "limit";
  readonly side: OrderSide;
  readonly positionEffect: PositionEffect;
  readonly price: DecimalValue;
  readonly quantity: DecimalValue;
  readonly notional: DecimalValue;
  readonly normalization: {
    readonly price: RoundingDirection;
    readonly quantity: RoundingDirection;
    readonly constraintVersion: string;
  };
  readonly protection?: ProtectionIntent;
}

export interface ValidatedOrderIntentInput {
  readonly intentId: string;
  readonly instrument: string;
  readonly orderType: "limit";
  readonly side: OrderSide;
  readonly positionEffect: PositionEffect;
  readonly price: DecimalValue;
  readonly quantity: DecimalValue;
  readonly notional: DecimalValue;
  readonly normalization: OrderIntent["normalization"];
  readonly protection?: ProtectionIntent;
}

export function createOrderIntent(
  input: ValidatedOrderIntentInput,
): Result<OrderIntent> {
  const intentId = requireIdentifier(input.intentId, "intentId");
  const instrument = requireIdentifier(input.instrument, "instrument");
  if (
    !intentId.ok ||
    !instrument.ok ||
    input.orderType !== "limit" ||
    (input.side !== "buy" && input.side !== "sell") ||
    (input.positionEffect !== "open" && input.positionEffect !== "close") ||
    !isDecimalValue(input.price) ||
    !isDecimalValue(input.quantity) ||
    !isDecimalValue(input.notional) ||
    !input.quantity.isPositive() ||
    !input.price.isPositive()
  ) {
    return fail(
      domainError("CONSTRAINT_VIOLATION", "order intent is not valid"),
    );
  }
  if (
    !input.normalization ||
    (input.normalization.price !== "floor" &&
      input.normalization.price !== "ceil") ||
    (input.normalization.quantity !== "floor" &&
      input.normalization.quantity !== "ceil")
  ) {
    return fail(
      domainError(
        "INVALID_CONSTRAINT",
        "order intent normalization is invalid",
      ),
    );
  }
  const constraintVersion = requireSafeText(
    input.normalization.constraintVersion,
    "constraintVersion",
  );
  if (!constraintVersion.ok) {
    return fail(
      domainError(
        "INVALID_CONSTRAINT",
        "order intent constraint version is invalid",
      ),
    );
  }
  if (input.price.multiply(input.quantity).compare(input.notional) !== 0) {
    return fail(
      domainError(
        "CONSTRAINT_VIOLATION",
        "order intent notional does not match price and quantity",
      ),
    );
  }
  if (
    input.protection !== undefined &&
    ((input.protection.stopLoss !== undefined &&
      (!isDecimalValue(input.protection.stopLoss) ||
        !input.protection.stopLoss.isPositive())) ||
      (input.protection.takeProfit !== undefined &&
        (!isDecimalValue(input.protection.takeProfit) ||
          !input.protection.takeProfit.isPositive())))
  ) {
    return fail(
      domainError("PROTECTION_REQUIRED", "order protection values are invalid"),
    );
  }
  if (
    input.protection !== undefined &&
    input.protection.stopLoss === undefined &&
    input.protection.takeProfit === undefined
  ) {
    return fail(
      domainError("PROTECTION_REQUIRED", "order protection requires an exit"),
    );
  }
  const result: {
    intentId: string;
    instrument: string;
    orderType: "limit";
    side: OrderSide;
    positionEffect: PositionEffect;
    price: DecimalValue;
    quantity: DecimalValue;
    notional: DecimalValue;
    normalization: OrderIntent["normalization"];
    protection?: ProtectionIntent;
  } = {
    intentId: intentId.value,
    instrument: instrument.value,
    orderType: "limit",
    side: input.side,
    positionEffect: input.positionEffect,
    price: input.price,
    quantity: input.quantity,
    notional: input.notional,
    normalization: Object.freeze({
      price: input.normalization.price,
      quantity: input.normalization.quantity,
      constraintVersion: constraintVersion.value,
    }),
  };
  if (input.protection !== undefined) {
    result.protection = Object.freeze({ ...input.protection });
  }
  return ok(Object.freeze(result));
}
