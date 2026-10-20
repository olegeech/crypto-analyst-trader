import type { PlanHash } from "../identity/canonical-serialization.js";
import { hashCanonical } from "../identity/canonical-serialization.js";
import type { DailyCandidateLeg } from "../planning/daily-entry-grid.js";
import { MAX_PLANNING_LEVELS } from "../planning/planning-policy.js";
import {
  createOrderIntent,
  type TakeProfitExecutionPolicy,
} from "../planning/order-intent.js";
import { boundedList, closedRecord } from "../planning/planning-validation.js";
import {
  rehydratePreparedPlanApproval,
  validatePreparedPlanApproval,
  type PreparedPlanApproval,
} from "../review/prepared-plan-approval.js";
import {
  rehydratePreparedDailyPlan,
  type PreparedDailyPlan,
} from "../review/prepared-daily-plan.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";
import { parseUtcTimestamp, type UtcTimestamp } from "../shared/time.js";
import {
  isRecord,
  requireFiniteInteger,
  requireHash,
  requireIdentifier,
} from "../shared/validation.js";

export const PREPARED_LEG_EXECUTION_VERSION =
  "prepared-leg-execution/v1" as const;

export interface PreparedLegSourceIdentity {
  readonly environment: "mainnet";
  readonly accountIdentityHash: string;
  readonly preparedHash: PlanHash;
  readonly leg: DailyCandidateLeg;
  readonly clientOrderId: string;
}

export interface PreparedLegExecution extends PreparedLegSourceIdentity {
  readonly schemaVersion: typeof PREPARED_LEG_EXECUTION_VERSION;
  readonly approvalHash: PlanHash;
  readonly approvedAt: UtcTimestamp;
  readonly expiresAt: UtcTimestamp;
}

export interface PreparedLegGridExecution {
  readonly approvalHash: PlanHash;
  readonly preparedHash: PlanHash;
  readonly legs: readonly {
    readonly execution: PreparedLegExecution;
    readonly sourceId: string;
  }[];
}

const CLIENT_ID_PREFIX = "m1-";
const CLIENT_ID_DIGEST_LENGTH = 32;
export const PREPARED_LEG_CLIENT_ORDER_ID_LENGTH =
  CLIENT_ID_PREFIX.length + CLIENT_ID_DIGEST_LENGTH;

function invalid(message = "prepared leg execution input is invalid") {
  return fail(domainError("INVALID_APPROVAL", message));
}

/** Stable across renewed approvals: an approved leg is one source identity. */
export function derivePreparedLegClientOrderId(
  preparedHash: string,
  legId: string,
): Result<string> {
  const parsedHash = requireHash(preparedHash, "preparedHash");
  const parsedLeg = requireIdentifier(legId, "legId");
  if (!parsedHash.ok || !parsedLeg.ok) return invalid();
  const digest = hashCanonical({
    identityVersion: "prepared-leg-client-order/v1",
    preparedHash: parsedHash.value,
    legId: parsedLeg.value,
  });
  if (!digest.ok) return digest;
  const clientOrderId = `${CLIENT_ID_PREFIX}${digest.value.slice(7, 39)}`;
  return clientOrderId.length === PREPARED_LEG_CLIENT_ORDER_ID_LENGTH
    ? ok(clientOrderId)
    : fail(
        domainError("INVALID_IDENTIFIER", "derived client identity is invalid"),
      );
}

/** Stable account-scoped source key; approval renewals do not change lineage. */
export function derivePreparedLegSourceId(
  accountIdentityHash: string,
  preparedHash: string,
  legId: string,
): Result<string> {
  const account = requireHash(accountIdentityHash, "accountIdentityHash");
  const prepared = requireHash(preparedHash, "preparedHash");
  const leg = requireIdentifier(legId, "legId");
  if (!account.ok || !prepared.ok || !leg.ok) return invalid();
  const digest = hashCanonical({
    identityVersion: "prepared-leg-source/v1",
    exchange: "bybit",
    environment: "mainnet",
    accountIdentityHash: account.value,
    category: "linear",
    positionMode: "one-way",
    preparedHash: prepared.value,
    legId: leg.value,
  });
  if (!digest.ok) return digest;
  return ok(`prepared-leg:${digest.value.slice(7, 47)}`);
}

