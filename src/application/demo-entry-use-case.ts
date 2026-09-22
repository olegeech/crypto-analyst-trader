import { createApproval } from "../domain/execution/approval.js";
import { createExecutionAttempt } from "../domain/execution/execution-attempt.js";
import { reconcileAttempt } from "../domain/execution/reconciliation.js";
import { hashCanonical } from "../domain/identity/plan-hash.js";
import { buildDemoEntryPlan, type DemoEntryPlan } from "./demo-entry-plan.js";
import {
  createDemoEntryInput,
  type DemoEntryInput,
} from "./demo-entry-input.js";
import {
  recoverPriorDemoRuns,
  type AccountingIngestInput,
  type AccountingIngestResult,
  type AccountingIngestor,
} from "./demo-recovery.js";
import { ingestExchangeFillObservation } from "./accounting-ingestion.js";
import { failureFromExchange } from "./application-errors.js";
import { requireTrustedCapability } from "../domain/capabilities/capability.js";
import { domainError } from "../domain/shared/errors.js";
import {
  addMilliseconds,
  type Clock,
  type UtcTimestamp,
  systemClock,
} from "../domain/shared/time.js";
import { fail, ok, type Result } from "../domain/shared/result.js";
import type {
  ExchangeExecutionPort,
  ExchangeReadState,
} from "../ports/exchange-execution.js";
import type { LeaseAuthority, PersistencePort } from "../ports/persistence.js";

export interface DemoEntryReview {
  readonly input: DemoEntryInput;
  readonly plan: DemoEntryPlan;
  readonly state: ExchangeReadState;
  readonly scope: PersistencePort["scope"];
  readonly runId: string;
  readonly approvalExpiresAt: UtcTimestamp;
}

export interface DemoEntryOutcome {
  readonly verdict:
    | "CONFIRMED_FILLED"
    | "CONFIRMED_OPEN"
    | "NOT_READY"
    | "DECLINED"
    | "HALTED"
    | "UNRESOLVED";
  readonly reasonCode: string;
  readonly nextAction: string;
  readonly scope: PersistencePort["scope"];
  readonly accountIdentityHash: string;
  readonly planHash: string;
  readonly runId: string;
  readonly lineageId?: string;
  readonly clientOrderId: string;
  readonly exchangeOrderId?: string;
  readonly reconciliationStatus?: string;
  readonly acknowledgement?: string;
}

export interface DemoEntryUseCaseOptions {
  readonly exchange: ExchangeExecutionPort;
  readonly persistence: PersistencePort;
  readonly clock?: Clock;
  readonly leaseTtlMs?: number;
  readonly approvalTtlMs?: number;
  readonly approvalActor?: string;
  readonly ingestAccounting?: AccountingIngestor;
}

function shortIdentity(prefix: string, input: unknown): Result<string> {
  const digest = hashCanonical(input);
  if (!digest.ok) return digest;
  return ok(`${prefix}-${digest.value.slice(7, 23)}`);
}

function accountIdentityHash(state: ExchangeReadState): Result<string> {
  return hashCanonical({
    accountId: state.accountMetadata.accountId,
    userId: state.accountMetadata.userId,
  });
}

function runIdForInput(input: DemoEntryInput): Result<string> {
  return shortIdentity("run", {
    exchange: "bybit",
    environment: "demo",
    category: "linear",
    positionMode: "one-way",
    input,
  });
}

function decimalEqual(
  left: { toString(): string },
  right: { toString(): string },
): boolean {
  return left.toString() === right.toString();
}

function isOne(value: { toString(): string }): boolean {
  return value.toString() === "1";
}

function constraintsEqual(
  left: ExchangeReadState["market"]["constraints"],
  right: ExchangeReadState["market"]["constraints"],
): boolean {
  return (
    left.instrument === right.instrument &&
    left.version === right.version &&
    decimalEqual(left.priceTickSize, right.priceTickSize) &&
    decimalEqual(left.quantityStep, right.quantityStep) &&
    decimalEqual(left.minQuantity, right.minQuantity) &&
    ((left.minNotional === undefined && right.minNotional === undefined) ||
      (left.minNotional !== undefined &&
        right.minNotional !== undefined &&
        decimalEqual(left.minNotional, right.minNotional)))
  );
}

