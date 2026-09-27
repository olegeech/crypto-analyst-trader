export const ANALYTICS_REASON_CODE_ORDER = Object.freeze([
  "INSUFFICIENT_WINDOW",
  "INVALID_MARKET_PRICE",
  "MISSING_LIQUIDATION_EVIDENCE",
  "MISSING_EXTERNAL_EVIDENCE",
  "INCOMPLETE_LIQUIDATION_COVERAGE",
  "INCOMPLETE_LIQUIDATION_HISTORY",
  "INPUT_IDENTITY_MISMATCH",
  "ZERO_LIQUIDATION_NOTIONAL",
  "ZERO_OPEN_INTEREST_REFERENCE",
  "ZERO_VOLATILITY_REFERENCE",
  "INCOMPATIBLE_SCORE_VERSION",
  "SCORE_DIRECTION_MISMATCH",
  "AMBIGUOUS_CEWS_DIRECTION",
  "EXTERNAL_EVIDENCE_HASH_MISMATCH",
  "EXTERNAL_EVIDENCE_AFTER_CUTOFF",
  "INVALID_TRAP_EVIDENCE",
] as const);

export type AnalyticsReasonCode = (typeof ANALYTICS_REASON_CODE_ORDER)[number];

export function normalizeAnalyticsReasonCodes(
  reasonCodes: readonly AnalyticsReasonCode[],
): readonly AnalyticsReasonCode[] {
  const present = new Set(reasonCodes);
  return Object.freeze(
    ANALYTICS_REASON_CODE_ORDER.filter((code) => present.has(code)),
  );
}
