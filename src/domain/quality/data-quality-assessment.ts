import {
  hashCanonical,
  type PlanHash,
} from "../identity/canonical-serialization.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import {
  isDecimalValue,
  parseDecimal,
  type DecimalValue,
} from "../shared/decimal.js";
import type { UtcTimestamp } from "../shared/time.js";
import type { Result } from "../shared/result.js";
import { fail, ok } from "../shared/result.js";
import { domainError } from "../shared/errors.js";
import { parseUtcTimestamp } from "../shared/time.js";
import {
  isRecord,
  requireHash,
  requireIdentifier,
  requireSafeText,
} from "../shared/validation.js";
import {
  QUALITY_REASON_CODES,
  INVARIANT_QUALITY_REASONS,
  type DataQualityFinding,
} from "./data-quality-findings.js";

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
  const parsed = validatePayload(payload);
  if (!parsed.ok) return parsed;
  const hash = hashCanonical(parsed.value);
  if (!hash.ok) return hash;
  return ok(deepFreeze({ ...parsed.value, contentHash: hash.value }));
}

const payloadKeys = [
  "schemaVersion",
  "qualityGate",
  "profileVersion",
  "profileHash",
  "evaluationTime",
  "bundleCutoff",
  "findings",
  "dispositions",
  "appliedPenalties",
  "evidenceConfidence",
] as const;

function invalid(
  message = "quality assessment is invalid or unsupported",
): Result<never> {
  return fail(domainError("INVALID_VALUE", message));
}

function hasOnlyKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Reflect.ownKeys(record).every(
    (key) => typeof key === "string" && keys.includes(key),
  );
}

function decimal(input: unknown): Result<DecimalValue> {
  return isDecimalValue(input) ? ok(input) : parseDecimal(input);
}

