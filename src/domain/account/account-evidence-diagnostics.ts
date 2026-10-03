import { domainError } from "../shared/errors.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { fail, ok, type Result } from "../shared/result.js";
import { isRecord } from "../shared/validation.js";

export const ACCOUNT_EVIDENCE_FAILURE_CODES = Object.freeze([
  "CREDENTIALS_UNAVAILABLE",
  "AUTHENTICATION_FAILED",
  "ACCOUNT_IDENTITY_MISMATCH",
  "READ_PERMISSION_DENIED",
  "WITHDRAWAL_PERMISSION_FORBIDDEN",
  "TIMESTAMP_SKEW",
  "RATE_LIMITED",
  "TRANSPORT_FAILED",
  "INVALID_RESPONSE",
  "UNSUPPORTED_CAPABILITY",
  "ORIGIN_MISMATCH",
  "COVERAGE_INCOMPLETE",
  "CRITICAL_STATE_CHANGED",
  "RECONCILIATION_MISMATCH",
  "COLLECTION_DEADLINE_EXCEEDED",
  "PAGE_BUDGET_EXCEEDED",
  "ATTEMPT_BUDGET_EXCEEDED",
  "ROW_BUDGET_EXCEEDED",
  "RESPONSE_BYTE_LIMIT_EXCEEDED",
  "CONTRADICTORY_OBSERVATION",
  "MODE_UNSUPPORTED",
  "MODE_UNKNOWN",
  "TIER_INVALID",
] as const);
export type AccountEvidenceFailureCode =
  (typeof ACCOUNT_EVIDENCE_FAILURE_CODES)[number];
export interface AccountEvidenceDiagnostic {
  readonly code: AccountEvidenceFailureCode;
  readonly severity: "warning" | "error";
  readonly scope:
    | "identity"
    | "collection"
    | "coverage"
    | "modes"
    | "wallet"
    | "collateral"
    | "positions"
    | "orders"
    | "executions"
    | "tiers";
}
export function parseAccountEvidenceFailureCodes(
  input: unknown,
): Result<readonly AccountEvidenceFailureCode[]> {
  if (
    !Array.isArray(input) ||
    input.length > 10_000 ||
    Object.values(Object.getOwnPropertyDescriptors(input)).some(
      (d) => !Object.hasOwn(d, "value"),
    ) ||
    [...input].some((value) => !ACCOUNT_EVIDENCE_FAILURE_CODES.includes(value))
  ) {
    return fail(
      domainError(
        "INVALID_VALUE",
        "account evidence failure codes are invalid",
      ),
    );
  }
  return ok(
    Object.freeze([...new Set(input as AccountEvidenceFailureCode[])].sort()),
  );
}
export function parseAccountEvidenceDiagnostics(
  input: unknown,
): Result<readonly AccountEvidenceDiagnostic[]> {
  if (
    !Array.isArray(input) ||
    input.length > 10_000 ||
    Object.values(Object.getOwnPropertyDescriptors(input)).some(
      (d) => !Object.hasOwn(d, "value"),
    )
  )
    return fail(
      domainError("INVALID_VALUE", "account evidence diagnostics are invalid"),
    );
  const output: AccountEvidenceDiagnostic[] = [];
  for (const value of input) {
    if (
      !isRecord(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== 3 ||
      Object.values(Object.getOwnPropertyDescriptors(value)).some(
        (d) => !Object.hasOwn(d, "value"),
      ) ||
      !Object.keys(value).every((key) =>
        ["code", "severity", "scope"].includes(key),
      ) ||
      !ACCOUNT_EVIDENCE_FAILURE_CODES.includes(
        value.code as AccountEvidenceFailureCode,
      ) ||
      !["warning", "error"].includes(value.severity as string) ||
      ![
        "identity",
        "collection",
        "coverage",
        "modes",
        "wallet",
        "collateral",
        "positions",
        "orders",
        "executions",
        "tiers",
      ].includes(value.scope as string)
    ) {
      return fail(
        domainError("INVALID_VALUE", "account evidence diagnostic is invalid"),
      );
    }
    output.push({
      code: value.code as AccountEvidenceFailureCode,
      severity: value.severity as AccountEvidenceDiagnostic["severity"],
      scope: value.scope as AccountEvidenceDiagnostic["scope"],
    });
  }
  return ok(
    deepFreeze(
      output.sort((a, b) =>
        `${a.code}:${a.scope}:${a.severity}`.localeCompare(
          `${b.code}:${b.scope}:${b.severity}`,
        ),
      ),
    ),
  );
}
