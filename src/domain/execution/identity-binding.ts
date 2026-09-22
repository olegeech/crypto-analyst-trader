import { DecimalValue, isDecimalValue } from "../shared/decimal.js";
import { domainError } from "../shared/errors.js";
import { parseUtcTimestamp, type UtcTimestamp } from "../shared/time.js";
import { fail, ok, type Result } from "../shared/result.js";
import {
  isRecord,
  requireHash,
  requireIdentifier,
  requireSafeText,
} from "../shared/validation.js";
import type { PlanHash } from "../identity/canonical-serialization.js";

export interface IdentityBindingOwnershipContext {
  readonly exchange: string;
  readonly environment: string;
  readonly accountId: string;
  readonly category: string;
  readonly positionMode: "one-way" | "hedge";
  readonly lineageId?: string;
  readonly intentId?: string;
  readonly attemptId?: string;
}

export interface IdentityBindingCandidate {
  readonly exchangeOrderId: string;
  readonly clientOrderId: string;
  readonly instrument: string;
  readonly side: "buy" | "sell";
  readonly requestedQuantity: DecimalValue;
  readonly ownershipContext: IdentityBindingOwnershipContext;
}

export type IdentityBindingCandidateInput = Omit<
  IdentityBindingCandidate,
  "requestedQuantity"
> & {
  readonly requestedQuantity: DecimalValue | string;
};

export interface IdentityBinding extends IdentityBindingCandidate {
  readonly bindingId: string;
  readonly lineageId: string;
  readonly attemptId: string;
  readonly intentId: string;
  readonly planHash: PlanHash;
  readonly boundAt: UtcTimestamp;
}

const producedIdentityBindings = new WeakSet<object>();

function invalidBinding(message: string): Result<never> {
  return fail(domainError("INVALID_VALUE", message));
}

function parseQuantity(value: unknown): Result<DecimalValue> {
  const quantity = isDecimalValue(value)
    ? ok(value)
    : DecimalValue.fromString(value);
  if (!quantity.ok || !quantity.value.isPositive()) {
    return invalidBinding("requested quantity must be positive");
  }
  return quantity;
}

function parseOwnershipContext(
  input: unknown,
): Result<IdentityBindingOwnershipContext> {
  if (!isRecord(input)) return invalidBinding("ownership context is invalid");
  const exchange = requireIdentifier(input.exchange, "exchange");
  const environment = requireSafeText(input.environment, "environment");
  const accountId = requireSafeText(input.accountId, "accountId");
  const category = requireIdentifier(input.category, "category");
  if (
    !exchange.ok ||
    !environment.ok ||
    !accountId.ok ||
    !category.ok ||
    (input.positionMode !== "one-way" && input.positionMode !== "hedge")
  ) {
    return invalidBinding("ownership context is invalid");
  }
  const context: {
    exchange: string;
    environment: string;
    accountId: string;
    category: string;
    positionMode: "one-way" | "hedge";
    lineageId?: string;
    intentId?: string;
    attemptId?: string;
  } = {
    exchange: exchange.value,
    environment: environment.value,
    accountId: accountId.value,
    category: category.value,
    positionMode: input.positionMode,
  };
  for (const field of ["lineageId", "intentId", "attemptId"] as const) {
    if (input[field] === undefined) continue;
    const value = requireIdentifier(input[field], field);
    if (!value.ok) return invalidBinding("ownership context is invalid");
    context[field] = value.value;
  }
  return ok(Object.freeze(context));
}

export function createIdentityBindingCandidate(
  input: unknown,
): Result<IdentityBindingCandidate> {
  if (!isRecord(input))
    return invalidBinding("identity binding candidate is invalid");
  const exchangeOrderId = requireIdentifier(
    input.exchangeOrderId,
    "exchangeOrderId",
  );
  const clientOrderId = requireIdentifier(input.clientOrderId, "clientOrderId");
  const instrument = requireIdentifier(input.instrument, "instrument");
  const quantity = parseQuantity(input.requestedQuantity);
  const ownershipContext = parseOwnershipContext(input.ownershipContext);
  if (
    !exchangeOrderId.ok ||
    !clientOrderId.ok ||
    !instrument.ok ||
    !quantity.ok ||
    !ownershipContext.ok ||
    (input.side !== "buy" && input.side !== "sell")
  ) {
    return invalidBinding(
      "identity binding candidate contains an invalid field",
    );
  }
  return ok(
    Object.freeze({
      exchangeOrderId: exchangeOrderId.value,
      clientOrderId: clientOrderId.value,
      instrument: instrument.value,
      side: input.side,
      requestedQuantity: quantity.value,
      ownershipContext: ownershipContext.value,
    }),
  );
}

export function identityBindingCandidateKey(
  candidate: IdentityBindingCandidate,
): string {
  const context = candidate.ownershipContext;
  return JSON.stringify([
    candidate.exchangeOrderId,
    candidate.clientOrderId,
    candidate.instrument,
    candidate.side,
    candidate.requestedQuantity.toString(),
    context.exchange,
    context.environment,
    context.accountId,
    context.category,
    context.positionMode,
    context.lineageId ?? null,
    context.intentId ?? null,
    context.attemptId ?? null,
  ]);
}

export function identityBindingCandidatesEqual(
  left: IdentityBindingCandidate,
  right: IdentityBindingCandidate,
): boolean {
  return (
    identityBindingCandidateKey(left) === identityBindingCandidateKey(right)
  );
}

export function identityBindingCandidateFromBinding(
  binding: IdentityBinding,
): IdentityBindingCandidate {
  return {
    exchangeOrderId: binding.exchangeOrderId,
    clientOrderId: binding.clientOrderId,
    instrument: binding.instrument,
    side: binding.side,
    requestedQuantity: binding.requestedQuantity,
    ownershipContext: binding.ownershipContext,
  };
}

export function createIdentityBinding(input: unknown): Result<IdentityBinding> {
  if (!isRecord(input)) return invalidBinding("identity binding is invalid");
  const bindingId = requireIdentifier(input.bindingId, "bindingId");
  const lineageId = requireIdentifier(input.lineageId, "lineageId");
  const attemptId = requireIdentifier(input.attemptId, "attemptId");
  const intentId = requireIdentifier(input.intentId, "intentId");
  const planHash = requireHash(input.planHash, "planHash");
  const boundAt = parseUtcTimestamp(input.boundAt);
  const candidate = createIdentityBindingCandidate(
    input.candidate === undefined ? input : input.candidate,
  );
  if (
    !bindingId.ok ||
    !lineageId.ok ||
    !attemptId.ok ||
    !intentId.ok ||
    !planHash.ok ||
    !boundAt.ok ||
    !candidate.ok
  ) {
    return invalidBinding("identity binding contains an invalid field");
  }
  const binding = Object.freeze({
    bindingId: bindingId.value,
    lineageId: lineageId.value,
    attemptId: attemptId.value,
    intentId: intentId.value,
    planHash: planHash.value as PlanHash,
    boundAt: boundAt.value,
    ...candidate.value,
  });
  producedIdentityBindings.add(binding);
  return ok(binding);
}

export function isProducedIdentityBinding(
  value: unknown,
): value is IdentityBinding {
  return (
    typeof value === "object" &&
    value !== null &&
    producedIdentityBindings.has(value)
  );
}
