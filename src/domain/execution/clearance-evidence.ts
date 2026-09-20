import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";
import { parseUtcTimestamp, type UtcTimestamp } from "../shared/time.js";
import {
  isRecord,
  requireFiniteInteger,
  requireIdentifier,
  requireSafeText,
} from "../shared/validation.js";

export const CLEARANCE_EVIDENCE_VERSION = "clearance/v1" as const;

export interface ClearanceEvidence {
  readonly evidenceVersion: typeof CLEARANCE_EVIDENCE_VERSION;
  readonly actor: string;
  readonly source: string;
  readonly timestamp: UtcTimestamp;
  readonly reason: string;
  readonly affectedLineageRevision: number;
  readonly affectedReconciliationRevision: number;
}

export function createClearanceEvidence(
  input: unknown,
): Result<ClearanceEvidence> {
  if (!isRecord(input)) {
    return fail(
      domainError("INVALID_VALUE", "clearance evidence must be an object"),
    );
  }
  const actor = requireIdentifier(input.actor, "actor");
  const source = requireSafeText(input.source, "source");
  const timestamp = parseUtcTimestamp(input.timestamp);
  const reason = requireSafeText(input.reason, "reason");
  const affectedLineageRevision = requireFiniteInteger(
    input.affectedLineageRevision,
    "affectedLineageRevision",
  );
  const affectedReconciliationRevision = requireFiniteInteger(
    input.affectedReconciliationRevision,
    "affectedReconciliationRevision",
  );
  if (
    input.evidenceVersion !== CLEARANCE_EVIDENCE_VERSION ||
    !actor.ok ||
    !source.ok ||
    !timestamp.ok ||
    !reason.ok ||
    !affectedLineageRevision.ok ||
    !affectedReconciliationRevision.ok
  ) {
    return fail(
      domainError(
        "INVALID_VALUE",
        "clearance evidence contains an invalid field",
      ),
    );
  }
  return ok(
    Object.freeze({
      evidenceVersion: CLEARANCE_EVIDENCE_VERSION,
      actor: actor.value,
      source: source.value,
      timestamp: timestamp.value,
      reason: reason.value,
      affectedLineageRevision: affectedLineageRevision.value,
      affectedReconciliationRevision: affectedReconciliationRevision.value,
    }),
  );
}
