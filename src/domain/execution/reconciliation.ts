import type { ExecutionAttempt } from "./execution-attempt.js";
import type { ExchangeOrderObservation } from "./exchange-order.js";
import type { ExecutionPlan } from "../planning/execution-plan.js";
import { isProducedExecutionPlan } from "../planning/plan-proof.js";
import type { PlanHash } from "../identity/canonical-serialization.js";
import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";
import type { UtcTimestamp } from "../shared/time.js";
import { requireHash } from "../shared/validation.js";
import { markReconciliationResult } from "./reconciliation-proof.js";
import { isProducedExecutionAttempt } from "./execution-attempt-proof.js";
import { isProducedExchangeOrder } from "./exchange-order-proof.js";

export type ReconciliationStatus =
  "RECONCILED" | "PARTIAL" | "FAILED" | "PENDING" | "UNRESOLVED";

export interface ReconciliationResult {
  readonly attemptId: string;
  readonly intentId: string;
  readonly planHash: PlanHash;
  readonly clientOrderId: string;
  readonly status: ReconciliationStatus;
  readonly observedAt: UtcTimestamp;
  readonly exchangeOrderId?: string;
}

export type ReconciliationPlan = ExecutionPlan;

export function reconcileAttempt(
  attempt: ExecutionAttempt,
  order: ExchangeOrderObservation | undefined,
  plan: ReconciliationPlan,
): Result<ReconciliationResult> {
  if (!isProducedExecutionAttempt(attempt)) {
    return fail(
      domainError(
        "INVALID_VALUE",
        "reconciliation requires a domain-produced execution attempt",
      ),
    );
  }
  if (order !== undefined && !isProducedExchangeOrder(order)) {
    return fail(
      domainError(
        "INVALID_VALUE",
        "reconciliation requires a domain-produced exchange order",
      ),
    );
  }
  if (!isProducedExecutionPlan(plan)) {
    return fail(
      domainError(
        "INVALID_PLAN",
        "reconciliation requires a domain-produced execution plan",
      ),
    );
  }
  const planHash = requireHash(plan.materialHash, "planHash");
  if (!planHash.ok) return planHash;
  if (attempt.planHash !== planHash.value) {
    return fail(
      domainError(
        "OWNERSHIP_MISMATCH",
        "execution attempt is not owned by the approved plan",
        { attemptId: attempt.attemptId },
      ),
    );
  }
  const intent = plan.material.orderIntents.find(
    (candidate) => candidate.intentId === attempt.intentId,
  );
  if (intent === undefined) {
    return fail(
      domainError(
        "OWNERSHIP_MISMATCH",
        "order intent is not owned by the approved plan",
        { attemptId: attempt.attemptId, intentId: attempt.intentId },
      ),
    );
  }
  if (order === undefined) {
    const status: ReconciliationStatus =
      attempt.acknowledgement === "rejected" ? "FAILED" : "UNRESOLVED";
    return ok(
      markReconciliationResult(
        Object.freeze({
          attemptId: attempt.attemptId,
          intentId: attempt.intentId,
          planHash: attempt.planHash,
          clientOrderId: attempt.clientOrderId,
          status,
          observedAt: attempt.submittedAt,
        }),
      ),
    );
  }
  if (
    attempt.exchangeOrderId === undefined ||
    order.exchangeOrderId !== attempt.exchangeOrderId ||
    order.clientOrderId !== attempt.clientOrderId ||
    order.instrument !== intent.instrument ||
    order.side !== intent.side ||
    order.requestedQuantity.compare(intent.quantity) !== 0 ||
    Date.parse(order.observedAt) < Date.parse(attempt.submittedAt)
  ) {
    return fail(
      domainError(
        "OWNERSHIP_MISMATCH",
        "exchange order is not owned by the attempt",
        {
          attemptId: attempt.attemptId,
          clientOrderId: order.clientOrderId,
        },
      ),
    );
  }
  const status: ReconciliationStatus =
    order.status === "filled" &&
    order.filledQuantity.compare(order.requestedQuantity) === 0
      ? "RECONCILED"
      : order.status === "open" || order.status === "partially-filled"
        ? "PENDING"
        : order.filledQuantity.isPositive()
          ? "PARTIAL"
          : "FAILED";
  return ok(
    markReconciliationResult(
      Object.freeze({
        attemptId: attempt.attemptId,
        intentId: attempt.intentId,
        planHash: attempt.planHash,
        clientOrderId: attempt.clientOrderId,
        status,
        observedAt: order.observedAt,
        exchangeOrderId: order.exchangeOrderId,
      }),
    ),
  );
}
