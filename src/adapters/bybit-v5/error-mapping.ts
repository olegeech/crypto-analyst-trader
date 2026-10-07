import type {
  ExchangeExecutionFailure,
  ExchangeOperation,
} from "../../ports/exchange-execution.js";
import { BybitOrderMappingError } from "./order-mappers.js";
import { BybitReadMappingError } from "./read-mappers.js";
import {
  BybitDemoTransportError,
  type BybitPrivateEnvironment,
} from "./transport.js";

export interface BybitFailureContext {
  readonly operation: ExchangeOperation;
  readonly clientOrderId?: string;
  readonly exchangeOrderId?: string;
}

function failure(
  context: BybitFailureContext,
  kind: ExchangeExecutionFailure["kind"],
  message: string,
  retry: ExchangeExecutionFailure["retry"],
  extras: { exchangeCode?: number; httpStatus?: number } = {},
): ExchangeExecutionFailure {
  return Object.freeze({
    kind,
    message,
    retry,
    operation: context.operation,
    ...(context.clientOrderId === undefined
      ? {}
      : { clientOrderId: context.clientOrderId }),
    ...(context.exchangeOrderId === undefined
      ? {}
      : { exchangeOrderId: context.exchangeOrderId }),
    ...(extras.exchangeCode === undefined
      ? {}
      : { exchangeCode: extras.exchangeCode }),
    ...(extras.httpStatus === undefined
      ? {}
      : { httpStatus: extras.httpStatus }),
  });
}

export function normalizeBybitFailure(
  error: unknown,
  context: BybitFailureContext,
  environment: BybitPrivateEnvironment = "demo",
): ExchangeExecutionFailure {
  const venue = environment === "mainnet" ? "Bybit Mainnet" : "Bybit Demo";
  if (error instanceof BybitDemoTransportError) {
    const extras = {
      ...(error.retCode === undefined ? {} : { exchangeCode: error.retCode }),
      ...(error.httpStatus === undefined
        ? {}
        : { httpStatus: error.httpStatus }),
    };
    switch (error.kind) {
      case "invalid-credentials":
      case "expired-credentials":
        return failure(
          context,
          "authentication",
          `${venue} credentials were rejected.`,
          "never",
          extras,
        );
      case "permission-denied":
      case "ip-restriction":
        return failure(
          context,
          "permission",
          `${venue} credentials cannot perform this operation.`,
          "never",
          extras,
        );
      case "clock-skew":
        return failure(
          context,
          "clock-skew",
          `${venue} rejected the request because the signing clock is outside the allowed window.`,
          "never",
          extras,
        );
      case "signing-defect":
        return failure(
          context,
          "configuration",
          `${venue} rejected the request signature; inspect adapter configuration before retrying.`,
          "never",
          extras,
        );
      case "rate-limited":
        return failure(
          context,
          "rate-limited",
          `${venue} rate-limited the request; wait before another bounded read.`,
          "read-only",
          extras,
        );
      case "ambiguous-server":
        return failure(
          context,
          "ambiguous",
          `${venue} returned an ambiguous server outcome; reconcile the original identity before retrying.`,
          "reconcile",
          extras,
        );
      case "ownership-conflict":
        return failure(
          context,
          "ownership",
          `${venue} reported an identity or order ownership conflict; reconcile the original identity.`,
          "reconcile",
          extras,
        );
      case "validation-failed":
        return failure(
          context,
          "precondition",
          `${venue} rejected the request as invalid for the selected scope.`,
          "never",
          extras,
        );
      case "invalid-request":
        return failure(
          context,
          "configuration",
          `${venue} adapter rejected an invalid request before exchange evidence was accepted.`,
          "never",
          extras,
        );
      case "invalid-response":
        return failure(
          context,
          "invalid-response",
          `${venue} returned a response that could not be validated.`,
          "reconcile",
          extras,
        );
      case "transport-failed":
        return failure(
          context,
          "transport",
          `${venue} request did not complete; reconcile before retrying a write.`,
          "reconcile",
          extras,
        );
      case "exchange-failure":
        return failure(
          context,
          context.operation === "read" ||
            context.operation === "observe" ||
            context.operation === "fills"
            ? "exchange"
            : "ambiguous",
          `${venue} returned an unclassified failure; reconcile the original identity before retrying.`,
          context.operation === "read" ||
            context.operation === "observe" ||
            context.operation === "fills"
            ? "never"
            : "reconcile",
          extras,
        );
    }
  }

  if (error instanceof BybitReadMappingError) {
    return failure(
      context,
      error.kind === "precondition" ? "precondition" : "invalid-response",
      error.kind === "precondition"
        ? `The selected ${environment === "mainnet" ? "Mainnet" : "Demo"} state does not satisfy the required precondition.`
        : `${venue} read evidence failed runtime validation.`,
      "never",
    );
  }

  if (error instanceof BybitOrderMappingError) {
    return failure(
      context,
      error.kind === "precondition" ? "precondition" : "configuration",
      error.kind === "precondition"
        ? `${venue} order response or ownership state conflicts with the supplied identity.`
        : `${venue} adapter rejected an invalid order request or response.`,
      error.kind === "precondition" ? "reconcile" : "never",
    );
  }

  return failure(
    context,
    "transport",
    `${venue} operation failed without a safe normalized diagnostic; reconcile before retrying a write.`,
    "reconcile",
  );
}
