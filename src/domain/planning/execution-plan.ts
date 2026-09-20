import {
  CANONICAL_SERIALIZATION_VERSION,
  canonicalSerialize,
  hashCanonical,
  type PlanHash,
} from "../identity/canonical-serialization.js";
import type { EvidenceRef } from "../evidence/evidence-ref.js";
import type { AccountSnapshot, MarketSnapshot } from "../market/snapshots.js";
import type { StrategyConfig } from "../market/strategy-config.js";
import type { OrderIntent } from "./order-intent.js";
import type { RiskDecision } from "../risk/risk-decision.js";
import { isProducedRiskDecision } from "../risk/risk-proof.js";
import type {
  CapabilityRequirement,
  CapabilityScope,
} from "../capabilities/capability.js";
import { isDecimalValue } from "../shared/decimal.js";
import { domainError } from "../shared/errors.js";
import { parseUtcTimestamp, type UtcTimestamp } from "../shared/time.js";
import { fail, ok, type Result } from "../shared/result.js";
import {
  isRecord,
  requireIdentifier,
  requireSafeText,
} from "../shared/validation.js";
import { markExecutionPlan } from "./plan-proof.js";

export interface PlanCandidate {
  readonly strategy: StrategyConfig;
  readonly marketSnapshot: MarketSnapshot;
  readonly accountSnapshot: AccountSnapshot;
  readonly evidence: readonly EvidenceRef[];
  readonly desiredCurrentDiff: Readonly<Record<string, unknown>>;
  readonly orderIntents: readonly OrderIntent[];
  readonly requiredCapabilities: readonly CapabilityRequirement[];
  readonly executionScope: CapabilityScope;
}

export interface PlanMaterial extends PlanCandidate {
  readonly riskDecision: RiskDecision;
}

export interface PlanPresentation {
  readonly generatedAt: UtcTimestamp;
  readonly comment?: string;
}

export interface ExecutionPlan {
  readonly planId: string;
  readonly identityVersion: string;
  readonly materialHash: PlanHash;
  readonly material: PlanMaterial;
  readonly presentation?: PlanPresentation;
}

export interface ExecutionPlanInput {
  readonly identityVersion: string;
  readonly material: PlanMaterial;
  readonly presentation?: {
    readonly generatedAt: unknown;
    readonly comment?: unknown;
  };
}

type MaterialIdentity = Omit<PlanMaterial, "riskDecision"> & {
  readonly riskDecision: Omit<RiskDecision, "decisionId" | "asOf">;
  readonly canonicalSerializationVersion: string;
  readonly identityVersion: string;
};

function hasAccessorProperty(value: object): boolean {
  return Object.values(Object.getOwnPropertyDescriptors(value)).some(
    (descriptor) => !("value" in descriptor),
  );
}

export function hashPlanCandidate(candidate: PlanCandidate): Result<PlanHash> {
  return hashCanonical({
    canonicalSerializationVersion: CANONICAL_SERIALIZATION_VERSION,
    candidate,
  });
}

function materialProjection(
  identityVersion: string,
  material: PlanMaterial,
): MaterialIdentity {
  const riskIdentity: MaterialIdentity["riskDecision"] = {
    inputHash: material.riskDecision.inputHash,
    intentIds: material.riskDecision.intentIds,
    status: material.riskDecision.status,
    reasonCodes: material.riskDecision.reasonCodes,
    evidence: material.riskDecision.evidence,
    requiredCapabilities: material.riskDecision.requiredCapabilities,
  };
  return {
    ...material,
    riskDecision: riskIdentity,
    canonicalSerializationVersion: CANONICAL_SERIALIZATION_VERSION,
    identityVersion,
  };
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (
    typeof value !== "object" ||
    value === null ||
    isDecimalValue(value) ||
    seen.has(value)
  )
    return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  Object.freeze(value);
  return value;
}

