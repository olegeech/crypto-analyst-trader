import type { AnalyticsEvidenceBundle } from "../analytics/analytics-evidence-bundle.js";
import { compareAnalyticsText as compare } from "../analytics/analytics-diagnostics.js";
import { parseDecimal } from "../shared/decimal.js";
import { domainError } from "../shared/errors.js";
import { fail, type Result } from "../shared/result.js";
import { parseUtcTimestamp } from "../shared/time.js";
import {
  createQualityProfile,
  hashQualityProfile,
  type QualityProfile,
} from "./quality-profile.js";
import {
  admitQualitySource,
  isQualitySourceInput,
  qualityRoleForOutcome,
  type QualitySourceInput,
} from "./quality-inputs.js";
import { classifyQualityEvidence } from "./quality-validation.js";
import {
  INVARIANT_QUALITY_REASONS,
  type DataQualityFinding,
  type QualityReasonCode,
} from "./data-quality-findings.js";
import {
  createDataQualityAssessment,
  type DataQualityAssessment,
  type QualityEvidenceDisposition,
} from "./data-quality-assessment.js";

export interface AssessDataQualityInput {
  readonly profile: QualityProfile;
  readonly sources: readonly QualitySourceInput[];
  readonly bundleCutoff: string;
  readonly evaluationTime: string;
  readonly externalAdmissions?: readonly {
    readonly artifactHash: string;
    readonly issuer: string;
  }[];
}
const admissionObjects = new WeakSet<object>();
/** Controlled code boundary only. Serialized external JSON cannot issue admission. */
export function issueQualityAdmission(issuer: string, artifactHash: string) {
  const admission = Object.freeze({ issuer, artifactHash });
  admissionObjects.add(admission);
  return admission;
}

