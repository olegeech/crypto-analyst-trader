import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { openSqlitePersistence } from "../src/adapters/sqlite/sqlite-persistence.js";
import { recoverPriorDemoRuns } from "../src/application/demo-recovery.js";
import { createApproval } from "../src/domain/execution/approval.js";
import { createExecutionAttempt } from "../src/domain/execution/execution-attempt.js";
import { createExchangeOrder } from "../src/domain/execution/exchange-order.js";
import {
  addMilliseconds,
  fixedClock,
  type Clock,
} from "../src/domain/shared/time.js";
import type { Result } from "../src/domain/shared/result.js";
import type {
  ExchangeExecutionPort,
  ExchangeOrderObservation,
  ExchangeResult,
} from "../src/ports/exchange-execution.js";
import type {
  PersistencePort,
  PersistenceScope,
} from "../src/ports/persistence.js";
import { createPlanFixture } from "./domain-plan-fixture.js";

const runtime = { nodeVersion: "22.22.3", sqliteVersion: "3.51.3" } as const;

function unwrap<T>(result: Result<T>): T {
  if (!result.ok)
    throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function createScope(): PersistenceScope {
  return {
    exchange: "bybit",
    environment: "demo",
    accountId: "demo:fixture",
    category: "linear",
    positionMode: "one-way",
  };
}

function openStore(clock: Clock): PersistencePort {
  const root = mkdtempSync(join(tmpdir(), "demo-recovery-"));
  return openStoreAt(clock, join(root, "execution.db"));
}

function openStoreAt(clock: Clock, databasePath: string): PersistencePort {
  return unwrap(
    openSqlitePersistence({
      environment: "demo",
      databasePath,
      runtime,
      clock,
      scope: createScope(),
    }),
  );
}

function unavailable(): ExchangeResult<never> {
  return {
    ok: false,
    error: {
      kind: "transport",
      message: "fixture exchange unavailable",
      retry: "never",
    },
  };
}

function exchangeThatCannotWrite(
  readState: () => ExchangeResult<never>,
): ExchangeExecutionPort {
  return {
    readState: async () => readState(),
    createOrder: async () => unavailable(),
    observeOrder: async () => unavailable(),
    listAttachedProtection: async () => unavailable(),
    listFills: async () => unavailable(),
    setLeverage: async () => unavailable(),
    cancelOrder: async () => unavailable(),
  };
}

function exchangeThatObserves(
  observation: ExchangeOrderObservation,
): ExchangeExecutionPort {
  return {
    readState: async () => unavailable(),
    createOrder: async () => unavailable(),
    observeOrder: async () => ({ ok: true, value: observation }),
    listAttachedProtection: async () => ({ ok: true, value: [] }),
    listFills: async () => ({ ok: true, value: [] }),
    setLeverage: async () => unavailable(),
    cancelOrder: async () => unavailable(),
  };
}

function seedUnboundAttempt(databasePath: string, runId: string): string {
  const clock = unwrap(fixedClock("2026-09-19T10:00:00Z"));
  const store = openStoreAt(clock, databasePath);
  const plan = createPlanFixture();
  const lineage = unwrap(
    store.prepareLineage({
      scope: store.scope,
      runId,
      plan,
      approval: unwrap(
        createApproval({
          approvalId: `${runId}-approval`,
          planHash: plan.materialHash,
          actor: "operator",
          approvedAt: clock.now(),
          expiresAt: unwrap(addMilliseconds(clock.now(), 300_000)),
        }),
      ),
      preparedAt: clock.now(),
    }),
  );
  const authority = unwrap(
    store.acquireLease({
      scope: store.scope,
      ownerRunId: runId,
      now: clock.now(),
      ttlMs: 1,
    }),
  );
  const intent = unwrap(
    store.prepareOwnedIntent({
      authority,
      lineageId: lineage.lineageId,
      intentId: plan.material.orderIntents[0]!.intentId,
      planHash: plan.materialHash,
      clientOrderId: `${runId}-client`,
      now: clock.now(),
      preparedAt: clock.now(),
    }),
  );
  const attempt = unwrap(
    createExecutionAttempt({
      attemptId: `${runId}-attempt`,
      planHash: plan.materialHash,
      intentId: intent.intentId,
      clientOrderId: intent.clientOrderId,
      submittedAt: clock.now(),
      acknowledgement: "accepted",
      terminalStatus: "unverified",
    }),
  );
  unwrap(
    store.appendAttempt({
      authority,
      lineageId: lineage.lineageId,
      attempt,
      dispatchedAt: clock.now(),
    }),
  );
  unwrap(store.raiseHalt(authority, "fixture restart recovery", clock.now()));
  store.close();
  return lineage.lineageId;
}

test("recovery clears a stale HALT when the exact Demo scope has no runs", async () => {
  const clock = unwrap(fixedClock("2026-09-22T10:00:00.000Z"));
  const store = openStore(clock);
  const authority = unwrap(
    store.acquireLease({
      scope: store.scope,
      ownerRunId: "recovery-empty",
      now: clock.now(),
      ttlMs: 60_000,
    }),
  );
  unwrap(store.raiseHalt(authority, "fixture stale halt", clock.now()));

  let reads = 0;
  const result = await recoverPriorDemoRuns({
    exchange: exchangeThatCannotWrite(() => {
      reads += 1;
      return unavailable();
    }),
    persistence: store,
    authority,
    clock,
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.safeToProceed, true);
    assert.equal(result.value.clearedHalt, true);
    assert.deepEqual(result.value.unresolvedLineages, []);
  }
  assert.equal(reads, 0);
  assert.equal(unwrap(store.readHalt()).active, false);
  store.close();
});

test("recovery blocks a plan-only lineage when fresh exchange state is unavailable", async () => {
  const clock = unwrap(fixedClock("2026-09-22T10:00:00.000Z"));
  const store = openStore(clock);
  const plan = createPlanFixture();
  const approval = unwrap(
    createApproval({
      approvalId: "recovery-plan-only-approval",
      planHash: plan.materialHash,
      actor: "demo-operator",
      approvedAt: clock.now(),
      expiresAt: unwrap(addMilliseconds(clock.now(), 60_000)),
    }),
  );
  const lineage = unwrap(
    store.prepareLineage({
      scope: store.scope,
      runId: "recovery-plan-only",
      plan,
      approval,
      preparedAt: clock.now(),
    }),
  );
  const authority = unwrap(
    store.acquireLease({
      scope: store.scope,
      ownerRunId: "recovery-plan-only",
      now: clock.now(),
      ttlMs: 60_000,
    }),
  );
  unwrap(store.raiseHalt(authority, "fixture unresolved plan", clock.now()));

  let reads = 0;
  const result = await recoverPriorDemoRuns({
    exchange: exchangeThatCannotWrite(() => {
      reads += 1;
      return unavailable();
    }),
    persistence: store,
    authority,
    clock,
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.safeToProceed, false);
    assert.equal(result.value.clearedHalt, false);
    assert.equal(result.value.blockedLineages, 1);
    assert.deepEqual(result.value.unresolvedLineages, [lineage.lineageId]);
  }
  assert.equal(reads, 2);
  assert.equal(unwrap(store.readHalt()).active, true);
  assert.equal(unwrap(store.readRuns()).length, 1);
  store.close();
});

test("restart recovery late-binds one exact exchange identity and retains HALT", async () => {
  const root = mkdtempSync(join(tmpdir(), "demo-recovery-restart-"));
  const databasePath = join(root, "execution.db");
  const runId = "restart-binding";
  const lineageId = seedUnboundAttempt(databasePath, runId);
  const clock = unwrap(fixedClock("2026-09-19T10:00:01Z"));
  const store = openStoreAt(clock, databasePath);
  const authority = unwrap(
    store.acquireLease({
      scope: store.scope,
      ownerRunId: "restart-recovery",
      now: clock.now(),
      ttlMs: 60_000,
    }),
  );
  const observedAt = unwrap(fixedClock("2026-09-19T10:00:05Z")).now();
  const order = unwrap(
    createExchangeOrder({
      exchangeOrderId: "restart-bound-order",
      clientOrderId: `${runId}-client`,
      instrument: "DOGEUSDT",
      side: "buy",
      requestedQuantity: "57",
      filledQuantity: "0",
      status: "open",
      observedAt,
      source: "fixture/restart-recovery",
    }),
  );

  const result = await recoverPriorDemoRuns({
    exchange: exchangeThatObserves(order),
    persistence: store,
    authority,
    clock,
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.safeToProceed, false);
    assert.equal(result.value.blockedLineages, 1);
    assert.deepEqual(result.value.unresolvedLineages, [lineageId]);
  }
  const run = unwrap(store.readRun(lineageId));
  assert.ok(run);
  assert.equal(run.identityBindings[0]?.exchangeOrderId, "restart-bound-order");
  assert.equal(run.reconciliations.at(-1)?.result.status, "PENDING");
  assert.equal(unwrap(store.readHalt()).active, true);
  store.close();
});

test("restart recovery rejects a mismatched late candidate without binding", async () => {
  const root = mkdtempSync(join(tmpdir(), "demo-recovery-mismatch-"));
  const databasePath = join(root, "execution.db");
  const runId = "restart-mismatch";
  const lineageId = seedUnboundAttempt(databasePath, runId);
  const clock = unwrap(fixedClock("2026-09-19T10:00:01Z"));
  const store = openStoreAt(clock, databasePath);
  const authority = unwrap(
    store.acquireLease({
      scope: store.scope,
      ownerRunId: "restart-mismatch-recovery",
      now: clock.now(),
      ttlMs: 60_000,
    }),
  );
  const observedAt = unwrap(fixedClock("2026-09-19T10:00:05Z")).now();
  const mismatchedOrder = unwrap(
    createExchangeOrder({
      exchangeOrderId: "mismatched-order",
      clientOrderId: `${runId}-client`,
      instrument: "DOGEUSDT",
      side: "buy",
      requestedQuantity: "58",
      filledQuantity: "0",
      status: "open",
      observedAt,
      source: "fixture/restart-recovery",
    }),
  );

  const result = await recoverPriorDemoRuns({
    exchange: exchangeThatObserves(mismatchedOrder),
    persistence: store,
    authority,
    clock,
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.safeToProceed, false);
    assert.deepEqual(result.value.unresolvedLineages, [lineageId]);
  }
  const run = unwrap(store.readRun(lineageId));
  assert.ok(run);
  assert.deepEqual(run.identityBindings, []);
  assert.equal(run.reconciliations.at(-1)?.result.status, "UNRESOLVED");
  assert.equal(unwrap(store.readHalt()).active, true);
  store.close();
});
