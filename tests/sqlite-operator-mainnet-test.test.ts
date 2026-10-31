import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openSqliteConnection } from "../src/adapters/sqlite/connection.js";
import { createSqliteExecutionStore } from "../src/adapters/sqlite/execution-store.js";
import { createSqliteOperatorMainnetTestStore } from "../src/adapters/sqlite/operator-mainnet-test-store.js";
import { resolveOperatorMainnetTradeCommand } from "../src/adapters/sqlite/operator-mainnet-test-lookup.js";
import {
  createOperatorMainnetQuote,
  createOperatorMainnetTestApproval,
  createOperatorMainnetTestPlan,
  deriveOperatorMainnetTestSourceId,
  type OperatorMainnetTestPlan,
} from "../src/domain/execution/operator-mainnet-test-plan.js";
import {
  createOperatorMainnetTradeCommandBinding,
  createOperatorMainnetTradeCommandPlan,
  createOperatorMainnetTradeCommandReceipt,
} from "../src/domain/execution/operator-mainnet-trade-command.js";
import { createOperatorMainnetRecoveryAttestation } from "../src/domain/execution/operator-mainnet-recovery.js";
import { createInstrumentConstraints } from "../src/domain/market/instrument-constraints.js";
import {
  canonicalSerialize,
  type PlanHash,
} from "../src/domain/identity/canonical-serialization.js";
import {
  parseUtcTimestamp,
  type UtcTimestamp,
} from "../src/domain/shared/time.js";
import type { Result } from "../src/domain/shared/result.js";
import type { PersistenceScope } from "../src/ports/persistence.js";
import type { OperatorMainnetTestSnapshot } from "../src/ports/operator-mainnet-test-persistence.js";
import { CURRENT_SCHEMA_VERSION } from "../src/adapters/sqlite/migrations.js";

const runtime = { nodeVersion: "22.22.3", sqliteVersion: "3.51.3" } as const;
const NOW = "2026-10-22T10:01:00.000Z" as UtcTimestamp;
const ACCOUNT = `sha256:${"a".repeat(64)}`;
const temporaryRoots: string[] = [];

test.after(() => {
  for (const root of temporaryRoots)
    rmSync(root, { recursive: true, force: true });
});

function value<T>(result: Result<T>): T {
  if (!result.ok)
    throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function timestamp(text: string): UtcTimestamp {
  return value(parseUtcTimestamp(text));
}

function plan(
  nonce = "operator-test-01",
  recoveryAttestationHash?: PlanHash,
  preparedAt: UtcTimestamp = NOW,
) {
  const preparedAtMs = Date.parse(preparedAt);
  const quote = value(
    createOperatorMainnetQuote({
      symbol: "DOGEUSDT",
      exchange: "bybit",
      environment: "mainnet",
      category: "linear",
      origin: "https://api.bybit.com",
      observedAt: new Date(preparedAtMs - 10).toISOString(),
      collectionStartedAt: new Date(preparedAtMs - 20).toISOString(),
      collectionCompletedAt: new Date(preparedAtMs - 5).toISOString(),
      bid: "0.08869",
      ask: "0.08870",
      last: "0.08869",
    }),
  );
  const constraints = value(
    createInstrumentConstraints({
      instrument: "DOGEUSDT",
      version: "bybit-v5:public-instrument/v2",
      priceTickSize: "0.0001",
      quantityStep: "0.1",
      minQuantity: "1",
      minNotional: "5",
      minPrice: "0.0001",
      maxPrice: "100",
      maxLimitQuantity: "100000",
    }),
  );
  return value(
    createOperatorMainnetTestPlan({
      accountIdentityHash: ACCOUNT,
      symbol: "DOGEUSDT",
      nonce,
      allocation: "10",
      grossNotionalCap: "8",
      maxDeviationBps: "10",
      quote,
      warningCodes: [],
      constraints,
      preparedAt,
      ...(recoveryAttestationHash === undefined
        ? {}
        : { recoveryAttestationHash }),
    }),
  );
}

function approval(valuePlan = plan(), approvedAt = valuePlan.preparedAt) {
  return value(
    createOperatorMainnetTestApproval({
      plan: valuePlan,
      planHash: valuePlan.contentHash,
      actor: "operator-01",
      consent: true,
      approvedAt,
    }),
  );
}

function apiStatusEvidence(observedAt: UtcTimestamp) {
  return {
    schemaVersion: "operator-mainnet-test-status-evidence/v1",
    observedAt,
    exchangeReads: 1,
  };
}

function exactPayload(
  valuePlan: Pick<
    OperatorMainnetTestPlan,
    "symbol" | "entry" | "clientOrderId"
  >,
): string {
  return JSON.stringify({
    category: "linear",
    symbol: valuePlan.symbol,
    side: "Buy",
    orderType: "Limit",
    qty: valuePlan.entry.quantity.toString(),
    price: valuePlan.entry.limitPrice.toString(),
    timeInForce: "GTC",
    positionIdx: 0,
    orderLinkId: valuePlan.clientOrderId,
    reduceOnly: false,
    takeProfit: valuePlan.entry.takeProfit.triggerPrice.toString(),
    tpslMode: "Partial",
    tpOrderType: "Market",
    tpTriggerBy: "LastPrice",
  });
}

function tradeCommand(
  commandId = "trade-command-01",
  bid = "0.08869",
  savedReceipt?: ReturnType<
    typeof createOperatorMainnetTradeCommandReceipt
  > extends Result<infer T>
    ? T
    : never,
) {
  const receipt =
    savedReceipt ??
    value(
      createOperatorMainnetTradeCommandReceipt({
        commandId,
        actorIdentityHash: `sha256:${"b".repeat(64)}`,
        accountIdentityHash: ACCOUNT,
        symbol: "DOGEUSDT",
        allocation: "10",
        grossNotionalCap: "8",
        maxDeviationBps: "10",
        acceptedAt: NOW,
      }),
    );
  const preparedAtMs = Date.parse(NOW);
  const quote = value(
    createOperatorMainnetQuote({
      symbol: "DOGEUSDT",
      exchange: "bybit",
      environment: "mainnet",
      category: "linear",
      origin: "https://api.bybit.com",
      observedAt: new Date(preparedAtMs - 10).toISOString(),
      collectionStartedAt: new Date(preparedAtMs - 20).toISOString(),
      collectionCompletedAt: new Date(preparedAtMs - 5).toISOString(),
      bid,
      ask: "0.08870",
      last: bid,
    }),
  );
  const constraints = value(
    createInstrumentConstraints({
      instrument: "DOGEUSDT",
      version: "bybit-v5:public-instrument/v2",
      priceTickSize: "0.0001",
      quantityStep: "0.1",
      minQuantity: "1",
      minNotional: "5",
      minPrice: "0.0001",
      maxPrice: "100",
      maxLimitQuantity: "100000",
    }),
  );
  const commandPlan = value(
    createOperatorMainnetTradeCommandPlan({
      receipt,
      quote,
      warningCodes: [],
      constraints,
      preparedAt: NOW,
    }),
  );
  const payloadJson = exactPayload(commandPlan);
  const payloadHashValue = payloadHash(payloadJson);
  const binding = value(
    createOperatorMainnetTradeCommandBinding({
      receipt,
      plan: commandPlan,
      createPayloadHash: payloadHashValue,
      boundAt: NOW,
    }),
  );
  return {
    receipt,
    plan: commandPlan,
    binding,
    payloadJson,
    payloadHash: payloadHashValue,
  };
}

function payloadHash(payload: string): PlanHash {
  return `sha256:${createHash("sha256").update(payload, "utf8").digest("hex")}` as PlanHash;
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "operator-mainnet-test-store-"));
  temporaryRoots.push(root);
  const path = join(root, "mainnet.db");
  const clock = { value: NOW };
  const connection = value(
    openSqliteConnection({
      environment: "mainnet",
      databasePath: path,
      runtime,
      clock: { now: () => clock.value },
    }),
  );
  const scope: PersistenceScope = {
    exchange: "bybit",
    environment: "mainnet",
    accountId: ACCOUNT,
    category: "linear",
    positionMode: "one-way",
  };
  const execution = value(createSqliteExecutionStore(connection, scope));
  const store = value(createSqliteOperatorMainnetTestStore(connection, scope));
  return { root, path, clock, connection, scope, execution, store };
}

function prepare(
  fixture: ReturnType<typeof setup>,
  valuePlan = plan(),
  valueApproval = approval(valuePlan),
  recoveryGrantId?: string,
) {
  const payload = exactPayload(valuePlan);
  return fixture.store.prepareCreateIntent({
    runId: "operator-run-01",
    plan: valuePlan,
    approval: valueApproval,
    payloadJson: payload,
    payloadHash: payloadHash(payload),
    preparedAt: fixture.clock.value,
    ...(recoveryGrantId === undefined ? {} : { recoveryGrantId }),
  });
}