export function assessDataQuality(
  input: AssessDataQualityInput,
): Result<DataQualityAssessment> {
  const profile = createQualityProfile(input.profile);
  const cutoff = parseUtcTimestamp(input.bundleCutoff);
  const evaluation = parseUtcTimestamp(input.evaluationTime);
  if (
    !profile.ok ||
    !cutoff.ok ||
    !evaluation.ok ||
    !Array.isArray(input.sources) ||
    input.sources.some((source) => !isQualitySourceInput(source))
  )
    return fail(
      domainError(
        "INVALID_VALUE",
        "quality assessment policy or time is invalid",
      ),
    );
  const records = input.sources.map(admitQualitySource);
  const findings: DataQualityFinding[] = classifyQualityEvidence(
    records,
    profile.value,
    cutoff.value,
    evaluation.value,
  );
  const dispositions: QualityEvidenceDisposition[] = [];
  const seen = new Set<string>();
  const add = (role: string, reasonCode: QualityReasonCode) =>
    findings.push({
      role,
      reasonCode,
      blocking:
        INVARIANT_QUALITY_REASONS.has(reasonCode) ||
        profile.value.roles.find((r) => r.id === role)?.required === true,
    });
  for (const record of records) {
    if (seen.has(record.role)) add(record.role, "DUPLICATE_OBSERVATION");
    seen.add(record.role);
    dispositions.push({
      role: record.role,
      disposition: record.failures.length ? "rejected" : "accepted",
      ...(record.contentHash ? { contentHash: record.contentHash } : {}),
      ...(record.bundleHash ? { bundleHash: record.bundleHash } : {}),
    });
    if (record.role !== "analytics" || !record.value || record.failures.length)
      continue;
    const analytics = record.value as AnalyticsEvidenceBundle;
    for (const outcome of [
      ...analytics.priceFeatures,
      ...analytics.derivativeFeatures,
      ...analytics.externalOutcomes,
    ]) {
      const role = qualityRoleForOutcome(outcome.requestId);
      seen.add(role);
      dispositions.push({
        role,
        disposition: outcome.status === "unavailable" ? "rejected" : "accepted",
        contentHash: analytics.contentHash,
      });
    }
    for (const external of analytics.externalEvidence) {
      const role = `external:${external.family}`;
      const admission = input.externalAdmissions?.find(
        (a) =>
          admissionObjects.has(a) && a.artifactHash === external.contentHash,
      );
      const trusted =
        admission &&
        profile.value.trust.some(
          (t) =>
            t.issuer === admission.issuer &&
            t.family === external.family &&
            t.producer === external.provenance.producer &&
            t.schemaVersion === external.schemaVersion &&
            t.modelVersion === external.modelVersion,
        );
      const index = dispositions.findIndex((d) => d.role === role);
      const disposition: QualityEvidenceDisposition = {
        role,
        disposition: trusted ? "accepted" : "rejected",
        contentHash: external.contentHash,
        ...(trusted && admission ? { admission } : {}),
      };
      if (index >= 0) dispositions[index] = disposition;
      else dispositions.push(disposition);
      seen.add(role);
      if (!trusted) add(role, "UNTRUSTED_EVIDENCE");
    }
  }
  for (const role of profile.value.roles)
    if (!seen.has(role.id)) {
      add(role.id, "MISSING_EVIDENCE");
      dispositions.push({ role: role.id, disposition: "missing" });
    }
  const penaltyByGroup = new Map<string, ReturnType<typeof decimal>>();
  const normalized = new Map<string, DataQualityFinding>();
  for (const finding of findings) {
    const penalty = profile.value.penalties.find(
      (p) => p.reasonCode === finding.reasonCode,
    );
    // A declared non-blocking degradation needs an explicit penalty rule; no hidden defaults.
    const declared = profile.value.roles.some((r) => r.id === finding.role);
    const blocking = finding.blocking;
    if (declared && !blocking && !penalty) {
      normalized.set(`${finding.role}:INVALID_QUALITY_POLICY`, {
        role: finding.role,
        reasonCode: "INVALID_QUALITY_POLICY",
        blocking: true,
      });
    }
    const resolved = {
      ...finding,
      blocking,
      ...(!blocking && penalty
        ? { confidenceImpactGroup: penalty.confidenceImpactGroup }
        : {}),
    };
    normalized.set(`${finding.role}:${finding.reasonCode}`, resolved);
    if (!blocking && penalty) {
      const old = penaltyByGroup.get(penalty.confidenceImpactGroup);
      if (!old || old.compare(penalty.penalty) < 0)
        penaltyByGroup.set(penalty.confidenceImpactGroup, penalty.penalty);
    }
  }
  const ordered = [...normalized.values()].sort((a, b) =>
    compare(`${a.role}:${a.reasonCode}`, `${b.role}:${b.reasonCode}`),
  );
  const rejected = new Set(
    ordered
      .filter((f) => f.blocking || f.reasonCode === "UNTRUSTED_EVIDENCE")
      .map((f) => f.role),
  );
  const orderedDispositions = [
    ...new Map(dispositions.map((d) => [d.role, d])).values(),
  ]
    .map((d) =>
      rejected.has(d.role) && d.disposition !== "missing"
        ? { ...d, disposition: "rejected" as const }
        : d,
    )
    .sort((a, b) => compare(a.role, b.role));
  let confidence = decimal("100");
  for (const penalty of penaltyByGroup.values())
    confidence = confidence.subtract(penalty);
  if (confidence.isNegative()) confidence = decimal("0");
  const profileHash = hashQualityProfile(profile.value);
  if (!profileHash.ok) return profileHash;
  return createDataQualityAssessment({
    schemaVersion: "data-quality-assessment/v1",
    qualityGate: ordered.some((f) => f.blocking) ? "BLOCK" : "OK",
    profileVersion: profile.value.profileVersion,
    profileHash: profileHash.value,
    evaluationTime: evaluation.value,
    bundleCutoff: cutoff.value,
    findings: ordered,
    dispositions: orderedDispositions,
    appliedPenalties: [...penaltyByGroup]
      .sort(([a], [b]) => compare(a, b))
      .map(([confidenceImpactGroup, penalty]) => ({
        confidenceImpactGroup,
        penalty,
      })),
    ...(records.some((r) => r.value && r.failures.length === 0)
      ? { evidenceConfidence: confidence }
      : {}),
  });
}
function decimal(value: string) {
  const result = parseDecimal(value);
  if (!result.ok) throw new Error("invalid internal decimal constant");
  return result.value;
}