function orderFingerprint(
  order: ExchangeReadState["openOrders"][number],
): string {
  return JSON.stringify([
    order.exchangeOrderId,
    order.clientOrderId,
    order.instrument,
    order.side,
    order.requestedQuantity.toString(),
    order.filledQuantity.toString(),
    order.status,
    order.parentOrderLinkId ?? null,
  ]);
}

function baselineEqual(
  initial: ExchangeReadState,
  current: ExchangeReadState,
  symbol: string,
): boolean {
  const initialPositions = initial.account.positions
    .filter((position) => position.instrument === symbol)
    .map((position) =>
      JSON.stringify([
        position.instrument,
        position.side,
        position.quantity.toString(),
        position.entryPrice?.toString() ?? null,
      ]),
    )
    .sort();
  const currentPositions = current.account.positions
    .filter((position) => position.instrument === symbol)
    .map((position) =>
      JSON.stringify([
        position.instrument,
        position.side,
        position.quantity.toString(),
        position.entryPrice?.toString() ?? null,
      ]),
    )
    .sort();
  const initialOrders = initial.openOrders
    .filter((order) => order.instrument === symbol)
    .map(orderFingerprint)
    .sort();
  const currentOrders = current.openOrders
    .filter((order) => order.instrument === symbol)
    .map(orderFingerprint)
    .sort();
  return (
    JSON.stringify(initialPositions) === JSON.stringify(currentPositions) &&
    JSON.stringify(initialOrders) === JSON.stringify(currentOrders)
  );
}

function keyMetadataEqual(
  left: ExchangeReadState["accountMetadata"],
  right: ExchangeReadState["accountMetadata"],
): boolean {
  return (
    left.accountId === right.accountId &&
    left.userId === right.userId &&
    left.apiKey.readOnly === right.apiKey.readOnly &&
    left.apiKey.contractTrade.order === right.apiKey.contractTrade.order &&
    left.apiKey.contractTrade.position ===
      right.apiKey.contractTrade.position &&
    left.apiKey.wallet.withdraw === right.apiKey.wallet.withdraw &&
    left.apiKey.wallet.transfer === right.apiKey.wallet.transfer &&
    left.apiKey.ipBinding === right.apiKey.ipBinding &&
    JSON.stringify(left.apiKey.ips) === JSON.stringify(right.apiKey.ips) &&
    left.apiKey.expiresAt === right.apiKey.expiresAt
  );
}

function scopeEqual(
  left: ExchangeReadState["account"]["scope"],
  right: ExchangeReadState["account"]["scope"],
): boolean {
  return (
    left.exchange === right.exchange &&
    left.environment === right.environment &&
    left.category === right.category &&
    left.positionMode === right.positionMode
  );
}

function validateExecutionAuthority(
  state: ExchangeReadState,
  scope: PersistencePort["scope"],
): Result<void> {
  if (
    !scopeEqual(state.account.scope, scope) ||
    state.accountMetadata.accountId !== scope.accountId ||
    state.accountMetadata.userId !== scope.accountId
  ) {
    return fail(
      domainError(
        "PERSISTENCE_ENVIRONMENT",
        "authenticated Demo identity or scope does not match the journal",
      ),
    );
  }
  const apiKey = state.accountMetadata.apiKey;
  if (apiKey.readOnly) {
    return fail(
      domainError("CAPABILITY_UNSUPPORTED", "Demo API key is read-only"),
    );
  }
  if (!apiKey.contractTrade.order || !apiKey.contractTrade.position) {
    return fail(
      domainError(
        "CAPABILITY_UNSUPPORTED",
        "Demo API key lacks ContractTrade Order and Position permissions",
      ),
    );
  }
  if (apiKey.wallet.withdraw || apiKey.wallet.transfer) {
    return fail(
      domainError(
        "CAPABILITY_UNSUPPORTED",
        "Demo API key has a prohibited wallet permission",
      ),
    );
  }
  return ok(undefined);
}