function manualRecoveryAttestation(
  source: OperatorMainnetTestSnapshot,
  takeProfitStatus = "Filled",
) {
  const sourceRevision =
    (source.attempt === undefined ? 0 : 1) +
    source.reconciliations.length +
    source.manualActions.length +
    (source.sourceDisposition === undefined ? 0 : 1);
  return value(
    createOperatorMainnetRecoveryAttestation({
      provenance: "MANUAL_ATTESTED_NOT_API_VERIFIED",
      exchange: "bybit",
      environment: "mainnet",
      accountIdentityHash: source.source.scope.accountId,
      sourceId: source.source.sourceId,
      sourcePlanHash: source.source.planHash,
      sourceIntentId: source.intent.writeIntentId,
      sourceRevision,
      actor: "operator-01",
      observedAt: NOW,
      inspection: {
        accountOpenOrdersInspected: true,
        accountOpenOrders: [],
        accountPositionsInspected: true,
        accountPositions: [],
        sourceOrderHistoryInspected: true,
        sourceOrders: [
          {
            orderId: "exchange-parent-01",
            clientOrderId: source.source.clientOrderId,
            symbol: source.plan.symbol,
            side: "Buy",
            orderType: "Limit",
            quantity: source.plan.entry.quantity.toString(),
            price: source.plan.entry.limitPrice.toString(),
            status: "Filled",
          },
          {
            orderId: "exchange-tp-01",
            symbol: source.plan.symbol,
            side: "Sell",
            orderType: "Market",
            quantity: source.plan.entry.quantity.toString(),
            status: takeProfitStatus,
          },
        ],
        sourceFillsInspected: true,
        sourceFills: [
          {
            executionId: "execution-entry-01",
            orderId: "exchange-parent-01",
            clientOrderId: source.source.clientOrderId,
            symbol: source.plan.symbol,
            side: "Buy",
            quantity: source.plan.entry.quantity.toString(),
            price: source.plan.entry.limitPrice.toString(),
            executedAt: NOW,
          },
          {
            executionId: "execution-exit-01",
            orderId: "exchange-tp-01",
            symbol: source.plan.symbol,
            side: "Sell",
            quantity: source.plan.entry.quantity.toString(),
            price: source.plan.entry.takeProfit.triggerPrice.toString(),
            executedAt: NOW,
          },
        ],
        sourcePositionInspected: true,
        sourcePosition: null,
        targetLeverage: "1",
        sourceTakeProfitInspected: true,
        sourceTakeProfitOrders: [
          {
            orderId: "exchange-tp-01",
            symbol: source.plan.symbol,
            side: "Sell",
            orderType: "Market",
            quantity: source.plan.entry.quantity.toString(),
            status: takeProfitStatus,
          },
        ],
      },
      manualActions: ["position-closed"],
      acceptedUncertainty: ["manual-ui-may-be-stale"],
    }),
  );
}

function saveRecoveryPlan(
  fixture: ReturnType<typeof setup>,
  valuePlan: ReturnType<typeof plan>,
) {
  value(fixture.store.persistPreparedPlan(valuePlan));
  return valuePlan;
}

function createManualRecoveryGrant(
  fixture: ReturnType<typeof setup>,
  source: OperatorMainnetTestSnapshot,
  recoveryPlanNonce = "recovery-plan-01",
) {
  const attestation = manualRecoveryAttestation(source);
  const recoveryPlan = plan(recoveryPlanNonce, attestation.contentHash);
  value(
    fixture.store.persistOperatorMainnetRecoveryAttestation({
      attestation,
      recordedAt: fixture.clock.value,
    }),
  );
  saveRecoveryPlan(fixture, recoveryPlan);
  const grant = value(
    fixture.store.createOperatorMainnetRecoveryGrant({
      sourceId: source.source.sourceId,
      planHash: recoveryPlan.contentHash,
      resolution: {
        kind: "manual-attested",
        attestationHash: attestation.contentHash,
      },
      actor: "operator-01",
      consent: true,
      issuedAt: fixture.clock.value,
    }),
  );
  return { attestation, recoveryPlan, grant };
}

test("operator create intent, canonical artifacts and exact payload commit atomically", () => {
  const fixture = setup();
  const valuePlan = plan();
  const valueApproval = approval(valuePlan);
  const source = value(prepare(fixture, valuePlan, valueApproval));

  assert.equal(source.source.planHash, valuePlan.contentHash);
  assert.deepEqual(source.source.authorization, {
    kind: "approval",
    hash: valueApproval.contentHash,
    artifactId: `operator-mainnet-test-approval:${valueApproval.contentHash}`,
  });
  assert.equal(source.source.clientOrderId, valuePlan.clientOrderId);
  assert.equal(source.source.payloadJson, exactPayload(valuePlan));
  assert.equal(
    source.source.payloadHash,
    payloadHash(source.source.payloadJson),
  );
  assert.equal(source.intent.operation, "CREATE");
  assert.equal(
    JSON.parse(source.intent.canonicalJson).schemaVersion,
    "operator-mainnet-test-create-intent/v2",
  );
  assert.equal("leaseEpoch" in JSON.parse(source.intent.canonicalJson), false);
  assert.equal("lease" in source, false);
  assert.equal(source.attempt, undefined);
  assert.equal(source.halt.active, false);
  assert.equal(
    fixture.connection.db
      .prepare("SELECT COUNT(*) AS count FROM operator_mainnet_test_sources")
      .get()?.count,
    1,
  );
  assert.equal(
    fixture.connection.db
      .prepare(
        "SELECT COUNT(*) AS count FROM operator_mainnet_test_write_intents",
      )
      .get()?.count,
    1,
  );
  assert.equal(
    fixture.connection.db
      .prepare(
        "SELECT COUNT(*) AS count FROM artifacts WHERE artifact_kind LIKE 'operator-mainnet-execution-%'",
      )
      .get()?.count,
    2,
  );
  assert.equal(CURRENT_SCHEMA_VERSION, 14);
});

test("prepared plan is durable and readable before any CREATE intent", () => {
  const fixture = setup();
  const valuePlan = plan("prepared-only-01");
  value(fixture.store.persistPreparedPlan(valuePlan));
  assert.equal(
    value(fixture.store.readPreparedPlan(valuePlan.contentHash))?.contentHash,
    valuePlan.contentHash,
  );
  assert.equal(
    fixture.connection.db
      .prepare(
        "SELECT COUNT(*) AS count FROM operator_mainnet_test_write_intents",
      )
      .get()?.count,
    0,
  );
  fixture.connection.close();

  const reopened = value(
    openSqliteConnection({
      environment: "mainnet",
      databasePath: fixture.path,
      runtime,
      clock: { now: () => fixture.clock.value },
    }),
  );
  const store = value(
    createSqliteOperatorMainnetTestStore(reopened, fixture.scope),
  );
  assert.equal(
    value(store.readPreparedPlan(valuePlan.contentHash))?.contentHash,
    valuePlan.contentHash,
  );
  reopened.close();
});

test("pending operator source for the same account blocks a different nonce and hash", () => {
  const fixture = setup();
  const firstPlan = plan("operator-test-01");
  value(prepare(fixture, firstPlan));

  const pending = value(fixture.store.findPendingOperatorMainnetTestSource());
  assert.equal(pending?.planHash, firstPlan.contentHash);
  const secondPlan = plan("operator-test-02");
  assert.notEqual(secondPlan.contentHash, firstPlan.contentHash);
  const second = prepare(fixture, secondPlan);
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.error.code, "UNRESOLVED_STATE");
  assert.equal(
    fixture.connection.db
      .prepare(
        "SELECT COUNT(*) AS count FROM operator_mainnet_test_write_intents",
      )
      .get()?.count,
    1,
  );
});

test("corrupt latest cleanup evidence cannot release an account-scoped pending source", () => {
  const fixture = setup();
  const source = value(prepare(fixture));
  const sourceId = source.source.sourceId;
  value(
    fixture.store.appendReconciliation({
      sourceId,
      lifecycleOutcome: "UNKNOWN",
      cleanupStatus: "pending",
      evidence: { verified: false },
      observedAt: fixture.clock.value,
    }),
  );

  // Simulate a torn or externally corrupted materialized status. The stored
  // canonical record still says `pending`, so disagreement must fail closed.
  fixture.connection.db
    .prepare(
      `UPDATE operator_mainnet_test_reconciliations
       SET cleanup_status = 'verified-clean' WHERE source_id = ?`,
    )
    .run(sourceId);

  const pending = fixture.store.findPendingOperatorMainnetTestSource();
  assert.equal(pending.ok, false);
  fixture.connection.close();
});

test("intent source is recovery-only across close and reopen", () => {
  const fixture = setup();
  const valuePlan = plan();
  const sourceId = value(
    deriveOperatorMainnetTestSourceId(valuePlan.contentHash),
  );
  value(prepare(fixture, valuePlan));
  fixture.connection.close();

  const reopened = value(
    openSqliteConnection({
      environment: "mainnet",
      databasePath: fixture.path,
      runtime,
      clock: { now: () => fixture.clock.value },
    }),
  );
  const store = value(
    createSqliteOperatorMainnetTestStore(reopened, fixture.scope),
  );
  const recovered = value(store.readOperatorMainnetTestSource(sourceId));
  assert.equal(recovered?.source.planHash, valuePlan.contentHash);
  assert.equal(recovered?.attempt, undefined);
  assert.equal(recovered?.intent.canonicalHash.startsWith("sha256:"), true);
  assert.equal(
    reopened.db
      .prepare(
        "SELECT COUNT(*) AS count FROM operator_mainnet_test_write_intents",
      )
      .get()?.count,
    1,
  );
  reopened.close();
});

