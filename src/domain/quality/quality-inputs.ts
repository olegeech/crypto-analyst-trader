import {
  createMarketEvidenceBundle,
  marketEvidenceContentHash,
  MARKET_EVIDENCE_PRODUCER,
  type MarketEvidenceBundle,
} from "../market/market-evidence-bundle.js";
import {
  createLiquidationEvidenceBundle,
  type LiquidationEvidenceBundle,
} from "../liquidation/liquidation-evidence-bundle.js";
import {
  rehydrateAnalyticsEvidenceBundle,
  type AnalyticsEvidenceBundle,
} from "../analytics/analytics-evidence-bundle.js";
import {
  createEvidenceRef,
  type EvidenceRef,
} from "../evidence/evidence-ref.js";
import { hashCanonical } from "../identity/canonical-serialization.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { isRecord, requireHash } from "../shared/validation.js";
import type { QualityReasonCode } from "./data-quality-findings.js";

export interface QualitySourceInput {
  readonly role: "market" | "liquidation" | "analytics";
  readonly value: unknown;
  readonly evidenceRef?: unknown;
  readonly expectedBundleHash?: unknown;
}
export interface QualityInputRecord {
  readonly role: QualitySourceInput["role"];
  readonly value?:
    MarketEvidenceBundle | LiquidationEvidenceBundle | AnalyticsEvidenceBundle;
  readonly evidenceRef?: EvidenceRef;
  readonly contentHash?: string;
  readonly bundleHash?: string;
  readonly failures: readonly QualityReasonCode[];
}
export interface TrustedQualityAdmission {
  readonly issuer: string;
  readonly artifactHash: string;
}

export function qualityRoleForOutcome(requestId: string): string {
  return requestId.startsWith("external:")
    ? requestId
    : `analytics:${requestId}`;
}

export function admitQualitySource(
  input: QualitySourceInput,
): QualityInputRecord {
  const failures: QualityReasonCode[] = [];
  const parsed =
    input.role === "market"
      ? createMarketEvidenceBundle(input.value)
      : input.role === "liquidation"
        ? createLiquidationEvidenceBundle(input.value)
        : rehydrateAnalyticsEvidenceBundle(input.value);
  if (!parsed.ok) {
    const hashError =
      parsed.error.code === "PLAN_HASH_MISMATCH" ||
      parsed.error.code === "INVALID_HASH";
    return deepFreeze({
      role: input.role,
      failures: [hashError ? "HASH_MISMATCH" : "INVALID_EVIDENCE"],
    });
  }
  const bundle = parsed.value;
  const bundleHash = hashCanonical(bundle);
  const contentHash =
    input.role === "market"
      ? marketEvidenceContentHash(bundle as MarketEvidenceBundle)
      : input.role === "analytics"
        ? {
            ok: true as const,
            value: (bundle as AnalyticsEvidenceBundle).contentHash,
          }
        : bundleHash;
  if (!bundleHash.ok || !contentHash.ok)
    return deepFreeze({ role: input.role, failures: ["HASH_MISMATCH"] });
  if (input.expectedBundleHash !== undefined) {
    const expected = requireHash(
      input.expectedBundleHash,
      "expectedBundleHash",
    );
    if (!expected.ok || expected.value !== bundleHash.value)
      failures.push("HASH_MISMATCH");
  }
  let evidenceRef: EvidenceRef | undefined;
  if (input.role === "market") {
    const market = bundle as MarketEvidenceBundle;
    const refs = market.evidence.filter(
      (ref) => ref.kind === "market-evidence-bundle",
    );
    if (refs.length !== 1) failures.push("INVALID_EVIDENCE");
    evidenceRef = refs[0];
    if (
      evidenceRef &&
      (market.producer !== MARKET_EVIDENCE_PRODUCER ||
        evidenceRef.producer !== MARKET_EVIDENCE_PRODUCER ||
        evidenceRef.schemaVersion !== market.schemaVersion ||
        evidenceRef.sourceId !== `bybit-public:${market.runId}` ||
        evidenceRef.asOf !== market.bundleCutoff)
    )
      failures.push("INVALID_EVIDENCE");
  } else if (input.role === "liquidation") {
    const ref = createEvidenceRef(input.evidenceRef);
    if (!ref.ok) failures.push("INVALID_EVIDENCE");
    else {
      evidenceRef = ref.value;
      const liquidation = bundle as LiquidationEvidenceBundle;
      if (
        ref.value.kind !== "liquidation-evidence-bundle" ||
        ref.value.producer !== liquidation.producer ||
        ref.value.schemaVersion !== liquidation.schemaVersion ||
        ref.value.sourceId !== liquidation.runId ||
        ref.value.asOf !== liquidation.bundleCutoff
      )
        failures.push("INVALID_EVIDENCE");
    }
  }
  if (evidenceRef && evidenceRef.contentHash !== contentHash.value)
    failures.push("HASH_MISMATCH");
  return deepFreeze({
    role: input.role,
    value: bundle,
    ...(evidenceRef ? { evidenceRef } : {}),
    contentHash: contentHash.value,
    bundleHash: bundleHash.value,
    failures: [...new Set(failures)].sort(),
  });
}

export function isQualitySourceInput(
  value: unknown,
): value is QualitySourceInput {
  return (
    isRecord(value) &&
    (value.role === "market" ||
      value.role === "liquidation" ||
      value.role === "analytics") &&
    Object.hasOwn(value, "value")
  );
}
