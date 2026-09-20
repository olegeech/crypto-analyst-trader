import type { Approval } from "./approval.js";
import { createApproval, validateApproval } from "./approval.js";
import {
  parseEvidenceList,
  requireFreshEvidence,
  type EvidenceRef,
} from "../evidence/evidence-ref.js";
import type { PlanHash } from "../identity/canonical-serialization.js";
import { domainError } from "../shared/errors.js";
import type { Clock } from "../shared/time.js";
import { fail, ok, type Result } from "../shared/result.js";
import {
  isRecord,
  requireHash,
  requireIdentifier,
} from "../shared/validation.js";
import type { ExecutionPlan } from "../planning/execution-plan.js";
import { isProducedExecutionPlan } from "../planning/plan-proof.js";
import type { ReconciliationResult } from "./reconciliation.js";
import { isProducedReconciliationResult } from "./reconciliation-proof.js";
import {
  isProducedLifecycleState,
  markLifecycleState,
} from "./lifecycle-proof.js";

export type LifecycleStateName =
  | "DRAFT"
  | "VALIDATED"
  | "BLOCKED"
  | "READY_FOR_APPROVAL"
  | "APPROVED"
  | "EXECUTING"
  | "PENDING_RECONCILIATION"
  | "RECONCILED"
  | "PARTIAL"
  | "FAILED"
  | "EXPIRED";

export interface LifecycleState {
  readonly state: LifecycleStateName;
  readonly planHash: PlanHash;
  readonly intentIds: readonly string[];
  readonly evidence: readonly EvidenceRef[];
  readonly approval?: Approval;
}

export type LifecyclePlan = ExecutionPlan;

export type LifecycleTransition =
  | { readonly type: "validate" }
  | { readonly type: "block" }
  | { readonly type: "ready-for-approval" }
  | { readonly type: "approve"; readonly approval: Approval }
  | { readonly type: "begin-execution" }
  | { readonly type: "mark-pending-reconciliation" }
  | {
      readonly type: "reconcile";
      readonly results: readonly ReconciliationResult[];
    }
  | { readonly type: "expire" };

function producedState(state: LifecycleState): LifecycleState {
  return markLifecycleState(Object.freeze(state));
}

export function createLifecycleState(
  plan: LifecyclePlan,
): Result<LifecycleState> {
  if (!isProducedExecutionPlan(plan)) {
    return fail(
      domainError(
        "INVALID_PLAN",
        "lifecycle requires a domain-produced execution plan",
      ),
    );
  }
  const parsed = requireHash(plan.materialHash, "planHash");
  if (!parsed.ok) return parsed;
  const evidence = plan.material.evidence;
  if (evidence.length === 0) {
    return fail(
      domainError("INVALID_EVIDENCE", "lifecycle evidence is required"),
    );
  }
  return ok(
    producedState({
      state: "DRAFT" as const,
      planHash: parsed.value as PlanHash,
      intentIds: Object.freeze(
        plan.material.orderIntents.map((intent) => intent.intentId),
      ),
      evidence: Object.freeze([...evidence]),
    }),
  );
}

