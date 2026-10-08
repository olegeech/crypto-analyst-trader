import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openSqliteConnection } from "../src/adapters/sqlite/connection.js";
import { createSqliteExecutionStore } from "../src/adapters/sqlite/execution-store.js";
import { createSqlitePreparedLegStore } from "../src/adapters/sqlite/prepared-leg-store.js";
import { createPreparedLegExecution } from "../src/domain/execution/prepared-leg-execution.js";
import { createPreparedLegOrderProof } from "../src/domain/execution/prepared-leg-order-proof.js";
import { encodeCanonicalArtifact } from "../src/domain/identity/canonical-artifact.js";
import {
  parseUtcTimestamp,
  type UtcTimestamp,
} from "../src/domain/shared/time.js";
import type { Result } from "../src/domain/shared/result.js";
import type { PersistenceScope } from "../src/ports/persistence.js";
import { preparedLegExecutionFixture } from "./fixtures/prepared-leg-execution-fixtures.js";
import { requireDailyFixture as value } from "./fixtures/daily-planning-evidence-fixtures.js";

const runtime = { nodeVersion: "22.22.3", sqliteVersion: "3.51.3" } as const;
const temporaryRoots: string[] = [];

test.after(() => {
  for (const root of temporaryRoots)
    rmSync(root, { recursive: true, force: true });
});

function unwrap<T>(result: Result<T>): T {
  if (!result.ok)
    throw new Error(result.error.code + ": " + result.error.message);
  return result.value;
}
function time(value: string): UtcTimestamp {
  return unwrap(parseUtcTimestamp(value));
}

function setup() {
  const fixture = preparedLegExecutionFixture();
  const now = time(fixture.now);
  const execution = value(
    createPreparedLegExecution({
      approval: fixture.approval,
      approvalHash: fixture.approval.contentHash,
      legId: fixture.legId,
      now: fixture.now,
    }),
  );
  const root = mkdtempSync(join(tmpdir(), "prepared-leg-store-"));
  temporaryRoots.push(root);
  const clock = { value: now };
  const connection = unwrap(
    openSqliteConnection({
      environment: "mainnet",
      databasePath: join(root, "mainnet.db"),
      runtime,
      clock: { now: () => clock.value },
    }),
  );
  const scope: PersistenceScope = {
    exchange: "bybit",
    environment: "mainnet",
    accountId: execution.accountIdentityHash,
    category: "linear",
    positionMode: "one-way",
  };
  const legacy = unwrap(createSqliteExecutionStore(connection, scope));
  const preparedEnvelope = value(
    encodeCanonicalArtifact("prepared-daily-plan", fixture.prepared),
  );
  const approvalEnvelope = value(
    encodeCanonicalArtifact("prepared-plan-approval", fixture.approval),
  );
  unwrap(
    legacy.writeArtifact({
      artifactId: "prepared:" + fixture.prepared.contentHash,
      artifactKind: "prepared-daily-plan",
      envelope: preparedEnvelope,
      materialHash: fixture.prepared.contentHash,
    }),
  );
  unwrap(
    legacy.writeArtifact({
      artifactId: "prepared-consent:" + fixture.approval.contentHash,
      artifactKind: "prepared-plan-approval",
      envelope: approvalEnvelope,
      materialHash: fixture.approval.contentHash,
    }),
  );
  const store = unwrap(createSqlitePreparedLegStore(connection, scope));
  const lease = unwrap(
    legacy.acquireLease({
      scope,
      ownerRunId: "prepared-run",
      now: clock.value,
      ttlMs: 60_000,
    }),
  );
  return {
    fixture,
    execution,
    now,
    root,
    connection,
    scope,
    legacy,
    store,
    lease,
    clock,
  };
}

function proof(
  execution: ReturnType<typeof setup>["execution"],
  observedAt: UtcTimestamp,
  status: "open" | "cancelled" = "open",
) {
  const intent = execution.leg.intent;
  return value(
    createPreparedLegOrderProof({
      exchangeOrderId: "exchange-order-21",
      clientOrderId: execution.clientOrderId,
      instrument: intent.instrument,
      category: "linear",
      side: "buy",
      requestedQuantity: intent.quantity.toString(),
      filledQuantity: "0",
      status,
      orderType: "limit",
      price: intent.price.toString(),
      timeInForce: "GTC",
      takeProfit: intent.protection!.takeProfit!.toString(),
      stopLoss: null,
      reduceOnly: false,
      positionIdx: 0,
      observedAt,
      source: "bybit-mainnet/realtime",
    }),
  );
}