test("CREATE attempt outcomes remain pending; only ambiguity raises incident HALT", () => {
  for (const outcome of ["accepted", "rejected"] as const) {
    const fixture = setup();
    const created = value(prepare(fixture));
    const recorded = value(
      fixture.store.recordAttempt({
        runId: "operator-run-01",
        sourceId: created.source.sourceId,
        attemptId: `operator-attempt-${outcome}`,
        outcome,
        recordedAt: fixture.clock.value,
      }),
    );
    assert.equal(recorded.attempt?.outcome, outcome);
    assert.equal(recorded.halt.active, false);
    assert.equal(
      value(fixture.store.findPendingOperatorMainnetTestSource())?.sourceId,
      created.source.sourceId,
    );
    const nextPlan = plan(`blocked-after-${outcome}`);
    const next = fixture.store.prepareCreateIntent({
      runId: "operator-run-02",
      plan: nextPlan,
      approval: approval(nextPlan),
      payloadJson: exactPayload(nextPlan),
      payloadHash: payloadHash(exactPayload(nextPlan)),
      preparedAt: fixture.clock.value,
    });
    assert.equal(next.ok, false);
    if (!next.ok) assert.equal(next.error.code, "UNRESOLVED_STATE");
    assert.equal(
      fixture.connection.db
        .prepare(
          "SELECT COUNT(*) AS count FROM halt_events WHERE account_id = ?",
        )
        .get(ACCOUNT)?.count,
      0,
    );
    fixture.connection.close();
  }

  const fixture = setup();
  const created = value(prepare(fixture));
  const recorded = value(
    fixture.store.recordAttempt({
      runId: "operator-run-01",
      sourceId: created.source.sourceId,
      attemptId: "operator-attempt-01",
      outcome: "ambiguous",
      providerReasonCode: "ACK_UNKNOWN",
      recordedAt: fixture.clock.value,
    }),
  );
  assert.equal(recorded.attempt?.outcome, "ambiguous");
  assert.equal(recorded.halt.active, true);
  assert.equal(recorded.halt.reconciliationRequired, true);
  const event = fixture.connection.db
    .prepare("SELECT evidence_json FROM halt_events WHERE account_id = ?")
    .get(ACCOUNT) as { readonly evidence_json: string | null } | undefined;
  assert.ok(event?.evidence_json);
  const evidence = JSON.parse(event.evidence_json) as Record<string, unknown>;
  assert.equal(evidence.schemaVersion, "operator-mainnet-halt-origin/v1");
  assert.equal(evidence.sourceId, created.source.sourceId);
  assert.equal(evidence.writeIntentId, created.intent.writeIntentId);
  assert.equal(
    (evidence.trigger as Record<string, unknown>).attemptCanonicalHash,
    recorded.attempt?.canonicalHash,
  );
  assert.equal(
    fixture.connection.db
      .prepare("SELECT COUNT(*) AS count FROM halt_events WHERE account_id = ?")
      .get(ACCOUNT)?.count,
    1,
  );
});

test("failed intent transaction leaves no source, intent or operator artifact", () => {
  const fixture = setup();
  fixture.connection.db.exec(`
    CREATE TRIGGER fail_operator_intent
    BEFORE INSERT ON operator_mainnet_test_write_intents
    BEGIN SELECT RAISE(ABORT, 'intent commit fault'); END;
  `);
  const result = prepare(fixture);
  assert.equal(result.ok, false);
  assert.equal(
    fixture.connection.db
      .prepare("SELECT COUNT(*) AS count FROM operator_mainnet_test_sources")
      .get()?.count,
    0,
  );
  assert.equal(
    fixture.connection.db
      .prepare(
        "SELECT COUNT(*) AS count FROM operator_mainnet_test_write_intents",
      )
      .get()?.count,
    0,
  );
  assert.equal(
    fixture.connection.db
      .prepare(
        "SELECT COUNT(*) AS count FROM artifacts WHERE artifact_kind LIKE 'operator-mainnet-execution-%'",
      )
      .get()?.count,
    0,
  );
});

test("reconciliation and manual action provenance append without rewriting prior rows", () => {
  const fixture = setup();
  const created = value(prepare(fixture));
  const first = value(
    fixture.store.appendReconciliation({
      sourceId: created.source.sourceId,
      lifecycleOutcome: "PARTIAL_EVIDENCE",
      cleanupStatus: "pending",
      evidence: { entryFillQuantity: "0", openEntryRemainder: true },
      observedAt: fixture.clock.value,
    }),
  );
  const action = value(
    fixture.store.appendManualAction({
      sourceId: created.source.sourceId,
      action: "entry-remainder-cancelled",
      provenance: { actor: "operator-01", source: "Bybit UI" },
      declaredAt: fixture.clock.value,
    }),
  );
  fixture.clock.value = timestamp("2026-10-22T10:01:01.000Z");
  const second = value(
    fixture.store.appendReconciliation({
      sourceId: created.source.sourceId,
      lifecycleOutcome: "NOT_EXERCISED",
      cleanupStatus: "verified-clean",
      evidence: apiStatusEvidence(fixture.clock.value),
      observedAt: fixture.clock.value,
    }),
  );
  const snapshot = value(
    fixture.store.readOperatorMainnetTestSource(created.source.sourceId),
  );
  assert.equal(first.revision, 1);
  assert.equal(action.revision, 1);
  assert.equal(second.revision, 2);
  assert.deepEqual(
    snapshot?.reconciliations.map((row) => row.canonicalHash),
    [first.canonicalHash, second.canonicalHash],
  );
  assert.deepEqual(
    snapshot?.manualActions.map((row) => row.actionId),
    [action.actionId],
  );
  assert.equal(
    value(fixture.store.findPendingOperatorMainnetTestSource()),
    undefined,
  );
});

test("fresh API verified-clean releases pending source independently of an expired unused grant", () => {
  const fixture = setup();
  const original = value(prepare(fixture));
  value(
    fixture.store.recordAttempt({
      runId: "operator-run-01",
      sourceId: original.source.sourceId,
      attemptId: "accepted-before-expired-grant",
      outcome: "accepted",
      exchangeOrderId: "exchange-parent-expired-grant",
      recordedAt: fixture.clock.value,
    }),
  );
  const source = value(
    fixture.store.readOperatorMainnetTestSource(original.source.sourceId),
  )!;
  const { recoveryPlan, grant } = createManualRecoveryGrant(fixture, source);

  assert.equal(
    value(fixture.store.findPendingOperatorMainnetTestSource())?.sourceId,
    original.source.sourceId,
    "manual grant alone does not release the pending source",
  );

  fixture.clock.value = timestamp("2026-10-22T10:07:00.000Z");
  value(
    fixture.store.appendReconciliation({
      sourceId: original.source.sourceId,
      lifecycleOutcome: "NOT_EXERCISED",
      cleanupStatus: "verified-clean",
      evidence: apiStatusEvidence(fixture.clock.value),
      observedAt: fixture.clock.value,
    }),
  );

  assert.equal(
    value(fixture.store.findPendingOperatorMainnetTestSource()),
    undefined,
  );
  assert.equal(
    value(
      fixture.store.findOperatorMainnetRecoveryGrant(
        recoveryPlan.contentHash,
        fixture.clock.value,
      ),
    ),
    undefined,
    "the expired grant is not returned as CREATE authority",
  );
  assert.equal(
    fixture.connection.db
      .prepare(
        "SELECT COUNT(*) AS count FROM operator_mainnet_recovery_grant_consumptions WHERE grant_id = ?",
      )
      .get(grant.grantId)?.count,
    0,
    "the old grant remains unused",
  );

  const nextPlan = plan(
    "new-plan-after-independent-api-cleanup",
    undefined,
    fixture.clock.value,
  );
  const next = prepare(fixture, nextPlan, approval(nextPlan));
  assert.equal(next.ok, true);
  if (next.ok)
    assert.notEqual(next.value.source.sourceId, original.source.sourceId);
  assert.equal(
    fixture.connection.db
      .prepare(
        "SELECT COUNT(*) AS count FROM operator_mainnet_recovery_grant_consumptions",
      )
      .get()?.count,
    0,
    "fresh API cleanup permits normal approval without consuming the expired grant",
  );
  fixture.connection.close();
});

test("status reconciliation appends without a lease and preserves real HALT", () => {
  const fixture = setup();
  const created = value(prepare(fixture));
  value(
    fixture.store.recordAttempt({
      runId: "operator-run-01",
      sourceId: created.source.sourceId,
      attemptId: "operator-attempt-recovery",
      outcome: "accepted",
      exchangeOrderId: "exchange-parent-recovery",
      recordedAt: fixture.clock.value,
    }),
  );
  assert.equal(value(fixture.execution.readHalt()).active, false);

  fixture.clock.value = timestamp("2026-10-22T10:02:01.000Z");
  const appended = value(
    fixture.store.appendReconciliation({
      sourceId: created.source.sourceId,
      lifecycleOutcome: "UNKNOWN",
      cleanupStatus: "unknown",
      evidence: { reason: "recovery read incomplete" },
      observedAt: fixture.clock.value,
    }),
  );
  value(
    fixture.store.raiseHalt(
      created.source.sourceId,
      "operator Mainnet status is unknown",
      fixture.clock.value,
    ),
  );
  assert.equal(appended.revision, 1);
  assert.equal(
    value(fixture.store.readOperatorMainnetTestSource(created.source.sourceId))
      ?.reconciliations.length,
    1,
  );
  assert.equal(value(fixture.execution.readLease()), undefined);
  assert.equal(value(fixture.execution.readHalt()).active, true);
  fixture.connection.close();
});