function validatePayload(input: unknown): Result<DataQualityAssessmentPayload> {
  if (!isRecord(input) || !hasOnlyKeys(input, payloadKeys)) return invalid();
  if (input.schemaVersion !== "data-quality-assessment/v1")
    return fail(
      domainError(
        "UNSUPPORTED_CONTRACT",
        "quality assessment schema version is unsupported",
      ),
    );
  const profileVersion = requireIdentifier(
    input.profileVersion,
    "profileVersion",
  );
  const profileHash = requireHash(input.profileHash, "profileHash");
  const evaluationTime = parseUtcTimestamp(input.evaluationTime);
  const bundleCutoff = parseUtcTimestamp(input.bundleCutoff);
  if (
    !profileVersion.ok ||
    !profileHash.ok ||
    !evaluationTime.ok ||
    !bundleCutoff.ok ||
    !Array.isArray(input.findings) ||
    !Array.isArray(input.dispositions) ||
    !Array.isArray(input.appliedPenalties)
  )
    return invalid();

  const findings: DataQualityFinding[] = [];
  const groups = new Set<string>();
  let previousFinding: string | undefined;
  for (const row of input.findings) {
    if (
      !isRecord(row) ||
      !hasOnlyKeys(row, [
        "role",
        "reasonCode",
        "blocking",
        "confidenceImpactGroup",
      ])
    )
      return invalid();
    const role = requireIdentifier(row.role, "role");
    const reasonCode = QUALITY_REASON_CODES.find(
      (reason) => reason === row.reasonCode,
    );
    if (
      !role.ok ||
      !reasonCode ||
      typeof row.blocking !== "boolean" ||
      (INVARIANT_QUALITY_REASONS.has(reasonCode) && !row.blocking)
    )
      return invalid();
    const key = `${role.value}:${reasonCode}`;
    if (previousFinding !== undefined && previousFinding >= key)
      return invalid("findings must be sorted and unique");
    previousFinding = key;
    let confidenceImpactGroup: string | undefined;
    if (Object.hasOwn(row, "confidenceImpactGroup")) {
      const group = requireIdentifier(
        row.confidenceImpactGroup,
        "confidenceImpactGroup",
      );
      if (!group.ok || row.blocking) return invalid();
      confidenceImpactGroup = group.value;
      groups.add(group.value);
    }
    findings.push({
      role: role.value,
      reasonCode,
      blocking: row.blocking,
      ...(confidenceImpactGroup === undefined ? {} : { confidenceImpactGroup }),
    });
  }
  const qualityGate = findings.some((finding) => finding.blocking)
    ? "BLOCK"
    : "OK";
  if (input.qualityGate !== qualityGate)
    return invalid("quality gate must match blocking findings");
  if (
    Date.parse(bundleCutoff.value) > Date.parse(evaluationTime.value) &&
    !findings.some(
      (finding) =>
        finding.reasonCode === "FUTURE_INFORMATION" && finding.blocking,
    )
  )
    return invalid(
      "a future cutoff requires a blocking future-information finding",
    );

  const dispositions: QualityEvidenceDisposition[] = [];
  let previousRole: string | undefined;
  for (const row of input.dispositions) {
    if (
      !isRecord(row) ||
      !hasOnlyKeys(row, [
        "role",
        "disposition",
        "contentHash",
        "bundleHash",
        "admission",
      ])
    )
      return invalid();
    const role = requireIdentifier(row.role, "role");
    if (
      !role.ok ||
      (previousRole !== undefined && previousRole >= role.value) ||
      (row.disposition !== "accepted" &&
        row.disposition !== "rejected" &&
        row.disposition !== "missing")
    )
      return invalid();
    previousRole = role.value;
    const hashes: { contentHash?: string; bundleHash?: string } = {};
    for (const field of ["contentHash", "bundleHash"] as const) {
      if (!Object.hasOwn(row, field)) continue;
      const hash = requireHash(row[field], field);
      if (!hash.ok) return hash;
      hashes[field] = hash.value;
    }
    if (
      row.disposition === "missing" &&
      (hashes.contentHash !== undefined || hashes.bundleHash !== undefined)
    )
      return invalid();
    if (row.disposition === "accepted" && hashes.contentHash === undefined)
      return invalid();
    let admission: QualityEvidenceDisposition["admission"];
    if (Object.hasOwn(row, "admission")) {
      if (
        !isRecord(row.admission) ||
        !hasOnlyKeys(row.admission, ["issuer", "artifactHash"])
      )
        return invalid();
      const issuer = requireSafeText(row.admission.issuer, "issuer");
      const artifactHash = requireHash(
        row.admission.artifactHash,
        "artifactHash",
      );
      if (
        !issuer.ok ||
        !artifactHash.ok ||
        row.disposition !== "accepted" ||
        !role.value.startsWith("external:") ||
        artifactHash.value !== hashes.contentHash
      )
        return invalid();
      // Historical data only: copying never registers admission authority with the evaluator.
      admission = { issuer: issuer.value, artifactHash: artifactHash.value };
    }
    dispositions.push({
      role: role.value,
      disposition: row.disposition,
      ...hashes,
      ...(admission === undefined ? {} : { admission }),
    });
  }
  for (const finding of findings) {
    const disposition = dispositions.find((row) => row.role === finding.role);
    // Assessment-time metadata has no source artifact to disposition.
    if (
      !disposition &&
      finding.role === "assessment" &&
      finding.reasonCode === "FUTURE_INFORMATION" &&
      finding.blocking
    )
      continue;
    if (
      !disposition ||
      (finding.reasonCode === "MISSING_EVIDENCE" &&
        disposition.disposition !== "missing") ||
      ((finding.blocking || finding.reasonCode === "UNTRUSTED_EVIDENCE") &&
        disposition.disposition === "accepted")
    )
      return invalid();
  }

  const hundred = decimal("100");
  const zero = decimal("0");
  if (!hundred.ok || !zero.ok) return invalid();
  let expectedConfidence = hundred.value;
  const appliedPenalties: DataQualityAssessmentPayload["appliedPenalties"][number][] =
    [];
  let previousGroup: string | undefined;
  for (const row of input.appliedPenalties) {
    if (
      !isRecord(row) ||
      !hasOnlyKeys(row, ["confidenceImpactGroup", "penalty"])
    )
      return invalid();
    const group = requireIdentifier(
      row.confidenceImpactGroup,
      "confidenceImpactGroup",
    );
    const penalty = decimal(row.penalty);
    if (
      !group.ok ||
      !penalty.ok ||
      penalty.value.isNegative() ||
      penalty.value.compare(hundred.value) > 0 ||
      !groups.has(group.value) ||
      (previousGroup !== undefined && previousGroup >= group.value)
    )
      return invalid();
    previousGroup = group.value;
    appliedPenalties.push({
      confidenceImpactGroup: group.value,
      penalty: penalty.value,
    });
    expectedConfidence = expectedConfidence.subtract(penalty.value);
  }
  if (appliedPenalties.length !== groups.size)
    return invalid("finding groups and penalties must match");
  if (expectedConfidence.isNegative()) expectedConfidence = zero.value;
  let evidenceConfidence: DecimalValue | undefined;
  if (Object.hasOwn(input, "evidenceConfidence")) {
    const confidence = decimal(input.evidenceConfidence);
    if (
      !confidence.ok ||
      confidence.value.isNegative() ||
      confidence.value.compare(hundred.value) > 0 ||
      confidence.value.compare(expectedConfidence) !== 0
    )
      return invalid("evidence confidence must match exact group penalties");
    evidenceConfidence = confidence.value;
  }
  return ok({
    schemaVersion: "data-quality-assessment/v1",
    qualityGate,
    profileVersion: profileVersion.value,
    profileHash: profileHash.value as PlanHash,
    evaluationTime: evaluationTime.value,
    bundleCutoff: bundleCutoff.value,
    findings,
    dispositions,
    appliedPenalties,
    ...(evidenceConfidence === undefined ? {} : { evidenceConfidence }),
  });
}

export function rehydrateDataQualityAssessment(
  input: unknown,
): Result<DataQualityAssessment> {
  if (!isRecord(input) || !hasOnlyKeys(input, [...payloadKeys, "contentHash"]))
    return invalid();
  const contentHash = requireHash(input.contentHash, "contentHash");
  if (!contentHash.ok) return contentHash;
  const { contentHash: _hash, ...payload } = input;
  void _hash;
  const parsed = validatePayload(payload);
  if (!parsed.ok) return parsed;
  const assessment = createDataQualityAssessment(parsed.value);
  if (!assessment.ok) return assessment;
  if (assessment.value.contentHash !== contentHash.value)
    return fail(
      domainError(
        "PLAN_HASH_MISMATCH",
        "quality assessment content hash does not match its payload",
      ),
    );
  return assessment;
}
