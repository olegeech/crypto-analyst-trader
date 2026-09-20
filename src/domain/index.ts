export {
  DecimalValue,
  RoundingMode,
  ceilToStep,
  floorToStep,
  isDecimalValue,
  parseDecimal,
} from "./shared/decimal.js";
export {
  domainError,
  domainErrorCodes,
  type DomainError,
  type DomainErrorCode,
} from "./shared/errors.js";
export { fail, mapResult, ok, type Result } from "./shared/result.js";
export {
  fixedClock,
  isAtOrAfter,
  parseUtcTimestamp,
  systemClock,
  type Clock,
  type UtcTimestamp,
} from "./shared/time.js";
export {
  canonicalSerialize,
  hashCanonical,
  CANONICAL_SERIALIZATION_VERSION,
  type PlanHash,
} from "./identity/plan-hash.js";
export {
  createEvidenceRef,
  evidenceExpiresAt,
  isEvidenceFresh,
  parseEvidenceList,
  requireCompatibleEvidence,
  requireFreshEvidence,
  type EvidenceCompatibility,
  type EvidenceKind,
  type EvidenceRef,
} from "./evidence/evidence-ref.js";
export {
  capabilityStatus,
  createCapabilityObservation,
  requireCapability,
  type CapabilityObservation,
  type CapabilityRequirement,
  type CapabilityScope,
  type CapabilityStatus,
} from "./capabilities/capability.js";
export {
  createAccountSnapshot,
  createMarketSnapshot,
  type AccountSnapshot,
  type MarketSnapshot,
  type SnapshotScope,
  type OwnedOrderSnapshot,
  type PositionSnapshot,
  type PositionSide,
} from "./market/snapshots.js";
export {
  createInstrumentConstraints,
  type InstrumentConstraints,
} from "./market/instrument-constraints.js";
export {
  createStrategyConfig,
  type StrategyConfig,
} from "./market/strategy-config.js";
export {
  createOrderIntent,
  type OrderIntent,
  type OrderSide,
  type PositionEffect,
  type ProtectionIntent,
  type RoundingDirection,
} from "./planning/order-intent.js";
export { normalizeOrderIntent } from "./planning/normalize-order-intent.js";
export {
  createExecutionPlan,
  canonicalMaterial,
  hashPlanCandidate,
  type ExecutionPlan,
  type ExecutionPlanInput,
  type PlanMaterial,
  type PlanCandidate,
  type PlanPresentation,
} from "./planning/execution-plan.js";
export {
  createBlockedRiskDecision,
  evaluateRisk,
  type RiskDecision,
  type RiskDecisionStatus,
  type RiskEvaluationInput,
} from "./risk/risk-decision.js";
export {
  createApproval,
  validateApproval,
  type Approval,
} from "./execution/approval.js";
export {
  createLifecycleState,
  transitionLifecycle,
  type LifecyclePlan,
  type LifecycleState,
  type LifecycleStateName,
  type LifecycleTransition,
} from "./execution/lifecycle.js";
export {
  createExecutionAttempt,
  type AttemptAcknowledgement,
  type AttemptTerminalStatus,
  type ExecutionAttempt,
} from "./execution/execution-attempt.js";
export {
  createExchangeOrder,
  type ExchangeOrderObservation,
  type ExchangeOrderStatus,
} from "./execution/exchange-order.js";
export {
  reconcileAttempt,
  type ReconciliationPlan,
  type ReconciliationResult,
  type ReconciliationStatus,
} from "./execution/reconciliation.js";
export { createFill, type Fill } from "./accounting/fill.js";
export { createFee, type Fee, type FeeKind } from "./accounting/fee.js";
export { createFunding, type Funding } from "./accounting/funding.js";
export {
  createLedgerEntry,
  type LedgerEntry,
  type LedgerEventKind,
} from "./accounting/ledger-entry.js";
