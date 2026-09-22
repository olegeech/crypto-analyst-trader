import {
  encodeCanonicalArtifact,
  rehydrateArtifact,
} from "../domain/identity/canonical-artifact.js";
import { hashCanonical } from "../domain/identity/plan-hash.js";
import {
  createExecutionAttempt,
  type ExecutionAttempt,
} from "../domain/execution/execution-attempt.js";
import {
  reconcileAttempt,
  rehydrateReconciliationResult,
  type ReconciliationResult,
} from "../domain/execution/reconciliation.js";
import { createClearanceEvidence } from "../domain/execution/clearance-evidence.js";
import type { ExchangeOrderObservation } from "../domain/execution/exchange-order.js";
import type { ExecutionPlan } from "../domain/planning/execution-plan.js";
import { domainError } from "../domain/shared/errors.js";
import { type Clock, type UtcTimestamp } from "../domain/shared/time.js";
import { fail, ok, type Result } from "../domain/shared/result.js";
import type {
  ExchangeExecutionPort,
  ExchangeFillObservation,
  ExchangeReadState,
} from "../ports/exchange-execution.js";
import type {
  AppendIdentityBindingRequest,
  IngestionFact,
  LeaseAuthority,
  PersistencePort,
  PersistenceRunSnapshot,
} from "../ports/persistence.js";

export interface AccountingIngestInput {
  readonly persistence: PersistencePort;
  readonly lineageId: string;
  readonly attemptId: string;
  readonly fills: readonly ExchangeFillObservation[];
  readonly observedAt: UtcTimestamp;
}

export interface AccountingIngestResult {
  readonly fillCount: number;
  readonly feeCount: number;
  readonly ledgerCount: number;
}

export type AccountingIngestor = (
  input: AccountingIngestInput,
) => Result<AccountingIngestResult>;

export interface DemoRecoveryDependencies {
  readonly exchange: ExchangeExecutionPort;
  readonly persistence: PersistencePort;
  readonly authority: LeaseAuthority;
  readonly clock: Clock;
  readonly ingestAccounting?: AccountingIngestor;
}

export interface DemoRecoverySummary {
  readonly safeToProceed: boolean;
  readonly clearedHalt: boolean;
  readonly reconciledLineages: number;
  readonly blockedLineages: number;
  readonly unresolvedLineages: readonly string[];
}

export interface RecoveredLineage {
  readonly lineageId: string;
  readonly status:
    "RECONCILED" | "PENDING" | "PARTIAL" | "FAILED" | "UNRESOLVED";
  readonly exchangeOrderId?: string;
}

function shortIdentity(prefix: string, input: unknown): Result<string> {
  const digest = hashCanonical(input);
  if (!digest.ok) return digest;
  return ok(`${prefix}-${digest.value.slice(7, 23)}`);
}

function latestReconciliation(
  run: PersistenceRunSnapshot,
): ReconciliationResult | undefined {
  return run.reconciliations[run.reconciliations.length - 1]?.result;
}

function leverageIsOne(state: ExchangeReadState): boolean {
  return state.leverage.effective.toString() === "1";
}

function latestAttempt(
  run: PersistenceRunSnapshot,
  intentId: string,
): PersistenceRunSnapshot["attempts"][number] | undefined {
  const attempts = run.attempts.filter(
    (candidate) => candidate.attempt.intentId === intentId,
  );
  return attempts[attempts.length - 1];
}

function bindingFor(
  run: PersistenceRunSnapshot,
  attemptId: string,
): PersistenceRunSnapshot["identityBindings"][number] | undefined {
  return run.identityBindings.find(
    (binding) => binding.attemptId === attemptId,
  );
}

function sameScope(
  left: PersistencePort["scope"],
  right: PersistencePort["scope"],
): boolean {
  return (
    left.exchange === right.exchange &&
    left.environment === right.environment &&
    left.accountId === right.accountId &&
    left.category === right.category &&
    left.positionMode === right.positionMode
  );
}