function capabilitiesValid(
  state: ExchangeReadState,
  plan: DemoEntryPlan,
  clock: Clock,
): Result<void> {
  for (const requirement of plan.plan.material.requiredCapabilities) {
    const observations = state.capabilities.filter(
      (candidate) =>
        candidate.capability === requirement.capability &&
        scopeEqual(candidate.scope, requirement.scope),
    );
    if (observations.length === 0) {
      return fail(
        domainError(
          "CAPABILITY_UNKNOWN",
          `fresh capability ${requirement.capability} is missing`,
        ),
      );
    }
    if (observations.length !== 1) {
      return fail(
        domainError(
          "INCOMPATIBLE_EVIDENCE",
          `conflicting fresh capability evidence exists for ${requirement.capability}`,
        ),
      );
    }
    const observation = observations[0]!;
    const trusted = requireTrustedCapability(observation, requirement, clock);
    if (!trusted.ok) return trusted;
  }
  return ok(undefined);
}

function sameApprovedAuthority(
  initial: ExchangeReadState,
  current: ExchangeReadState,
  plan: DemoEntryPlan,
  clock: Clock,
  allowLeverageChange = false,
): Result<void> {
  if (
    current.accountReadiness.status !== "ready" ||
    !scopeEqual(initial.account.scope, current.account.scope) ||
    current.market.instrument !== plan.intent.instrument ||
    !scopeEqual(initial.market.scope, current.market.scope) ||
    !keyMetadataEqual(initial.accountMetadata, current.accountMetadata) ||
    !baselineEqual(initial, current, plan.intent.instrument) ||
    !constraintsEqual(initial.market.constraints, current.market.constraints) ||
    (!allowLeverageChange &&
      !decimalEqual(initial.leverage.effective, current.leverage.effective))
  ) {
    return fail(
      domainError(
        "CONSTRAINT_VIOLATION",
        "Demo authority, baseline, leverage or constraints changed after approval",
      ),
    );
  }
  return capabilitiesValid(current, plan, clock);
}

function attemptIdFor(
  lineageId: string,
  clientOrderId: string,
): Result<string> {
  return shortIdentity("attempt", { lineageId, clientOrderId, ordinal: 1 });
}

function defaultAccountingIngestor(
  input: AccountingIngestInput,
): Result<AccountingIngestResult> {
  let fillCount = 0;
  let feeCount = 0;
  let ledgerCount = 0;
  for (const fill of input.fills) {
    const ingested = ingestExchangeFillObservation(
      input.persistence,
      input.persistence.scope,
      fill,
      input.attemptId,
      {
        eventKey: `${input.lineageId}:${fill.executionId}`,
        ledgerCurrency: "USDT",
      },
    );
    if (!ingested.ok) return ingested;
    fillCount += ingested.value.fill.status === "inserted" ? 1 : 0;
    feeCount +=
      ingested.value.fee === undefined ||
      ingested.value.fee.status !== "inserted"
        ? 0
        : 1;
    ledgerCount += ingested.value.ledgerEntries.filter(
      (entry) => entry.status === "inserted",
    ).length;
  }
  return ok({ fillCount, feeCount, ledgerCount });
}

function outcome(
  review: DemoEntryReview,
  state: ExchangeReadState,
  values: Omit<
    DemoEntryOutcome,
    "scope" | "accountIdentityHash" | "planHash" | "runId" | "clientOrderId"
  >,
): Result<DemoEntryOutcome> {
  const identity = accountIdentityHash(state);
  if (!identity.ok) return identity;
  return ok(
    Object.freeze({
      ...values,
      scope: review.scope,
      accountIdentityHash: identity.value,
      planHash: review.plan.plan.materialHash,
      runId: review.runId,
      clientOrderId: review.plan.clientOrderId,
    }),
  );
}

