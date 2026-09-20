import {
  requireCapability,
  parseCapabilityScope,
  type CapabilityRequirement,
  type CapabilityObservation,
} from "../capabilities/capability.js";
import { isProducedCapabilityObservation } from "../capabilities/capability-proof.js";
import {
  createEvidenceRef,
  isEvidenceFresh,
  requireFreshEvidence,
  type EvidenceRef,
} from "../evidence/evidence-ref.js";
import {
  hashPlanCandidate,
  type PlanCandidate,
} from "../planning/execution-plan.js";
import { markRiskDecision } from "./risk-proof.js";
import {
  floorToStep,
  isDecimalValue,
  type DecimalValue,
} from "../shared/decimal.js";
import {
  domainError,
  domainErrorCodes,
  type DomainErrorCode,
} from "../shared/errors.js";
import { parseUtcTimestamp, type Clock } from "../shared/time.js";
import { fail, ok, type Result } from "../shared/result.js";
import {
  isRecord,
  requireHash,
  requireIdentifier,
  requireSafeText,
} from "../shared/validation.js";
import type { PlanHash } from "../identity/canonical-serialization.js";
import {
  isProducedAccountSnapshot,
  isProducedMarketSnapshot,
} from "../market/snapshot-proof.js";

export type RiskDecisionStatus = "pass" | "blocked";

export interface RiskDecision {
  readonly decisionId: string;
  readonly inputHash: PlanHash;
  readonly intentIds: readonly string[];
  readonly status: RiskDecisionStatus;
  readonly reasonCodes: readonly DomainErrorCode[];
  readonly asOf: ReturnType<Clock["now"]>;
  readonly evidence: readonly EvidenceRef[];
  readonly requiredCapabilities: readonly CapabilityRequirement[];
}

export interface RiskEvaluationInput {
  readonly decisionId: string;
  readonly candidate: PlanCandidate;
  readonly capabilities: readonly CapabilityObservation[];
  readonly clock: Clock;
}

function sameEvidence(left: EvidenceRef, right: EvidenceRef): boolean {
  return (
    left.kind === right.kind &&
    left.schemaVersion === right.schemaVersion &&
    left.producer === right.producer &&
    left.sourceId === right.sourceId &&
    left.asOf === right.asOf &&
    left.validForMs === right.validForMs &&
    left.contentHash === right.contentHash
  );
}

function sameScope(
  left: CapabilityRequirement["scope"],
  right: CapabilityRequirement["scope"],
): boolean {
  return (
    left.exchange === right.exchange &&
    left.environment === right.environment &&
    left.category === right.category &&
    left.positionMode === right.positionMode
  );
}

function sameSnapshotScope(
  snapshot: PlanCandidate["marketSnapshot"] | PlanCandidate["accountSnapshot"],
  executionScope: PlanCandidate["executionScope"],
): boolean {
  return (
    snapshot.scope.exchange === executionScope.exchange &&
    snapshot.scope.environment === executionScope.environment &&
    snapshot.scope.category === executionScope.category &&
    snapshot.scope.positionMode === executionScope.positionMode
  );
}

function hasCapabilityRequirement(
  requirements: readonly CapabilityRequirement[],
  capability: string,
  scope: CapabilityRequirement["scope"],
): boolean {
  return requirements.some(
    (requirement) =>
      requirement.capability === capability &&
      sameScope(requirement.scope, scope),
  );
}

function isValidProtection(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  const stopLoss = value.stopLoss;
  const takeProfit = value.takeProfit;
  if (stopLoss === undefined && takeProfit === undefined) return false;
  return (
    (stopLoss === undefined ||
      (isDecimalValue(stopLoss) && stopLoss.isPositive())) &&
    (takeProfit === undefined ||
      (isDecimalValue(takeProfit) && takeProfit.isPositive()))
  );
}