test("prepared source and create intent are committed atomically and renewed invocation cannot create twice", () => {
  const state = setup();
  const request = {
    authority: state.lease,
    runId: "prepared-run",
    execution: state.execution,
    preparedAt: state.now,
  };
  const first = unwrap(state.store.preparePreparedLegCreate(request));
  assert.equal(first.created, true);
  assert.equal(first.approvalAdded, true);
  assert.equal(first.snapshot.lineage.legId, state.fixture.legId);
  assert.equal(first.snapshot.createIntent.operation, "create");
  assert.equal(
    first.snapshot.createIntent.clientOrderId,
    state.execution.clientOrderId,
  );
  assert.equal(
    state.connection.db
      .prepare("SELECT COUNT(*) AS n FROM prepared_leg_sources")
      .get()?.n,
    1,
  );
  assert.equal(
    state.connection.db
      .prepare(
        "SELECT COUNT(*) AS n FROM prepared_leg_write_intents WHERE operation = 'create'",
      )
      .get()?.n,
    1,
  );

  const replay = unwrap(state.store.preparePreparedLegCreate(request));
  assert.equal(replay.created, false);
  assert.equal(
    replay.snapshot.createIntent.writeIntentId,
    first.snapshot.createIntent.writeIntentId,
  );
  assert.equal(
    state.connection.db
      .prepare(
        "SELECT COUNT(*) AS n FROM prepared_leg_write_intents WHERE operation = 'create'",
      )
      .get()?.n,
    1,
  );
  state.connection.close();
});

test("prepared-leg create transaction rolls back source and approval when intent insert fails", () => {
  const state = setup();
  const request = {
    authority: state.lease,
    runId: "prepared-run",
    execution: state.execution,
    preparedAt: state.now,
  };
  state.connection.db.exec(`
    CREATE TRIGGER reject_prepared_leg_create_intent
    BEFORE INSERT ON prepared_leg_write_intents
    WHEN NEW.operation = 'create'
    BEGIN
      SELECT RAISE(ABORT, 'injected intent insert failure');
    END;
  `);

  const failed = state.store.preparePreparedLegCreate(request);
  assert.equal(failed.ok, false);
  for (const table of [
    "prepared_leg_sources",
    "prepared_leg_approvals",
    "prepared_leg_write_intents",
  ]) {
    assert.equal(
      state.connection.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()
        ?.n,
      0,
      `${table} must roll back with the failed create intent`,
    );
  }

  state.connection.db.exec("DROP TRIGGER reject_prepared_leg_create_intent");
  const retried = unwrap(state.store.preparePreparedLegCreate(request));
  assert.equal(retried.created, true);
  assert.equal(
    state.connection.db
      .prepare("SELECT COUNT(*) AS n FROM prepared_leg_sources")
      .get()?.n,
    1,
  );
  assert.equal(
    state.connection.db
      .prepare("SELECT COUNT(*) AS n FROM prepared_leg_approvals")
      .get()?.n,
    1,
  );
  assert.equal(
    state.connection.db
      .prepare("SELECT COUNT(*) AS n FROM prepared_leg_write_intents")
      .get()?.n,
    1,
  );
  state.connection.close();
});

test("exact open reconciliation is known state without HALT; separately prepared exact cancel remains single-order", () => {
  const state = setup();
  const source = unwrap(
    state.store.preparePreparedLegCreate({
      authority: state.lease,
      runId: "prepared-run",
      execution: state.execution,
      preparedAt: state.now,
    }),
  ).snapshot;
  const opened = proof(state.execution, state.now);
  unwrap(
    state.store.appendPreparedLegAttempt({
      authority: state.lease,
      sourceId: source.lineage.sourceId,
      operation: "create",
      attemptId: "create-attempt-1",
      result: { outcome: "accepted", exchangeOrderId: opened.exchangeOrderId },
      recordedAt: state.now,
    }),
  );
  const openRecord = unwrap(
    state.store.appendPreparedLegReconciliation({
      authority: state.lease,
      sourceId: source.lineage.sourceId,
      status: "CONFIRMED_OPEN",
      observedAt: state.now,
      exchangeOrderId: opened.exchangeOrderId,
      result: { orderProof: opened },
    }),
  );
  assert.equal(openRecord.status, "CONFIRMED_OPEN");
  assert.equal(openRecord.revision, 1);
  assert.equal(unwrap(state.legacy.readHalt()).active, false);

  const cancel = unwrap(
    state.store.preparePreparedLegCancel({
      authority: state.lease,
      sourceId: source.lineage.sourceId,
      runId: "prepared-run",
      proof: opened,
      preparedAt: state.now,
    }),
  );
  assert.equal(cancel.created, true);
  assert.equal(cancel.snapshot.cancelIntent?.operation, "cancel");
  assert.equal(
    cancel.snapshot.cancelIntent?.exchangeOrderId,
    opened.exchangeOrderId,
  );
  const resumedCancel = unwrap(
    state.store.preparePreparedLegCancel({
      authority: state.lease,
      sourceId: source.lineage.sourceId,
      runId: "prepared-run",
      proof: opened,
      preparedAt: state.now,
    }),
  );
  assert.equal(resumedCancel.created, false);
  assert.equal(
    resumedCancel.snapshot.cancelIntent?.writeIntentId,
    cancel.snapshot.cancelIntent?.writeIntentId,
  );
  assert.equal(
    state.connection.db
      .prepare(
        "SELECT COUNT(*) AS n FROM prepared_leg_write_intents WHERE operation = 'cancel'",
      )
      .get()?.n,
    1,
  );

  const cancelled = proof(state.execution, state.now, "cancelled");
  const record = unwrap(
    state.store.appendPreparedLegReconciliation({
      authority: state.lease,
      sourceId: source.lineage.sourceId,
      status: "CANCELLED",
      observedAt: state.now,
      exchangeOrderId: cancelled.exchangeOrderId,
      result: { orderProof: cancelled },
    }),
  );
  assert.equal(record.status, "CANCELLED");
  assert.equal(unwrap(state.legacy.readHalt()).active, false);
  state.connection.close();
});