export class DemoEntryUseCase {
  private readonly exchange: ExchangeExecutionPort;
  private readonly persistence: PersistencePort;
  private readonly clock: Clock;
  private readonly leaseTtlMs: number;
  private readonly approvalTtlMs: number;
  private readonly approvalActor: string;
  private readonly ingestAccounting: AccountingIngestor | undefined;

  public constructor(options: DemoEntryUseCaseOptions) {
    this.exchange = options.exchange;
    this.persistence = options.persistence;
    this.clock = options.clock ?? systemClock;
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.approvalTtlMs = options.approvalTtlMs ?? 120_000;
    this.approvalActor = options.approvalActor ?? "demo-operator";
    this.ingestAccounting =
      options.ingestAccounting ?? defaultAccountingIngestor;
  }

  private async acquireAndRecover(
    runId: string,
  ): Promise<
    Result<{ authority: LeaseAuthority; state: ExchangeReadState | undefined }>
  > {
    const acquired = this.persistence.acquireLease({
      scope: this.persistence.scope,
      ownerRunId: runId,
      now: this.clock.now(),
      ttlMs: this.leaseTtlMs,
    });
    if (!acquired.ok) return acquired;
    const authority = {
      ownerRunId: acquired.value.ownerRunId,
      epoch: acquired.value.epoch,
    };
    const recoveryDependencies = {
      exchange: this.exchange,
      persistence: this.persistence,
      authority,
      clock: this.clock,
      ...(this.ingestAccounting === undefined
        ? {}
        : { ingestAccounting: this.ingestAccounting }),
    };
    const recovered = await recoverPriorDemoRuns(recoveryDependencies);
    if (!recovered.ok) return recovered;
    if (!recovered.value.safeToProceed) {
      return fail(
        domainError(
          "UNRESOLVED_STATE",
          "exact-scope Demo recovery is not safe for a new exchange write",
        ),
      );
    }
    return ok({ authority, state: undefined });
  }

  private fenceForWrite(
    authority: LeaseAuthority,
    review: DemoEntryReview,
  ): Result<UtcTimestamp> {
    const now = this.clock.now();
    if (Date.parse(now) >= Date.parse(review.approvalExpiresAt)) {
      return fail(
        domainError(
          "PLAN_EXPIRED",
          "approved Demo plan expired before the exchange write",
        ),
      );
    }
    const halt = this.persistence.readHalt();
    if (!halt.ok) return halt;
    if (halt.value.active || halt.value.reconciliationRequired) {
      return fail(
        domainError(
          "HALT_ACTIVE",
          "HALT or reconciliation-required state blocks the exchange write",
        ),
      );
    }
    const renewed = this.persistence.renewLease({
      scope: this.persistence.scope,
      ownerRunId: authority.ownerRunId,
      authority,
      now,
      ttlMs: this.leaseTtlMs,
    });
    if (!renewed.ok) return renewed;
    if (renewed.value.reconciliationRequired) {
      return fail(
        domainError(
          "UNRESOLVED_STATE",
          "current lease still requires reconciliation",
        ),
      );
    }
    return ok(now);
  }

  private releasePreparationLease(authority: LeaseAuthority): Result<void> {
    const released = this.persistence.releaseLease(authority);
    if (!released.ok && released.error.code === "RUN_LEASE_LOST") {
      return ok(undefined);
    }
    return released;
  }