function observationFact(
  persistence: PersistencePort,
  lineageId: string,
  role: "parent" | "protection",
  observation: ExchangeOrderObservation,
): Result<IngestionFact> {
  const envelope = encodeCanonicalArtifact("exchange-order", observation);
  if (!envelope.ok) return envelope;
  const digest = hashCanonical({
    lineageId,
    role,
    exchangeOrderId: observation.exchangeOrderId,
    clientOrderId: observation.clientOrderId,
    status: observation.status,
    filledQuantity: observation.filledQuantity,
    ...(observation.parentOrderLinkId === undefined
      ? {}
      : { parentOrderLinkId: observation.parentOrderLinkId }),
  });
  if (!digest.ok) return digest;
  const factIdentity = `exchange-${role}-${lineageId}-${digest.value.slice(7, 23)}`;
  const artifactId = shortIdentity("observation", {
    lineageId,
    role,
    canonicalHash: envelope.value.canonicalHash,
  });
  if (!artifactId.ok) return artifactId;
  return ok({
    factKind: "exchange-observation",
    eventIdentity: factIdentity,
    scope: persistence.scope,
    observedAt: observation.observedAt,
    canonicalHash: envelope.value.canonicalHash,
    artifact: {
      artifactId: artifactId.value,
      artifactKind: "exchange-order",
      envelope: envelope.value,
    },
  });
}

function appendObservationFact(
  persistence: PersistencePort,
  lineageId: string,
  role: "parent" | "protection",
  observation: ExchangeOrderObservation,
): Result<void> {
  const fact = observationFact(persistence, lineageId, role, observation);
  if (!fact.ok) return fact;
  const stored = persistence.ingestFact(fact.value);
  return stored.ok ? ok(undefined) : stored;
}

function validateCandidate(
  observation: ExchangeOrderObservation,
  plan: ExecutionPlan,
  attempt: ExecutionAttempt,
): Result<void> {
  const intent = plan.material.orderIntents.find(
    (candidate) => candidate.intentId === attempt.intentId,
  );
  if (
    intent === undefined ||
    observation.clientOrderId !== attempt.clientOrderId ||
    observation.instrument !== intent.instrument ||
    observation.side !== intent.side ||
    observation.requestedQuantity.compare(intent.quantity) !== 0 ||
    Date.parse(observation.observedAt) < Date.parse(attempt.submittedAt)
  ) {
    return fail(
      domainError(
        "OWNERSHIP_MISMATCH",
        "exchange observation does not match the durable owned intent",
      ),
    );
  }
  return ok(undefined);
}

function candidateBindingRequest(
  persistence: PersistencePort,
  authority: LeaseAuthority,
  run: PersistenceRunSnapshot,
  attempt: ExecutionAttempt,
  observation: ExchangeOrderObservation,
  boundAt: UtcTimestamp,
): AppendIdentityBindingRequest {
  const intent = run.plan.material.orderIntents.find(
    (candidate) => candidate.intentId === attempt.intentId,
  )!;
  return {
    authority,
    lineageId: run.lineage.lineageId,
    attemptId: attempt.attemptId,
    planHash: attempt.planHash,
    intentId: attempt.intentId,
    clientOrderId: attempt.clientOrderId,
    candidates: [
      {
        exchangeOrderId: observation.exchangeOrderId,
        clientOrderId: observation.clientOrderId,
        instrument: observation.instrument,
        side: observation.side,
        requestedQuantity: intent.quantity,
        ownershipContext: {
          exchange: persistence.scope.exchange,
          environment: persistence.scope.environment,
          accountId: persistence.scope.accountId,
          category: persistence.scope.category,
          positionMode: persistence.scope.positionMode,
          lineageId: run.lineage.lineageId,
          intentId: attempt.intentId,
          attemptId: attempt.attemptId,
        },
      },
    ],
    boundAt,
  };
}

