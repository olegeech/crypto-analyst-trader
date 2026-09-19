import { domainError } from "../shared/errors.js";
import {
  parseUtcTimestamp,
  type Clock,
  type UtcTimestamp,
} from "../shared/time.js";
import { fail, ok, type Result } from "../shared/result.js";
import {
  isRecord,
  requireHash,
  requireIdentifier,
  requireSafeText,
} from "../shared/validation.js";
import type { PlanHash } from "../identity/canonical-serialization.js";

export interface Approval {
  readonly approvalId: string;
  readonly planHash: PlanHash;
  readonly actor: string;
  readonly approvedAt: UtcTimestamp;
  readonly expiresAt: UtcTimestamp;
  readonly note?: string;
}

function invalidApproval(message: string): Result<never> {
  return fail(domainError("INVALID_APPROVAL", message));
}

export function createApproval(input: unknown): Result<Approval> {
  if (!isRecord(input)) return invalidApproval("approval must be an object");
  const approvalId = requireIdentifier(input.approvalId, "approvalId");
  const planHash = requireHash(input.planHash, "planHash");
  const actor = requireIdentifier(input.actor, "actor");
  const approvedAt = parseUtcTimestamp(input.approvedAt);
  const expiresAt = parseUtcTimestamp(input.expiresAt);
  if (
    !approvalId.ok ||
    !planHash.ok ||
    !actor.ok ||
    !approvedAt.ok ||
    !expiresAt.ok
  ) {
    return invalidApproval("approval contains an invalid field");
  }
  if (Date.parse(expiresAt.value) <= Date.parse(approvedAt.value)) {
    return invalidApproval("approval expiry must be after approval time");
  }
  let note: string | undefined;
  if (input.note !== undefined) {
    const noteResult = requireSafeText(input.note, "note");
    if (!noteResult.ok) return invalidApproval("approval note is invalid");
    note = noteResult.value;
  }
  const approval: {
    approvalId: string;
    planHash: PlanHash;
    actor: string;
    approvedAt: UtcTimestamp;
    expiresAt: UtcTimestamp;
    note?: string;
  } = {
    approvalId: approvalId.value,
    planHash: planHash.value as PlanHash,
    actor: actor.value,
    approvedAt: approvedAt.value,
    expiresAt: expiresAt.value,
  };
  if (note !== undefined) approval.note = note;
  return ok(Object.freeze(approval));
}

export function validateApproval(
  approval: Approval,
  expectedPlanHash: string,
  clock: Clock,
): Result<Approval> {
  const parsed = createApproval(approval);
  if (!parsed.ok) return parsed;
  const validated = parsed.value;
  const now = Date.parse(clock.now());
  if (validated.planHash !== expectedPlanHash) {
    return fail(
      domainError(
        "PLAN_HASH_MISMATCH",
        "approval does not bind the current plan",
        {
          approvalId: validated.approvalId,
        },
      ),
    );
  }
  if (now < Date.parse(validated.approvedAt)) {
    return fail(
      domainError("INVALID_APPROVAL", "approval is not effective yet", {
        approvalId: validated.approvalId,
      }),
    );
  }
  if (now >= Date.parse(validated.expiresAt)) {
    return fail(
      domainError("PLAN_EXPIRED", "approval is expired", {
        approvalId: validated.approvalId,
      }),
    );
  }
  return ok(validated);
}
