import {
  canonicalSerialize,
  hashCanonical,
} from "../identity/canonical-serialization.js";
import { closedRecord } from "../planning/planning-validation.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";
import {
  parseUtcTimestamp,
  timestampFromEpochMs,
  type UtcTimestamp,
} from "../shared/time.js";
import { requireIdentifier } from "../shared/validation.js";
import {
  rehydratePreparedDailyPlan,
  type PreparedDailyPlan,
} from "./prepared-daily-plan.js";

export interface PreparedPlanApproval {
  readonly schemaVersion: "prepared-plan-approval/v1";
  readonly approvalId: string;
  readonly contentHash: string;
  readonly preparedHash: string;
  readonly preparedArtifactHash: string;
  readonly actor: string;
  readonly consent: true;
  readonly note: string | null;
  readonly approvedAt: UtcTimestamp;
  readonly expiresAt: UtcTimestamp;
  readonly policyVersion: string;
  readonly executionAuthority: "none";
  readonly replayInputs: { readonly prepared: PreparedDailyPlan };
}

const INPUT_KEYS = [
  "prepared",
  "preparedHash",
  "actor",
  "consent",
  "approvedAt",
  "note",
] as const;
const ARTIFACT_KEYS = [
  "schemaVersion",
  "approvalId",
  "contentHash",
  "preparedHash",
  "preparedArtifactHash",
  "actor",
  "consent",
  "note",
  "approvedAt",
  "expiresAt",
  "policyVersion",
  "executionAuthority",
  "replayInputs",
] as const;
function invalid(message = "prepared approval is invalid"): Result<never> {
  return fail(domainError("INVALID_APPROVAL", message));
}

/** Pure consent record. The application supplies actor/time, not request JSON. */
export function createPreparedPlanApproval(
  input: unknown,
): Result<PreparedPlanApproval> {
  if (!closedRecord(input, INPUT_KEYS) || input.consent !== true)
    return invalid();
  const prepared = rehydratePreparedDailyPlan(input.prepared);
  const actor = requireIdentifier(input.actor, "actor");
  const approvedAt = parseUtcTimestamp(input.approvedAt);
  if (
    !prepared.ok ||
    !actor.ok ||
    !approvedAt.ok ||
    prepared.value.state === "BLOCKED" ||
    input.preparedHash !== prepared.value.contentHash
  )
    return invalid("exact approvable snapshot, actor and consent are required");
  if (
    Date.parse(approvedAt.value) <
    Date.parse(prepared.value.inputIdentity.evaluationTime)
  )
    return invalid("approval cannot precede prepared evaluation");
  const note =
    input.note === undefined || input.note === null ? null : input.note;
  if (
    note !== null &&
    (typeof note !== "string" ||
      note.length > 2000 ||
      /[\u0000-\u001f\u007f]/u.test(note))
  )
    return invalid("approval note is invalid");
  const normalizedNote = note === null ? null : note.trim() || null;
  if (prepared.value.noteRequired && normalizedNote === null)
    return invalid("review requires a nonblank operator note");
  const policy = prepared.value.replayInputs.approvalPolicy;
  const expiresAt = timestampFromEpochMs(
    Date.parse(approvedAt.value) + policy.ttlMs,
  );
  const preparedArtifactHash = hashCanonical(prepared.value);
  if (!expiresAt.ok || !preparedArtifactHash.ok) return invalid();
  const payload = {
    schemaVersion: "prepared-plan-approval/v1" as const,
    preparedHash: prepared.value.contentHash,
    preparedArtifactHash: preparedArtifactHash.value,
    actor: actor.value,
    consent: true as const,
    note: normalizedNote,
    approvedAt: approvedAt.value,
    expiresAt: expiresAt.value,
    policyVersion: policy.policyVersion,
    executionAuthority: "none" as const,
    replayInputs: { prepared: prepared.value },
  };
  const id = hashCanonical(payload);
  if (!id.ok) return id;
  const identified = {
    ...payload,
    approvalId: `prepared-plan-approval:${id.value}`,
  };
  const contentHash = hashCanonical(identified);
  return contentHash.ok
    ? ok(deepFreeze({ ...identified, contentHash: contentHash.value }))
    : contentHash;
}

export function rehydratePreparedPlanApproval(
  input: unknown,
): Result<PreparedPlanApproval> {
  if (
    !closedRecord(input, ARTIFACT_KEYS) ||
    !closedRecord(input.replayInputs, ["prepared"])
  )
    return invalid();
  const replayed = createPreparedPlanApproval({
    prepared: input.replayInputs.prepared,
    preparedHash: input.preparedHash,
    actor: input.actor,
    consent: input.consent,
    approvedAt: input.approvedAt,
    note: input.note,
  });
  if (!replayed.ok) return replayed;
  const actual = canonicalSerialize(input),
    expected = canonicalSerialize(replayed.value);
  return actual.ok && expected.ok && actual.value === expected.value
    ? replayed
    : invalid("approval differs from deterministic replay");
}

/** Validity of consent only: never returns an execution capability. */
export function validatePreparedPlanApproval(
  approval: unknown,
  prepared: unknown,
  now: unknown,
): Result<PreparedPlanApproval> {
  const a = rehydratePreparedPlanApproval(approval),
    p = rehydratePreparedDailyPlan(prepared),
    time = parseUtcTimestamp(now);
  if (
    !a.ok ||
    !p.ok ||
    !time.ok ||
    a.value.preparedHash !== p.value.contentHash
  )
    return invalid("approval association is invalid");
  if (Date.parse(time.value) < Date.parse(a.value.approvedAt))
    return invalid("approval is not yet valid");
  if (Date.parse(time.value) >= Date.parse(a.value.expiresAt))
    return fail(domainError("PLAN_EXPIRED", "prepared consent has expired"));
  return a;
}