function unresolvedResult(
  attempt: ExecutionAttempt,
  observedAt: UtcTimestamp,
  exchangeOrderId?: string,
): Result<ReconciliationResult> {
  return rehydrateReconciliationResult({
    attemptId: attempt.attemptId,
    intentId: attempt.intentId,
    planHash: attempt.planHash,
    clientOrderId: attempt.clientOrderId,
    status: "UNRESOLVED",
    observedAt,
    ...(exchangeOrderId === undefined ? {} : { exchangeOrderId }),
  });
}

function expectedAccounting(
  facts: readonly IngestionFact[],
  run: PersistenceRunSnapshot,
): boolean {
  const attemptIds = new Set(
    run.attempts.map((attempt) => attempt.attempt.attemptId),
  );
  const fillIds = new Set<string>();
  for (const fact of facts) {
    if (fact.factKind !== "fill") continue;
    const fill = rehydrateArtifact("fill", fact.artifact.envelope);
    if (
      fill.ok &&
      "attemptId" in fill.value &&
      "fillId" in fill.value &&
      typeof fill.value.attemptId === "string" &&
      typeof fill.value.fillId === "string" &&
      attemptIds.has(fill.value.attemptId)
    )
      fillIds.add(fill.value.fillId);
  }
  if (fillIds.size === 0) return false;
  return facts.some((fact) => {
    if (fact.factKind !== "ledger-entry") return false;
    const ledger = rehydrateArtifact("ledger-entry", fact.artifact.envelope);
    return (
      ledger.ok &&
      "kind" in ledger.value &&
      "referenceId" in ledger.value &&
      ledger.value.kind === "fill" &&
      typeof ledger.value.referenceId === "string" &&
      fillIds.has(ledger.value.referenceId)
    );
  });
}

function expectedProtection(
  facts: readonly IngestionFact[],
  lineageId: string,
): boolean {
  return facts.some(
    (fact) =>
      fact.factKind === "exchange-observation" &&
      fact.eventIdentity.includes(lineageId) &&
      fact.eventIdentity.includes("protection"),
  );
}

async function appendReconciliation(
  dependencies: DemoRecoveryDependencies,
  lineageId: string,
  result: ReconciliationResult,
): Promise<Result<void>> {
  const appended = dependencies.persistence.appendReconciliation({
    authority: dependencies.authority,
    lineageId,
    result,
    recordedAt: dependencies.clock.now(),
  });
  return appended.ok ? ok(undefined) : appended;
}

