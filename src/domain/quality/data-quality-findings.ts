export const QUALITY_REASON_CODES = [
  "MISSING_EVIDENCE",
  "INVALID_EVIDENCE",
  "HASH_MISMATCH",
  "LINEAGE_MISMATCH",
  "UNTRUSTED_EVIDENCE",
  "STALE_EVIDENCE",
  "FUTURE_INFORMATION",
  "INVALID_GENERATION_TIME",
  "METADATA_CLOCK_SKEW",
  "INCOMPLETE_EVIDENCE",
  "INCOMPLETE_LIQUIDATION_COVERAGE",
  "INCOMPLETE_LIQUIDATION_HISTORY",
  "UNAVAILABLE_ANALYTICS",
  "PARTIAL_ANALYTICS",
  "DUPLICATE_OBSERVATION",
  "GAPPED_WINDOW",
  "INCOMPATIBLE_WINDOW",
] as const;
export type QualityReasonCode = (typeof QUALITY_REASON_CODES)[number];
export const INVARIANT_QUALITY_REASONS: ReadonlySet<QualityReasonCode> =
  new Set([
    "INVALID_EVIDENCE",
    "HASH_MISMATCH",
    "LINEAGE_MISMATCH",
    "FUTURE_INFORMATION",
    "INVALID_GENERATION_TIME",
    "DUPLICATE_OBSERVATION",
    "INCOMPATIBLE_WINDOW",
  ]);
export interface DataQualityFinding {
  readonly role: string;
  readonly reasonCode: QualityReasonCode;
  readonly blocking: boolean;
  readonly confidenceImpactGroup?: string;
}
