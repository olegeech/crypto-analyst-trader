import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";
import { isRecord, requireIdentifier } from "../shared/validation.js";
import {
  ANALYTICS_REASON_CODE_ORDER,
  normalizeAnalyticsReasonCodes,
  type AnalyticsReasonCode,
} from "./analytics-diagnostics.js";
import type { AnalyticsInputIdentity } from "./analytics-inputs.js";
import type {
  AnalyticsProfile,
  ExternalEvidenceFamily,
} from "./analytics-profile.js";

export type AnalyticsSufficiencyStatus =
  "complete" | "partial" | "insufficient";

export type AnalyticsOutputStatus = "complete" | "partial" | "unavailable";

export interface AnalyticsOutputOutcome {
  readonly requestId: string;
  readonly status: AnalyticsOutputStatus;
  readonly reasonCodes: readonly AnalyticsReasonCode[];
}

export interface AnalyticsSufficiency {
  readonly status: AnalyticsSufficiencyStatus;
  readonly reasonCodes: readonly AnalyticsReasonCode[];
}

interface RequiredOutput {
  readonly requestId: string;
  readonly required: boolean;
  readonly missingReason: AnalyticsReasonCode;
}

function invalid(message: string, field?: string): Result<never> {
  return fail(
    domainError(
      "INVALID_VALUE",
      message,
      field === undefined ? undefined : { field },
    ),
  );
}

function externalRequestId(family: ExternalEvidenceFamily): string {
  return `external:${family}`;
}

function validReasonCode(value: unknown): value is AnalyticsReasonCode {
  return (
    typeof value === "string" &&
    ANALYTICS_REASON_CODE_ORDER.some((code) => code === value)
  );
}

function outputRequests(profile: AnalyticsProfile): RequiredOutput[] {
  return [
    ...profile.features.map((feature) => ({
      requestId: feature.id,
      required: feature.required,
      missingReason:
        feature.kind === "liquidation-window"
          ? ("MISSING_LIQUIDATION_EVIDENCE" as const)
          : ("INSUFFICIENT_WINDOW" as const),
    })),
    ...profile.externalEvidence.map((external) => ({
      requestId: externalRequestId(external.family),
      required: external.required,
      missingReason: "MISSING_EXTERNAL_EVIDENCE" as const,
    })),
  ];
}

export function reduceAnalyticsSufficiency(
  profile: AnalyticsProfile,
  outcomes: readonly AnalyticsOutputOutcome[],
  inputIdentity?: AnalyticsInputIdentity,
): Result<AnalyticsSufficiency> {
  const requests = outputRequests(profile);
  const requestById = new Map(requests.map((item) => [item.requestId, item]));
  const outcomeById = new Map<string, AnalyticsOutputOutcome>();
  const reasonCodes: AnalyticsReasonCode[] = [];

  if (!Array.isArray(outcomes))
    return invalid("analytics outcomes must be an array");
  for (const outcome of outcomes) {
    if (!isRecord(outcome))
      return invalid("analytics outcome must be an object");
    const requestId = requireIdentifier(outcome.requestId, "requestId");
    if (
      !requestId.ok ||
      !requestById.has(requestId.value) ||
      (outcome.status !== "complete" &&
        outcome.status !== "partial" &&
        outcome.status !== "unavailable") ||
      !Array.isArray(outcome.reasonCodes) ||
      outcome.reasonCodes.some((code) => !validReasonCode(code))
    ) {
      return invalid("analytics outcome is invalid");
    }
    if (outcomeById.has(requestId.value)) {
      return invalid(
        "analytics outcomes contain a duplicate request id",
        "requestId",
      );
    }
    const parsedOutcome = outcome as unknown as AnalyticsOutputOutcome;
    outcomeById.set(requestId.value, parsedOutcome);
    reasonCodes.push(...parsedOutcome.reasonCodes);
  }

  for (const request of requests) {
    const outcome = outcomeById.get(request.requestId);
    if (outcome === undefined) {
      reasonCodes.push(request.missingReason);
    }
  }
  if (inputIdentity?.compatibility === "incompatible") {
    reasonCodes.push("INPUT_IDENTITY_MISMATCH");
  }

  const requiredRequests = requests.filter((request) => request.required);
  const allRequiredComplete = requiredRequests.every(
    (request) => outcomeById.get(request.requestId)?.status === "complete",
  );
  const anyRequiredDefensible = requiredRequests.some((request) => {
    const status = outcomeById.get(request.requestId)?.status;
    return status === "complete" || status === "partial";
  });
  const hasIdentityConflict = inputIdentity?.compatibility === "incompatible";
  const status: AnalyticsSufficiencyStatus = hasIdentityConflict
    ? "insufficient"
    : allRequiredComplete
      ? "complete"
      : anyRequiredDefensible
        ? "partial"
        : "insufficient";

  return ok(
    Object.freeze({
      status,
      reasonCodes: normalizeAnalyticsReasonCodes(reasonCodes),
    }),
  );
}