async function reconcileRun(
  dependencies: DemoRecoveryDependencies,
  run: PersistenceRunSnapshot,
): Promise<Result<RecoveredLineage>> {
  if (!sameScope(run.lineage.scope, dependencies.persistence.scope)) {
    return fail(
      domainError(
        "PERSISTENCE_ENVIRONMENT",
        "recovery run is outside the exact Demo persistence scope",
      ),
    );
  }
  if (run.ownedIntents.length === 0) {
    for (const intent of run.plan.material.orderIntents) {
      const state = await dependencies.exchange.readState({
        instrument: intent.instrument,
      });
      if (!state.ok || !leverageIsOne(state.value)) {
        return ok({ lineageId: run.lineage.lineageId, status: "UNRESOLVED" });
      }
    }
    return ok({ lineageId: run.lineage.lineageId, status: "FAILED" });
  }
  if (run.ownedIntents.length !== 1) {
    return fail(
      domainError(
        "UNRESOLVED_STATE",
        "managed Demo recovery found more than one owned intent in one lineage",
      ),
    );
  }
  const intentRecord = run.ownedIntents[0]!;
  const planIntent = run.plan.material.orderIntents.find(
    (intent) => intent.intentId === intentRecord.intentId,
  );
  if (planIntent === undefined) {
    return fail(
      domainError("OWNERSHIP_MISMATCH", "owned intent is absent from its plan"),
    );
  }
  let attemptRecord = latestAttempt(run, intentRecord.intentId);
  if (attemptRecord === undefined) {
    const attemptId = shortIdentity("attempt", {
      lineageId: run.lineage.lineageId,
      intentId: intentRecord.intentId,
      clientOrderId: intentRecord.clientOrderId,
    });
    if (!attemptId.ok) return attemptId;
    const attempt = createExecutionAttempt({
      attemptId: attemptId.value,
      planHash: intentRecord.planHash,
      intentId: intentRecord.intentId,
      clientOrderId: intentRecord.clientOrderId,
      submittedAt: intentRecord.preparedAt,
      acknowledgement: "pending",
      terminalStatus: "unverified",
    });
    if (!attempt.ok) return attempt;
    const appended = dependencies.persistence.appendAttempt({
      authority: dependencies.authority,
      lineageId: run.lineage.lineageId,
      attempt: attempt.value,
      dispatchedAt: dependencies.clock.now(),
    });
    if (!appended.ok) return appended;
    attemptRecord = appended.value;
  }
  if (
    run.attempts.filter(
      (item) => item.attempt.intentId === intentRecord.intentId,
    ).length > 1
  ) {
    return fail(
      domainError(
        "UNRESOLVED_STATE",
        "managed Demo recovery found multiple attempts for one owned intent",
      ),
    );
  }

  const storedAttempt = attemptRecord.attempt;
  const binding = bindingFor(run, storedAttempt.attemptId);
  let attempt = storedAttempt;
  let exchangeOrderId =
    storedAttempt.exchangeOrderId ?? binding?.exchangeOrderId;
  let order: ExchangeOrderObservation | undefined;
  if (exchangeOrderId !== undefined) {
    const observed = await dependencies.exchange.observeOrder({
      instrument: planIntent.instrument,
      clientOrderId: storedAttempt.clientOrderId,
      exchangeOrderId,
    });
    if (!observed.ok) {
      const unresolved = unresolvedResult(
        storedAttempt,
        dependencies.clock.now(),
        exchangeOrderId,
      );
      if (!unresolved.ok) return unresolved;
      const appended = await appendReconciliation(
        dependencies,
        run.lineage.lineageId,
        unresolved.value,
      );
      if (!appended.ok) return appended;
      return ok({
        lineageId: run.lineage.lineageId,
        status: "UNRESOLVED",
        exchangeOrderId,
      });
    }
    order = observed.value;
  } else {
    const observed = await dependencies.exchange.observeOrder({
      instrument: planIntent.instrument,
      clientOrderId: storedAttempt.clientOrderId,
    });
    if (!observed.ok) {
      const unresolved = unresolvedResult(
        storedAttempt,
        dependencies.clock.now(),
      );
      if (!unresolved.ok) return unresolved;
      const appended = await appendReconciliation(
        dependencies,
        run.lineage.lineageId,
        unresolved.value,
      );
      if (!appended.ok) return appended;
      return ok({ lineageId: run.lineage.lineageId, status: "UNRESOLVED" });
    }
    const valid = validateCandidate(observed.value, run.plan, storedAttempt);
    if (!valid.ok) {
      const unresolved = unresolvedResult(
        storedAttempt,
        dependencies.clock.now(),
      );
      if (!unresolved.ok) return unresolved;
      const appended = await appendReconciliation(
        dependencies,
        run.lineage.lineageId,
        unresolved.value,
      );
      if (!appended.ok) return appended;
      return ok({ lineageId: run.lineage.lineageId, status: "UNRESOLVED" });
    }
    const bound = dependencies.persistence.appendIdentityBinding(
      candidateBindingRequest(
        dependencies.persistence,
        dependencies.authority,
        run,
        storedAttempt,
        observed.value,
        dependencies.clock.now(),
      ),
    );
    if (!bound.ok) return bound;
    if (bound.value.status !== "BOUND") {
      const unresolved = unresolvedResult(
        storedAttempt,
        dependencies.clock.now(),
      );
      if (!unresolved.ok) return unresolved;
      const appended = await appendReconciliation(
        dependencies,
        run.lineage.lineageId,
        unresolved.value,
      );
      if (!appended.ok) return appended;
      return ok({ lineageId: run.lineage.lineageId, status: "UNRESOLVED" });
    }
    exchangeOrderId = bound.value.binding.exchangeOrderId;
    order = observed.value;
    const enrichedAttempt = createExecutionAttempt({
      ...storedAttempt,
      exchangeOrderId,
    });
    if (!enrichedAttempt.ok) return enrichedAttempt;
    attempt = enrichedAttempt.value;
  }
  if (order === undefined) {
    return fail(
      domainError("UNRESOLVED_STATE", "order observation is missing"),
    );
  }
  const validOrder = validateCandidate(order, run.plan, attempt);
  if (!validOrder.ok) {
    const unresolved = unresolvedResult(
      attempt,
      dependencies.clock.now(),
      exchangeOrderId,
    );
    if (!unresolved.ok) return unresolved;
    const appended = await appendReconciliation(
      dependencies,
      run.lineage.lineageId,
      unresolved.value,
    );
    if (!appended.ok) return appended;
    return ok({
      lineageId: run.lineage.lineageId,
      status: "UNRESOLVED",
      exchangeOrderId,
    });
  }
  const parentFact = appendObservationFact(
    dependencies.persistence,
    run.lineage.lineageId,
    "parent",
    order,
  );
  if (!parentFact.ok) return parentFact;

  let result = reconcileAttempt(attempt, order, run.plan);
  if (!result.ok) return result;
  let accountingOkay = true;
  let protectionOkay = true;
  if (order.status === "filled") {
    const protection = await dependencies.exchange.listAttachedProtection({
      instrument: order.instrument,
      parentClientOrderId: order.clientOrderId,
    });
    if (!protection.ok) {
      accountingOkay = false;
      protectionOkay = false;
    } else {
      protectionOkay = protection.value.length > 0;
      for (const child of protection.value) {
        const fact = appendObservationFact(
          dependencies.persistence,
          run.lineage.lineageId,
          "protection",
          child,
        );
        if (!fact.ok) return fact;
      }
    }
    const fills = await dependencies.exchange.listFills({
      instrument: order.instrument,
      clientOrderId: order.clientOrderId,
      exchangeOrderId: order.exchangeOrderId,
    });
    if (!fills.ok || fills.value.length === 0) {
      accountingOkay = false;
    } else {
      const total = fills.value.reduce(
        (sum, fill) => sum.add(fill.quantity),
        order.filledQuantity.subtract(order.filledQuantity),
      );
      if (total.compare(order.filledQuantity) !== 0) accountingOkay = false;
      if (dependencies.ingestAccounting === undefined) {
        accountingOkay = false;
      } else {
        const ingested = dependencies.ingestAccounting({
          persistence: dependencies.persistence,
          lineageId: run.lineage.lineageId,
          attemptId: attempt.attemptId,
          fills: fills.value,
          observedAt: dependencies.clock.now(),
        });
        if (!ingested.ok) return ingested;
      }
    }
    if (!accountingOkay || !protectionOkay) {
      const unresolved = unresolvedResult(
        attempt,
        dependencies.clock.now(),
        order.exchangeOrderId,
      );
      if (!unresolved.ok) return unresolved;
      result = unresolved;
    }
  } else if (order.status === "partially-filled") {
    const fills = await dependencies.exchange.listFills({
      instrument: order.instrument,
      clientOrderId: order.clientOrderId,
      exchangeOrderId: order.exchangeOrderId,
    });
    if (
      fills.ok &&
      fills.value.length > 0 &&
      dependencies.ingestAccounting !== undefined
    ) {
      const ingested = dependencies.ingestAccounting({
        persistence: dependencies.persistence,
        lineageId: run.lineage.lineageId,
        attemptId: attempt.attemptId,
        fills: fills.value,
        observedAt: dependencies.clock.now(),
      });
      if (!ingested.ok) return ingested;
    }
  }
  const appended = await appendReconciliation(
    dependencies,
    run.lineage.lineageId,
    result.value,
  );
  if (!appended.ok) return appended;
  return ok({
    lineageId: run.lineage.lineageId,
    status: result.value.status,
    ...(order.exchangeOrderId === undefined
      ? {}
      : { exchangeOrderId: order.exchangeOrderId }),
  });
}