function executionIdentityFromApproval(
  approval: PreparedPlanApproval,
  approvalHash: PlanHash,
  legId: string,
  requireCurrentProtectionPolicy: boolean,
): Result<PreparedLegExecution> {
  if (approval.contentHash !== approvalHash)
    return invalid("exact approval identity is required");
  const prepared = approval.replayInputs.prepared;
  const sourceLeg = selectApprovedLeg(prepared, legId);
  const selected = requireCurrentProtectionPolicy
    ? applyApprovedProtectionPolicy(prepared, sourceLeg)
    : sourceLeg;
  const preparedHash = requireHash(prepared.contentHash, "preparedHash");
  const accountIdentityHash = requireHash(
    prepared.inputIdentity.accountIdentityHash,
    "accountIdentityHash",
  );
  if (
    !selected.ok ||
    !preparedHash.ok ||
    !accountIdentityHash.ok ||
    approval.preparedHash !== preparedHash.value ||
    prepared.inputIdentity.environment !== "mainnet"
  )
    return invalid("approval is not bound to an eligible Mainnet plan");
  const clientOrderId = derivePreparedLegClientOrderId(
    preparedHash.value,
    legId,
  );
  if (!clientOrderId.ok) return clientOrderId;
  return ok(
    deepFreeze({
      schemaVersion: PREPARED_LEG_EXECUTION_VERSION,
      environment: "mainnet",
      accountIdentityHash: accountIdentityHash.value,
      preparedHash: preparedHash.value as PlanHash,
      approvalHash,
      leg: selected.value,
      clientOrderId: clientOrderId.value,
      approvedAt: approval.approvedAt,
      expiresAt: approval.expiresAt,
    }),
  );
}

function applyApprovedProtectionPolicy(
  prepared: PreparedDailyPlan,
  leg: Result<DailyCandidateLeg>,
): Result<DailyCandidateLeg> {
  const policy = prepared.replayInputs.protectionPolicy;
  if (
    !leg.ok ||
    prepared.inputIdentity.environment !== "mainnet" ||
    policy === undefined ||
    policy.schemaVersion !== "prepared-protection-policy/v1" ||
    policy.environment !== "mainnet" ||
    policy.policyVersion !== "m1-mainnet-per-leg-tp/v1" ||
    policy.entry.orderType !== "Limit" ||
    policy.entry.timeInForce !== "GTC" ||
    policy.stopLoss !== "none" ||
    policy.takeProfit.tpslMode !== "Partial" ||
    !("orderType" in policy.takeProfit) ||
    policy.takeProfit.orderType !== "Market" ||
    policy.takeProfit.triggerBy !== "LastPrice"
  )
    return invalid("Mainnet approval lacks the current protection policy");
  const takeProfitPolicy: TakeProfitExecutionPolicy = {
    policyVersion: policy.policyVersion,
    tpslMode: policy.takeProfit.tpslMode,
    orderType: policy.takeProfit.orderType,
    triggerBy: policy.takeProfit.triggerBy,
  };
  const intent = createOrderIntent({
    ...leg.value.intent,
    protection: {
      takeProfit: leg.value.intent.protection!.takeProfit!,
      takeProfitPolicy,
    },
  });
  if (!intent.ok) return invalid("approved protection policy is invalid");
  return ok(deepFreeze({ ...leg.value, intent: intent.value }));
}

/** Rebuilds immutable source terms from the prepared artifact without consent lookup. */
export function derivePreparedLegSourceIdentity(
  input: unknown,
): Result<PreparedLegSourceIdentity> {
  const keys = ["prepared", "preparedHash", "legId", "accountIdentityHash"];
  if (
    !closedRecord(input, keys) ||
    Reflect.ownKeys(input).length !== keys.length
  )
    return invalid("durable prepared-leg source identity is invalid");
  const preparedHash = requireHash(input.preparedHash, "preparedHash");
  const legId = requireIdentifier(input.legId, "legId");
  const accountIdentityHash = requireHash(
    input.accountIdentityHash,
    "accountIdentityHash",
  );
  const prepared = rehydratePreparedDailyPlan(input.prepared);
  if (
    !preparedHash.ok ||
    !legId.ok ||
    !accountIdentityHash.ok ||
    !prepared.ok ||
    prepared.value.contentHash !== preparedHash.value ||
    prepared.value.inputIdentity.environment !== "mainnet" ||
    prepared.value.inputIdentity.accountIdentityHash !==
      accountIdentityHash.value
  )
    return invalid("durable prepared artifact does not match source scope");
  const leg = selectApprovedLeg(prepared.value, legId.value);
  if (!leg.ok) return leg;
  const clientOrderId = derivePreparedLegClientOrderId(
    preparedHash.value,
    legId.value,
  );
  if (!clientOrderId.ok) return clientOrderId;
  return ok(
    deepFreeze({
      environment: "mainnet",
      accountIdentityHash: accountIdentityHash.value,
      preparedHash: preparedHash.value as PlanHash,
      leg: leg.value,
      clientOrderId: clientOrderId.value,
    }),
  );
}