  public async prepare(input: unknown): Promise<Result<DemoEntryReview>> {
    const parsed = createDemoEntryInput(input);
    if (!parsed.ok) return parsed;
    const runId = runIdForInput(parsed.value);
    if (!runId.ok) return runId;
    const preflight = await this.exchange.readState({
      instrument: parsed.value.symbol,
    });
    if (!preflight.ok)
      return fail(
        domainError(
          "UNRESOLVED_STATE",
          failureFromExchange(preflight.error).message,
        ),
      );
    const preflightAuthority = validateExecutionAuthority(
      preflight.value,
      this.persistence.scope,
    );
    if (!preflightAuthority.ok) return preflightAuthority;
    const acquired = await this.acquireAndRecover(runId.value);
    if (!acquired.ok) return acquired;
    const authority = acquired.value.authority;
    const halt = this.persistence.readHalt();
    if (!halt.ok) return halt;
    if (halt.value.active) {
      return fail(
        domainError(
          "HALT_ACTIVE",
          "account HALT remains active after exact-scope recovery",
        ),
      );
    }
    const state = await this.exchange.readState({
      instrument: parsed.value.symbol,
    });
    if (!state.ok) {
      const released = this.releasePreparationLease(authority);
      if (!released.ok) return released;
      return fail(
        domainError(
          "UNRESOLVED_STATE",
          failureFromExchange(state.error).message,
        ),
      );
    }
    const stateAuthority = validateExecutionAuthority(
      state.value,
      this.persistence.scope,
    );
    if (!stateAuthority.ok) {
      const released = this.releasePreparationLease(authority);
      if (!released.ok) return released;
      return stateAuthority;
    }
    const plan = buildDemoEntryPlan(parsed.value, state.value, this.clock);
    if (!plan.ok) {
      const released = this.persistence.releaseLease(authority);
      if (!released.ok && released.error.code !== "RUN_LEASE_LOST")
        return released;
      return plan;
    }
    const expires = addMilliseconds(this.clock.now(), this.approvalTtlMs);
    if (!expires.ok) {
      const released = this.releasePreparationLease(authority);
      if (!released.ok) return released;
      return expires;
    }
    const released = this.releasePreparationLease(authority);
    if (!released.ok) return released;
    return ok(
      Object.freeze({
        input: parsed.value,
        plan: plan.value,
        state: state.value,
        scope: this.persistence.scope,
        runId: runId.value,
        approvalExpiresAt: expires.value,
      }),
    );
  }