export function rehydrateLifecycleState(
  input: unknown,
): Result<LifecycleState> {
  if (!isRecord(input)) {
    return fail(
      domainError("INVALID_TRANSITION", "lifecycle state must be an object"),
    );
  }
  const planHash = requireHash(input.planHash, "planHash");
  const evidence = parseEvidenceList(input.evidence);
  if (
    !planHash.ok ||
    !evidence.ok ||
    !Array.isArray(input.intentIds) ||
    !input.intentIds.every(
      (intentId) => requireIdentifier(intentId, "intentId").ok,
    ) ||
    (input.state !== "DRAFT" &&
      input.state !== "VALIDATED" &&
      input.state !== "BLOCKED" &&
      input.state !== "READY_FOR_APPROVAL" &&
      input.state !== "APPROVED" &&
      input.state !== "EXECUTING" &&
      input.state !== "PENDING_RECONCILIATION" &&
      input.state !== "RECONCILED" &&
      input.state !== "PARTIAL" &&
      input.state !== "FAILED" &&
      input.state !== "EXPIRED")
  ) {
    return fail(
      domainError(
        "INVALID_TRANSITION",
        "lifecycle state contains an invalid field",
      ),
    );
  }
  let approval: Approval | undefined;
  if (input.approval !== undefined) {
    const parsedApproval = createApproval(input.approval);
    if (!parsedApproval.ok) return parsedApproval;
    approval = parsedApproval.value;
  }
  return ok(
    markLifecycleState(
      Object.freeze({
        state: input.state,
        planHash: planHash.value as PlanHash,
        intentIds: Object.freeze([...input.intentIds] as string[]),
        evidence: evidence.value,
        ...(approval === undefined ? {} : { approval }),
      }),
    ),
  );
}

function unsupported(message: string): Result<never> {
  return fail(domainError("UNSUPPORTED_TRANSITION", message));
}

function reconciliationState(
  current: LifecycleState,
  results: readonly ReconciliationResult[],
): Result<LifecycleStateName> {
  if (results.length !== current.intentIds.length) {
    return fail(
      domainError(
        "OWNERSHIP_MISMATCH",
        "reconciliation must cover every plan intent",
      ),
    );
  }
  const expected = new Set(current.intentIds);
  const seen = new Set<string>();
  const seenAttemptIds = new Set<string>();
  const seenClientOrderIds = new Set<string>();
  const seenExchangeOrderIds = new Set<string>();
  for (const result of results) {
    if (!isProducedReconciliationResult(result)) {
      return fail(
        domainError(
          "INVALID_TRANSITION",
          "reconciliation results must be produced by the domain",
        ),
      );
    }
    if (
      result.planHash !== current.planHash ||
      !expected.has(result.intentId) ||
      seen.has(result.intentId) ||
      seenAttemptIds.has(result.attemptId) ||
      seenClientOrderIds.has(result.clientOrderId) ||
      (result.exchangeOrderId !== undefined &&
        seenExchangeOrderIds.has(result.exchangeOrderId))
    ) {
      return fail(
        domainError(
          "OWNERSHIP_MISMATCH",
          "reconciliation result is not owned by the lifecycle plan",
        ),
      );
    }
    seen.add(result.intentId);
    seenAttemptIds.add(result.attemptId);
    seenClientOrderIds.add(result.clientOrderId);
    if (result.exchangeOrderId !== undefined) {
      seenExchangeOrderIds.add(result.exchangeOrderId);
    }
    if (result.status === "PENDING" || result.status === "UNRESOLVED") {
      return fail(
        domainError(
          "UNRESOLVED_RECONCILIATION",
          "pending or unresolved reconciliation cannot close the lifecycle",
        ),
      );
    }
  }
  if (seen.size !== expected.size) {
    return fail(
      domainError(
        "OWNERSHIP_MISMATCH",
        "reconciliation must cover every plan intent",
      ),
    );
  }
  if (results.every((result) => result.status === "RECONCILED")) {
    return ok("RECONCILED");
  }
  if (results.every((result) => result.status === "FAILED")) {
    return ok("FAILED");
  }
  return ok("PARTIAL");
}