async function allLineagesSafe(
  dependencies: DemoRecoveryDependencies,
  runs: readonly PersistenceRunSnapshot[],
  facts: readonly IngestionFact[],
): Promise<boolean> {
  for (const run of runs) {
    if (run.ownedIntents.length === 0) {
      for (const intent of run.plan.material.orderIntents) {
        const state = await dependencies.exchange.readState({
          instrument: intent.instrument,
        });
        if (!state.ok || !leverageIsOne(state.value)) return false;
      }
      continue;
    }
    const result = latestReconciliation(run);
    if (
      result === undefined ||
      (result.status !== "RECONCILED" && result.status !== "FAILED")
    ) {
      return false;
    }
    if (
      result.status !== "FAILED" &&
      (!expectedAccounting(facts, run) ||
        !expectedProtection(facts, run.lineage.lineageId))
    ) {
      return false;
    }
  }
  return true;
}

async function clearHaltIfSafe(
  dependencies: DemoRecoveryDependencies,
): Promise<Result<boolean>> {
  const halt = dependencies.persistence.readHalt();
  if (!halt.ok) return halt;
  if (!halt.value.active) return ok(false);
  const runs = dependencies.persistence.readRuns();
  if (!runs.ok) return runs;
  const facts = dependencies.persistence.readFacts();
  if (!facts.ok) return facts;
  if (!(await allLineagesSafe(dependencies, runs.value, facts.value)))
    return ok(false);
  const timestamp = dependencies.clock.now();
  const clearance = createClearanceEvidence({
    evidenceVersion: "clearance/v1",
    actor: "demo-operator",
    source: "application/demo-recovery",
    timestamp,
    reason: "all exact-scope lineages are terminal, accounted and protected",
    affectedLineageRevision: runs.value.length,
    affectedReconciliationRevision: runs.value.reduce(
      (count, run) => count + run.reconciliations.length,
      0,
    ),
  });
  if (!clearance.ok) return clearance;
  const cleared = dependencies.persistence.clearHalt({
    authority: dependencies.authority,
    evidence: clearance.value,
    expectedHaltRevision: halt.value.revision,
  });
  if (!cleared.ok) return cleared;
  return ok(true);
}

