import { hashCanonical } from "../identity/canonical-serialization.js";
import {
  parseDecimal,
  isDecimalValue,
  type DecimalValue,
} from "../shared/decimal.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";
import {
  isRecord,
  requireIdentifier,
  requireFiniteInteger,
} from "../shared/validation.js";
import {
  QUALITY_REASON_CODES,
  INVARIANT_QUALITY_REASONS,
  type QualityReasonCode,
} from "./data-quality-findings.js";

export interface QualityRolePolicy {
  readonly id: string;
  readonly required: boolean;
  readonly maxAgeMs: number;
}
export interface QualityTrustIdentity {
  readonly issuer: string;
  readonly family: string;
  readonly producer: string;
  readonly schemaVersion: string;
  readonly modelVersion: string;
}
export interface QualityPenalty {
  readonly reasonCode: QualityReasonCode;
  readonly confidenceImpactGroup: string;
  readonly penalty: DecimalValue;
}
export interface QualityProfile {
  readonly schemaVersion: "quality-profile/v1";
  readonly profileVersion: string;
  readonly roles: readonly QualityRolePolicy[];
  readonly metadataSkewMs: number;
  readonly trust: readonly QualityTrustIdentity[];
  readonly penalties: readonly QualityPenalty[];
}

const invalid = () =>
  fail(
    domainError("INVALID_VALUE", "quality profile is invalid or unsupported"),
  );
const textOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function keys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
export function createQualityProfile(input: unknown): Result<QualityProfile> {
  if (
    !isRecord(input) ||
    !keys(input, [
      "schemaVersion",
      "profileVersion",
      "roles",
      "metadataSkewMs",
      "trust",
      "penalties",
    ]) ||
    input.schemaVersion !== "quality-profile/v1"
  )
    return invalid();
  const version = requireIdentifier(input.profileVersion, "profileVersion");
  const skew = requireFiniteInteger(input.metadataSkewMs, "metadataSkewMs");
  if (
    !version.ok ||
    !skew.ok ||
    !Array.isArray(input.roles) ||
    input.roles.length === 0 ||
    !Array.isArray(input.trust) ||
    !Array.isArray(input.penalties)
  )
    return invalid();
  const roles: QualityRolePolicy[] = [];
  for (const row of input.roles) {
    if (!isRecord(row) || !keys(row, ["id", "required", "maxAgeMs"]))
      return invalid();
    const id = requireIdentifier(row.id, "id");
    const age = requireFiniteInteger(row.maxAgeMs, "maxAgeMs", 1);
    if (
      !id.ok ||
      !age.ok ||
      typeof row.required !== "boolean" ||
      roles.some((r) => r.id === id.value)
    )
      return invalid();
    roles.push({ id: id.value, required: row.required, maxAgeMs: age.value });
  }
  const trust: QualityTrustIdentity[] = [];
  for (const row of input.trust) {
    const fields = [
      "issuer",
      "family",
      "producer",
      "schemaVersion",
      "modelVersion",
    ] as const;
    if (!isRecord(row) || !keys(row, fields)) return invalid();
    const values = fields.map((key) => requireIdentifier(row[key], key));
    if (values.some((v) => !v.ok)) return invalid();
    const identity = Object.fromEntries(
      fields.map((key, i) => [key, values[i]?.ok ? values[i].value : ""]),
    ) as unknown as QualityTrustIdentity;
    if (trust.some((v) => fields.every((key) => v[key] === identity[key])))
      return invalid();
    trust.push(identity);
  }
  const penalties: QualityPenalty[] = [];
  for (const row of input.penalties) {
    if (
      !isRecord(row) ||
      !keys(row, ["reasonCode", "confidenceImpactGroup", "penalty"])
    )
      return invalid();
    const reason = QUALITY_REASON_CODES.find((code) => code === row.reasonCode);
    const group = requireIdentifier(
      row.confidenceImpactGroup,
      "confidenceImpactGroup",
    );
    const penalty = isDecimalValue(row.penalty)
      ? ok(row.penalty)
      : parseDecimal(row.penalty);
    const hundred = parseDecimal("100");
    if (
      !reason ||
      INVARIANT_QUALITY_REASONS.has(reason) ||
      !group.ok ||
      !penalty.ok ||
      !hundred.ok ||
      penalty.value.isNegative() ||
      penalty.value.compare(hundred.value) > 0 ||
      penalties.some((p) => p.reasonCode === reason)
    )
      return invalid();
    penalties.push({
      reasonCode: reason,
      confidenceImpactGroup: group.value,
      penalty: penalty.value,
    });
  }
  return ok(
    deepFreeze({
      schemaVersion: "quality-profile/v1",
      profileVersion: version.value,
      roles: roles.sort((a, b) => textOrder(a.id, b.id)),
      metadataSkewMs: skew.value,
      trust: trust.sort((a, b) =>
        textOrder(JSON.stringify(a), JSON.stringify(b)),
      ),
      penalties: penalties.sort((a, b) =>
        textOrder(a.reasonCode, b.reasonCode),
      ),
    }),
  );
}
export function hashQualityProfile(profile: QualityProfile) {
  return hashCanonical(profile);
}
