import process from "node:process";

import {
  PromptInterruptedError,
  promptVisible,
} from "../../src/cli/interactive-prompt.js";
import {
  assertProbePlanCurrent,
  canonicalize,
  hashProbePlan,
  isProbePlanExpired,
  type ProbePlan,
} from "./probe-plan.js";
import { accountHash } from "./store.js";

export const DEFAULT_APPROVAL_TTL_MS = 120_000;
export const DEFAULT_APPROVAL_ATTEMPTS = 3;

export type ApprovalRefusalReason =
  | "expired"
  | "non-tty"
  | "cancelled"
  | "timeout"
  | "empty-input"
  | "digest-mismatch"
  | "prompt-failed";

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

type Output = { write(message: string): void };
type Prompt = (label: string) => Promise<string>;
type PromptInput = NodeJS.ReadableStream & { isTTY?: boolean };

export interface ApprovalOptions {
  readonly clock?: () => number;
  readonly prompt?: Prompt;
  readonly input?: PromptInput;
  readonly output?: Output;
  readonly ttlMs?: number;
  readonly maxAttempts?: number;
}

function approvalBlock(plan: ProbePlan, digest: string): string {
  const printablePlan = {
    schemaVersion: plan.schemaVersion,
    environment: plan.environment,
    account: accountHash(plan.accountId),
    scenario: plan.scenario,
    expiresAt: plan.expiresAt,
    method: plan.method,
    endpoint: plan.endpoint,
    params: plan.params,
  };
  return [
    "Approve exactly this Bybit Testnet write:",
    canonicalize(printablePlan),
    `probe-plan-sha256: ${digest}`,
    "Retype the complete digest to approve",
  ].join("\n");
}

function refused(
  reason: ApprovalRefusalReason,
  message: string,
): ProbeApproval {
  return { kind: "refused", reason, message };
}

export async function approveProbePlan(
  plan: ProbePlan,
  options: ApprovalOptions = {},
): Promise<ProbeApproval> {
  const clock = options.clock ?? Date.now;
  const output = options.output ?? process.stdout;
  const digest = hashProbePlan(plan);
  const ttlMs = options.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_APPROVAL_ATTEMPTS;
  const approvedAt = clock();
  if (isProbePlanExpired(plan, approvedAt)) {
    return refused("expired", "The probe plan has already expired.");
  }
  if (!Number.isInteger(ttlMs) || ttlMs < 1) {
    return refused("prompt-failed", "The approval TTL is invalid.");
  }
  const approvalExpiresAt = Math.min(plan.expiresAt, approvedAt + ttlMs);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    return refused("prompt-failed", "The approval attempt budget is invalid.");
  }

  const input = options.input ?? process.stdin;
  if (options.prompt === undefined && input.isTTY !== true) {
    return refused(
      "non-tty",
      "Interactive exact-digest approval requires a terminal.",
    );
  }

  output.write(`${approvalBlock(plan, digest)}\n`);
  const prompt =
    options.prompt ??
    ((label: string) =>
      promptVisible(
        label,
        "Interactive exact-digest approval requires a terminal.",
        {
          timeoutMs: Math.min(ttlMs, DEFAULT_APPROVAL_TTL_MS),
          input,
          output: output as unknown as NodeJS.WritableStream,
        },
      ));

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const currentNow = clock();
    if (
      isProbePlanExpired(plan, currentNow) ||
      currentNow >= approvalExpiresAt
    ) {
      return refused(
        "expired",
        "The probe plan expired before approval completed.",
      );
    }
    let answer: string;
    try {
      answer = await prompt(
        `Retype probe-plan digest (${attempt + 1}/${maxAttempts})`,
      );
    } catch (error) {
      if (error instanceof PromptInterruptedError) {
        return refused(error.reason, error.message);
      }
      if (error instanceof Error && /terminal|tty/i.test(error.message)) {
        return refused(
          "non-tty",
          "Interactive exact-digest approval requires a terminal.",
        );
      }
      return refused(
        "prompt-failed",
        "The approval prompt could not be completed.",
      );
    }
    const normalizedAnswer = answer.trim().toLowerCase();
    if (!normalizedAnswer) {
      return refused("empty-input", "An empty digest is not approval.");
    }
    if (normalizedAnswer === digest) {
      const finalApprovedAt = clock();
      if (
        isProbePlanExpired(plan, finalApprovedAt) ||
        finalApprovedAt >= approvalExpiresAt
      ) {
        return refused(
          "expired",
          "The probe plan expired before approval completed.",
        );
      }
      return {
        kind: "approved",
        plan,
        digest,
        approvedAt: finalApprovedAt,
        expiresAt: approvalExpiresAt,
      };
    }
    if (attempt + 1 < maxAttempts) {
      output.write("The digest did not match; no write was dispatched.\n");
    }
  }
  return refused(
    "digest-mismatch",
    "The exact probe-plan digest was not approved.",
  );
}

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
