import {
  hashCanonical,
  type PlanHash,
} from "../identity/canonical-serialization.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import type { DecimalValue } from "../shared/decimal.js";
import type { UtcTimestamp } from "../shared/time.js";
import type { Result } from "../shared/result.js";
import { ok } from "../shared/result.js";
import type { DataQualityFinding } from "./data-quality-findings.js";

export interface QualityEvidenceDisposition {
  readonly role: string;
  readonly disposition: "accepted" | "rejected" | "missing";
  readonly contentHash?: string;
  readonly bundleHash?: string;
  readonly admission?: {
    readonly issuer: string;
    readonly artifactHash: string;
  };
}
export interface DataQualityAssessmentPayload {
  readonly schemaVersion: "data-quality-assessment/v1";
  readonly qualityGate: "OK" | "BLOCK";
  readonly profileVersion: string;
  readonly profileHash: PlanHash;
  readonly evaluationTime: UtcTimestamp;
  readonly bundleCutoff: UtcTimestamp;
  readonly findings: readonly DataQualityFinding[];
  readonly dispositions: readonly QualityEvidenceDisposition[];
  readonly appliedPenalties: readonly {
    readonly confidenceImpactGroup: string;
    readonly penalty: DecimalValue;
  }[];
  readonly evidenceConfidence?: DecimalValue;
}
export interface DataQualityAssessment extends DataQualityAssessmentPayload {
  readonly contentHash: PlanHash;
}
export function createDataQualityAssessment(
  payload: DataQualityAssessmentPayload,
): Result<DataQualityAssessment> {
  const hash = hashCanonical(payload);
  if (!hash.ok) return hash;
  return ok(deepFreeze({ ...payload, contentHash: hash.value }));
}
