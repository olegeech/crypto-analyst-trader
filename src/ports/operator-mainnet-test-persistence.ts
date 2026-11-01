import type {
  OperatorMainnetTestApproval,
  OperatorMainnetTestPlan,
} from "../domain/execution/operator-mainnet-test-plan.js";
import type {
  OperatorMainnetTradeCommandBinding,
  OperatorMainnetTradeCommandPlan,
  OperatorMainnetTradeCommandReceipt,
} from "../domain/execution/operator-mainnet-trade-command.js";
import type {
  OperatorMainnetRecoveryAttestation,
  OperatorMainnetRecoveryGrant,
} from "../domain/execution/operator-mainnet-recovery.js";
import type { PlanHash } from "../domain/identity/canonical-serialization.js";
import type { Result } from "../domain/shared/result.js";
import type { UtcTimestamp } from "../domain/shared/time.js";
import type { HaltState, PersistenceScope } from "./persistence.js";

export type OperatorMainnetTestAttemptOutcome =
  "accepted" | "rejected" | "ambiguous";

export type OperatorMainnetTestLifecycleOutcome =
  | "ENTRY_TP_PROVEN"
  | "TP_LIFECYCLE_PASS"
  | "NOT_EXERCISED"
  | "PARTIAL_EVIDENCE"
  | "UNKNOWN"
  | "MANUAL_CLEANUP";

export type OperatorMainnetTestCleanupStatus =
  "pending" | "verified-clean" | "unknown";

export type OperatorMainnetTestManualAction =
  "entry-remainder-cancelled" | "position-closed" | "other";

export interface OperatorMainnetTestSourceRecord {
  readonly sourceId: string;
  readonly scope: PersistenceScope;
  readonly planHash: PlanHash;
  readonly planArtifactId: string;
  readonly authorization: OperatorMainnetAuthorizationReference;
  readonly clientOrderId: string;
  readonly payloadJson: string;
  readonly payloadHash: PlanHash;
  readonly createdAt: UtcTimestamp;
}

/** Durable artifact reference; direct-command authority is never represented as an approval. */
export type OperatorMainnetAuthorizationReference =
  | {
      readonly kind: "approval";
      readonly hash: PlanHash;
      readonly artifactId: string;
    }
  | {
      readonly kind: "trade-command";
      readonly hash: PlanHash;
      readonly artifactId: string;
      readonly commandId: string;
      readonly receiptHash: PlanHash;
      readonly receiptArtifactId: string;
    };

export interface OperatorMainnetTestIntentRecord {
  readonly writeIntentId: string;
  readonly sourceId: string;
  readonly operation: "CREATE";
  readonly runId: string;
  readonly canonicalJson: string;
  readonly canonicalHash: PlanHash;
  readonly preparedAt: UtcTimestamp;
  readonly commandId?: string;
  readonly commandReceiptHash?: PlanHash;
  readonly commandBindingHash?: PlanHash;
}

export interface OperatorMainnetTestAttemptRecord {
  readonly attemptId: string;
  readonly writeIntentId: string;
  readonly outcome: OperatorMainnetTestAttemptOutcome;
  readonly exchangeOrderId?: string;
  readonly providerReasonCode?: string;
  readonly canonicalJson: string;
  readonly canonicalHash: PlanHash;
  readonly recordedAt: UtcTimestamp;
}

export interface OperatorMainnetTestReconciliationRecord {
  readonly reconciliationId: string;
  readonly sourceId: string;
  readonly revision: number;
  readonly lifecycleOutcome: OperatorMainnetTestLifecycleOutcome;
  readonly cleanupStatus: OperatorMainnetTestCleanupStatus;
  readonly canonicalJson: string;
  readonly canonicalHash: PlanHash;
  readonly observedAt: UtcTimestamp;
}

export interface OperatorMainnetTestManualActionRecord {
  readonly actionId: string;
  readonly sourceId: string;
  readonly revision: number;
  readonly action: OperatorMainnetTestManualAction;
  readonly canonicalJson: string;
  readonly canonicalHash: PlanHash;
  readonly declaredAt: UtcTimestamp;
}