/** Derives durable source identity for recovery, even after consent expiry. */
export function derivePreparedLegExecutionIdentity(
  input: unknown,
): Result<PreparedLegExecution> {
  if (
    !closedRecord(input, ["approval", "approvalHash", "legId"]) ||
    Reflect.ownKeys(input).length !== 3
  )
    return invalid();

  const approvalHash = requireHash(input.approvalHash, "approvalHash");
  const legId = requireIdentifier(input.legId, "legId");
  const parsedApproval = rehydratePreparedPlanApproval(input.approval);
  if (!approvalHash.ok || !legId.ok || !parsedApproval.ok)
    return invalid("exact approval identity is required");
  return executionIdentityFromApproval(
    parsedApproval.value,
    approvalHash.value as PlanHash,
    legId.value,
    false,
  );
}

/** Rehydrates exact consent and selects terms only from its embedded plan. */
export function createPreparedLegExecution(
  input: unknown,
): Result<PreparedLegExecution> {
  if (
    !closedRecord(input, ["approval", "approvalHash", "legId", "now"]) ||
    Reflect.ownKeys(input).length !== 4
  )
    return invalid();

  const now = parseUtcTimestamp(input.now);
  const approvalHash = requireHash(input.approvalHash, "approvalHash");
  const legId = requireIdentifier(input.legId, "legId");
  const parsedApproval = rehydratePreparedPlanApproval(input.approval);
  if (!now.ok || !approvalHash.ok || !legId.ok || !parsedApproval.ok)
    return invalid("exact approval identity is required");
  const approval = parsedApproval.value;
  const prepared = approval.replayInputs.prepared;
  const derived = executionIdentityFromApproval(
    approval,
    approvalHash.value as PlanHash,
    legId.value,
    true,
  );
  if (!derived.ok) return derived;
  const validApproval = validatePreparedPlanApproval(
    approval,
    prepared,
    now.value,
  );
  if (!validApproval.ok) return validApproval;
  return derived;
}

/** Validates the approved grid's complete, canonical index and leg identity shape. */
export function validatePreparedLegGridShape(input: unknown): Result<true> {
  if (!boundedList(input, MAX_PLANNING_LEVELS))
    return invalid("approved grid length is outside the supported range");

  const legIds = new Set<string>();
  const legKeys = ["legId", "index", "allocation", "timeInForce", "intent"];
  for (let index = 0; index < input.length; index += 1) {
    const candidate = input[index];
    if (
      !closedRecord(candidate, legKeys) ||
      Reflect.ownKeys(candidate).length !== legKeys.length ||
      candidate.timeInForce !== "GTC" ||
      candidate.allocation === undefined ||
      !isRecord(candidate.intent)
    )
      return invalid("approved grid contains a malformed leg");

    const legId = requireIdentifier(candidate.legId, "legId");
    const legIndex = requireFiniteInteger(candidate.index, "index");
    if (
      !legId.ok ||
      !legIndex.ok ||
      legIndex.value !== index ||
      legIds.has(legId.value)
    )
      return invalid("approved grid leg identities or indices are invalid");
    legIds.add(legId.value);
  }

  return ok(true);
}

