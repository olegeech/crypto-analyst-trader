import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";
import { parseUtcTimestamp, type UtcTimestamp } from "../shared/time.js";
import {
  isRecord,
  requireIdentifier,
  requireSafeText,
} from "../shared/validation.js";

export type LiquidationEvidenceDiagnosticCode =
  | "catalogue-incomplete"
  | "catalogue-unavailable"
  | "duplicate-market"
  | "history-incomplete"
  | "history-unavailable"
  | "incompatible-metadata"
  | "invalid-catalogue"
  | "invalid-observation"
  | "missing-bucket"
  | "provider-unavailable"
  | "rate-limited"
  | "response-budget-exhausted"
  | "secret-unavailable";

export type LiquidationEvidenceOperation =
  "discover-markets" | "fetch-liquidation-history" | "finalize-bundle";

export interface LiquidationEvidenceDiagnostic {
  readonly code: LiquidationEvidenceDiagnosticCode;
  readonly operation: LiquidationEvidenceOperation;
  readonly asset?: string;
  readonly providerSymbol?: string;
  readonly bucketTimestamp?: UtcTimestamp;
}

export interface LiquidationEvidenceDiagnosticInput {
  readonly code: LiquidationEvidenceDiagnosticCode;
  readonly operation: LiquidationEvidenceOperation;
  readonly asset?: string;
  readonly providerSymbol?: string;
  readonly bucketTimestamp?: string;
}

const DIAGNOSTIC_CODES = new Set<LiquidationEvidenceDiagnosticCode>([
  "catalogue-incomplete",
  "catalogue-unavailable",
  "duplicate-market",
  "history-incomplete",
  "history-unavailable",
  "incompatible-metadata",
  "invalid-catalogue",
  "invalid-observation",
  "missing-bucket",
  "provider-unavailable",
  "rate-limited",
  "response-budget-exhausted",
  "secret-unavailable",
]);

const OPERATIONS = new Set<LiquidationEvidenceOperation>([
  "discover-markets",
  "fetch-liquidation-history",
  "finalize-bundle",
]);

function invalid(message: string): Result<never> {
  return fail(domainError("INVALID_VALUE", message));
}

export function createLiquidationEvidenceDiagnostic(
  input: unknown,
): Result<LiquidationEvidenceDiagnostic> {
  if (!isRecord(input))
    return invalid("liquidation diagnostic must be an object");
  const code = input.code;
  const operation = input.operation;
  if (
    typeof code !== "string" ||
    !DIAGNOSTIC_CODES.has(code as LiquidationEvidenceDiagnosticCode) ||
    typeof operation !== "string" ||
    !OPERATIONS.has(operation as LiquidationEvidenceOperation)
  ) {
    return invalid("liquidation diagnostic identity is invalid");
  }
  const asset =
    input.asset === undefined
      ? ok<string | undefined>(undefined)
      : requireIdentifier(input.asset, "asset");
  const providerSymbol =
    input.providerSymbol === undefined
      ? ok<string | undefined>(undefined)
      : requireSafeText(input.providerSymbol, "providerSymbol");
  const bucketTimestamp =
    input.bucketTimestamp === undefined
      ? ok<UtcTimestamp | undefined>(undefined)
      : parseUtcTimestamp(input.bucketTimestamp);
  if (!asset.ok || !providerSymbol.ok || !bucketTimestamp.ok) {
    return invalid("liquidation diagnostic contains an invalid field");
  }
  const diagnostic: {
    code: LiquidationEvidenceDiagnosticCode;
    operation: LiquidationEvidenceOperation;
    asset?: string;
    providerSymbol?: string;
    bucketTimestamp?: UtcTimestamp;
  } = {
    code: code as LiquidationEvidenceDiagnosticCode,
    operation: operation as LiquidationEvidenceOperation,
  };
  if (asset.value !== undefined) diagnostic.asset = asset.value;
  if (providerSymbol.value !== undefined) {
    diagnostic.providerSymbol = providerSymbol.value;
  }
  if (bucketTimestamp.value !== undefined) {
    diagnostic.bucketTimestamp = bucketTimestamp.value;
  }
  return ok(Object.freeze(diagnostic));
}

export function parseLiquidationEvidenceDiagnostics(
  input: unknown,
): Result<readonly LiquidationEvidenceDiagnostic[]> {
  if (!Array.isArray(input))
    return invalid("liquidation diagnostics must be an array");
  const diagnostics: LiquidationEvidenceDiagnostic[] = [];
  for (const item of input) {
    const parsed = createLiquidationEvidenceDiagnostic(item);
    if (!parsed.ok) return parsed;
    diagnostics.push(parsed.value);
  }
  return ok(Object.freeze(diagnostics));
}
