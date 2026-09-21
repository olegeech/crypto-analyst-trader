import type {
  ExchangeCancelOrderRequest,
  ExchangeOrderAcknowledgement,
  ExchangeOrderRequest,
} from "../../ports/exchange-execution.js";
import { isDecimalValue } from "../../domain/shared/decimal.js";
import type { UtcTimestamp } from "../../domain/shared/time.js";
import type { BybitResponse } from "./transport.js";

export const CREATE_ORDER_PATH = "/v5/order/create";
export const CANCEL_ORDER_PATH = "/v5/order/cancel";

export type BybitOrderTimeInForce = "GTC" | "IOC" | "FOK" | "PostOnly";

export interface BybitCreateOrderRequest {
  readonly [field: string]: unknown;
  readonly category: "linear";
  readonly symbol: string;
  readonly side: "Buy" | "Sell";
  readonly orderType: "Limit";
  readonly qty: string;
  readonly price: string;
  readonly timeInForce: BybitOrderTimeInForce;
  readonly positionIdx: 0;
  readonly orderLinkId: string;
  readonly reduceOnly: boolean;
  readonly takeProfit?: string;
  readonly stopLoss?: string;
  readonly tpslMode?: "Full";
}

export interface BybitCancelOrderRequest {
  readonly [field: string]: unknown;
  readonly category: "linear";
  readonly symbol: string;
  readonly orderId?: string;
  readonly orderLinkId: string;
}

export class BybitOrderMappingError extends Error {
  readonly kind: "invalid-request" | "invalid-response" | "precondition";

  constructor(kind: BybitOrderMappingError["kind"], message: string) {
    super(message);
    this.name = "BybitOrderMappingError";
    this.kind = kind;
  }
}

const CLIENT_ORDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,36}$/u;

function invalidRequest(message: string): never {
  throw new BybitOrderMappingError("invalid-request", message);
}

function invalidResponse(message: string): never {
  throw new BybitOrderMappingError("invalid-response", message);
}

function precondition(message: string): never {
  throw new BybitOrderMappingError("precondition", message);
}

function validateClientOrderId(clientOrderId: string): string {
  if (
    typeof clientOrderId !== "string" ||
    !CLIENT_ORDER_ID_PATTERN.test(clientOrderId)
  ) {
    invalidRequest(
      "clientOrderId must be 1-36 ASCII letters, digits, underscore or hyphen.",
    );
  }
  return clientOrderId;
}

function validateTimeInForce(timeInForce: string): BybitOrderTimeInForce {
  if (
    timeInForce !== "GTC" &&
    timeInForce !== "IOC" &&
    timeInForce !== "FOK" &&
    timeInForce !== "PostOnly"
  ) {
    invalidRequest("timeInForce is not supported by the Demo linear adapter.");
  }
  return timeInForce;
}

function mapProtection(request: ExchangeOrderRequest): {
  takeProfit?: string;
  stopLoss?: string;
  tpslMode?: "Full";
} {
  const protection = request.intent.protection;
  if (protection === undefined) return {};
  if (request.reduceOnly) {
    invalidRequest("reduce-only orders cannot carry attached protection.");
  }
  if (
    (protection.takeProfit !== undefined &&
      !isDecimalValue(protection.takeProfit)) ||
    (protection.stopLoss !== undefined && !isDecimalValue(protection.stopLoss))
  ) {
    invalidRequest(
      "attached protection values must be validated decimal values.",
    );
  }
  const takeProfit = protection.takeProfit?.toString();
  const stopLoss = protection.stopLoss?.toString();
  if (takeProfit === undefined && stopLoss === undefined) {
    invalidRequest(
      "attached protection must contain a take-profit or stop-loss.",
    );
  }
  if (takeProfit !== undefined) {
    const comparison = protection.takeProfit!.compare(request.intent.price);
    if (
      (request.intent.side === "buy" && comparison <= 0) ||
      (request.intent.side === "sell" && comparison >= 0)
    ) {
      invalidRequest("take-profit is on the wrong side of the entry price.");
    }
  }
  if (stopLoss !== undefined) {
    const comparison = protection.stopLoss!.compare(request.intent.price);
    if (
      (request.intent.side === "buy" && comparison >= 0) ||
      (request.intent.side === "sell" && comparison <= 0)
    ) {
      invalidRequest("stop-loss is on the wrong side of the entry price.");
    }
  }
  return {
    ...(takeProfit === undefined ? {} : { takeProfit }),
    ...(stopLoss === undefined ? {} : { stopLoss }),
    tpslMode: "Full",
  };
}