test("an abandoned pre-intent lease does not block operator journal or raise HALT", () => {
  const fixture = setup();
  value(
    fixture.execution.acquireLease({
      scope: fixture.scope,
      ownerRunId: "abandoned-pre-intent",
      now: timestamp("2026-10-22T09:59:00.000Z"),
      ttlMs: 1_000,
    }),
  );
  assert.equal(
    value(fixture.store.findPendingOperatorMainnetTestSource()),
    undefined,
  );
  const created = value(prepare(fixture));
  assert.equal(created.halt.active, false);
  assert.equal(
    value(fixture.execution.readLease())?.ownerRunId,
    "abandoned-pre-intent",
  );
  assert.equal(
    fixture.connection.db
      .prepare("SELECT COUNT(*) AS count FROM halt_events")
      .get()?.count,
    0,
  );
  fixture.connection.close();
});

test("attempt recording requires the persisted run identity without a lease", () => {
  const fixture = setup();
  const created = value(prepare(fixture));
  const result = fixture.store.recordAttempt({
    runId: "another-process",
    sourceId: created.source.sourceId,
    attemptId: "wrong-run-attempt",
    outcome: "ambiguous",
    recordedAt: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(
    value(fixture.store.readOperatorMainnetTestSource(created.source.sourceId))
      ?.attempt,
    undefined,
  );
  assert.equal(value(fixture.execution.readHalt()).active, false);
  fixture.connection.close();
});

test("source-bound HALT rejects absent or foreign sources and preserves a real incident", () => {
  const fixture = setup();
  assert.equal(
    fixture.store.raiseHalt("nonexistent-source", "unknown exchange state", NOW)
      .ok,
    false,
  );
  assert.equal(value(fixture.execution.readHalt()).active, false);
  const created = value(prepare(fixture));
  const foreignStore = value(
    createSqliteOperatorMainnetTestStore(fixture.connection, {
      ...fixture.scope,
      accountId: `sha256:${"b".repeat(64)}`,
    }),
  );
  assert.equal(
    foreignStore.raiseHalt(
      created.source.sourceId,
      "unknown exchange state",
      NOW,
    ).ok,
    false,
  );
  const raised = value(
    fixture.store.raiseHalt(
      created.source.sourceId,
      "unknown exchange state",
      NOW,
    ),
  );
  assert.equal(raised.active, true);
  const event = fixture.connection.db
    .prepare("SELECT evidence_json FROM halt_events WHERE account_id = ?")
    .get(ACCOUNT) as { readonly evidence_json: string | null } | undefined;
  assert.ok(event?.evidence_json);
  const evidence = JSON.parse(event.evidence_json) as Record<string, unknown>;
  assert.equal(evidence.schemaVersion, "operator-mainnet-halt-origin/v1");
  assert.equal(evidence.sourceId, created.source.sourceId);
  assert.equal(evidence.writeIntentId, created.intent.writeIntentId);
  value(
    fixture.store.appendReconciliation({
      sourceId: created.source.sourceId,
      lifecycleOutcome: "NOT_EXERCISED",
      cleanupStatus: "verified-clean",
      evidence: { noExchangeOrder: true },
      observedAt: NOW,
    }),
  );
  const next = prepare(fixture, plan("blocked-by-real-incident"));
  assert.equal(next.ok, false);
  if (!next.ok) assert.equal(next.error.code, "HALT_ACTIVE");
  assert.equal(
    value(fixture.execution.readHalt()).reason,
    "unknown exchange state",
  );
  fixture.connection.close();
});

test("legacy #31 attempt-shaped HALT evidence stays immutable and missing origin keeps HALT actionable", () => {
  const fixture = setup();
  const created = value(prepare(fixture));
  const recorded = value(
    fixture.store.recordAttempt({
      runId: "operator-run-01",
      sourceId: created.source.sourceId,
      attemptId: "legacy-halt-attempt",
      outcome: "ambiguous",
      providerReasonCode: "ACK_UNKNOWN",
      recordedAt: fixture.clock.value,
    }),
  );
  const legacyEventEvidence = recorded.attempt!.canonicalJson;
  const legacyEvent = JSON.parse(legacyEventEvidence) as Record<
    string,
    unknown
  >;
  assert.equal(
    legacyEvent.schemaVersion,
    "operator-mainnet-test-create-attempt/v1",
  );
  assert.equal(legacyEvent.sourceId, created.source.sourceId);
  assert.equal(legacyEvent.writeIntentId, created.intent.writeIntentId);

  // This was the #31 event shape: the event payload itself was the canonical
  // saved attempt. Opening the source validates the same persisted evidence.
  fixture.connection.db
    .prepare("UPDATE halt_events SET evidence_json = ? WHERE account_id = ?")
    .run(legacyEventEvidence, ACCOUNT);
  const validated = value(
    fixture.store.readOperatorMainnetTestSource(created.source.sourceId),
  );
  assert.equal(validated?.attempt?.canonicalJson, legacyEventEvidence);
  assert.equal(validated?.source.sourceId, legacyEvent.sourceId);
  assert.equal(validated?.intent.writeIntentId, legacyEvent.writeIntentId);
  assert.equal(
    (
      fixture.connection.db
        .prepare("SELECT evidence_json FROM halt_events WHERE account_id = ?")
        .get(ACCOUNT) as { readonly evidence_json: string | null }
    ).evidence_json,
    legacyEventEvidence,
  );

  // Missing legacy origin evidence never clears HALT or permits another plan.
  fixture.connection.db
    .prepare("UPDATE halt_events SET evidence_json = NULL WHERE account_id = ?")
    .run(ACCOUNT);
  const nextPlan = plan("blocked-by-unlinked-legacy-halt");
  const blocked = prepare(fixture, nextPlan);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) {
    assert.equal(blocked.error.code, "HALT_ACTIVE");
    assert.match(
      blocked.error.message,
      /inspect saved event and source\/intent evidence/u,
    );
  }
  assert.equal(value(fixture.execution.readHalt()).active, true);
  assert.equal(
    (
      fixture.connection.db
        .prepare("SELECT evidence_json FROM halt_events WHERE account_id = ?")
        .get(ACCOUNT) as { readonly evidence_json: string | null }
    ).evidence_json,
    null,
  );
  fixture.connection.close();
});

test("manual recovery clears eligible HALT once and atomically consumes grant with source disposition and new intent", () => {
  const fixture = setup();
  const original = value(prepare(fixture));
  value(
    fixture.store.recordAttempt({
      runId: "operator-run-01",
      sourceId: original.source.sourceId,
      attemptId: "recovery-ambiguous-attempt",
      outcome: "ambiguous",
      providerReasonCode: "ACK_UNKNOWN",
      recordedAt: fixture.clock.value,
    }),
  );
  const unresolved = value(
    fixture.store.readOperatorMainnetTestSource(original.source.sourceId),
  )!;
  // Accept the historical #31 shape only because these exact immutable bytes
  // are also present as the source's saved attempt.
  fixture.connection.db
    .prepare("UPDATE halt_events SET evidence_json = ? WHERE account_id = ?")
    .run(unresolved.attempt!.canonicalJson, ACCOUNT);
  const { attestation, recoveryPlan, grant } = createManualRecoveryGrant(
    fixture,
    unresolved,
  );

  assert.equal(grant.resolution.kind, "manual-attested");
  assert.equal(
    grant.resolution.kind === "manual-attested" &&
      grant.resolution.attestationHash,
    attestation.contentHash,
  );
  assert.equal(grant.haltRevision, 2);
  const activeEvent = fixture.connection.db
    .prepare(
      "SELECT event_id FROM halt_events WHERE account_id = ? AND active = 1",
    )
    .get(ACCOUNT) as { readonly event_id: string } | undefined;
  assert.equal(grant.haltOrigin?.eventId, activeEvent?.event_id);
  assert.equal(grant.haltOrigin?.revision, 1);
  assert.equal(value(fixture.execution.readHalt()).active, false);
  assert.equal(
    fixture.connection.db
      .prepare("SELECT COUNT(*) AS count FROM halt_events WHERE account_id = ?")
      .get(ACCOUNT)?.count,
    2,
  );
  assert.equal(
    value(fixture.store.findPendingOperatorMainnetTestSource())?.sourceId,
    original.source.sourceId,
    "an unconsumed grant leaves the original source blocking",
  );
  assert.equal(
    value(
      fixture.store.findOperatorMainnetRecoveryGrant(
        recoveryPlan.contentHash,
        fixture.clock.value,
      ),
    )?.grantId,
    grant.grantId,
  );

  fixture.clock.value = timestamp("2026-10-22T10:01:01.000Z");
  const duplicate = fixture.store.createOperatorMainnetRecoveryGrant({
    sourceId: original.source.sourceId,
    planHash: recoveryPlan.contentHash,
    resolution: {
      kind: "manual-attested",
      attestationHash: attestation.contentHash,
    },
    actor: "operator-01",
    consent: true,
    issuedAt: fixture.clock.value,
  });
  assert.equal(
    duplicate.ok,
    false,
    "the same attestation cannot mint a second grant",
  );
  fixture.clock.value = NOW;

  const wrongPlan = plan("wrong-recovery-plan");
  assert.equal(
    prepare(fixture, wrongPlan, approval(wrongPlan), grant.grantId).ok,
    false,
  );
  assert.equal(
    fixture.connection.db
      .prepare(
        "SELECT COUNT(*) AS count FROM operator_mainnet_recovery_grant_consumptions",
      )
      .get()?.count,
    0,
  );

  fixture.connection.db.exec(`
    CREATE TRIGGER fail_operator_recovery_disposition
    BEFORE INSERT ON operator_mainnet_test_source_dispositions
    BEGIN SELECT RAISE(ABORT, 'recovery disposition fault'); END;
  `);
  assert.equal(
    prepare(fixture, recoveryPlan, approval(recoveryPlan), grant.grantId).ok,
    false,
  );
  assert.equal(
    fixture.connection.db
      .prepare("SELECT COUNT(*) AS count FROM operator_mainnet_test_sources")
      .get()?.count,
    1,
  );
  assert.equal(
    fixture.connection.db
      .prepare(
        "SELECT COUNT(*) AS count FROM operator_mainnet_test_write_intents",
      )
      .get()?.count,
    1,
  );
  assert.equal(
    fixture.connection.db
      .prepare(
        "SELECT COUNT(*) AS count FROM operator_mainnet_recovery_grant_consumptions",
      )
      .get()?.count,
    0,
  );
  assert.equal(
    value(
      fixture.store.findOperatorMainnetRecoveryGrant(
        recoveryPlan.contentHash,
        fixture.clock.value,
      ),
    )?.grantId,
    grant.grantId,
    "a rolled-back intent transaction does not spend the grant",
  );

  fixture.connection.db.exec(
    "DROP TRIGGER fail_operator_recovery_disposition;",
  );
  const next = value(
    prepare(fixture, recoveryPlan, approval(recoveryPlan), grant.grantId),
  );
  assert.equal(
    JSON.parse(next.intent.canonicalJson).schemaVersion,
    "operator-mainnet-test-create-intent/v3",
  );
  assert.equal(
    JSON.parse(next.intent.canonicalJson).recoveryGrantId,
    grant.grantId,
  );
  assert.equal(
    value(fixture.store.readOperatorMainnetTestSource(original.source.sourceId))
      ?.sourceDisposition?.disposition,
    "human-attested",
  );
  assert.equal(
    fixture.connection.db
      .prepare(
        "SELECT COUNT(*) AS count FROM operator_mainnet_recovery_grant_consumptions",
      )
      .get()?.count,
    1,
  );
  assert.equal(
    value(fixture.store.findPendingOperatorMainnetTestSource())?.sourceId,
    next.source.sourceId,
  );
  assert.equal(
    value(
      fixture.store.findOperatorMainnetRecoveryGrant(
        recoveryPlan.contentHash,
        fixture.clock.value,
      ),
    ),
    undefined,
  );
  assert.equal(
    prepare(fixture, recoveryPlan, approval(recoveryPlan), grant.grantId).ok,
    false,
    "a committed recovery grant is single-use",
  );
  assert.deepEqual(
    fixture.connection.db.prepare("PRAGMA foreign_key_check").all(),
    [],
  );
  fixture.connection.close();
});

test("HALT-free pending-source recovery does not append fictional clearance and source revision invalidates grant", () => {
  const fixture = setup();
  const original = value(prepare(fixture));
  value(
    fixture.store.recordAttempt({
      runId: "operator-run-01",
      sourceId: original.source.sourceId,
      attemptId: "accepted-but-pending",
      outcome: "accepted",
      exchangeOrderId: "exchange-parent-accepted",
      recordedAt: fixture.clock.value,
    }),
  );
  const pending = value(
    fixture.store.readOperatorMainnetTestSource(original.source.sourceId),
  )!;
  const { recoveryPlan, grant } = createManualRecoveryGrant(fixture, pending);

  assert.equal(grant.haltOrigin, null);
  assert.equal(grant.haltRevision, 0);
  assert.equal(value(fixture.execution.readHalt()).active, false);
  assert.equal(
    fixture.connection.db
      .prepare("SELECT COUNT(*) AS count FROM halt_events WHERE account_id = ?")
      .get(ACCOUNT)?.count,
    0,
  );
  assert.equal(
    value(fixture.store.findPendingOperatorMainnetTestSource())?.sourceId,
    original.source.sourceId,
  );

  fixture.clock.value = timestamp("2026-10-22T10:01:01.000Z");
  value(
    fixture.store.appendReconciliation({
      sourceId: original.source.sourceId,
      lifecycleOutcome: "UNKNOWN",
      cleanupStatus: "unknown",
      evidence: { reason: "newer source evidence" },
      observedAt: fixture.clock.value,
    }),
  );
  assert.equal(
    value(
      fixture.store.findOperatorMainnetRecoveryGrant(
        recoveryPlan.contentHash,
        fixture.clock.value,
      ),
    ),
    undefined,
  );
  assert.equal(
    prepare(fixture, recoveryPlan, approval(recoveryPlan), grant.grantId).ok,
    false,
    "newer source evidence invalidates an unconsumed grant",
  );
  assert.equal(
    fixture.connection.db
      .prepare(
        "SELECT COUNT(*) AS count FROM operator_mainnet_recovery_grant_consumptions",
      )
      .get()?.count,
    0,
  );
  fixture.connection.close();
});

test("recording an attempt invalidates a manual attestation bound before the attempt existed", () => {
  const fixture = setup();
  const original = value(prepare(fixture));
  const attestation = manualRecoveryAttestation(original);
  assert.equal(attestation.sourceRevision, 0);
  value(
    fixture.store.persistOperatorMainnetRecoveryAttestation({
      attestation,
      recordedAt: fixture.clock.value,
    }),
  );
  const recoveryPlan = saveRecoveryPlan(
    fixture,
    plan("attempt-invalidates-recovery-attestation"),
  );
  value(
    fixture.store.recordAttempt({
      runId: "operator-run-01",
      sourceId: original.source.sourceId,
      attemptId: "attempt-added-after-attestation",
      outcome: "accepted",
      exchangeOrderId: "exchange-parent-after-attestation",
      recordedAt: fixture.clock.value,
    }),
  );

  const grant = fixture.store.createOperatorMainnetRecoveryGrant({
    sourceId: original.source.sourceId,
    planHash: recoveryPlan.contentHash,
    resolution: {
      kind: "manual-attested",
      attestationHash: attestation.contentHash,
    },
    actor: "operator-01",
    consent: true,
    issuedAt: fixture.clock.value,
  });
  assert.equal(grant.ok, false);
  assert.equal(value(fixture.execution.readHalt()).active, false);
  assert.equal(
    fixture.connection.db
      .prepare("SELECT COUNT(*) AS count FROM operator_mainnet_recovery_grants")
      .get()?.count,
    0,
  );
  assert.equal(
    value(
      fixture.store.readOperatorMainnetRecoveryAttestation(
        attestation.contentHash,
      ),
    )?.sourceRevision,
    0,
  );
  fixture.connection.close();
});

test("fresh verified API cleanup can clear a source-bound HALT without a manual disposition", () => {
  const fixture = setup();
  const original = value(prepare(fixture));
  value(
    fixture.store.recordAttempt({
      runId: "operator-run-01",
      sourceId: original.source.sourceId,
      attemptId: "api-recovery-ambiguous",
      outcome: "ambiguous",
      recordedAt: fixture.clock.value,
    }),
  );
  const reconciliation = value(
    fixture.store.appendReconciliation({
      sourceId: original.source.sourceId,
      lifecycleOutcome: "TP_LIFECYCLE_PASS",
      cleanupStatus: "verified-clean",
      evidence: { entryAndExitFillsMatched: true, noOpenOrders: true },
      observedAt: fixture.clock.value,
    }),
  );
  const recoveryPlan = saveRecoveryPlan(fixture, plan("api-recovery-plan"));
  const grant = value(
    fixture.store.createOperatorMainnetRecoveryGrant({
      sourceId: original.source.sourceId,
      planHash: recoveryPlan.contentHash,
      resolution: {
        kind: "api-resolved",
        reconciliationId: reconciliation.reconciliationId,
        reconciliationHash: reconciliation.canonicalHash,
      },
      actor: "operator-01",
      consent: true,
      issuedAt: fixture.clock.value,
    }),
  );
  assert.equal(grant.resolution.kind, "api-resolved");
  assert.equal(value(fixture.execution.readHalt()).active, false);
  assert.equal(
    value(fixture.store.readOperatorMainnetTestSource(original.source.sourceId))
      ?.sourceDisposition,
    undefined,
  );
  const clearance = fixture.connection.db
    .prepare(
      "SELECT evidence_json FROM halt_events WHERE account_id = ? AND active = 0",
    )
    .get(ACCOUNT) as { readonly evidence_json: string | null } | undefined;
  assert.ok(clearance?.evidence_json);
  assert.equal(JSON.parse(clearance.evidence_json).grantId, grant.grantId);
  fixture.connection.close();
});

test("status-unknown HALT remains attributable to its historical reconciliation after a newer clean result", () => {
  const fixture = setup();
  const original = value(prepare(fixture));
  const unknown = value(
    fixture.store.appendReconciliation({
      sourceId: original.source.sourceId,
      lifecycleOutcome: "UNKNOWN",
      cleanupStatus: "unknown",
      evidence: { reason: "first status read was incomplete" },
      observedAt: fixture.clock.value,
    }),
  );
  value(
    fixture.store.raiseHalt(
      original.source.sourceId,
      "operator Mainnet status is unknown",
      fixture.clock.value,
    ),
  );
  fixture.clock.value = timestamp("2026-10-22T10:01:01.000Z");
  const clean = value(
    fixture.store.appendReconciliation({
      sourceId: original.source.sourceId,
      lifecycleOutcome: "TP_LIFECYCLE_PASS",
      cleanupStatus: "verified-clean",
      evidence: { retryResolvedLifecycle: true },
      observedAt: fixture.clock.value,
    }),
  );
  const recoveryPlan = saveRecoveryPlan(fixture, plan("status-halt-recovery"));
  const grant = value(
    fixture.store.createOperatorMainnetRecoveryGrant({
      sourceId: original.source.sourceId,
      planHash: recoveryPlan.contentHash,
      resolution: {
        kind: "api-resolved",
        reconciliationId: clean.reconciliationId,
        reconciliationHash: clean.canonicalHash,
      },
      actor: "operator-01",
      consent: true,
      issuedAt: fixture.clock.value,
    }),
  );
  assert.equal(grant.haltOrigin?.revision, 1);
  assert.equal(grant.sourceRevision, 2);
  assert.equal(value(fixture.execution.readHalt()).active, false);
  assert.equal(
    value(fixture.store.readOperatorMainnetTestSource(original.source.sourceId))
      ?.reconciliations[0]?.canonicalHash,
    unknown.canonicalHash,
  );
  fixture.connection.close();
});

test("recovery rejects an unlinked legacy HALT origin and leaves account blocked", () => {
  const fixture = setup();
  const original = value(prepare(fixture));
  const attempt = value(
    fixture.store.recordAttempt({
      runId: "operator-run-01",
      sourceId: original.source.sourceId,
      attemptId: "legacy-unlinked-attempt",
      outcome: "ambiguous",
      recordedAt: fixture.clock.value,
    }),
  ).attempt!;
  fixture.connection.db
    .prepare("UPDATE halt_events SET evidence_json = NULL WHERE account_id = ?")
    .run(ACCOUNT);
  const source = value(
    fixture.store.readOperatorMainnetTestSource(original.source.sourceId),
  )!;
  const attestation = manualRecoveryAttestation(source);
  value(
    fixture.store.persistOperatorMainnetRecoveryAttestation({
      attestation,
      recordedAt: fixture.clock.value,
    }),
  );
  const recoveryPlan = saveRecoveryPlan(fixture, plan("blocked-recovery-plan"));
  const grant = fixture.store.createOperatorMainnetRecoveryGrant({
    sourceId: original.source.sourceId,
    planHash: recoveryPlan.contentHash,
    resolution: {
      kind: "manual-attested",
      attestationHash: attestation.contentHash,
    },
    actor: "operator-01",
    consent: true,
    issuedAt: fixture.clock.value,
  });
  assert.equal(grant.ok, false);
  if (!grant.ok) {
    assert.equal(grant.error.code, "HALT_ACTIVE");
    assert.match(
      grant.error.message,
      /HALT origin is missing or uncorrelated/u,
    );
  }
  assert.equal(value(fixture.execution.readHalt()).active, true);
  assert.equal(
    fixture.connection.db
      .prepare("SELECT COUNT(*) AS count FROM operator_mainnet_recovery_grants")
      .get()?.count,
    0,
  );
  assert.equal(attempt.writeIntentId, original.intent.writeIntentId);
  fixture.connection.close();
});

test("manual recovery rejects nonterminal source TP status even when account-wide open orders are empty", () => {
  const fixture = setup();
  const original = value(prepare(fixture));
  value(
    fixture.store.recordAttempt({
      runId: "operator-run-01",
      sourceId: original.source.sourceId,
      attemptId: "nonterminal-tp-source",
      outcome: "ambiguous",
      recordedAt: fixture.clock.value,
    }),
  );
  const source = value(
    fixture.store.readOperatorMainnetTestSource(original.source.sourceId),
  )!;
  const attestation = manualRecoveryAttestation(source, "New");
  assert.equal(attestation.inspection.accountOpenOrders.length, 0);
  assert.equal(attestation.inspection.sourceTakeProfitOrders[0]?.status, "New");
  value(
    fixture.store.persistOperatorMainnetRecoveryAttestation({
      attestation,
      recordedAt: fixture.clock.value,
    }),
  );
  const recoveryPlan = saveRecoveryPlan(
    fixture,
    plan("recovery-open-tp-blocked", attestation.contentHash),
  );

  const grant = fixture.store.createOperatorMainnetRecoveryGrant({
    sourceId: original.source.sourceId,
    planHash: recoveryPlan.contentHash,
    resolution: {
      kind: "manual-attested",
      attestationHash: attestation.contentHash,
    },
    actor: "operator-01",
    consent: true,
    issuedAt: fixture.clock.value,
  });
  assert.equal(grant.ok, false);
  if (!grant.ok) {
    assert.equal(grant.error.code, "UNRESOLVED_STATE");
    assert.match(grant.error.message, /nonterminal or unknown order status/u);
  }
  assert.equal(value(fixture.execution.readHalt()).active, true);
  assert.equal(
    fixture.connection.db
      .prepare("SELECT COUNT(*) AS count FROM operator_mainnet_recovery_grants")
      .get()?.count,
    0,
  );
  assert.equal(
    fixture.connection.db
      .prepare(
        "SELECT COUNT(*) AS count FROM halt_events WHERE account_id = ? AND active = 0",
      )
      .get(ACCOUNT)?.count,
    0,
  );
  fixture.connection.close();
});

test("v8 through v14 migrations preserve populated historical v1 intent bytes and recovery records", () => {
  const fixture = setup();
  const created = value(prepare(fixture));
  value(
    fixture.store.recordAttempt({
      runId: "operator-run-01",
      sourceId: created.source.sourceId,
      attemptId: "historical-attempt",
      outcome: "ambiguous",
      recordedAt: NOW,
    }),
  );
  // Reconstitute the v8 projections and canonical v1 record before opening it
  // with the current adapter. Additive recovery, history, and accounting tables
  // are absent in a v8 database.
  fixture.connection.db.exec(`
    ALTER TABLE operator_mainnet_test_write_intents ADD COLUMN lease_owner_run_id TEXT NOT NULL DEFAULT 'historic-run';
    ALTER TABLE operator_mainnet_test_write_intents ADD COLUMN lease_epoch INTEGER NOT NULL DEFAULT 1 CHECK (lease_epoch > 0);
    DROP TABLE operator_mainnet_test_source_dispositions;
    DROP TABLE operator_mainnet_recovery_grant_consumptions;
    DROP TABLE operator_mainnet_recovery_grants;
    DROP TABLE operator_mainnet_recovery_attestations;
    DROP TABLE history_window_conflicts;
    DROP TABLE history_window_checkpoints;
    DROP TABLE history_source_conflicts;
    DROP TABLE history_source_observations;
    DROP TABLE history_accounting_reports;
    DROP TABLE history_accounting_wallet_anchors;
    DROP TRIGGER operator_mainnet_test_sources_authorization_insert;
    DROP TRIGGER operator_mainnet_test_sources_authorization_update;
    DROP TRIGGER operator_mainnet_trade_command_receipts_no_update;
    DROP TRIGGER operator_mainnet_trade_command_receipts_no_delete;
    DROP TRIGGER operator_mainnet_trade_command_bindings_no_update;
    DROP TRIGGER operator_mainnet_trade_command_bindings_no_delete;
    DROP TRIGGER operator_mainnet_trade_command_consumptions_no_update;
    DROP TRIGGER operator_mainnet_trade_command_consumptions_no_delete;
    DROP TRIGGER operator_mainnet_trade_command_outcomes_no_update;
    DROP TRIGGER operator_mainnet_trade_command_outcomes_no_delete;
    DROP TABLE operator_mainnet_trade_command_outcomes;
    DROP TABLE operator_mainnet_trade_command_consumptions;
    DROP TABLE operator_mainnet_trade_command_bindings;
    DROP TABLE operator_mainnet_trade_command_receipts;
    ALTER TABLE operator_mainnet_test_sources DROP COLUMN authorization_artifact_id;
    ALTER TABLE operator_mainnet_test_sources DROP COLUMN authorization_hash;
    ALTER TABLE operator_mainnet_test_sources DROP COLUMN authorization_kind;
    UPDATE schema_meta SET schema_version = 8;
  `);
  const historical = value(
    canonicalSerialize({
      ...JSON.parse(created.intent.canonicalJson),
      schemaVersion: "operator-mainnet-test-create-intent/v1",
      leaseOwnerRunId: "historic-run",
      leaseEpoch: 7,
    }),
  );
  const historicalHash = payloadHash(historical);
  fixture.connection.db
    .prepare(
      `UPDATE operator_mainnet_test_write_intents
    SET canonical_json = ?, canonical_hash = ?, lease_epoch = 7`,
    )
    .run(historical, historicalHash);
  const attempts = fixture.connection.db
    .prepare("SELECT * FROM operator_mainnet_test_attempts")
    .all();
  const artifacts = fixture.connection.db
    .prepare("SELECT * FROM artifacts ORDER BY artifact_id")
    .all();
  fixture.connection.close();
  const migrated = value(
    openSqliteConnection({
      environment: "mainnet",
      databasePath: fixture.path,
      runtime,
      clock: { now: () => NOW },
    }),
  );
  const store = value(
    createSqliteOperatorMainnetTestStore(migrated, fixture.scope),
  );
  const recovered = value(
    store.readOperatorMainnetTestSource(created.source.sourceId),
  );
  assert.equal(recovered?.intent.canonicalJson, historical);
  assert.equal(recovered?.intent.canonicalHash, historicalHash);
  assert.equal(recovered?.attempt?.outcome, "ambiguous");
  assert.equal(recovered?.halt.active, true);
  assert.equal(recovered?.authorization.kind, "approval");
  if (!recovered || recovered.authorization.kind !== "approval")
    throw new Error("legacy source did not retain approval authority");
  assert.equal("leaseEpoch" in recovered!.intent, false);
  assert.equal("lease" in recovered!, false);
  assert.deepEqual(
    migrated.db.prepare("SELECT * FROM operator_mainnet_test_attempts").all(),
    attempts,
  );
  assert.deepEqual(
    migrated.db.prepare("SELECT * FROM artifacts ORDER BY artifact_id").all(),
    artifacts,
  );
  assert.deepEqual(migrated.db.prepare("PRAGMA foreign_key_check").all(), []);
  const migratedAuthorization = migrated.db
    .prepare(
      `SELECT authorization_kind, authorization_hash, authorization_artifact_id,
                approval_hash, approval_artifact_id
         FROM operator_mainnet_test_sources WHERE source_id = ?`,
    )
    .get(created.source.sourceId);
  assert.deepEqual(
    migratedAuthorization ? { ...migratedAuthorization } : undefined,
    {
      authorization_kind: "approval",
      authorization_hash: created.source.authorization.hash,
      authorization_artifact_id: created.source.authorization.artifactId,
      approval_hash: created.source.authorization.hash,
      approval_artifact_id: created.source.authorization.artifactId,
    },
  );
  assert.equal(
    migrated.db
      .prepare("SELECT schema_version FROM schema_meta WHERE singleton = 1")
      .get()?.schema_version,
    CURRENT_SCHEMA_VERSION,
  );
  const columns = migrated.db
    .prepare("PRAGMA table_info(operator_mainnet_test_write_intents)")
    .all()
    .map((row) => row.name);
  assert.equal(columns.includes("lease_owner_run_id"), false);
  assert.equal(columns.includes("lease_epoch"), false);
  assert.equal(
    store.prepareCreateIntent({
      runId: "new-run",
      plan: recovered!.plan,
      approval: recovered.authorization.approval,
      payloadJson: recovered!.source.payloadJson,
      payloadHash: recovered!.source.payloadHash,
      preparedAt: NOW,
    }).ok,
    false,
  );
  // Historical lease values are still validated from immutable canonical JSON.
  const corrupt = value(
    canonicalSerialize({ ...JSON.parse(historical), leaseEpoch: 0 }),
  );
  migrated.db
    .prepare(
      "UPDATE operator_mainnet_test_write_intents SET canonical_json = ?, canonical_hash = ?",
    )
    .run(corrupt, payloadHash(corrupt));
  assert.equal(
    store.readOperatorMainnetTestSource(created.source.sourceId).ok,
    false,
  );
  migrated.close();
});

test("direct trade-command evidence binds once and consumes atomically without approval artifacts", () => {
  const fixture = setup();
  const command = tradeCommand();
  value(
    fixture.store.persistOperatorMainnetTradeCommandReceipt({
      receipt: command.receipt,
      recordedAt: NOW,
    }),
  );
  value(
    fixture.store.bindOperatorMainnetTradeCommand({
      binding: command.binding,
      boundAt: NOW,
    }),
  );

  fixture.connection.db.exec(`
    CREATE TRIGGER test_abort_trade_command_consumption
    BEFORE INSERT ON operator_mainnet_trade_command_consumptions
    BEGIN SELECT RAISE(ABORT, 'injected transaction failure'); END;
  `);
  const request = {
    runId: "trade-command-run-01",
    plan: command.plan,
    tradeCommand: {
      receipt: command.receipt,
      binding: command.binding,
      authorizationAt: NOW,
    },
    payloadJson: command.payloadJson,
    payloadHash: command.payloadHash,
    preparedAt: NOW,
  } as const;
  assert.equal(fixture.store.prepareCreateIntent(request).ok, false);
  for (const table of [
    "operator_mainnet_test_sources",
    "operator_mainnet_test_write_intents",
    "operator_mainnet_trade_command_consumptions",
  ])
    assert.equal(
      fixture.connection.db
        .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
        .get()?.count,
      0,
    );
  fixture.connection.db.exec(
    "DROP TRIGGER test_abort_trade_command_consumption",
  );

  const created = value(fixture.store.prepareCreateIntent(request));
  assert.equal(created.authorization.kind, "trade-command");
  if (created.authorization.kind !== "trade-command")
    throw new Error("direct source was decoded as legacy approval");
  assert.equal("approval" in created.authorization, false);
  assert.equal(
    created.authorization.artifactId,
    `operator-mainnet-trade-command-binding:${command.binding.contentHash}`,
  );
  assert.equal(created.source.authorization.kind, "trade-command");
  assert.equal(
    created.source.authorization.artifactId,
    created.authorization.artifactId,
  );
  assert.equal(created.intent.commandId, command.receipt.commandId);
  assert.equal(created.intent.commandReceiptHash, command.receipt.contentHash);
  assert.equal(created.intent.commandBindingHash, command.binding.contentHash);

  const storedArtifacts = fixture.connection.db
    .prepare(
      `SELECT artifact_kind FROM artifacts
       WHERE artifact_id IN (?, ?, ?)
       ORDER BY artifact_id`,
    )
    .all(
      `operator-mainnet-trade-command-binding:${command.binding.contentHash}`,
      `operator-mainnet-trade-command-receipt:${command.receipt.contentHash}`,
      `operator-mainnet-test:${command.plan.contentHash}`,
    )
    .map((row) => row.artifact_kind);
  assert.deepEqual(
    storedArtifacts.sort(),
    [
      "operator-mainnet-trade-command-binding",
      "operator-mainnet-trade-command-receipt",
      "operator-mainnet-execution-test",
    ].sort(),
  );
  assert.equal(
    fixture.connection.db
      .prepare(
        `SELECT COUNT(*) AS count FROM artifacts
         WHERE artifact_kind = 'operator-mainnet-execution-approval'`,
      )
      .get()?.count,
    0,
  );
  const compatibilityRef = fixture.connection.db
    .prepare(
      `SELECT s.authorization_kind, s.approval_hash, s.approval_artifact_id,
              a.artifact_kind
       FROM operator_mainnet_test_sources s
       JOIN artifacts a ON a.artifact_id = s.approval_artifact_id
       WHERE s.source_id = ?`,
    )
    .get(created.source.sourceId) as Record<string, unknown>;
  assert.deepEqual(
    { ...compatibilityRef },
    {
      authorization_kind: "trade-command",
      approval_hash: command.binding.contentHash,
      approval_artifact_id: created.authorization.artifactId,
      artifact_kind: "operator-mainnet-trade-command-binding",
    },
  );

  const aggregate = value(
    fixture.store.readOperatorMainnetTradeCommand(command.receipt.commandId),
  );
  assert.equal(aggregate?.consumption?.sourceId, created.source.sourceId);
  assert.equal(aggregate?.source?.authorization.kind, "trade-command");
  assert.equal(fixture.store.prepareCreateIntent(request).ok, false);

  fixture.connection.close();
  const reopened = value(
    openSqliteConnection({
      environment: "mainnet",
      databasePath: fixture.path,
      runtime,
      clock: { now: () => NOW },
    }),
  );
  const reopenedStore = value(
    createSqliteOperatorMainnetTestStore(reopened, fixture.scope),
  );
  const recovered = value(
    reopenedStore.readOperatorMainnetTradeCommand(command.receipt.commandId),
  );
  assert.equal(recovered?.receipt.contentHash, command.receipt.contentHash);
  assert.equal(recovered?.binding?.contentHash, command.binding.contentHash);
  assert.equal(
    recovered?.consumption?.writeIntentId,
    created.intent.writeIntentId,
  );
  assert.equal(recovered?.source?.authorization.kind, "trade-command");
  const resolved = value(
    resolveOperatorMainnetTradeCommand(command.receipt.commandId, {
      databasePath: fixture.path,
    }),
  );
  assert.equal(
    resolved?.snapshot.receipt.contentHash,
    command.receipt.contentHash,
  );
  assert.equal(
    resolved?.snapshot.consumption?.sourceId,
    created.source.sourceId,
  );
  assert.equal(
    reopened.db
      .prepare(
        "SELECT COUNT(*) AS count FROM operator_mainnet_trade_command_consumptions",
      )
      .get()?.count,
    1,
  );
  assert.deepEqual(reopened.db.prepare("PRAGMA foreign_key_check").all(), []);
  reopened.close();
});

test("direct trade-command plans cannot create legacy recovery grants", () => {
  const fixture = setup();
  const original = value(prepare(fixture));
  const command = tradeCommand("direct-plan-cannot-recover");
  saveRecoveryPlan(fixture, command.plan as unknown as OperatorMainnetTestPlan);
  const haltBefore = value(fixture.execution.readHalt());

  const grant = fixture.store.createOperatorMainnetRecoveryGrant({
    sourceId: original.source.sourceId,
    planHash: command.plan.contentHash,
    resolution: {
      kind: "manual-attested",
      attestationHash: `sha256:${"c".repeat(64)}` as PlanHash,
    },
    actor: "operator-01",
    consent: true,
    issuedAt: fixture.clock.value,
  });

  assert.equal(grant.ok, false);
  if (!grant.ok) {
    assert.equal(grant.error.code, "PERSISTENCE_CONFLICT");
    assert.match(
      grant.error.message,
      /direct trade-command plans cannot authorize recovery grants/u,
    );
  }
  assert.deepEqual(value(fixture.execution.readHalt()), haltBefore);
  assert.equal(
    fixture.connection.db
      .prepare("SELECT COUNT(*) AS count FROM operator_mainnet_recovery_grants")
      .get()?.count,
    0,
  );
  fixture.connection.close();
});

test("direct intent expiry uses local authorization time, not provider event time", () => {
  const validFixture = setup();
  const validCommand = tradeCommand("trade-command-local-expiry-valid");
  value(
    validFixture.store.persistOperatorMainnetTradeCommandReceipt({
      receipt: validCommand.receipt,
      recordedAt: NOW,
    }),
  );
  value(
    validFixture.store.bindOperatorMainnetTradeCommand({
      binding: validCommand.binding,
      boundAt: NOW,
    }),
  );
  const providerAfterExpiry = new Date(
    Date.parse(validCommand.receipt.expiresAt) + 1_000,
  ).toISOString() as UtcTimestamp;
  const localBeforeExpiry = new Date(
    Date.parse(validCommand.receipt.expiresAt) - 1,
  ).toISOString() as UtcTimestamp;
  const accepted = value(
    validFixture.store.prepareCreateIntent({
      runId: "trade-command-run-01",
      plan: validCommand.plan,
      tradeCommand: {
        receipt: validCommand.receipt,
        binding: validCommand.binding,
        authorizationAt: localBeforeExpiry,
      },
      payloadJson: validCommand.payloadJson,
      payloadHash: validCommand.payloadHash,
      preparedAt: providerAfterExpiry,
    }),
  );
  assert.equal(accepted.intent.preparedAt, providerAfterExpiry);
  assert.equal(accepted.authorization.kind, "trade-command");
  validFixture.connection.close();

  const expiredFixture = setup();
  const expiredCommand = tradeCommand("trade-command-local-expiry-blocked");
  value(
    expiredFixture.store.persistOperatorMainnetTradeCommandReceipt({
      receipt: expiredCommand.receipt,
      recordedAt: NOW,
    }),
  );
  value(
    expiredFixture.store.bindOperatorMainnetTradeCommand({
      binding: expiredCommand.binding,
      boundAt: NOW,
    }),
  );
  const providerBeforeExpiry = new Date(
    Date.parse(expiredCommand.receipt.expiresAt) - 1_000,
  ).toISOString() as UtcTimestamp;
  const rejected = expiredFixture.store.prepareCreateIntent({
    runId: "trade-command-run-01",
    plan: expiredCommand.plan,
    tradeCommand: {
      receipt: expiredCommand.receipt,
      binding: expiredCommand.binding,
      authorizationAt: expiredCommand.receipt.expiresAt,
    },
    payloadJson: expiredCommand.payloadJson,
    payloadHash: expiredCommand.payloadHash,
    preparedAt: providerBeforeExpiry,
  });
  assert.equal(rejected.ok, false);
  for (const table of [
    "operator_mainnet_test_sources",
    "operator_mainnet_test_write_intents",
    "operator_mainnet_trade_command_consumptions",
  ])
    assert.equal(
      expiredFixture.connection.db
        .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
        .get()?.count,
      0,
    );
  expiredFixture.connection.close();
});

test("direct trade-command outcomes are safe, append-only and prevent later binding", () => {
  const fixture = setup();
  const command = tradeCommand();
  value(
    fixture.store.persistOperatorMainnetTradeCommandReceipt({
      receipt: command.receipt,
      recordedAt: NOW,
    }),
  );
  assert.equal(
    fixture.store.persistOperatorMainnetTradeCommandReceipt({
      receipt: command.receipt,
      recordedAt: NOW,
    }).ok,
    true,
  );
  value(
    fixture.store.bindOperatorMainnetTradeCommand({
      binding: command.binding,
      boundAt: NOW,
    }),
  );
  const changedDerivation = tradeCommand(
    command.receipt.commandId,
    "0.08860",
    command.receipt,
  );
  assert.notEqual(
    changedDerivation.binding.contentHash,
    command.binding.contentHash,
  );
  assert.equal(
    fixture.store.bindOperatorMainnetTradeCommand({
      binding: changedDerivation.binding,
      boundAt: NOW,
    }).ok,
    false,
  );
  value(
    fixture.store.appendOperatorMainnetTradeCommandOutcome({
      commandId: command.receipt.commandId,
      outcomeId: "trade-command-outcome-01",
      stage: "precheck",
      code: "ACCOUNT_CAPACITY_INCOMPLETE",
      diagnosticDetails: { reason: "balance unavailable", symbol: "DOGEUSDT" },
      occurredAt: NOW,
    }),
  );
  assert.equal(
    fixture.store.appendOperatorMainnetTradeCommandOutcome({
      commandId: command.receipt.commandId,
      outcomeId: "trade-command-outcome-secret",
      stage: "precheck",
      code: "BLOCKED",
      diagnosticDetails: { apiKey: "must-not-persist" } as never,
      occurredAt: NOW,
    }).ok,
    false,
  );
  const aggregate = value(
    fixture.store.readOperatorMainnetTradeCommand(command.receipt.commandId),
  );
  assert.equal(aggregate?.binding?.contentHash, command.binding.contentHash);
  assert.equal(aggregate?.consumption, undefined);
  assert.equal(aggregate?.source, undefined);
  assert.equal(aggregate?.outcomes.length, 1);
  assert.equal(
    aggregate?.outcomes[0]?.diagnosticDetails.reason,
    "balance unavailable",
  );
  assert.equal(
    fixture.store.bindOperatorMainnetTradeCommand({
      binding: changedDerivation.binding,
      boundAt: NOW,
    }).ok,
    false,
  );
  assert.equal(
    fixture.store.prepareCreateIntent({
      runId: "trade-command-run-01",
      plan: command.plan,
      tradeCommand: {
        receipt: command.receipt,
        binding: command.binding,
        authorizationAt: NOW,
      },
      payloadJson: command.payloadJson,
      payloadHash: command.payloadHash,
      preparedAt: NOW,
    }).ok,
    false,
  );
  assert.equal(
    fixture.connection.db
      .prepare("SELECT COUNT(*) AS count FROM operator_mainnet_test_sources")
      .get()?.count,
    0,
  );
  fixture.connection.close();
});

test("direct-command status rejects consumption and intent cross-link corruption", () => {
  const fixture = setup();
  const command = tradeCommand();
  value(
    fixture.store.persistOperatorMainnetTradeCommandReceipt({
      receipt: command.receipt,
      recordedAt: NOW,
    }),
  );
  value(
    fixture.store.bindOperatorMainnetTradeCommand({
      binding: command.binding,
      boundAt: NOW,
    }),
  );
  const created = value(
    fixture.store.prepareCreateIntent({
      runId: "trade-command-run-01",
      plan: command.plan,
      tradeCommand: {
        receipt: command.receipt,
        binding: command.binding,
        authorizationAt: NOW,
      },
      payloadJson: command.payloadJson,
      payloadHash: command.payloadHash,
      preparedAt: NOW,
    }),
  );

  // Simulate out-of-band journal corruption while retaining valid hash shapes.
  fixture.connection.db.exec(
    "DROP TRIGGER operator_mainnet_trade_command_consumptions_no_update",
  );
  const corruptHash = `sha256:${"f".repeat(64)}`;
  fixture.connection.db
    .prepare(
      `UPDATE operator_mainnet_trade_command_consumptions
       SET binding_hash = ? WHERE command_id = ?`,
    )
    .run(corruptHash, command.receipt.commandId);
  assert.equal(
    fixture.store.readOperatorMainnetTradeCommand(command.receipt.commandId).ok,
    false,
  );
  fixture.connection.db
    .prepare(
      `UPDATE operator_mainnet_trade_command_consumptions
       SET binding_hash = ? WHERE command_id = ?`,
    )
    .run(command.binding.contentHash, command.receipt.commandId);

  const source = value(
    fixture.store.readOperatorMainnetTestSource(created.source.sourceId),
  );
  assert.ok(source);
  const alteredIntent = value(
    canonicalSerialize({
      ...JSON.parse(source.intent.canonicalJson),
      commandReceiptHash: corruptHash,
    }),
  );
  fixture.connection.db
    .prepare(
      `UPDATE operator_mainnet_test_write_intents
       SET canonical_json = ?, canonical_hash = ? WHERE source_id = ?`,
    )
    .run(alteredIntent, payloadHash(alteredIntent), created.source.sourceId);
  assert.equal(
    fixture.store.readOperatorMainnetTestSource(created.source.sourceId).ok,
    false,
  );
  fixture.connection.close();
});
