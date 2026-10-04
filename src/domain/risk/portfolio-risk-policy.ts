import { hashCanonical } from "../identity/canonical-serialization.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import {
  isDecimalValue,
  parseDecimal,
  type DecimalValue,
} from "../shared/decimal.js";
import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";
import {
  requireFiniteInteger,
  requireIdentifier,
} from "../shared/validation.js";

export const PORTFOLIO_RISK_POLICY_SCHEMA_VERSION =
  "portfolio-risk-policy/v1" as const;

export interface PortfolioRiskPolicy {
  readonly schemaVersion: typeof PORTFOLIO_RISK_POLICY_SCHEMA_VERSION;
  readonly policyVersion: string;
  readonly maxAccountEvidenceAgeMs: number;
  readonly marginReserveRatio: DecimalValue;
  readonly maxDerivativesLeverage: DecimalValue;
  readonly entryFeeRate: DecimalValue;
  readonly exitFeeRate: DecimalValue;
  readonly slippageBufferRate: DecimalValue;
  readonly minimumNetEdgeRate: DecimalValue;
}

const policyFields = [
  "schemaVersion",
  "policyVersion",
  "maxAccountEvidenceAgeMs",
  "marginReserveRatio",
  "maxDerivativesLeverage",
  "entryFeeRate",
  "exitFeeRate",
  "slippageBufferRate",
  "minimumNetEdgeRate",
] as const;
const ONE = parseDecimal("1");
const MAX_DECIMAL_TEXT_LENGTH = 128;

function invalid(): Result<never> {
  return fail(domainError("INVALID_VALUE", "portfolio risk policy is invalid"));
}

/** Closed plain data only; never evaluate getters from untrusted policy input. */
function closedPolicyRecord(
  value: unknown,
): value is Record<(typeof policyFields)[number], unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return false;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== policyFields.length ||
    keys.some(
      (key) => typeof key !== "string" || !policyFields.includes(key as never),
    )
  )
    return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.values(descriptors).every((descriptor) =>
    Object.hasOwn(descriptor, "value"),
  );
}

function decimal(
  value: unknown,
  options: { readonly positive?: boolean; readonly belowOne?: boolean } = {},
): Result<DecimalValue> {
  if (
    !isDecimalValue(value) &&
    (typeof value !== "string" || value.length > MAX_DECIMAL_TEXT_LENGTH)
  )
    return invalid();
  const parsed = isDecimalValue(value) ? ok(value) : parseDecimal(value);
  if (
    !parsed.ok ||
    parsed.value.isNegative() ||
    (options.positive === true && !parsed.value.isPositive()) ||
    (options.belowOne === true &&
      (!ONE.ok || parsed.value.compare(ONE.value) >= 0)) ||
    parsed.value.toString().length > MAX_DECIMAL_TEXT_LENGTH
  )
    return invalid();
  return parsed;
}

export function createPortfolioRiskPolicy(
  input: unknown,
): Result<PortfolioRiskPolicy> {
  if (
    !closedPolicyRecord(input) ||
    input.schemaVersion !== PORTFOLIO_RISK_POLICY_SCHEMA_VERSION
  )
    return invalid();

  const version = requireIdentifier(input.policyVersion, "policyVersion");
  const maxAge = requireFiniteInteger(
    input.maxAccountEvidenceAgeMs,
    "maxAccountEvidenceAgeMs",
    1,
  );
  const reserveRatio = decimal(input.marginReserveRatio, { belowOne: true });
  const leverage = decimal(input.maxDerivativesLeverage, { positive: true });
  const entryFee = decimal(input.entryFeeRate);
  const exitFee = decimal(input.exitFeeRate);
  const slippage = decimal(input.slippageBufferRate);
  const minimumEdge = decimal(input.minimumNetEdgeRate);

  if (
    !version.ok ||
    !maxAge.ok ||
    !reserveRatio.ok ||
    !leverage.ok ||
    !entryFee.ok ||
    !exitFee.ok ||
    !slippage.ok ||
    !minimumEdge.ok
  )
    return invalid();

  return ok(
    deepFreeze({
      schemaVersion: PORTFOLIO_RISK_POLICY_SCHEMA_VERSION,
      policyVersion: version.value,
      maxAccountEvidenceAgeMs: maxAge.value,
      marginReserveRatio: reserveRatio.value,
      maxDerivativesLeverage: leverage.value,
      entryFeeRate: entryFee.value,
      exitFeeRate: exitFee.value,
      slippageBufferRate: slippage.value,
      minimumNetEdgeRate: minimumEdge.value,
    }),
  );
}

export function portfolioRiskPolicyHash(
  policy: PortfolioRiskPolicy,
): Result<string> {
  return hashCanonical(policy);
}
