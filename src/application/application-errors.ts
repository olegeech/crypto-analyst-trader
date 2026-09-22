import type { DomainError, DomainErrorCode } from "../domain/shared/errors.js";
import type { ExchangeExecutionFailure } from "../ports/exchange-execution.js";

export type DemoEntryVerdict =
  | "CONFIRMED_FILLED"
  | "CONFIRMED_OPEN"
  | "NOT_READY"
  | "DECLINED"
  | "HALTED"
  | "UNRESOLVED";

export const DEMO_ENTRY_EXIT_CODES = Object.freeze({
  CONFIRMED_FILLED: 0,
  CONFIRMED_OPEN: 0,
  INTERNAL: 1,
  INVALID_INPUT: 2,
  DECLINED: 3,
  NOT_READY: 4,
  HALTED: 5,
  UNRESOLVED: 5,
} as const);

export interface DemoEntryFailure {
  readonly reasonCode: string;
  readonly message: string;
  readonly nextAction: string;
  readonly domainCode?: DomainErrorCode;
}

function safeDomainMessage(code: DomainErrorCode): string {
  return `Demo application stopped at the ${code} safety gate.`;
}

function safeExchangeMessage(error: ExchangeExecutionFailure): string {
  const operation = error.operation ?? "exchange";
  return `Bybit Demo ${operation} returned a classified ${error.kind} result.`;
}

export function failureFromDomain(
  error: DomainError,
  nextAction = "inspect the exact Demo state and retry when safe",
): DemoEntryFailure {
  return Object.freeze({
    reasonCode: error.code,
    message: safeDomainMessage(error.code),
    nextAction,
    domainCode: error.code,
  });
}

export function failureFromExchange(
  error: ExchangeExecutionFailure,
): DemoEntryFailure {
  const nextAction =
    error.retry === "reconcile"
      ? "reconcile the original client identity before any retry"
      : error.retry === "read-only"
        ? "retry the bounded read after inspecting the Demo connection"
        : "inspect the sanitized Demo failure and correct the precondition";
  return Object.freeze({
    reasonCode: `EXCHANGE_${error.kind.toUpperCase()}`,
    message: safeExchangeMessage(error),
    nextAction,
  });
}

export function exitCodeForFailure(failure: DemoEntryFailure): number {
  switch (failure.reasonCode) {
    case "INVALID_ARGUMENT":
    case "INVALID_DECIMAL":
    case "INVALID_IDENTIFIER":
      return DEMO_ENTRY_EXIT_CODES.INVALID_INPUT;
    case "RUN_LEASE_HELD":
    case "RUN_LEASE_LOST":
    case "HALT_ACTIVE":
    case "UNRESOLVED_STATE":
    case "UNRESOLVED_RECONCILIATION":
    case "PERSISTENCE_CONFLICT":
    case "EXCHANGE_AMBIGUOUS":
    case "EXCHANGE_OWNERSHIP":
      return DEMO_ENTRY_EXIT_CODES.HALTED;
    case "EXCHANGE_PRECONDITION":
      return DEMO_ENTRY_EXIT_CODES.NOT_READY;
    case "PLAN_EXPIRED":
    case "INVALID_APPROVAL":
      return DEMO_ENTRY_EXIT_CODES.DECLINED;
    case "CONSTRAINT_VIOLATION":
    case "CAPABILITY_UNKNOWN":
    case "CAPABILITY_UNSUPPORTED":
    case "STALE_EVIDENCE":
    case "INCOMPATIBLE_EVIDENCE":
    case "PERSISTENCE_ENVIRONMENT":
    case "PERSISTENCE_RUNTIME":
    case "PERSISTENCE_SCHEMA":
    case "NOT_READY":
      return DEMO_ENTRY_EXIT_CODES.NOT_READY;
    default:
      return DEMO_ENTRY_EXIT_CODES.INTERNAL;
  }
}