export interface OperatorMainnetTestSourceDispositionRecord {
  readonly dispositionId: string;
  readonly sourceId: string;
  readonly revision: number;
  readonly disposition: "human-attested";
  readonly grantId: string;
  readonly nextSourceId: string;
  readonly nextWriteIntentId: string;
  readonly canonicalJson: string;
  readonly canonicalHash: PlanHash;
  readonly recordedAt: UtcTimestamp;
}

interface OperatorMainnetTestSnapshotBase {
  readonly source: OperatorMainnetTestSourceRecord;
  readonly plan: OperatorMainnetTestPlan;
  readonly intent: OperatorMainnetTestIntentRecord;
  readonly attempt?: OperatorMainnetTestAttemptRecord;
  readonly reconciliations: readonly OperatorMainnetTestReconciliationRecord[];
  readonly manualActions: readonly OperatorMainnetTestManualActionRecord[];
  readonly sourceDisposition?: OperatorMainnetTestSourceDispositionRecord;
  readonly halt: HaltState;
}

export type OperatorMainnetTestSnapshot =
  | (OperatorMainnetTestSnapshotBase & {
      readonly authorization: {
        readonly kind: "approval";
        readonly hash: PlanHash;
        readonly artifactId: string;
        readonly approval: OperatorMainnetTestApproval;
      };
    })
  | (OperatorMainnetTestSnapshotBase & {
      readonly authorization: {
        readonly kind: "trade-command";
        readonly hash: PlanHash;
        readonly artifactId: string;
        readonly commandId: string;
        readonly receiptHash: PlanHash;
        readonly receiptArtifactId: string;
        readonly receipt: OperatorMainnetTradeCommandReceipt;
        readonly binding: OperatorMainnetTradeCommandBinding;
      };
    });

interface PrepareOperatorMainnetTestCreateRequestBase {
  readonly runId: string;
  /** Exact UTF-8 bytes passed to the Bybit create transport. */
  readonly payloadJson: string;
  readonly payloadHash: PlanHash;
  readonly preparedAt: UtcTimestamp;
}

export type PrepareOperatorMainnetTestCreateRequest =
  | (PrepareOperatorMainnetTestCreateRequestBase & {
      readonly plan: OperatorMainnetTestPlan;
      readonly approval: OperatorMainnetTestApproval;
      readonly tradeCommand?: never;
      /** Optional source-bound one-plan recovery grant, consumed atomically with intent. */
      readonly recoveryGrantId?: string;
    })
  | (PrepareOperatorMainnetTestCreateRequestBase & {
      readonly plan: OperatorMainnetTradeCommandPlan;
      readonly approval?: never;
      readonly tradeCommand: {
        readonly receipt: OperatorMainnetTradeCommandReceipt;
        readonly binding: OperatorMainnetTradeCommandBinding;
        /** Local authorization clock used for the receipt submission expiry check. */
        readonly authorizationAt: UtcTimestamp;
      };
      readonly recoveryGrantId?: never;
    });

export type OperatorMainnetTradeCommandOutcomeStage =
  "plan-derivation" | "precheck" | "binding" | "admission";

export const OPERATOR_MAINNET_TRADE_COMMAND_DIAGNOSTIC_FIELDS = [
  "reason",
  "symbol",
  "availableBalance",
  "requiredAmount",
  "shortfall",
  "orderNotional",
  "entryFeeReserve",
  "exitFeeReserve",
  "totalReserve",
  "requiredAvailableBalance",
  "quoteBid",
  "quoteAsk",
  "quoteAgeMs",
  "approvedBidLower",
  "approvedBidUpper",
  "allowedDeviationBps",
  "criticalChangedGroups",
  "source",
  "ageMs",
  "futureByMs",
  "limitMs",
  "collectionFutureByMs",
  "quoteObservedAt",
  "causeCode",
  "pass",
  "predicate",
  "group",
  "changedConstraint",
  "readOnly",
  "contractOrder",
  "contractPosition",
  "walletTransfer",
  "withdraw",
  "spotHedging",
  "positionSide",
  "positionQuantity",
  "positionPresent",
  "activeOrdersPresent",
  "activeOrderCount",
  "leverage",
  "leverageConfiguration",
  "leverageConfigOutcome",
  "leverageBuy",
  "leverageSell",
  "leverageEffective",
  "marginMode",
  "utaStatus",
  "stage",
] as const;

