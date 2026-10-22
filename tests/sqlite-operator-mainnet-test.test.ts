import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openSqliteConnection } from "../src/adapters/sqlite/connection.js";
import { createSqliteExecutionStore } from "../src/adapters/sqlite/execution-store.js";
import { createSqliteOperatorMainnetTestStore } from "../src/adapters/sqlite/operator-mainnet-test-store.js";
import {
  createOperatorMainnetQuote,
  createOperatorMainnetTestApproval,
  createOperatorMainnetTestPlan,
  deriveOperatorMainnetTestSourceId,
} from "../src/domain/execution/operator-mainnet-test-plan.js";
import { createInstrumentConstraints } from "../src/domain/market/instrument-constraints.js";
import type { PlanHash } from "../src/domain/identity/canonical-serialization.js";
import {
  parseUtcTimestamp,
  type UtcTimestamp,
} from "../src/domain/shared/time.js";
import type { Result } from "../src/domain/shared/result.js";
import type { PersistenceScope } from "../src/ports/persistence.js";
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

function plan(nonce = "operator-test-01") {
  const quote = value(
    createOperatorMainnetQuote({
      symbol: "DOGEUSDT",
      exchange: "bybit",
      environment: "mainnet",
      category: "linear",
      origin: "https://api.bybit.com",
      observedAt: "2026-10-22T10:00:59.990Z",
      collectionStartedAt: "2026-10-22T10:00:59.980Z",
      collectionCompletedAt: "2026-10-22T10:00:59.995Z",
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
      preparedAt: NOW,
    }),
  );
}

function approval(valuePlan = plan()) {
  return value(
    createOperatorMainnetTestApproval({
      plan: valuePlan,
      planHash: valuePlan.contentHash,
      actor: "operator-01",
      consent: true,
      approvedAt: NOW,
    }),
  );
}

function exactPayload(valuePlan: ReturnType<typeof plan>): string {
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
  const lease = value(
    execution.acquireLease({
      scope,
      ownerRunId: "operator-run-01",
      now: NOW,
      ttlMs: 60_000,
    }),
  );
  return { root, path, clock, connection, scope, execution, store, lease };
}

function prepare(
  fixture: ReturnType<typeof setup>,
  valuePlan = plan(),
  valueApproval = approval(valuePlan),
) {
  const payload = exactPayload(valuePlan);
  return fixture.store.prepareCreateIntent({
    authority: {
      ownerRunId: fixture.lease.ownerRunId,
      epoch: fixture.lease.epoch,
    },
    runId: fixture.lease.ownerRunId,
    plan: valuePlan,
    approval: valueApproval,
    payloadJson: payload,
    payloadHash: payloadHash(payload),
    preparedAt: fixture.clock.value,
  });
}

test("operator create intent, canonical artifacts and exact payload commit atomically", () => {
  const fixture = setup();
  const valuePlan = plan();
  const valueApproval = approval(valuePlan);
  const source = value(prepare(fixture, valuePlan, valueApproval));

  assert.equal(source.source.planHash, valuePlan.contentHash);
  assert.equal(source.source.approvalHash, valueApproval.contentHash);
  assert.equal(source.source.clientOrderId, valuePlan.clientOrderId);
  assert.equal(source.source.payloadJson, exactPayload(valuePlan));
  assert.equal(
    source.source.payloadHash,
    payloadHash(source.source.payloadJson),
  );
  assert.equal(source.intent.operation, "CREATE");
  assert.equal(source.intent.leaseEpoch, fixture.lease.epoch);
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
  assert.equal(CURRENT_SCHEMA_VERSION, 8);
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

  const pending = value(
    fixture.store.findPendingOperatorMainnetTestSource(
      { ownerRunId: fixture.lease.ownerRunId, epoch: fixture.lease.epoch },
      fixture.clock.value,
    ),
  );
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
      authority: {
        ownerRunId: fixture.lease.ownerRunId,
        epoch: fixture.lease.epoch,
      },
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

  const pending = fixture.store.findPendingOperatorMainnetTestSource(
    { ownerRunId: fixture.lease.ownerRunId, epoch: fixture.lease.epoch },
    fixture.clock.value,
  );
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

test("attempt and unknown-protection HALT are one fenced atomic write", () => {
  const fixture = setup();
  const created = value(prepare(fixture));
  const recorded = value(
    fixture.store.recordAttemptAndHalt({
      authority: {
        ownerRunId: fixture.lease.ownerRunId,
        epoch: fixture.lease.epoch,
      },
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
  const authority = {
    ownerRunId: fixture.lease.ownerRunId,
    epoch: fixture.lease.epoch,
  };
  const first = value(
    fixture.store.appendReconciliation({
      authority,
      sourceId: created.source.sourceId,
      lifecycleOutcome: "PARTIAL_EVIDENCE",
      cleanupStatus: "pending",
      evidence: { entryFillQuantity: "0", openEntryRemainder: true },
      observedAt: fixture.clock.value,
    }),
  );
  const action = value(
    fixture.store.appendManualAction({
      authority,
      sourceId: created.source.sourceId,
      action: "entry-remainder-cancelled",
      provenance: { actor: "operator-01", source: "Bybit UI" },
      declaredAt: fixture.clock.value,
    }),
  );
  fixture.clock.value = timestamp("2026-10-22T10:01:01.000Z");
  const second = value(
    fixture.store.appendReconciliation({
      authority,
      sourceId: created.source.sourceId,
      lifecycleOutcome: "NOT_EXERCISED",
      cleanupStatus: "verified-clean",
      evidence: { entryFillQuantity: "0", openEntryRemainder: false },
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
    value(
      fixture.store.findPendingOperatorMainnetTestSource(
        authority,
        fixture.clock.value,
      ),
    ),
    undefined,
  );
});

test("status reconciliation can append after lease takeover without clearing HALT", () => {
  const fixture = setup();
  const created = value(prepare(fixture));
  value(
    fixture.store.recordAttemptAndHalt({
      authority: {
        ownerRunId: fixture.lease.ownerRunId,
        epoch: fixture.lease.epoch,
      },
      sourceId: created.source.sourceId,
      attemptId: "operator-attempt-recovery",
      outcome: "accepted",
      exchangeOrderId: "exchange-parent-recovery",
      recordedAt: fixture.clock.value,
    }),
  );

  fixture.clock.value = timestamp("2026-10-22T10:02:01.000Z");
  const recoveryLease = value(
    fixture.execution.acquireLease({
      scope: fixture.scope,
      ownerRunId: "operator-status-recovery",
      now: fixture.clock.value,
      ttlMs: 60_000,
    }),
  );
  assert.equal(recoveryLease.reconciliationRequired, true);
  assert.equal(value(fixture.execution.readHalt()).active, true);

  const appended = value(
    fixture.store.appendReconciliation({
      authority: {
        ownerRunId: recoveryLease.ownerRunId,
        epoch: recoveryLease.epoch,
      },
      sourceId: created.source.sourceId,
      lifecycleOutcome: "UNKNOWN",
      cleanupStatus: "unknown",
      evidence: { reason: "recovery read incomplete" },
      observedAt: fixture.clock.value,
    }),
  );
  assert.equal(appended.revision, 1);
  assert.equal(
    value(fixture.store.readOperatorMainnetTestSource(created.source.sourceId))
      ?.reconciliations.length,
    1,
  );
  assert.equal(
    value(fixture.execution.readLease())?.reconciliationRequired,
    true,
  );
  assert.equal(value(fixture.execution.readHalt()).active, true);
  fixture.connection.close();
});
