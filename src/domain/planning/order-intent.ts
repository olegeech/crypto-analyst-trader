import { isDecimalValue } from "../shared/decimal.js";
import type { DecimalValue } from "../shared/decimal.js";
import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";
import { requireIdentifier, requireSafeText } from "../shared/validation.js";
import { closedRecord } from "./planning-validation.js";

export type OrderSide = "buy" | "sell";
export type PositionEffect = "open" | "close";
export type RoundingDirection = "floor" | "ceil";

export interface TakeProfitExecutionPolicy {
  readonly policyVersion: "m1-mainnet-per-leg-tp/v1";
  readonly tpslMode: "Partial";
  readonly orderType: "Market";
  readonly triggerBy: "LastPrice";
}

export interface ProtectionIntent {
  readonly stopLoss?: DecimalValue;
  readonly takeProfit?: DecimalValue;
  readonly takeProfitPolicy?: TakeProfitExecutionPolicy;
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
  const protectionInput = input.protection;
  const stopLoss = protectionInput?.stopLoss;
  const takeProfit = protectionInput?.takeProfit;
  const takeProfitPolicy = protectionInput?.takeProfitPolicy;
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
    protectionInput !== undefined &&
    (!closedRecord(protectionInput, [
      "stopLoss",
      "takeProfit",
      "takeProfitPolicy",
    ]) ||
      (stopLoss !== undefined &&
        (!isDecimalValue(stopLoss) || !stopLoss.isPositive())) ||
      (takeProfit !== undefined &&
        (!isDecimalValue(takeProfit) || !takeProfit.isPositive())) ||
      (takeProfitPolicy !== undefined &&
        (!closedRecord(takeProfitPolicy, [
          "policyVersion",
          "tpslMode",
          "orderType",
          "triggerBy",
        ]) ||
          Reflect.ownKeys(takeProfitPolicy).length !== 4 ||
          takeProfitPolicy.policyVersion !== "m1-mainnet-per-leg-tp/v1" ||
          takeProfitPolicy.tpslMode !== "Partial" ||
          takeProfitPolicy.orderType !== "Market" ||
          takeProfitPolicy.triggerBy !== "LastPrice" ||
          takeProfit === undefined ||
          stopLoss !== undefined)))
  ) {
    return fail(
      domainError("PROTECTION_REQUIRED", "order protection values are invalid"),
    );
  }
  if (
    protectionInput !== undefined &&
    stopLoss === undefined &&
    takeProfit === undefined
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
  if (protectionInput !== undefined) {
    result.protection = Object.freeze({
      ...(stopLoss === undefined ? {} : { stopLoss }),
      ...(takeProfit === undefined ? {} : { takeProfit }),
      ...(takeProfitPolicy === undefined
        ? {}
        : {
            takeProfitPolicy: Object.freeze({
              policyVersion: "m1-mainnet-per-leg-tp/v1" as const,
              tpslMode: "Partial" as const,
              orderType: "Market" as const,
              triggerBy: "LastPrice" as const,
            }),
          }),
    });
  }
  return ok(Object.freeze(result));
}