export function createExecutionPlan(
  input: ExecutionPlanInput,
): Result<ExecutionPlan> {
  const identityVersion = requireSafeText(
    input.identityVersion,
    "identityVersion",
  );
  if (!identityVersion.ok) return identityVersion;
  if (
    !isRecord(input.material) ||
    !Array.isArray(input.material.evidence) ||
    !Array.isArray(input.material.orderIntents) ||
    !input.material.orderIntents.every((intent) => isRecord(intent)) ||
    !isRecord(input.material.desiredCurrentDiff)
  ) {
    return fail(domainError("INVALID_PLAN", "plan material is incomplete"));
  }
  if (hasAccessorProperty(input.material)) {
    return fail(
      domainError(
        "INVALID_PLAN",
        "plan material cannot contain accessor properties",
      ),
    );
  }
  const material = { ...input.material };
  if (
    !isRecord(material.riskDecision) ||
    !Array.isArray(material.riskDecision.intentIds) ||
    !material.riskDecision.intentIds.every(
      (intentId) => typeof intentId === "string",
    )
  ) {
    return fail(domainError("INVALID_PLAN", "risk decision is required"));
  }
  if (!isProducedRiskDecision(material.riskDecision)) {
    return fail(
      domainError(
        "INVALID_PLAN",
        "risk decision must be produced by domain risk evaluation",
      ),
    );
  }
  const candidateIntentIds: string[] = [];
  for (const intent of material.orderIntents) {
    const intentId = requireIdentifier(intent.intentId, "intentId");
    if (!intentId.ok) {
      return fail(
        domainError("INVALID_PLAN", "order intent identity is invalid"),
      );
    }
    candidateIntentIds.push(intentId.value);
  }
  const { riskDecision, ...candidate } = material;
  const candidateHash = hashPlanCandidate(candidate);
  if (!candidateHash.ok) return candidateHash;
  if (riskDecision.inputHash !== candidateHash.value) {
    return fail(
      domainError(
        "PLAN_HASH_MISMATCH",
        "risk decision does not bind the plan candidate",
      ),
    );
  }
  if (riskDecision.status !== "pass") {
    return fail(
      domainError(
        "CONSTRAINT_VIOLATION",
        "a blocked risk decision cannot create an executable plan",
      ),
    );
  }
  if (
    riskDecision.intentIds.length !== candidateIntentIds.length ||
    new Set(riskDecision.intentIds).size !== riskDecision.intentIds.length ||
    new Set(candidateIntentIds).size !== candidateIntentIds.length ||
    riskDecision.intentIds.some(
      (intentId) => !candidateIntentIds.includes(intentId),
    ) ||
    candidateIntentIds.some(
      (intentId) => !riskDecision.intentIds.includes(intentId),
    )
  ) {
    return fail(
      domainError(
        "INVALID_PLAN",
        "risk decision does not cover every order intent in the candidate",
      ),
    );
  }
  const materialHash = hashCanonical(
    materialProjection(identityVersion.value, material),
  );
  if (!materialHash.ok) return materialHash;
  const presentation = input.presentation;
  let parsedPresentation:
    { generatedAt: UtcTimestamp; comment?: string } | undefined;
  if (presentation !== undefined) {
    const generatedAt = parseUtcTimestamp(presentation.generatedAt);
    if (!generatedAt.ok) return generatedAt;
    parsedPresentation = { generatedAt: generatedAt.value };
    if (presentation.comment !== undefined) {
      const comment = requireSafeText(presentation.comment, "comment");
      if (!comment.ok) return comment;
      parsedPresentation.comment = comment.value;
    }
  }
  const plan: {
    planId: string;
    identityVersion: string;
    materialHash: PlanHash;
    material: PlanMaterial;
    presentation?: PlanPresentation;
  } = {
    planId: `plan-${materialHash.value.slice(7, 23)}`,
    identityVersion: identityVersion.value,
    materialHash: materialHash.value,
    material,
  };
  if (parsedPresentation !== undefined) plan.presentation = parsedPresentation;
  return ok(markExecutionPlan(deepFreeze(plan)));
}

export function canonicalMaterial(plan: ExecutionPlan): Result<string> {
  return canonicalSerialize(
    materialProjection(plan.identityVersion, plan.material),
  );
}