export async function recoverPriorDemoRuns(
  dependencies: DemoRecoveryDependencies,
): Promise<Result<DemoRecoverySummary>> {
  const initial = dependencies.persistence.readRuns();
  if (!initial.ok) return initial;
  const unresolved: string[] = [];
  let reconciledLineages = 0;
  let blockedLineages = 0;
  for (const run of initial.value) {
    const latest = latestReconciliation(run);
    if (run.ownedIntents.length > 0 && latest?.status === "FAILED") {
      reconciledLineages += 1;
      continue;
    }
    const recovered = await reconcileRun(dependencies, run);
    if (!recovered.ok) return recovered;
    if (
      recovered.value.status === "RECONCILED" ||
      recovered.value.status === "FAILED"
    ) {
      reconciledLineages += 1;
    } else {
      blockedLineages += 1;
      unresolved.push(recovered.value.lineageId);
    }
  }
  const cleared = await clearHaltIfSafe(dependencies);
  if (!cleared.ok) return cleared;
  const halt = dependencies.persistence.readHalt();
  if (!halt.ok) return halt;
  return ok({
    safeToProceed: unresolved.length === 0 && !halt.value.active,
    clearedHalt: cleared.value,
    reconciledLineages,
    blockedLineages,
    unresolvedLineages: Object.freeze(unresolved),
  });
}

export const recoverDemoRuns = recoverPriorDemoRuns;