export type OperatorMainnetTradeCommandDiagnosticDetails = Readonly<
  Record<string, string | number | boolean>
>;

export interface OperatorMainnetTradeCommandOutcomeRecord {
  readonly outcomeId: string;
  readonly commandId: string;
  readonly revision: number;
  readonly stage: OperatorMainnetTradeCommandOutcomeStage;
  readonly code: string;
  readonly occurredAt: UtcTimestamp;
  readonly diagnosticDetails: OperatorMainnetTradeCommandDiagnosticDetails;
  readonly canonicalJson: string;
  readonly canonicalHash: PlanHash;
}

export interface OperatorMainnetTradeCommandConsumptionRecord {
  readonly commandId: string;
  readonly receiptHash: PlanHash;
  readonly bindingHash: PlanHash;
  readonly sourceId: string;
  readonly writeIntentId: string;
  readonly consumedAt: UtcTimestamp;
}

/** Read-only aggregate used by command-id status, including interrupted pre-intent states. */
export interface OperatorMainnetTradeCommandSnapshot {
  readonly receipt: OperatorMainnetTradeCommandReceipt;
  readonly binding?: OperatorMainnetTradeCommandBinding;
  readonly outcomes: readonly OperatorMainnetTradeCommandOutcomeRecord[];
  readonly consumption?: OperatorMainnetTradeCommandConsumptionRecord;
  readonly source?: OperatorMainnetTestSnapshot;
}

export interface PersistOperatorMainnetTradeCommandReceiptRequest {
  readonly receipt: OperatorMainnetTradeCommandReceipt;
  readonly recordedAt: UtcTimestamp;
}

export interface BindOperatorMainnetTradeCommandRequest {
  readonly binding: OperatorMainnetTradeCommandBinding;
  readonly boundAt: UtcTimestamp;
}

export interface AppendOperatorMainnetTradeCommandOutcomeRequest {
  readonly commandId: string;
  readonly outcomeId: string;
  readonly stage: OperatorMainnetTradeCommandOutcomeStage;
  readonly code: string;
  readonly diagnosticDetails?: OperatorMainnetTradeCommandDiagnosticDetails;
  readonly occurredAt: UtcTimestamp;
}

export type OperatorMainnetRecoveryResolutionRequest =
  | {
      readonly kind: "api-resolved";
      readonly reconciliationId: string;
      readonly reconciliationHash: PlanHash;
    }
  | {
      readonly kind: "manual-attested";
      readonly attestationHash: PlanHash;
    };

export interface PersistOperatorMainnetRecoveryAttestationRequest {
  readonly attestation: OperatorMainnetRecoveryAttestation;
  readonly recordedAt: UtcTimestamp;
}

export interface CreateOperatorMainnetRecoveryGrantRequest {
  readonly sourceId: string;
  readonly planHash: PlanHash;
  readonly resolution: OperatorMainnetRecoveryResolutionRequest;
  readonly actor: string;
  readonly consent: true;
  readonly issuedAt: UtcTimestamp;
}

export interface RecordOperatorMainnetTestAttemptRequest {
  readonly runId: string;
  readonly sourceId: string;
  readonly attemptId: string;
  readonly outcome: OperatorMainnetTestAttemptOutcome;
  readonly exchangeOrderId?: string;
  readonly providerReasonCode?: string;
  readonly recordedAt: UtcTimestamp;
}

export interface AppendOperatorMainnetTestReconciliationRequest {
  readonly sourceId: string;
  readonly lifecycleOutcome: OperatorMainnetTestLifecycleOutcome;
  readonly cleanupStatus: OperatorMainnetTestCleanupStatus;
  readonly evidence: unknown;
  readonly observedAt: UtcTimestamp;
}

export interface AppendOperatorMainnetTestManualActionRequest {
  readonly sourceId: string;
  readonly action: OperatorMainnetTestManualAction;
  readonly provenance: unknown;
  readonly declaredAt: UtcTimestamp;
}

