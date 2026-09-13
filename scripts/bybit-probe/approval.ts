import {
  assertProbePlanCurrent,
  hashProbePlan,
  isProbePlanExpired,
  type ProbePlan,
} from "./probe-plan.js";

export const DEFAULT_APPROVAL_TTL_MS = 120_000;

export type ApprovalRefusalReason = "expired" | "invalid-ttl";

export type ProbeApproval =
  | Readonly<{
      kind: "approved";
      plan: ProbePlan;
      digest: string;
      approvedAt: number;
      expiresAt: number;
    }>
  | Readonly<{
      kind: "refused";
      reason: ApprovalRefusalReason;
      message: string;
    }>;

export interface ApprovalOptions {
  readonly clock?: () => number;
  readonly ttlMs?: number;
}

function refused(
  reason: ApprovalRefusalReason,
  message: string,
): ProbeApproval {
  return { kind: "refused", reason, message };
}

/**
 * The bounded Testnet probe is authorized by its explicit invocation. Each
 * write still receives an exact, expiring plan identity and is revalidated
 * immediately before dispatch; this function records that run-scoped
 * authorization without adding a redundant prompt for every write.
 */
export async function authorizeProbePlan(
  plan: ProbePlan,
  options: ApprovalOptions = {},
): Promise<ProbeApproval> {
  const clock = options.clock ?? Date.now;
  const digest = hashProbePlan(plan);
  const ttlMs = options.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
  const approvedAt = clock();
  if (isProbePlanExpired(plan, approvedAt)) {
    return refused("expired", "The probe plan has already expired.");
  }
  if (!Number.isInteger(ttlMs) || ttlMs < 1) {
    return refused(
      "invalid-ttl",
      "The probe-plan authorization TTL is invalid.",
    );
  }
  const approvalExpiresAt = Math.min(plan.expiresAt, approvedAt + ttlMs);
  if (approvalExpiresAt <= approvedAt) {
    return refused(
      "expired",
      "The probe plan expired before authorization completed.",
    );
  }
  return {
    kind: "approved",
    plan,
    digest,
    approvedAt,
    expiresAt: approvalExpiresAt,
  };
}

// Keep the old name as a source-compatible alias for spike-local callers. It
// is intentionally non-interactive; explicit probe invocation is the UX gate.
export const approveProbePlan = authorizeProbePlan;

export function reverifyProbeApproval(
  approval: Extract<ProbeApproval, { kind: "approved" }>,
  actualPlan: ProbePlan,
  now: number,
): void {
  if (now >= approval.expiresAt) throw new Error("probe plan approval expired");
  assertProbePlanCurrent(
    approval.plan,
    approval.digest,
    now,
    approval.plan.accountId,
  );
  if (isProbePlanExpired(actualPlan, now))
    throw new Error("probe plan approval expired");
  if (actualPlan.accountId !== approval.plan.accountId) {
    throw new Error("probe plan account mismatch");
  }
  if (hashProbePlan(actualPlan) !== approval.digest) {
    throw new Error("probe plan digest mismatch");
  }
}

export const verifyBeforeDispatch = reverifyProbeApproval;
