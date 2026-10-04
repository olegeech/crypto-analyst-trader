import { deepFreeze } from "../shared/deep-freeze.js";
import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";

export const PORTFOLIO_RISK_BLOCK_REASON_CODES = Object.freeze([
  "ACCOUNT_EVIDENCE_FUTURE",
  "ACCOUNT_EVIDENCE_INCOMPLETE",
  "ACCOUNT_EVIDENCE_INVALID",
  "ACCOUNT_EVIDENCE_STALE",
  "ACCOUNT_LIABILITY_UNMODELED",
  "ACCOUNT_MODE_UNSUPPORTED",
  "ACCOUNT_RESTRICTION_ACTIVE",
  "AVAILABLE_BALANCE_UNKNOWN",
  "CAPACITY_EXCEEDED",
  "CURRENT_STATE_UNVALUABLE",
  "ECONOMICS_INPUT_UNKNOWN",
  "ECONOMICS_INSUFFICIENT",
  "INPUT_IDENTITY_MISMATCH",
  "INVALID_RISK_POLICY",
  "LEVERAGE_EXCEEDS_POLICY",
  "LEVERAGE_UNKNOWN",
  "POSITION_MODE_UNSUPPORTED",
  "REDUCTION_STATE_INVALID",
  "REQUIRED_ACCOUNT_FACT_UNKNOWN",
  "REQUIRED_EVIDENCE_STALE",
  "SUPPLEMENTAL_EVIDENCE_CONFLICT",
  "SUPPLEMENTAL_EVIDENCE_INVALID",
  "SUPPLEMENTAL_EVIDENCE_STALE",
  "TARGET_INSTRUMENT_NOT_TRADING",
  "UNSUPPORTED_EXPOSURE",
] as const);

export type PortfolioRiskBlockReasonCode =
  (typeof PORTFOLIO_RISK_BLOCK_REASON_CODES)[number];

export const PORTFOLIO_RISK_NO_OP_REASON_CODES = Object.freeze([
  "NO_REDUCIBLE_LONG",
  "REDUCTION_QUANTITY_TOO_SMALL",
] as const);

export type PortfolioRiskNoOpReasonCode =
  (typeof PORTFOLIO_RISK_NO_OP_REASON_CODES)[number];

function parseReasonCodes<T extends string>(
  input: unknown,
  allowed: readonly T[],
): Result<readonly T[]> {
  if (
    !Array.isArray(input) ||
    input.length > allowed.length ||
    Reflect.ownKeys(input).length !== input.length + 1
  )
    return fail(domainError("INVALID_VALUE", "risk reason codes are invalid"));
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Object.values(descriptors).some(
      (descriptor) => !Object.hasOwn(descriptor, "value"),
    )
  )
    return fail(domainError("INVALID_VALUE", "risk reason codes are invalid"));
  const codes: T[] = [];
  for (let index = 0; index < input.length; index++) {
    const value: unknown = descriptors[String(index)]?.value;
    if (typeof value !== "string" || !allowed.includes(value as T))
      return fail(
        domainError("INVALID_VALUE", "risk reason codes are invalid"),
      );
    codes.push(value as T);
  }
  return ok(deepFreeze([...new Set(codes)].sort()));
}

export function createPortfolioRiskBlockReasonCodes(
  input: unknown,
): Result<readonly PortfolioRiskBlockReasonCode[]> {
  return parseReasonCodes(input, PORTFOLIO_RISK_BLOCK_REASON_CODES);
}

export function createPortfolioRiskNoOpReasonCodes(
  input: unknown,
): Result<readonly PortfolioRiskNoOpReasonCode[]> {
  return parseReasonCodes(input, PORTFOLIO_RISK_NO_OP_REASON_CODES);
}