/**
 * Source-native, append-only journal for the supervised operator experiment.
 * The pending-source check is repeated inside prepareCreateIntent's write
 * transaction to close the gap between admission and durable intent.
 */
export interface OperatorMainnetTestPersistencePort {
  /** Keep a prepared, not-yet-approved plan in the scoped canonical artifact store. */
  persistPreparedPlan(plan: OperatorMainnetTestPlan): Result<void>;
  readPreparedPlan(
    planHash: PlanHash,
  ): Result<OperatorMainnetTestPlan | undefined>;
  /** Persist one immutable local command receipt before plan derivation. */
  persistOperatorMainnetTradeCommandReceipt(
    request: PersistOperatorMainnetTradeCommandReceiptRequest,
  ): Result<OperatorMainnetTradeCommandReceipt>;
  readOperatorMainnetTradeCommandReceipt(
    commandId: string,
  ): Result<OperatorMainnetTradeCommandReceipt | undefined>;
  /** Bind the saved receipt to exactly one deterministic plan and payload. */
  bindOperatorMainnetTradeCommand(
    request: BindOperatorMainnetTradeCommandRequest,
  ): Result<OperatorMainnetTradeCommandBinding>;
  readOperatorMainnetTradeCommandBinding(
    commandId: string,
  ): Result<OperatorMainnetTradeCommandBinding | undefined>;
  /** Append a safe, pre-intent outcome; absence after interruption remains unknown. */
  appendOperatorMainnetTradeCommandOutcome(
    request: AppendOperatorMainnetTradeCommandOutcomeRequest,
  ): Result<OperatorMainnetTradeCommandOutcomeRecord>;
  readOperatorMainnetTradeCommand(
    commandId: string,
  ): Result<OperatorMainnetTradeCommandSnapshot | undefined>;
  /** Persist immutable, redacted UI provenance before explicit recovery consent. */
  persistOperatorMainnetRecoveryAttestation(
    request: PersistOperatorMainnetRecoveryAttestationRequest,
  ): Result<OperatorMainnetRecoveryAttestation>;
  readOperatorMainnetRecoveryAttestation(
    attestationHash: PlanHash,
  ): Result<OperatorMainnetRecoveryAttestation | undefined>;
  /**
   * Create the explicit exact-plan grant and, only for a validated active
   * operator HALT, append its clearance in the same SQLite transaction.
   */
  createOperatorMainnetRecoveryGrant(
    request: CreateOperatorMainnetRecoveryGrantRequest,
  ): Result<OperatorMainnetRecoveryGrant>;
  readOperatorMainnetRecoveryGrant(
    grantId: string,
  ): Result<OperatorMainnetRecoveryGrant | undefined>;
  /** Returns only an unconsumed, unexpired grant with current source/HALT revisions. */
  findOperatorMainnetRecoveryGrant(
    planHash: PlanHash,
    now: UtcTimestamp,
  ): Result<OperatorMainnetRecoveryGrant | undefined>;
  readOperatorMainnetTestSource(
    sourceId: string,
  ): Result<OperatorMainnetTestSnapshot | undefined>;
  findPendingOperatorMainnetTestSource(): Result<
    OperatorMainnetTestSourceRecord | undefined
  >;
  prepareCreateIntent(
    request: PrepareOperatorMainnetTestCreateRequest,
  ): Result<OperatorMainnetTestSnapshot>;
  /** Persist an attempt; only ambiguous delivery raises a source-linked HALT. */
  recordAttempt(
    request: RecordOperatorMainnetTestAttemptRequest,
  ): Result<OperatorMainnetTestSnapshot>;
  raiseHalt(
    sourceId: string,
    reason: string,
    at: UtcTimestamp,
  ): Result<HaltState>;
  appendReconciliation(
    request: AppendOperatorMainnetTestReconciliationRequest,
  ): Result<OperatorMainnetTestReconciliationRecord>;
  appendManualAction(
    request: AppendOperatorMainnetTestManualActionRequest,
  ): Result<OperatorMainnetTestManualActionRecord>;
}
