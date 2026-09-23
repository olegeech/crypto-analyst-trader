import { domainError } from "../shared/errors.js";
import {
  parseUtcTimestamp,
  timestampFromEpochMs,
  type Clock,
  type UtcTimestamp,
} from "../shared/time.js";
import {
  isRecord,
  requireFiniteInteger,
  requireHash,
  requireSafeText,
} from "../shared/validation.js";
import { fail, ok, type Result } from "../shared/result.js";

export type EvidenceKind =
  | "market-snapshot"
  | "market-evidence-bundle"
  | "account-snapshot"
  | "capability-probe"
  | "risk-input"
  | "research-artifact";

export interface EvidenceRef {
  readonly kind: EvidenceKind;
  readonly schemaVersion: string;
  readonly producer: string;
  readonly sourceId: string;
  readonly asOf: UtcTimestamp;
  readonly validForMs: number;
  readonly contentHash: string;
}

export interface EvidenceCompatibility {
  readonly kind?: EvidenceKind;
  readonly schemaVersion?: string;
  readonly producer?: string;
  readonly sourceId?: string;
  readonly contentHash?: string;
}

const EVIDENCE_KINDS = new Set<EvidenceKind>([
  "market-snapshot",
  "market-evidence-bundle",
  "account-snapshot",
  "capability-probe",
  "risk-input",
  "research-artifact",
]);

function evidenceFailure(message: string, field?: string): Result<never> {
  return fail(
    domainError(
      "INVALID_EVIDENCE",
      message,
      field === undefined ? undefined : { field },
    ),
  );
}

export function createEvidenceRef(input: unknown): Result<EvidenceRef> {
  if (!isRecord(input)) return evidenceFailure("evidence must be an object");
  const kind = input.kind;
  if (typeof kind !== "string" || !EVIDENCE_KINDS.has(kind as EvidenceKind)) {
    return evidenceFailure("evidence kind is unsupported", "kind");
  }
  const schemaVersion = requireSafeText(input.schemaVersion, "schemaVersion");
  const producer = requireSafeText(input.producer, "producer");
  const sourceId = requireSafeText(input.sourceId, "sourceId");
  const asOf = parseUtcTimestamp(input.asOf);
  const validForMs = requireFiniteInteger(input.validForMs, "validForMs", 1);
  const contentHash = requireHash(input.contentHash, "contentHash");
  if (
    !schemaVersion.ok ||
    !producer.ok ||
    !sourceId.ok ||
    !asOf.ok ||
    !validForMs.ok ||
    !contentHash.ok
  ) {
    const fields: readonly (readonly [string, boolean])[] = [
      ["schemaVersion", schemaVersion.ok],
      ["producer", producer.ok],
      ["sourceId", sourceId.ok],
      ["asOf", asOf.ok],
      ["validForMs", validForMs.ok],
      ["contentHash", contentHash.ok],
    ];
    const field = fields.find(([, valid]) => !valid)?.[0];
    return evidenceFailure("evidence contains an invalid field", field);
  }
  return ok(
    Object.freeze({
      kind: kind as EvidenceKind,
      schemaVersion: schemaVersion.value,
      producer: producer.value,
      sourceId: sourceId.value,
      asOf: asOf.value,
      validForMs: validForMs.value,
      contentHash: contentHash.value,
    }),
  );
}

export function evidenceExpiresAt(evidence: EvidenceRef): Result<UtcTimestamp> {
  const epoch = Date.parse(evidence.asOf) + evidence.validForMs;
  return timestampFromEpochMs(epoch);
}

export function isEvidenceFresh(evidence: EvidenceRef, clock: Clock): boolean {
  const expiresAt = evidenceExpiresAt(evidence);
  if (!expiresAt.ok) return false;
  const now = Date.parse(clock.now());
  const asOf = Date.parse(evidence.asOf);
  return asOf <= now && now < Date.parse(expiresAt.value);
}

export function requireFreshEvidence(
  evidence: readonly EvidenceRef[],
  clock: Clock,
): Result<readonly EvidenceRef[]> {
  const stale = evidence.find((item) => !isEvidenceFresh(item, clock));
  if (stale !== undefined) {
    return fail(
      domainError("STALE_EVIDENCE", "evidence is stale", {
        sourceId: stale.sourceId,
      }),
    );
  }
  return ok(evidence);
}

export function requireCompatibleEvidence(
  evidence: EvidenceRef,
  expected: EvidenceCompatibility,
): Result<EvidenceRef> {
  const matches =
    (expected.kind === undefined || evidence.kind === expected.kind) &&
    (expected.schemaVersion === undefined ||
      evidence.schemaVersion === expected.schemaVersion) &&
    (expected.producer === undefined ||
      evidence.producer === expected.producer) &&
    (expected.sourceId === undefined ||
      evidence.sourceId === expected.sourceId) &&
    (expected.contentHash === undefined ||
      evidence.contentHash === expected.contentHash);
  if (!matches) {
    return fail(
      domainError(
        "INCOMPATIBLE_EVIDENCE",
        "evidence does not match the required identity",
      ),
    );
  }
  return ok(evidence);
}

export function parseEvidenceList(
  input: unknown,
): Result<readonly EvidenceRef[]> {
  if (!Array.isArray(input) || input.length === 0) {
    return evidenceFailure("evidence must be a non-empty array", "evidence");
  }
  const parsed: EvidenceRef[] = [];
  for (const item of input) {
    const result = createEvidenceRef(item);
    if (!result.ok) return result;
    parsed.push(result.value);
  }
  return ok(Object.freeze(parsed));
}