export function evaluateRisk(input: RiskEvaluationInput): Result<RiskDecision> {
  const decisionId = requireIdentifier(input.decisionId, "decisionId");
  if (!decisionId.ok) return decisionId;
  const candidateHash = hashPlanCandidate(input.candidate);
  if (!candidateHash.ok) return candidateHash;
  const reasonCodes: DomainErrorCode[] = [];
  const intentIds = input.candidate.orderIntents.flatMap((intent) =>
    isRecord(intent) && typeof intent.intentId === "string"
      ? [intent.intentId]
      : [],
  );
  const snapshotEvidence = [
    ...input.candidate.marketSnapshot.evidence,
    ...input.candidate.accountSnapshot.evidence,
  ];
  if (
    !isProducedMarketSnapshot(input.candidate.marketSnapshot) ||
    !isProducedAccountSnapshot(input.candidate.accountSnapshot) ||
    input.candidate.marketSnapshot.evidence.length === 0 ||
    input.candidate.accountSnapshot.evidence.length === 0
  ) {
    reasonCodes.push("INVALID_EVIDENCE");
  }
  const maxOrderNotional = input.candidate.strategy.maxOrderNotional;
  const validMaxOrderNotional =
    isDecimalValue(maxOrderNotional) && maxOrderNotional.isPositive();
  if (!validMaxOrderNotional) reasonCodes.push("INVALID_PLAN");
  if (
    input.candidate.orderIntents.length === 0 ||
    intentIds.length !== input.candidate.orderIntents.length ||
    new Set(intentIds).size !== intentIds.length
  ) {
    reasonCodes.push("INVALID_PLAN");
  }
  if (
    input.candidate.orderIntents.length > 0 &&
    input.candidate.requiredCapabilities.length === 0
  ) {
    reasonCodes.push("CAPABILITY_UNKNOWN");
  }
  if (
    input.candidate.orderIntents.length > 0 &&
    !hasCapabilityRequirement(
      input.candidate.requiredCapabilities,
      "order-create",
      input.candidate.executionScope,
    )
  ) {
    reasonCodes.push("CAPABILITY_UNKNOWN");
  }
  if (
    input.candidate.orderIntents.some(
      (intent) => isRecord(intent) && intent.protection !== undefined,
    ) &&
    !hasCapabilityRequirement(
      input.candidate.requiredCapabilities,
      "attached-protection",
      input.candidate.executionScope,
    )
  ) {
    reasonCodes.push("CAPABILITY_UNKNOWN");
  }
  if (
    input.candidate.requiredCapabilities.some(
      (requirement) =>
        !sameScope(requirement.scope, input.candidate.executionScope),
    )
  ) {
    reasonCodes.push("CAPABILITY_UNKNOWN");
  }
  if (
    !sameSnapshotScope(
      input.candidate.marketSnapshot,
      input.candidate.executionScope,
    ) ||
    !sameSnapshotScope(
      input.candidate.accountSnapshot,
      input.candidate.executionScope,
    )
  ) {
    reasonCodes.push("INCOMPATIBLE_EVIDENCE");
  }
  const closeQuantities = new Map<string, DecimalValue>();
  for (const intent of input.candidate.orderIntents) {
    if (
      !isRecord(intent) ||
      intent.orderType !== "limit" ||
      (intent.side !== "buy" && intent.side !== "sell") ||
      (intent.positionEffect !== "open" && intent.positionEffect !== "close") ||
      !isRecord(intent.normalization)
    ) {
      reasonCodes.push("INVALID_PLAN");
      continue;
    }
    if (!isValidProtection(intent.protection)) {
      reasonCodes.push("PROTECTION_REQUIRED");
      continue;
    }
    if (
      !isDecimalValue(intent.price) ||
      !isDecimalValue(intent.quantity) ||
      !isDecimalValue(intent.notional) ||
      !intent.price.isPositive() ||
      !intent.quantity.isPositive()
    ) {
      reasonCodes.push("INVALID_PLAN");
      continue;
    }
    if (intent.positionEffect === "close" && intent.protection !== undefined) {
      reasonCodes.push("PROTECTION_REQUIRED");
      continue;
    }
    if (intent.positionEffect === "close") {
      const previousCloseQuantity = closeQuantities.get(intent.instrument);
      const totalCloseQuantity =
        previousCloseQuantity === undefined
          ? intent.quantity
          : previousCloseQuantity.add(intent.quantity);
      closeQuantities.set(intent.instrument, totalCloseQuantity);
      const positionSide = intent.side === "sell" ? "long" : "short";
      const positionQuantity = input.candidate.accountSnapshot.positions
        .filter(
          (position) =>
            position.instrument === intent.instrument &&
            position.side === positionSide,
        )
        .reduce(
          (total, position) => total.add(position.quantity),
          intent.quantity.subtract(intent.quantity),
        );
      if (
        positionQuantity.isZero() ||
        totalCloseQuantity.compare(positionQuantity) > 0
      ) {
        reasonCodes.push("CONSTRAINT_VIOLATION");
      }
    }
    if (
      input.candidate.strategy.requiresProtection &&
      intent.positionEffect === "open" &&
      (intent.protection === undefined ||
        (intent.protection.stopLoss === undefined &&
          intent.protection.takeProfit === undefined))
    ) {
      reasonCodes.push("PROTECTION_REQUIRED");
    }
    if (
      intent.instrument !== input.candidate.marketSnapshot.instrument ||
      intent.normalization.constraintVersion !==
        input.candidate.marketSnapshot.constraints.version
    ) {
      reasonCodes.push("CONSTRAINT_VIOLATION");
    }
    const computedNotional = intent.price.multiply(intent.quantity);
    if (computedNotional.compare(intent.notional) !== 0) {
      reasonCodes.push("CONSTRAINT_VIOLATION");
    }
    if (
      validMaxOrderNotional &&
      computedNotional.compare(maxOrderNotional) > 0
    ) {
      reasonCodes.push("CONSTRAINT_VIOLATION");
    }
    const normalizedPrice = floorToStep(
      intent.price,
      input.candidate.marketSnapshot.constraints.priceTickSize,
    );
    const normalizedQuantity = floorToStep(
      intent.quantity,
      input.candidate.marketSnapshot.constraints.quantityStep,
    );
    if (
      !normalizedPrice.ok ||
      normalizedPrice.value.compare(intent.price) !== 0 ||
      !normalizedQuantity.ok ||
      normalizedQuantity.value.compare(intent.quantity) !== 0
    ) {
      reasonCodes.push("CONSTRAINT_VIOLATION");
    }
    if (intent.protection !== undefined) {
      for (const protectionPrice of [
        intent.protection.stopLoss,
        intent.protection.takeProfit,
      ]) {
        if (protectionPrice === undefined) continue;
        const normalizedProtection = floorToStep(
          protectionPrice,
          input.candidate.marketSnapshot.constraints.priceTickSize,
        );
        if (
          !normalizedProtection.ok ||
          normalizedProtection.value.compare(protectionPrice) !== 0
        ) {
          reasonCodes.push("CONSTRAINT_VIOLATION");
        }
      }
    }
    if (
      intent.quantity.compare(
        input.candidate.marketSnapshot.constraints.minQuantity,
      ) < 0
    ) {
      reasonCodes.push("QUANTITY_TOO_SMALL");
    }
    const minNotional = input.candidate.marketSnapshot.constraints.minNotional;
    if (
      minNotional !== undefined &&
      computedNotional.compare(minNotional) < 0
    ) {
      reasonCodes.push("NOTIONAL_TOO_SMALL");
    }
    if (intent.positionEffect === "open" && intent.protection !== undefined) {
      const stopOnWrongSide =
        intent.protection.stopLoss !== undefined &&
        (intent.side === "buy"
          ? intent.protection.stopLoss.compare(intent.price) >= 0
          : intent.protection.stopLoss.compare(intent.price) <= 0);
      const targetOnWrongSide =
        intent.protection.takeProfit !== undefined &&
        (intent.side === "buy"
          ? intent.protection.takeProfit.compare(intent.price) <= 0
          : intent.protection.takeProfit.compare(intent.price) >= 0);
      if (stopOnWrongSide || targetOnWrongSide) {
        reasonCodes.push("PROTECTION_REQUIRED");
      }
    }
  }
  if (input.candidate.evidence.length === 0) {
    reasonCodes.push("INVALID_EVIDENCE");
  } else {
    const fresh = requireFreshEvidence(
      [...input.candidate.evidence, ...snapshotEvidence],
      input.clock,
    );
    if (!fresh.ok) reasonCodes.push("STALE_EVIDENCE");
  }
  if (
    snapshotEvidence.some(
      (snapshotItem) =>
        !input.candidate.evidence.some((item) =>
          sameEvidence(item, snapshotItem),
        ),
    )
  ) {
    reasonCodes.push("INCOMPATIBLE_EVIDENCE");
  }
  for (const requirement of input.candidate.requiredCapabilities) {
    const observations = input.capabilities.filter(
      (item) =>
        isProducedCapabilityObservation(item) &&
        item.capability === requirement.capability &&
        item.scope.exchange === requirement.scope.exchange &&
        item.scope.environment === requirement.scope.environment &&
        item.scope.category === requirement.scope.category &&
        item.scope.positionMode === requirement.scope.positionMode,
    );
    if (observations.length === 0) {
      reasonCodes.push("CAPABILITY_UNKNOWN");
      continue;
    }
    for (const observation of observations) {
      if (
        !input.candidate.evidence.some((item) =>
          sameEvidence(item, observation.evidence),
        )
      ) {
        reasonCodes.push("INCOMPATIBLE_EVIDENCE");
      }
      if (!isEvidenceFresh(observation.evidence, input.clock)) {
        reasonCodes.push("STALE_EVIDENCE");
      }
      const gate = requireCapability(observation, requirement);
      if (!gate.ok) {
        reasonCodes.push(gate.error.code);
      }
    }
  }
  const uniqueReasons = [...new Set(reasonCodes)];
  const decision = Object.freeze({
    decisionId: decisionId.value,
    inputHash: candidateHash.value as PlanHash,
    intentIds: Object.freeze([...intentIds]),
    status: uniqueReasons.length === 0 ? "pass" : "blocked",
    reasonCodes: Object.freeze(uniqueReasons),
    asOf: input.clock.now(),
    evidence: Object.freeze([...input.candidate.evidence]),
    requiredCapabilities: Object.freeze([
      ...input.candidate.requiredCapabilities,
    ]),
  });
  return ok(markRiskDecision(decision));
}

