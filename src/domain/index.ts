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
  ARTIFACT_SCHEMA_VERSION,
  decodeCanonicalArtifact,
  encodeCanonicalArtifact,
  rehydrateArtifact,
  type ArtifactKind,
  type CanonicalArtifactEnvelope,
  type RehydratedArtifact,
} from "./identity/canonical-artifact.js";
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
  createAdapterCapabilityObservation,
  createCapabilityObservation,
  requireCapability,
  requireTrustedCapability,
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
  MARKET_EVIDENCE_PRODUCER,
  MARKET_EVIDENCE_SCHEMA_VERSION,
  MARKET_EVIDENCE_SYMBOLS,
  MARKET_EVIDENCE_UNIVERSE_VERSION,
  createMarketEvidenceBundle,
  isCompleteMarketEvidenceBundle,
  type FundingObservation,
  type MarketEvidenceBundle,
  type MarketEvidenceDiagnostic,
  type MarketEvidenceSource,
  type MarketEvidenceStatus,
  type MarketEvidenceSymbol,
  type MarketInstrumentEvidence,
  type MarketInstrumentStatus,
  type MarketSeriesInterval,
  type MarketSymbolEvidence,
  type MarketTickerEvidence,
  type OhlcvObservation,
  type OhlcvSeries,
  type OpenInterestInterval,
  type OpenInterestObservation,
  type OpenInterestSeries,
} from "./market/market-evidence-bundle.js";
export {
  createMarketEvidenceDiagnostic,
  parseMarketEvidenceDiagnostics,
  type MarketEvidenceBudgetState,
  type MarketEvidenceDiagnosticCode,
} from "./market/market-evidence-diagnostics.js";
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
  rehydrateRiskDecision,
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
  CLEARANCE_EVIDENCE_VERSION,
  createClearanceEvidence,
  type ClearanceEvidence,
} from "./execution/clearance-evidence.js";
export {
  createLifecycleState,
  rehydrateLifecycleState,
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
  createIdentityBinding,
  createIdentityBindingCandidate,
  identityBindingCandidateFromBinding,
  identityBindingCandidateKey,
  identityBindingCandidatesEqual,
  isProducedIdentityBinding,
  type IdentityBinding,
  type IdentityBindingCandidate,
  type IdentityBindingCandidateInput,
  type IdentityBindingOwnershipContext,
} from "./execution/identity-binding.js";
export {
  createExchangeOrder,
  type ExchangeOrderObservation,
  type ExchangeOrderStatus,
} from "./execution/exchange-order.js";
export {
  reconcileAttempt,
  rehydrateReconciliationResult,
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
