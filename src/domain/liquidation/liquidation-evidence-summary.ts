import {
  LIQUIDATION_EVIDENCE_V2_SCHEMA_VERSION,
  type LiquidationEvidenceBundle as LiquidationEvidenceBundleV1,
  type LiquidationEvidenceBundleV2,
  type VersionedLiquidationEvidenceBundle,
} from "./liquidation-evidence-bundle.js";
import { LIQUIDATION_HISTORY_BUCKETS } from "./liquidation-evidence-windows.js";

interface LiquidationEvidenceBucketSummaryBase {
  readonly eligibleConstituents: number;
  readonly constituentsWithResolvedGrid: number;
  readonly expectedHourlyBuckets: number;
  readonly resolvedHourlyBuckets: number;
  readonly unresolvedRequestedBuckets: number;
}

export interface LiquidationEvidenceBucketSummaryV1 extends LiquidationEvidenceBucketSummaryBase {
  readonly constituentsWithProviderRows: null;
  readonly providerExplicitBuckets: null;
  readonly providerImpliedZeroBuckets: null;
}

export interface LiquidationEvidenceBucketSummaryV2 extends LiquidationEvidenceBucketSummaryBase {
  readonly constituentsWithProviderRows: number;
  readonly providerExplicitBuckets: number;
  readonly providerImpliedZeroBuckets: number;
}

export function summarizeLiquidationEvidenceBuckets(
  bundle: LiquidationEvidenceBundleV1,
): LiquidationEvidenceBucketSummaryV1;
export function summarizeLiquidationEvidenceBuckets(
  bundle: LiquidationEvidenceBundleV2,
): LiquidationEvidenceBucketSummaryV2;
export function summarizeLiquidationEvidenceBuckets(
  bundle: VersionedLiquidationEvidenceBundle,
): LiquidationEvidenceBucketSummaryV1 | LiquidationEvidenceBucketSummaryV2;
export function summarizeLiquidationEvidenceBuckets(
  bundle: VersionedLiquidationEvidenceBundle,
): LiquidationEvidenceBucketSummaryV1 | LiquidationEvidenceBucketSummaryV2 {
  let eligibleConstituents = 0;
  let constituentsWithResolvedGrid = 0;
  let resolvedHourlyBuckets = 0;
  let constituentsWithProviderRows = 0;
  let providerExplicitBuckets = 0;
  let providerImpliedZeroBuckets = 0;

  for (const target of bundle.targets) {
    for (const constituent of target.constituents) {
      eligibleConstituents += 1;
      let hasProviderRows = false;
      if (constituent.observations.length === LIQUIDATION_HISTORY_BUCKETS) {
        constituentsWithResolvedGrid += 1;
      }
      for (const observation of constituent.observations) {
        resolvedHourlyBuckets += 1;
        if ("provenance" in observation) {
          if (observation.provenance === "provider-explicit") {
            providerExplicitBuckets += 1;
            hasProviderRows = true;
          } else {
            providerImpliedZeroBuckets += 1;
          }
        }
      }
      if (hasProviderRows) constituentsWithProviderRows += 1;
    }
  }

  const expectedHourlyBuckets =
    eligibleConstituents * LIQUIDATION_HISTORY_BUCKETS;
  const base = {
    eligibleConstituents,
    constituentsWithResolvedGrid,
    expectedHourlyBuckets,
    resolvedHourlyBuckets,
    unresolvedRequestedBuckets: Math.max(
      0,
      expectedHourlyBuckets - resolvedHourlyBuckets,
    ),
  };

  if (bundle.schemaVersion === LIQUIDATION_EVIDENCE_V2_SCHEMA_VERSION) {
    return Object.freeze({
      ...base,
      constituentsWithProviderRows,
      providerExplicitBuckets,
      providerImpliedZeroBuckets,
    });
  }

  return Object.freeze({
    ...base,
    constituentsWithProviderRows: null,
    providerExplicitBuckets: null,
    providerImpliedZeroBuckets: null,
  });
}