export function createBlockedRiskDecision(
  decisionId: string,
  intentId: string,
  inputHash: string,
  reasonCode: DomainErrorCode,
  clock: Clock,
): Result<RiskDecision> {
  const parsed = requireIdentifier(decisionId, "decisionId");
  if (!parsed.ok) return parsed;
  const parsedHash = requireHash(inputHash, "inputHash");
  if (!parsedHash.ok) return parsedHash;
  const parsedIntent = requireIdentifier(intentId, "intentId");
  if (!parsedIntent.ok) return parsedIntent;
  const decision = Object.freeze({
    decisionId: parsed.value,
    inputHash: parsedHash.value as PlanHash,
    intentIds: Object.freeze([parsedIntent.value]),
    status: "blocked" as const,
    reasonCodes: Object.freeze([reasonCode]),
    asOf: clock.now(),
    evidence: Object.freeze([]),
    requiredCapabilities: Object.freeze([]),
  });
  return ok(markRiskDecision(decision));
}

export function rehydrateRiskDecision(input: unknown): Result<RiskDecision> {
  if (!isRecord(input)) {
    return fail(
      domainError("INVALID_VALUE", "risk decision must be an object"),
    );
  }
  const decisionId = requireIdentifier(input.decisionId, "decisionId");
  const inputHash = requireHash(input.inputHash, "inputHash");
  const asOf = parseUtcTimestamp(input.asOf);
  if (
    !decisionId.ok ||
    !inputHash.ok ||
    !asOf.ok ||
    (input.status !== "pass" && input.status !== "blocked") ||
    !Array.isArray(input.intentIds) ||
    !input.intentIds.every(
      (intentId) => requireIdentifier(intentId, "intentId").ok,
    ) ||
    !Array.isArray(input.reasonCodes) ||
    !Array.isArray(input.evidence) ||
    !Array.isArray(input.requiredCapabilities)
  ) {
    return fail(
      domainError("INVALID_VALUE", "risk decision contains an invalid field"),
    );
  }
  const reasonCodes: DomainErrorCode[] = [];
  for (const reasonCode of input.reasonCodes) {
    if (
      typeof reasonCode !== "string" ||
      !Object.values(domainErrorCodes).includes(reasonCode as DomainErrorCode)
    ) {
      return fail(
        domainError("INVALID_VALUE", "risk decision reason code is invalid"),
      );
    }
    reasonCodes.push(reasonCode as DomainErrorCode);
  }
  const evidence: EvidenceRef[] = [];
  for (const item of input.evidence) {
    const parsed = createEvidenceRef(item);
    if (!parsed.ok) return parsed;
    evidence.push(parsed.value);
  }
  const requiredCapabilities: CapabilityRequirement[] = [];
  for (const item of input.requiredCapabilities) {
    if (!isRecord(item)) {
      return fail(
        domainError("INVALID_CAPABILITY", "capability requirement is invalid"),
      );
    }
    const capability = requireSafeText(item.capability, "capability");
    const scope = parseCapabilityScope(item.scope);
    if (!capability.ok) return capability;
    if (!scope.ok) return scope;
    requiredCapabilities.push({
      capability: capability.value,
      scope: scope.value,
    });
  }
  return ok(
    markRiskDecision(
      Object.freeze({
        decisionId: decisionId.value,
        inputHash: inputHash.value as PlanHash,
        intentIds: Object.freeze([...input.intentIds] as string[]),
        status: input.status,
        reasonCodes: Object.freeze(reasonCodes),
        asOf: asOf.value,
        evidence: Object.freeze(evidence),
        requiredCapabilities: Object.freeze(requiredCapabilities),
      }),
    ),
  );
}