export function mapCreateOrderRequest(
  request: ExchangeOrderRequest,
): BybitCreateOrderRequest {
  if (
    request === null ||
    typeof request !== "object" ||
    request.intent === null ||
    typeof request.intent !== "object"
  ) {
    invalidRequest("order request and intent must be objects.");
  }
  if (request.intent.orderType !== "limit") {
    invalidRequest("only limit orders are supported by the Demo adapter.");
  }
  if (
    !isDecimalValue(request.intent.price) ||
    !isDecimalValue(request.intent.quantity) ||
    !request.intent.price.isPositive() ||
    !request.intent.quantity.isPositive()
  ) {
    invalidRequest(
      "order price and quantity must be positive validated decimals.",
    );
  }
  if (typeof request.reduceOnly !== "boolean") {
    invalidRequest("reduceOnly must be an explicit boolean.");
  }
  const clientOrderId = validateClientOrderId(request.clientOrderId);
  const timeInForce = validateTimeInForce(request.timeInForce);
  const protection = mapProtection(request);
  return Object.freeze({
    category: "linear",
    symbol: request.intent.instrument,
    side: request.intent.side === "buy" ? "Buy" : "Sell",
    orderType: "Limit",
    qty: request.intent.quantity.toString(),
    price: request.intent.price.toString(),
    timeInForce,
    positionIdx: 0,
    orderLinkId: clientOrderId,
    reduceOnly: request.reduceOnly,
    ...protection,
  });
}

export function mapCancelOrderRequest(
  request: ExchangeCancelOrderRequest,
): BybitCancelOrderRequest {
  const orderLinkId = validateClientOrderId(request.clientOrderId);
  if (request.exchangeOrderId !== undefined) {
    if (
      typeof request.exchangeOrderId !== "string" ||
      request.exchangeOrderId.length === 0 ||
      /[\u0000-\u001f\u007f\r\n]/u.test(request.exchangeOrderId)
    ) {
      invalidRequest("exchangeOrderId must be a non-empty safe identifier.");
    }
  }
  return Object.freeze({
    category: "linear",
    symbol: request.instrument,
    orderLinkId,
    ...(request.exchangeOrderId === undefined
      ? {}
      : { orderId: request.exchangeOrderId }),
  });
}

function responseText(
  response: BybitResponse,
  field: string,
): string | undefined {
  const value = response.result[field];
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || /[\u0000-\u001f\u007f\r\n]/u.test(value)) {
    invalidResponse(`Bybit order response has an invalid ${field}.`);
  }
  return value;
}

export function mapOrderAcknowledgement(
  response: BybitResponse,
  clientOrderId: string,
  acknowledgedAt: UtcTimestamp,
): ExchangeOrderAcknowledgement {
  validateClientOrderId(clientOrderId);
  const returnedClientOrderId = responseText(response, "orderLinkId");
  if (
    returnedClientOrderId !== undefined &&
    returnedClientOrderId !== clientOrderId
  ) {
    precondition(
      "Bybit returned an orderLinkId different from the supplied identity.",
    );
  }
  const exchangeOrderId = responseText(response, "orderId");
  return Object.freeze({
    clientOrderId,
    acknowledgedAt,
    status: exchangeOrderId === undefined ? "pending" : "accepted",
    ...(exchangeOrderId === undefined ? {} : { exchangeOrderId }),
  });
}
