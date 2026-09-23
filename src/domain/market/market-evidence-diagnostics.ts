import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";
import { parseUtcTimestamp, type UtcTimestamp } from "../shared/time.js";
import {
  isRecord,
  requireFiniteInteger,
  requireIdentifier,
  requireSafeText,
} from "../shared/validation.js";

export type MarketEvidenceDiagnosticCode =
  | "exchange-time-failed"
  | "rate-limited"
  | "transport-failed"
  | "invalid-response"
  | "wrong-identity"
  | "duplicate-observation"
  | "contradictory-observation"
  | "repeated-cursor"
  | "page-budget-exhausted"
  | "row-budget-exhausted"
  | "missing-required-data"
  | "incomplete-proof"
  | "future-observation"
  | "unfinished-candle"
  | "non-monotonic-time";

const DIAGNOSTIC_CODES = new Set<MarketEvidenceDiagnosticCode>([
  "exchange-time-failed",
  "rate-limited",
  "transport-failed",
  "invalid-response",
  "wrong-identity",
  "duplicate-observation",
  "contradictory-observation",
  "repeated-cursor",
  "page-budget-exhausted",
  "row-budget-exhausted",
  "missing-required-data",
  "incomplete-proof",
  "future-observation",
  "unfinished-candle",
  "non-monotonic-time",
]);

export interface MarketEvidenceBudgetState {
  readonly pages: number;
  readonly maxPages: number;
  readonly rows: number;
  readonly maxRows: number;
  readonly retries: number;
  readonly maxRetries: number;
}

export interface MarketEvidenceDiagnostic {
  readonly code: MarketEvidenceDiagnosticCode;
  readonly operation: string;
  readonly endpoint: string;
  readonly symbol?: string;
  readonly series?: string;
  readonly sourceTimestamp?: UtcTimestamp;
  readonly budget?: MarketEvidenceBudgetState;
}

function diagnosticFailure(message: string): Result<never> {
  return fail(domainError("INVALID_VALUE", message));
}

function optionalIdentifier(
  value: unknown,
  field: string,
): Result<string | undefined> {
  if (value === undefined) return ok(undefined);
  return requireIdentifier(value, field);
}

function optionalTimestamp(
  value: unknown,
  field: string,
): Result<UtcTimestamp | undefined> {
  if (value === undefined) return ok(undefined);
  const parsed = parseUtcTimestamp(value);
  if (!parsed.ok) {
    return fail(
      domainError("INVALID_TIMESTAMP", `${field} is invalid`, { field }),
    );
  }
  return parsed;
}

function parseBudget(
  value: unknown,
): Result<MarketEvidenceBudgetState | undefined> {
  if (value === undefined) return ok(undefined);
  if (!isRecord(value))
    return diagnosticFailure("diagnostic budget is invalid");
  const fields = {
    pages: requireFiniteInteger(value.pages, "budget.pages"),
    maxPages: requireFiniteInteger(value.maxPages, "budget.maxPages", 1),
    rows: requireFiniteInteger(value.rows, "budget.rows"),
    maxRows: requireFiniteInteger(value.maxRows, "budget.maxRows", 1),
    retries: requireFiniteInteger(value.retries, "budget.retries"),
    maxRetries: requireFiniteInteger(value.maxRetries, "budget.maxRetries"),
  };
  if (
    !fields.pages.ok ||
    !fields.maxPages.ok ||
    !fields.rows.ok ||
    !fields.maxRows.ok ||
    !fields.retries.ok ||
    !fields.maxRetries.ok
  ) {
    return diagnosticFailure("diagnostic budget contains an invalid field");
  }
  if (
    fields.pages.value > fields.maxPages.value ||
    fields.rows.value > fields.maxRows.value ||
    fields.retries.value > fields.maxRetries.value
  ) {
    return diagnosticFailure("diagnostic budget exceeds its declared bound");
  }
  return ok(
    Object.freeze({
      pages: fields.pages.value,
      maxPages: fields.maxPages.value,
      rows: fields.rows.value,
      maxRows: fields.maxRows.value,
      retries: fields.retries.value,
      maxRetries: fields.maxRetries.value,
    }),
  );
}

export function createMarketEvidenceDiagnostic(
  input: unknown,
): Result<MarketEvidenceDiagnostic> {
  if (!isRecord(input))
    return diagnosticFailure("diagnostic must be an object");
  const code = input.code;
  if (
    typeof code !== "string" ||
    !DIAGNOSTIC_CODES.has(code as MarketEvidenceDiagnosticCode)
  ) {
    return diagnosticFailure("diagnostic code is unsupported");
  }
  const operation = requireSafeText(input.operation, "operation");
  const endpoint = requireSafeText(input.endpoint, "endpoint");
  const symbol = optionalIdentifier(input.symbol, "symbol");
  const series = optionalIdentifier(input.series, "series");
  const sourceTimestamp = optionalTimestamp(
    input.sourceTimestamp,
    "sourceTimestamp",
  );
  const budget = parseBudget(input.budget);
  if (
    !operation.ok ||
    !endpoint.ok ||
    !symbol.ok ||
    !series.ok ||
    !sourceTimestamp.ok ||
    !budget.ok
  ) {
    return diagnosticFailure("diagnostic contains an invalid field");
  }
  const diagnostic: {
    code: MarketEvidenceDiagnosticCode;
    operation: string;
    endpoint: string;
    symbol?: string;
    series?: string;
    sourceTimestamp?: UtcTimestamp;
    budget?: MarketEvidenceBudgetState;
  } = {
    code: code as MarketEvidenceDiagnosticCode,
    operation: operation.value,
    endpoint: endpoint.value,
  };
  if (symbol.value !== undefined) diagnostic.symbol = symbol.value;
  if (series.value !== undefined) diagnostic.series = series.value;
  if (sourceTimestamp.value !== undefined) {
    diagnostic.sourceTimestamp = sourceTimestamp.value;
  }
  if (budget.value !== undefined) diagnostic.budget = budget.value;
  return ok(Object.freeze(diagnostic));
}

export function parseMarketEvidenceDiagnostics(
  input: unknown,
): Result<readonly MarketEvidenceDiagnostic[]> {
  if (!Array.isArray(input)) {
    return diagnosticFailure("diagnostics must be an array");
  }
  const parsed: MarketEvidenceDiagnostic[] = [];
  for (const item of input) {
    const diagnostic = createMarketEvidenceDiagnostic(item);
    if (!diagnostic.ok) return diagnostic;
    parsed.push(diagnostic.value);
  }
  return ok(Object.freeze(parsed));
}