  public async execute(
    review: DemoEntryReview,
    approved: boolean,
  ): Promise<Result<DemoEntryOutcome>> {
    const identityState = review.state;
    if (!approved) {
      return outcome(review, identityState, {
        verdict: "DECLINED",
        reasonCode: "OPERATOR_DECLINED",
        nextAction: "no exchange write was attempted",
      });
    }
    const preflight = await this.exchange.readState({
      instrument: review.input.symbol,
    });
    if (!preflight.ok) {
      return outcome(review, identityState, {
        verdict: "HALTED",
        reasonCode: `EXCHANGE_${preflight.error.kind.toUpperCase()}`,
        nextAction: failureFromExchange(preflight.error).nextAction,
      });
    }
    const preflightAuthority = validateExecutionAuthority(
      preflight.value,
      this.persistence.scope,
    );
    if (!preflightAuthority.ok) {
      return outcome(review, preflight.value, {
        verdict: "NOT_READY",
        reasonCode: preflightAuthority.error.code,
        nextAction: "stop and correct the authenticated Demo account scope",
      });
    }
    const acquired = await this.acquireAndRecover(review.runId);
    if (!acquired.ok) return acquired;
    const authority = acquired.value.authority;
    const beforeWrite = await this.exchange.readState({
      instrument: review.input.symbol,
    });
    if (!beforeWrite.ok) {
      const halt = this.persistence.raiseHalt(
        authority,
        failureFromExchange(beforeWrite.error).message,
        this.clock.now(),
      );
      if (!halt.ok) return halt;
      return outcome(review, identityState, {
        verdict: "HALTED",
        reasonCode: `EXCHANGE_${beforeWrite.error.kind.toUpperCase()}`,
        nextAction: failureFromExchange(beforeWrite.error).nextAction,
      });
    }
    const beforeWriteAuthority = validateExecutionAuthority(
      beforeWrite.value,
      this.persistence.scope,
    );
    if (!beforeWriteAuthority.ok) {
      const halt = this.persistence.raiseHalt(
        authority,
        beforeWriteAuthority.error.message,
        this.clock.now(),
      );
      if (!halt.ok) return halt;
      return outcome(review, beforeWrite.value, {
        verdict: "NOT_READY",
        reasonCode: beforeWriteAuthority.error.code,
        nextAction: "stop and correct the authenticated Demo account scope",
      });
    }
    const validated = sameApprovedAuthority(
      review.state,
      beforeWrite.value,
      review.plan,
      this.clock,
    );
    if (!validated.ok) {
      const halt = this.persistence.raiseHalt(
        authority,
        validated.error.message,
        this.clock.now(),
      );
      if (!halt.ok) return halt;
      return outcome(review, beforeWrite.value, {
        verdict: "NOT_READY",
        reasonCode: validated.error.code,
        nextAction: "rebuild and re-approve the changed exact plan",
      });
    }
    const approvedAt = this.clock.now();
    if (Date.parse(approvedAt) >= Date.parse(review.approvalExpiresAt)) {
      return outcome(review, beforeWrite.value, {
        verdict: "DECLINED",
        reasonCode: "PLAN_EXPIRED",
        nextAction: "prepare a fresh review and approve it before expiry",
      });
    }
    const approvalId = shortIdentity("approval", {
      planHash: review.plan.plan.materialHash,
      runId: review.runId,
      approvedAt: this.clock.now(),
    });
    if (!approvalId.ok) return approvalId;
    const approval = createApproval({
      approvalId: approvalId.value,
      planHash: review.plan.plan.materialHash,
      actor: this.approvalActor,
      approvedAt,
      expiresAt: review.approvalExpiresAt,
    });
    if (!approval.ok) return approval;
    const lineage = this.persistence.prepareLineage({
      scope: this.persistence.scope,
      runId: review.runId,
      plan: review.plan.plan,
      approval: approval.value,
      preparedAt: this.clock.now(),
    });
    if (!lineage.ok) return lineage;

    let current = beforeWrite.value;
    if (!isOne(current.leverage.effective)) {
      const fenced = this.fenceForWrite(authority, review);
      if (!fenced.ok) {
        return outcome(review, current, {
          verdict: fenced.error.code === "PLAN_EXPIRED" ? "DECLINED" : "HALTED",
          reasonCode: fenced.error.code,
          nextAction:
            fenced.error.code === "PLAN_EXPIRED"
              ? "prepare a fresh review and approve it before expiry"
              : "reconcile the current lease and Demo state before retrying",
          lineageId: lineage.value.lineageId,
        });
      }
      const set = await this.exchange.setLeverage({
        instrument: review.input.symbol,
        target: review.plan.leverage.target,
      });
      if (!set.ok) {
        const raised = this.persistence.raiseHalt(
          authority,
          failureFromExchange(set.error).message,
          this.clock.now(),
        );
        if (!raised.ok) return raised;
        return outcome(review, current, {
          verdict: "HALTED",
          reasonCode: `EXCHANGE_${set.error.kind.toUpperCase()}`,
          nextAction: "reread leverage before any retry; no order was created",
          lineageId: lineage.value.lineageId,
        });
      }
      if (!isOne(set.value.effective.effective)) {
        const raised = this.persistence.raiseHalt(
          authority,
          "Demo leverage readback did not prove 1x",
          this.clock.now(),
        );
        if (!raised.ok) return raised;
        return outcome(review, current, {
          verdict: "HALTED",
          reasonCode: "LEVERAGE_UNPROVEN",
          nextAction: "inspect leverage readback before any retry",
          lineageId: lineage.value.lineageId,
        });
      }
      const reread = await this.exchange.readState({
        instrument: review.input.symbol,
      });
      if (!reread.ok)
        return fail(
          domainError(
            "UNRESOLVED_STATE",
            failureFromExchange(reread.error).message,
          ),
        );
      const rereadValidation = sameApprovedAuthority(
        review.state,
        reread.value,
        review.plan,
        this.clock,
        true,
      );
      if (!rereadValidation.ok || !isOne(reread.value.leverage.effective)) {
        const raised = this.persistence.raiseHalt(
          authority,
          rereadValidation.ok
            ? "Demo leverage readback is not 1x"
            : rereadValidation.error.message,
          this.clock.now(),
        );
        if (!raised.ok) return raised;
        return outcome(review, reread.value, {
          verdict: "HALTED",
          reasonCode: rereadValidation.ok
            ? "LEVERAGE_UNPROVEN"
            : rereadValidation.error.code,
          nextAction:
            "rebuild and re-approve after the leverage state is stable",
          lineageId: lineage.value.lineageId,
        });
      }
      current = reread.value;
    }

    const ownedIntent = this.persistence.prepareOwnedIntent({
      authority,
      lineageId: lineage.value.lineageId,
      intentId: review.plan.intent.intentId,
      planHash: review.plan.plan.materialHash,
      clientOrderId: review.plan.clientOrderId,
      now: this.clock.now(),
      preparedAt: this.clock.now(),
    });
    if (!ownedIntent.ok) return ownedIntent;
    const dispatchAt = this.fenceForWrite(authority, review);
    if (!dispatchAt.ok) {
      return outcome(review, current, {
        verdict:
          dispatchAt.error.code === "PLAN_EXPIRED" ? "DECLINED" : "HALTED",
        reasonCode: dispatchAt.error.code,
        nextAction:
          dispatchAt.error.code === "PLAN_EXPIRED"
            ? "prepare a fresh review and approve it before expiry"
            : "reconcile the current lease and Demo state before retrying",
        lineageId: lineage.value.lineageId,
      });
    }
    const acknowledgement = await this.exchange.createOrder({
      intent: review.plan.intent,
      clientOrderId: review.plan.clientOrderId,
      timeInForce: "GTC",
      reduceOnly: false,
    });
    const attemptId = attemptIdFor(
      lineage.value.lineageId,
      review.plan.clientOrderId,
    );
    if (!attemptId.ok) return attemptId;
    const knownRejected =
      !acknowledgement.ok &&
      (acknowledgement.error.kind === "permission" ||
        acknowledgement.error.kind === "precondition" ||
        acknowledgement.error.kind === "exchange");
    const attempt = createExecutionAttempt({
      attemptId: attemptId.value,
      planHash: review.plan.plan.materialHash,
      intentId: review.plan.intent.intentId,
      clientOrderId: review.plan.clientOrderId,
      submittedAt: dispatchAt.value,
      acknowledgement: acknowledgement.ok
        ? acknowledgement.value.status
        : knownRejected
          ? "rejected"
          : "pending",
      terminalStatus:
        acknowledgement.ok || !knownRejected ? "unverified" : "rejected",
      ...(acknowledgement.ok &&
      acknowledgement.value.exchangeOrderId === undefined
        ? {}
        : acknowledgement.ok
          ? { exchangeOrderId: acknowledgement.value.exchangeOrderId }
          : {}),
    });
    if (!attempt.ok) return attempt;
    const appendedAttempt = this.persistence.appendAttempt({
      authority,
      lineageId: lineage.value.lineageId,
      attempt: attempt.value,
      dispatchedAt: this.clock.now(),
    });
    if (!appendedAttempt.ok) return appendedAttempt;
    const acknowledgementStatus = attempt.value.acknowledgement;
    if (!acknowledgement.ok && knownRejected) {
      const failed = reconcileAttempt(
        attempt.value,
        undefined,
        review.plan.plan,
      );
      if (!failed.ok) return failed;
      const recorded = this.persistence.appendReconciliation({
        authority,
        lineageId: lineage.value.lineageId,
        result: failed.value,
        recordedAt: this.clock.now(),
      });
      if (!recorded.ok) return recorded;
      const released = this.persistence.releaseLease(authority);
      if (!released.ok) return released;
      return outcome(review, current, {
        verdict: "NOT_READY",
        reasonCode: `EXCHANGE_${acknowledgement.error.kind.toUpperCase()}`,
        nextAction: failureFromExchange(acknowledgement.error).nextAction,
        lineageId: lineage.value.lineageId,
        acknowledgement: attempt.value.acknowledgement,
        reconciliationStatus: failed.value.status,
      });
    }
    const recoveryDependencies = {
      exchange: this.exchange,
      persistence: this.persistence,
      authority,
      clock: this.clock,
      ...(this.ingestAccounting === undefined
        ? {}
        : { ingestAccounting: this.ingestAccounting }),
    };
    const recovered = await recoverPriorDemoRuns(recoveryDependencies);
    if (!recovered.ok) return recovered;
    const runs = this.persistence.readRuns();
    if (!runs.ok) return runs;
    const currentRun = runs.value.find(
      (candidate) => candidate.lineage.lineageId === lineage.value.lineageId,
    );
    if (currentRun === undefined) {
      return fail(
        domainError(
          "PERSISTENCE_INTEGRITY",
          "the committed Demo lineage disappeared before reconciliation",
        ),
      );
    }
    const latest =
      currentRun.reconciliations[currentRun.reconciliations.length - 1]?.result;
    if (latest === undefined) {
      return outcome(review, current, {
        verdict: "HALTED",
        reasonCode: "UNRESOLVED_RECONCILIATION",
        nextAction: "retain HALT and reconcile the original client identity",
        lineageId: lineage.value.lineageId,
        acknowledgement: acknowledgementStatus,
      });
    }
    if (latest.status === "PENDING" || latest.status === "PARTIAL") {
      return outcome(review, current, {
        verdict: "CONFIRMED_OPEN",
        reasonCode: latest.status,
        nextAction:
          "owned Demo state remains open; reconcile before any new exposure",
        lineageId: lineage.value.lineageId,
        ...(latest.exchangeOrderId === undefined
          ? {}
          : { exchangeOrderId: latest.exchangeOrderId }),
        acknowledgement: acknowledgementStatus,
        reconciliationStatus: latest.status,
      });
    }
    if (latest.status !== "RECONCILED") {
      return outcome(review, current, {
        verdict: "UNRESOLVED",
        reasonCode: latest.status,
        nextAction: "retain HALT and reconcile the original client identity",
        lineageId: lineage.value.lineageId,
        ...(latest.exchangeOrderId === undefined
          ? {}
          : { exchangeOrderId: latest.exchangeOrderId }),
        acknowledgement: acknowledgementStatus,
        reconciliationStatus: latest.status,
      });
    }
    const finalHalt = this.persistence.readHalt();
    if (!finalHalt.ok) return finalHalt;
    if (!recovered.value.safeToProceed || finalHalt.value.active) {
      return outcome(review, current, {
        verdict: "UNRESOLVED",
        reasonCode: "ACCOUNTING_OR_PROTECTION_UNPROVEN",
        nextAction: "retain HALT and reconcile the original filled order",
        lineageId: lineage.value.lineageId,
        ...(latest.exchangeOrderId === undefined
          ? {}
          : { exchangeOrderId: latest.exchangeOrderId }),
        acknowledgement: acknowledgementStatus,
        reconciliationStatus: "UNRESOLVED",
      });
    }
    const released = this.persistence.releaseLease(authority);
    if (!released.ok) return released;
    return outcome(review, current, {
      verdict: "CONFIRMED_FILLED",
      reasonCode: "RECONCILED",
      nextAction:
        "the expected owned Demo position remains open for later management",
      lineageId: lineage.value.lineageId,
      ...(latest.exchangeOrderId === undefined
        ? {}
        : { exchangeOrderId: latest.exchangeOrderId }),
      acknowledgement: acknowledgementStatus,
      reconciliationStatus: latest.status,
    });
  }

  public async run(
    input: unknown,
    approve: (review: DemoEntryReview) => Promise<boolean> | boolean,
  ): Promise<Result<DemoEntryOutcome>> {
    const review = await this.prepare(input);
    if (!review.ok) return review;
    return this.execute(review.value, await approve(review.value));
  }
}

export const createDemoEntryUseCase = (options: DemoEntryUseCaseOptions) =>
  new DemoEntryUseCase(options);