test("contradictory exact-order terms are durably classified unresolved and raise HALT", () => {
  const state = setup();
  const source = unwrap(
    state.store.preparePreparedLegCreate({
      authority: state.lease,
      runId: "prepared-run",
      execution: state.execution,
      preparedAt: state.now,
    }),
  ).snapshot;
  const valid = proof(state.execution, state.now);
  const wrongTerms = value(
    createPreparedLegOrderProof({
      exchangeOrderId: valid.exchangeOrderId,
      clientOrderId: valid.clientOrderId,
      instrument: valid.instrument,
      category: "linear",
      side: "buy",
      requestedQuantity: valid.requestedQuantity.toString(),
      filledQuantity: "0",
      status: "open",
      orderType: "limit",
      price: valid.price.toString() + "1",
      timeInForce: "GTC",
      takeProfit: valid.takeProfit?.toString(),
      stopLoss: null,
      reduceOnly: false,
      positionIdx: 0,
      observedAt: state.now,
      source: "bybit-mainnet/realtime",
    }),
  );
  const record = unwrap(
    state.store.appendPreparedLegReconciliation({
      authority: state.lease,
      sourceId: source.lineage.sourceId,
      status: "CONFIRMED_OPEN",
      observedAt: state.now,
      result: { orderProof: wrongTerms },
    }),
  );
  assert.equal(record.status, "UNRESOLVED");
  assert.equal(unwrap(state.legacy.readHalt()).active, true);
  assert.equal(
    state.connection.db
      .prepare("SELECT COUNT(*) AS n FROM prepared_leg_reconciliations")
      .get()?.n,
    1,
  );
  state.connection.close();
});

test("cancel rejects stale, filled, foreign or unowned order proofs before writing an intent", () => {
  const state = setup();
  const source = unwrap(
    state.store.preparePreparedLegCreate({
      authority: state.lease,
      runId: "prepared-run",
      execution: state.execution,
      preparedAt: state.now,
    }),
  ).snapshot;
  const opened = proof(state.execution, state.now);
  unwrap(
    state.store.appendPreparedLegReconciliation({
      authority: state.lease,
      sourceId: source.lineage.sourceId,
      status: "CONFIRMED_OPEN",
      observedAt: state.now,
      result: { orderProof: opened },
    }),
  );
  const stale = value(
    createPreparedLegOrderProof({
      exchangeOrderId: opened.exchangeOrderId,
      clientOrderId: opened.clientOrderId,
      instrument: opened.instrument,
      category: "linear",
      side: "buy",
      requestedQuantity: opened.requestedQuantity.toString(),
      filledQuantity: "0",
      status: "open",
      orderType: "limit",
      price: opened.price!.toString(),
      timeInForce: "GTC",
      takeProfit: opened.takeProfit!.toString(),
      stopLoss: null,
      reduceOnly: false,
      positionIdx: 0,
      observedAt: time("2026-09-24T14:00:03.000Z"),
      source: "bybit-mainnet/realtime",
    }),
  );
  const rejected = state.store.preparePreparedLegCancel({
    authority: state.lease,
    sourceId: source.lineage.sourceId,
    runId: "prepared-run",
    proof: stale,
    preparedAt: state.now,
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.code, "OWNERSHIP_MISMATCH");
  assert.equal(
    state.connection.db
      .prepare(
        "SELECT COUNT(*) AS n FROM prepared_leg_write_intents WHERE operation = 'cancel'",
      )
      .get()?.n,
    0,
  );
  state.connection.close();
});
