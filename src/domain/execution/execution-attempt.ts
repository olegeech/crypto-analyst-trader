import type { PlanHash } from "../identity/canonical-serialization.js";
import { domainError } from "../shared/errors.js";
import { parseUtcTimestamp, type UtcTimestamp } from "../shared/time.js";
import { fail, ok, type Result } from "../shared/result.js";
import {
  isRecord,
  requireHash,
  requireIdentifier,
} from "../shared/validation.js";
import { markExecutionAttempt } from "./execution-attempt-proof.js";

export type AttemptAcknowledgement = "pending" | "accepted" | "rejected";
export type AttemptTerminalStatus =
  "unverified" | "open" | "filled" | "cancelled" | "rejected";

export interface ExecutionAttempt {
  readonly attemptId: string;
  readonly planHash: PlanHash;
  readonly intentId: string;
  readonly clientOrderId: string;
  readonly submittedAt: UtcTimestamp;
  readonly acknowledgement: AttemptAcknowledgement;
  readonly terminalStatus: AttemptTerminalStatus;
  readonly exchangeOrderId?: string;
}

export function createExecutionAttempt(
  input: unknown,
): Result<ExecutionAttempt> {
  if (!isRecord(input)) {
    return fail(
      domainError("INVALID_VALUE", "execution attempt must be an object"),
    );
  }
  const attemptId = requireIdentifier(input.attemptId, "attemptId");
  const planHash = requireHash(input.planHash, "planHash");
  const intentId = requireIdentifier(input.intentId, "intentId");
  const clientOrderId = requireIdentifier(input.clientOrderId, "clientOrderId");
  const submittedAt = parseUtcTimestamp(input.submittedAt);
  if (
    !attemptId.ok ||
    !planHash.ok ||
    !intentId.ok ||
    !clientOrderId.ok ||
    !submittedAt.ok ||
    (input.acknowledgement !== "pending" &&
      input.acknowledgement !== "accepted" &&
      input.acknowledgement !== "rejected") ||
    (input.terminalStatus !== "unverified" &&
      input.terminalStatus !== "open" &&
      input.terminalStatus !== "filled" &&
      input.terminalStatus !== "cancelled" &&
      input.terminalStatus !== "rejected")
  ) {
    return fail(
      domainError(
        "INVALID_VALUE",
        "execution attempt contains an invalid field",
      ),
    );
  }
  let exchangeOrderId: string | undefined;
  if (input.exchangeOrderId !== undefined) {
    const parsed = requireIdentifier(input.exchangeOrderId, "exchangeOrderId");
    if (!parsed.ok) return parsed;
    exchangeOrderId = parsed.value;
  }
  const attempt: {
    attemptId: string;
    planHash: PlanHash;
    intentId: string;
    clientOrderId: string;
    submittedAt: UtcTimestamp;
    acknowledgement: AttemptAcknowledgement;
    terminalStatus: AttemptTerminalStatus;
    exchangeOrderId?: string;
  } = {
    attemptId: attemptId.value,
    planHash: planHash.value as PlanHash,
    intentId: intentId.value,
    clientOrderId: clientOrderId.value,
    submittedAt: submittedAt.value,
    acknowledgement: input.acknowledgement,
    terminalStatus: input.terminalStatus,
  };
  if (exchangeOrderId !== undefined) attempt.exchangeOrderId = exchangeOrderId;
  return ok(markExecutionAttempt(Object.freeze(attempt)));
}