export function transitionLifecycle(
  current: LifecycleState,
  transition: LifecycleTransition,
  clock: Clock,
): Result<LifecycleState> {
  if (!isProducedLifecycleState(current)) {
    return fail(
      domainError(
        "INVALID_TRANSITION",
        "lifecycle state must be produced by the domain",
      ),
    );
  }
  if (transition.type === "validate") {
    if (current.state !== "DRAFT")
      return unsupported("only a draft can be validated");
    return ok(
      producedState({
        state: "VALIDATED" as const,
        planHash: current.planHash,
        intentIds: current.intentIds,
        evidence: current.evidence,
      }),
    );
  }

  if (transition.type === "block") {
    if (
      current.state !== "DRAFT" &&
      current.state !== "VALIDATED" &&
      current.state !== "READY_FOR_APPROVAL"
    ) {
      return unsupported("only a pre-execution plan can be blocked");
    }
    return ok(
      producedState({
        state: "BLOCKED" as const,
        planHash: current.planHash,
        intentIds: current.intentIds,
        evidence: current.evidence,
      }),
    );
  }

  if (transition.type === "ready-for-approval") {
    if (current.state !== "VALIDATED") {
      return unsupported("only a validated plan can become ready for approval");
    }
    return ok(
      producedState({
        state: "READY_FOR_APPROVAL" as const,
        planHash: current.planHash,
        intentIds: current.intentIds,
        evidence: current.evidence,
      }),
    );
  }

  if (transition.type === "approve") {
    if (current.state !== "READY_FOR_APPROVAL") {
      return unsupported("only a ready plan can be approved");
    }
    if (transition.approval.planHash !== current.planHash) {
      return fail(
        domainError(
          "PLAN_HASH_MISMATCH",
          "approval does not bind lifecycle plan",
        ),
      );
    }
    const valid = validateApproval(
      transition.approval,
      current.planHash,
      clock,
    );
    if (!valid.ok) return valid;
    return ok(
      producedState({
        state: "APPROVED" as const,
        planHash: current.planHash,
        intentIds: current.intentIds,
        evidence: current.evidence,
        approval: valid.value,
      }),
    );
  }

  if (transition.type === "begin-execution") {
    if (current.state !== "APPROVED" || current.approval === undefined) {
      return unsupported("only an approved plan can begin execution");
    }
    const valid = validateApproval(current.approval, current.planHash, clock);
    if (!valid.ok) return valid;
    const freshEvidence = requireFreshEvidence(current.evidence, clock);
    if (!freshEvidence.ok) return freshEvidence;
    return ok(
      producedState({
        state: "EXECUTING" as const,
        planHash: current.planHash,
        intentIds: current.intentIds,
        evidence: current.evidence,
        approval: current.approval,
      }),
    );
  }

  if (transition.type === "mark-pending-reconciliation") {
    if (current.state !== "EXECUTING") {
      return unsupported("only an executing plan can await reconciliation");
    }
    return ok(
      producedState({
        state: "PENDING_RECONCILIATION" as const,
        planHash: current.planHash,
        intentIds: current.intentIds,
        evidence: current.evidence,
        ...(current.approval === undefined
          ? {}
          : { approval: current.approval }),
      }),
    );
  }

  if (transition.type === "reconcile") {
    if (current.state !== "PENDING_RECONCILIATION") {
      return unsupported("only a pending plan can be reconciled");
    }
    if (!Array.isArray(transition.results)) {
      return fail(
        domainError(
          "INVALID_TRANSITION",
          "reconciliation results must be an array",
        ),
      );
    }
    const state = reconciliationState(current, transition.results);
    if (!state.ok) return state;
    return ok(
      producedState({
        state: state.value,
        planHash: current.planHash,
        intentIds: current.intentIds,
        evidence: current.evidence,
        ...(current.approval === undefined
          ? {}
          : { approval: current.approval }),
      }),
    );
  }

  if (current.state !== "APPROVED" || current.approval === undefined) {
    return unsupported("only an approved plan can expire");
  }
  if (Date.parse(clock.now()) < Date.parse(current.approval.expiresAt)) {
    return fail(
      domainError(
        "UNSUPPORTED_TRANSITION",
        "plan approval has not reached expiry",
      ),
    );
  }
  return ok(
    producedState({
      state: "EXPIRED" as const,
      planHash: current.planHash,
      intentIds: current.intentIds,
      evidence: current.evidence,
      approval: current.approval,
    }),
  );
}