/** Admits every leg from the exact, currently valid approval in plan order. */
export function createPreparedLegGridExecution(
  input: unknown,
): Result<PreparedLegGridExecution> {
  const keys = ["approval", "approvalHash", "now"];
  if (
    !closedRecord(input, keys) ||
    Reflect.ownKeys(input).length !== keys.length
  )
    return invalid();

  const now = parseUtcTimestamp(input.now);
  const approvalHash = requireHash(input.approvalHash, "approvalHash");
  const parsedApproval = rehydratePreparedPlanApproval(input.approval);
  if (!now.ok || !approvalHash.ok || !parsedApproval.ok)
    return invalid("exact approval identity is required");

  const approval = parsedApproval.value;
  const prepared = approval.replayInputs.prepared;
  if (approval.contentHash !== approvalHash.value)
    return invalid("exact approval identity is required");
  const validApproval = validatePreparedPlanApproval(
    approval,
    prepared,
    now.value,
  );
  if (!validApproval.ok) return validApproval;

  const candidateLegs =
    prepared.replayInputs.preflight.replayInputs.dailyPlan.candidateLegs;
  if (candidateLegs === undefined)
    return invalid("approved plan does not contain a candidate grid");
  const shape = validatePreparedLegGridShape(candidateLegs);
  if (!shape.ok) return shape;

  const preparedHash = requireHash(prepared.contentHash, "preparedHash");
  const accountIdentityHash = requireHash(
    prepared.inputIdentity.accountIdentityHash,
    "accountIdentityHash",
  );
  if (
    !preparedHash.ok ||
    !accountIdentityHash.ok ||
    approval.preparedHash !== preparedHash.value
  )
    return invalid("approval is not bound to its prepared plan");

  const admittedLegs: {
    execution: PreparedLegExecution;
    sourceId: string;
  }[] = [];
  const clientOrderIds = new Set<string>();
  const sourceIds = new Set<string>();
  for (const leg of candidateLegs) {
    const execution = executionIdentityFromApproval(
      approval,
      approvalHash.value as PlanHash,
      leg.legId,
      true,
    );
    if (!execution.ok) return execution;
    const sourceId = derivePreparedLegSourceId(
      accountIdentityHash.value,
      preparedHash.value,
      leg.legId,
    );
    if (!sourceId.ok) return sourceId;
    if (
      clientOrderIds.has(execution.value.clientOrderId) ||
      sourceIds.has(sourceId.value)
    )
      return invalid("approved grid contains duplicate execution identities");

    clientOrderIds.add(execution.value.clientOrderId);
    sourceIds.add(sourceId.value);
    admittedLegs.push({
      execution: execution.value,
      sourceId: sourceId.value,
    });
  }

  return ok(
    deepFreeze({
      approvalHash: approvalHash.value as PlanHash,
      preparedHash: preparedHash.value as PlanHash,
      legs: admittedLegs,
    }),
  );
}

function selectApprovedLeg(
  prepared: PreparedDailyPlan,
  legId: string,
): Result<DailyCandidateLeg> {
  const preflight = prepared.replayInputs.preflight;
  const dailyPlan = preflight.replayInputs.dailyPlan;
  if (
    prepared.state === "BLOCKED" ||
    preflight.verdict !== "PASS" ||
    dailyPlan.decision.recommendation !== "ADD_LONG" ||
    dailyPlan.candidateLegs === undefined ||
    preflight.actionProposal?.kind !== "add-long" ||
    prepared.summary.targetGate.status !== "clean" ||
    prepared.summary.targetGate.positionState !== "flat" ||
    prepared.summary.targetGate.activeOrderCount !== 0 ||
    !prepared.summary.targetGate.relevantCoverageComplete
  )
    return invalid("prepared plan is not an approvable create-only ADD plan");
  const seen = new Set<string>();
  let selected: DailyCandidateLeg | undefined;
  let selectedCount = 0;
  let duplicateId = false;
  for (const leg of dailyPlan.candidateLegs) {
    if (seen.has(leg.legId)) duplicateId = true;
    else seen.add(leg.legId);
    if (leg.legId === legId) {
      selected = leg;
      selectedCount += 1;
    }
  }
  if (selectedCount !== 1 || duplicateId)
    return invalid("selected leg is missing or ambiguous in the approved grid");
  const leg = selected!;
  if (
    leg.intent.instrument !== prepared.summary.symbol ||
    leg.intent.orderType !== "limit" ||
    leg.intent.side !== "buy" ||
    leg.intent.positionEffect !== "open" ||
    !leg.intent.quantity.isPositive() ||
    !leg.intent.price.isPositive() ||
    !leg.intent.protection?.takeProfit?.isPositive() ||
    leg.intent.protection.stopLoss !== undefined ||
    leg.timeInForce !== "GTC"
  )
    return invalid("approved leg does not match the M1 entry contract");
  return ok(leg);
}
