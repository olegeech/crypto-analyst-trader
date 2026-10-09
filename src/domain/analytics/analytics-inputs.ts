import { hashCanonical } from "../identity/canonical-serialization.js";
import {
  LIQUIDATION_EVIDENCE_V2_SCHEMA_VERSION,
  type VersionedLiquidationEvidenceBundle,
} from "../liquidation/liquidation-evidence-bundle.js";
import {
  marketEvidenceContentHash,
  type MarketEvidenceBundle,
} from "../market/market-evidence-bundle.js";
import { ok, type Result } from "../shared/result.js";
import type { UtcTimestamp } from "../shared/time.js";
import { normalizeAnalyticsReasonCodes } from "./analytics-diagnostics.js";
import type { AnalyticsReasonCode } from "./analytics-diagnostics.js";

export interface AnalyticsInputIdentity {
  readonly runId: string;
  readonly universeVersion: string;
  readonly bundleCutoff: UtcTimestamp;
  readonly marketContentHash: string;
  readonly marketBundleHash: string;
  readonly liquidationRunId?: string;
  readonly liquidationUniverseVersion?: string;
  readonly liquidationBundleCutoff?: UtcTimestamp;
  readonly liquidationMarketContentHash?: string;
  readonly liquidationBundleHash?: string;
  /** Present only when the source uses the v2 provider-semantic contract. */
  readonly liquidationEvidenceSchemaVersion?: typeof LIQUIDATION_EVIDENCE_V2_SCHEMA_VERSION;
  readonly compatibility: "compatible" | "incompatible";
  readonly reasonCodes: readonly AnalyticsReasonCode[];
}

export function createAnalyticsInputIdentity(
  market: MarketEvidenceBundle,
  liquidation?: VersionedLiquidationEvidenceBundle,
): Result<AnalyticsInputIdentity> {
  const marketContentHash = marketEvidenceContentHash(market);
  const marketBundleHash = hashCanonical(market);
  if (!marketContentHash.ok) return marketContentHash;
  if (!marketBundleHash.ok) return marketBundleHash;

  const marketIdentity = {
    runId: market.runId,
    universeVersion: market.universeVersion,
    bundleCutoff: market.bundleCutoff,
    marketContentHash: marketContentHash.value,
    marketBundleHash: marketBundleHash.value,
  };
  if (liquidation === undefined) {
    return ok(
      Object.freeze({
        ...marketIdentity,
        compatibility: "compatible" as const,
        reasonCodes: normalizeAnalyticsReasonCodes([]),
      }),
    );
  }

  const liquidationBundleHash = hashCanonical(liquidation);
  if (!liquidationBundleHash.ok) return liquidationBundleHash;
  const compatible =
    liquidation.runId === market.runId &&
    liquidation.marketEvidence.runId === market.runId &&
    liquidation.marketEvidence.universeVersion === market.universeVersion &&
    liquidation.bundleCutoff === market.bundleCutoff &&
    liquidation.marketEvidence.bundleCutoff === market.bundleCutoff &&
    liquidation.marketEvidence.contentHash === marketContentHash.value;
  const reasonCodes = normalizeAnalyticsReasonCodes(
    compatible ? [] : ["INPUT_IDENTITY_MISMATCH"],
  );
  return ok(
    Object.freeze({
      ...marketIdentity,
      liquidationRunId: liquidation.runId,
      liquidationUniverseVersion: liquidation.marketEvidence.universeVersion,
      liquidationBundleCutoff: liquidation.bundleCutoff,
      liquidationMarketContentHash: liquidation.marketEvidence.contentHash,
      liquidationBundleHash: liquidationBundleHash.value,
      ...(liquidation.schemaVersion === LIQUIDATION_EVIDENCE_V2_SCHEMA_VERSION
        ? { liquidationEvidenceSchemaVersion: liquidation.schemaVersion }
        : {}),
      compatibility: compatible ? "compatible" : "incompatible",
      reasonCodes,
    }),
  );
}
