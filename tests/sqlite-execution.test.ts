import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  openSqliteConnection,
  type SqliteConnection,
} from "../src/adapters/sqlite/connection.js";
import {
  createSqliteExecutionStore,
  type SqliteExecutionStore,
} from "../src/adapters/sqlite/execution-store.js";
import { createApproval } from "../src/domain/execution/approval.js";
import { createExecutionAttempt } from "../src/domain/execution/execution-attempt.js";
import {
  reconcileAttempt,
  rehydrateReconciliationResult,
} from "../src/domain/execution/reconciliation.js";
import { encodeCanonicalArtifact } from "../src/domain/identity/canonical-artifact.js";
import {
  parseUtcTimestamp,
  type UtcTimestamp,
} from "../src/domain/shared/time.js";
import type { Result } from "../src/domain/shared/result.js";
import type { PersistenceScope } from "../src/ports/persistence.js";
import { createPlanFixture } from "./domain-plan-fixture.js";

const supportedRuntime = {
  nodeVersion: "22.22.3",
  sqliteVersion: "3.51.3",
} as const;

function unwrap<T>(result: Result<T>): T {
  if (!result.ok)
    throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function time(value: string): UtcTimestamp {
  return unwrap(parseUtcTimestamp(value));
}

function createStore(): {
  readonly root: string;
  readonly connection: SqliteConnection;
  readonly store: SqliteExecutionStore;
  readonly scope: PersistenceScope;
  readonly setNow: (value: string) => void;
} {
  const plan = createPlanFixture();
  const root = mkdtempSync(join(tmpdir(), "sqlite-execution-"));
  const clockState = { value: time("2026-09-19T10:00:02Z") };
  const connection = unwrap(
    openSqliteConnection({
      environment: "demo",
      databasePath: join(root, "execution.db"),
      runtime: supportedRuntime,
      clock: { now: () => clockState.value },
    }),
  );
  const scope: PersistenceScope = {
    exchange: plan.material.executionScope.exchange,
    environment: "demo",
    accountId: plan.material.accountSnapshot.accountScope,
    category: plan.material.executionScope.category,
    positionMode: plan.material.executionScope.positionMode,
  };
  return {
    root,
    connection,
    store: unwrap(createSqliteExecutionStore(connection, scope)),
    scope,
    setNow(value: string): void {
      clockState.value = time(value);
    },
  };
}

function approvalFor(plan: ReturnType<typeof createPlanFixture>) {
  return unwrap(
    createApproval({
      approvalId: "execution-approval",
      planHash: plan.materialHash,
      actor: "operator",
      approvedAt: time("2026-09-19T10:00:00Z"),
      expiresAt: time("2026-09-19T10:05:00Z"),
    }),
  );
}

function prepareLineageAndLease(
  store: SqliteExecutionStore,
  scope: PersistenceScope,
) {
  const plan = createPlanFixture();
  const lineage = unwrap(
    store.prepareLineage({
      scope,
      runId: "run-one",
      plan,
      approval: approvalFor(plan),
      preparedAt: time("2026-09-19T10:00:01Z"),
    }),
  );
  const lease = unwrap(
    store.acquireLease({
      scope,
      ownerRunId: "run-one",
      now: time("2026-09-19T10:00:02Z"),
      ttlMs: 60_000,
    }),
  );
  return { plan, lineage, lease };
}

function prepareIntent(
  store: SqliteExecutionStore,
  scope: PersistenceScope,
  clientOrderId = "owned-client",
) {
  const { plan, lineage, lease } = prepareLineageAndLease(store, scope);
  const intentId = plan.material.orderIntents[0]!.intentId;
  const intent = unwrap(
    store.prepareOwnedIntent({
      authority: lease,
      lineageId: lineage.lineageId,
      intentId,
      planHash: plan.materialHash,
      clientOrderId,
      now: time("2026-09-19T10:00:03Z"),
      preparedAt: time("2026-09-19T10:00:03Z"),
    }),
  );
  return { plan, lineage, lease, intent, intentId, clientOrderId };
}

test("durable lineage and owned intent survive close/reopen and same-identity retries", () => {
  const first = createStore();
  const prepared = prepareIntent(first.store, first.scope);
  const repeatedLineage = unwrap(
    first.store.prepareLineage({
      scope: first.scope,
      runId: "run-one",
      plan: prepared.plan,
      approval: approvalFor(prepared.plan),
      preparedAt: time("2026-09-19T10:00:04Z"),
    }),
  );
  const repeatedIntent = unwrap(
    first.store.prepareOwnedIntent({
      authority: prepared.lease,
      lineageId: prepared.lineage.lineageId,
      intentId: prepared.intentId,
      planHash: prepared.plan.materialHash,
      clientOrderId: prepared.clientOrderId,
      now: time("2026-09-19T10:00:05Z"),
      preparedAt: time("2026-09-19T10:00:05Z"),
    }),
  );
  assert.equal(repeatedLineage.lineageId, prepared.lineage.lineageId);
  assert.equal(repeatedIntent.intentRecordId, prepared.intent.intentRecordId);
  first.store.close();

  const reopenedConnection = unwrap(
    openSqliteConnection({
      environment: "demo",
      databasePath: join(first.root, "execution.db"),
      runtime: supportedRuntime,
      clock: { now: () => time("2026-09-19T10:00:05Z") },
    }),
  );
  const reopened = unwrap(
    createSqliteExecutionStore(reopenedConnection, first.scope),
  );
  assert.equal(
    unwrap(reopened.readLineage(prepared.lineage.lineageId))?.planHash,
    prepared.plan.materialHash,
  );
  assert.equal(
    unwrap(
      reopened.readOwnedIntent(prepared.lineage.lineageId, prepared.intentId),
    )?.clientOrderId,
    prepared.clientOrderId,
  );
  assert.equal(
    unwrap(reopened.readPlan(prepared.lineage.lineageId))?.materialHash,
    prepared.plan.materialHash,
  );
  reopened.close();
});

test("trusted time revalidates approval before creating a durable intent", () => {
  const { store, scope, setNow } = createStore();
  const plan = createPlanFixture();
  const lineage = unwrap(
    store.prepareLineage({
      scope,
      runId: "approval-run",
      plan,
      approval: approvalFor(plan),
      preparedAt: time("2026-09-19T10:00:01Z"),
    }),
  );
  const lease = unwrap(
    store.acquireLease({
      scope,
      ownerRunId: "approval-run",
      now: time("2026-09-19T10:00:02Z"),
      ttlMs: 60 * 60 * 1_000,
    }),
  );
  setNow("2026-09-19T10:06:00Z");
  const result = store.prepareOwnedIntent({
    authority: lease,
    lineageId: lineage.lineageId,
    intentId: plan.material.orderIntents[0]!.intentId,
    planHash: plan.materialHash,
    clientOrderId: "expired-approval-client",
    now: time("2026-09-19T10:00:03Z"),
    preparedAt: time("2026-09-19T10:00:03Z"),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "PLAN_EXPIRED");
  assert.equal(
    unwrap(store.readOwnedIntent(lineage.lineageId, "fixture-intent")),
    undefined,
  );
  store.close();
});

test("lease and HALT authority are isolated by account", () => {
  const first = createStore();
  const otherScope: PersistenceScope = {
    ...first.scope,
    accountId: "demo:other-account",
  };
  const other = unwrap(
    createSqliteExecutionStore(first.connection, otherScope),
  );
  const firstLease = unwrap(
    first.store.acquireLease({
      scope: first.scope,
      ownerRunId: "first-account-run",
      now: time("2026-09-19T10:00:00Z"),
      ttlMs: 60_000,
    }),
  );
  const otherLease = unwrap(
    other.acquireLease({
      scope: otherScope,
      ownerRunId: "other-account-run",
      now: time("2026-09-19T10:00:00Z"),
      ttlMs: 60_000,
    }),
  );
  assert.equal(firstLease.epoch, 1);
  assert.equal(otherLease.epoch, 1);
  assert.equal(
    unwrap(
      first.store.raiseHalt(
        firstLease,
        "first-account review",
        time("2026-09-19T10:00:04Z"),
      ),
    ).active,
    true,
  );
  assert.equal(unwrap(other.readHalt()).active, false);
  const artifactEnvelope = unwrap(
    encodeCanonicalArtifact("execution-plan", createPlanFixture()),
  );
  unwrap(
    first.store.writeArtifact({
      artifactId: "account-scoped-artifact",
      artifactKind: "execution-plan",
      envelope: artifactEnvelope,
    }),
  );
  assert.ok(unwrap(first.store.readArtifact("account-scoped-artifact")));
  assert.equal(
    unwrap(other.readArtifact("account-scoped-artifact")),
    undefined,
  );
  first.store.close();
});

test("independent duplicate lineages and conflicting client IDs raise account HALT", () => {
  const { store, scope } = createStore();
  const prepared = prepareIntent(store, scope);
  const duplicate = store.prepareLineage({
    scope,
    runId: "run-two",
    plan: prepared.plan,
    approval: approvalFor(prepared.plan),
    preparedAt: time("2026-09-19T10:00:04Z"),
  });
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.error.code, "DUPLICATE_LINEAGE");

  const conflict = store.prepareOwnedIntent({
    authority: prepared.lease,
    lineageId: prepared.lineage.lineageId,
    intentId: prepared.intentId,
    planHash: prepared.plan.materialHash,
    clientOrderId: "different-client",
    now: time("2026-09-19T10:00:05Z"),
    preparedAt: time("2026-09-19T10:00:05Z"),
  });
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.error.code, "PERSISTENCE_CONFLICT");
  assert.equal(unwrap(store.readHalt()).active, true);
  store.close();
});

test("attempts and reconciliations remain append-only and project the latest state", () => {
  const { store, scope } = createStore();
  const prepared = prepareIntent(store, scope);
  const attempt = unwrap(
    createExecutionAttempt({
      attemptId: "attempt-one",
      planHash: prepared.plan.materialHash,
      intentId: prepared.intentId,
      clientOrderId: prepared.clientOrderId,
      submittedAt: time("2026-09-19T10:00:04Z"),
      acknowledgement: "accepted",
      terminalStatus: "unverified",
    }),
  );
  unwrap(
    store.appendAttempt({
      authority: prepared.lease,
      lineageId: prepared.lineage.lineageId,
      attempt,
      dispatchedAt: time("2026-09-19T10:00:04Z"),
    }),
  );
  const unresolved = unwrap(
    reconcileAttempt(attempt, undefined, prepared.plan),
  );
  unwrap(
    store.appendReconciliation({
      authority: prepared.lease,
      lineageId: prepared.lineage.lineageId,
      result: unresolved,
      recordedAt: time("2026-09-19T10:00:05Z"),
    }),
  );
  const failed = unwrap(
    rehydrateReconciliationResult({
      attemptId: attempt.attemptId,
      intentId: prepared.intentId,
      planHash: prepared.plan.materialHash,
      clientOrderId: prepared.clientOrderId,
      status: "FAILED",
      observedAt: time("2026-09-19T10:00:06Z"),
    }),
  );
  unwrap(
    store.appendReconciliation({
      authority: prepared.lease,
      lineageId: prepared.lineage.lineageId,
      result: failed,
      recordedAt: time("2026-09-19T10:00:06Z"),
    }),
  );
  assert.equal(
    unwrap(store.readAttempts(prepared.lineage.lineageId)).length,
    1,
  );
  const reconciliations = unwrap(
    store.readReconciliations(prepared.lineage.lineageId),
  );
  assert.equal(reconciliations.length, 2);
  assert.equal(reconciliations.at(-1)?.result.status, "FAILED");
  assert.equal(unwrap(store.readHalt()).active, true);
  store.close();
});

test("lease contention, expiry takeover and epoch fencing are fail-closed", () => {
  const { store, scope, setNow } = createStore();
  setNow("2026-09-19T10:00:00Z");
  const firstLease = unwrap(
    store.acquireLease({
      scope,
      ownerRunId: "run-one",
      now: time("2026-09-19T10:00:00Z"),
      ttlMs: 1_000,
    }),
  );
  const held = store.acquireLease({
    scope,
    ownerRunId: "run-two",
    now: time("2026-09-19T10:00:00.500Z"),
    ttlMs: 1_000,
  });
  assert.equal(held.ok, false);
  if (!held.ok) {
    assert.equal(held.error.code, "RUN_LEASE_HELD");
    assert.deepEqual(Object.keys(held.error.details ?? {}), ["expiresAt"]);
  }
  setNow("2026-09-19T10:00:01Z");
  const takeover = unwrap(
    store.acquireLease({
      scope,
      ownerRunId: "run-two",
      now: time("2026-09-19T10:00:01Z"),
      ttlMs: 1_000,
    }),
  );
  assert.equal(takeover.epoch, firstLease.epoch + 1);
  assert.equal(takeover.reconciliationRequired, true);
  assert.equal(unwrap(store.readHalt()).active, true);
  const staleRenewal = store.renewLease({
    scope,
    ownerRunId: "run-one",
    now: time("2026-09-19T10:00:01.100Z"),
    ttlMs: 1_000,
    authority: firstLease,
  });
  assert.equal(staleRenewal.ok, false);
  if (!staleRenewal.ok) assert.equal(staleRenewal.error.code, "RUN_LEASE_LOST");
  const staleRelease = store.releaseLease(firstLease);
  assert.equal(staleRelease.ok, false);
  if (!staleRelease.ok) assert.equal(staleRelease.error.code, "RUN_LEASE_LOST");
  store.close();
});

test("current lease owner can reconcile a prior run after takeover", () => {
  const { store, scope, setNow } = createStore();
  const plan = createPlanFixture();
  const lineage = unwrap(
    store.prepareLineage({
      scope,
      runId: "crashed-run",
      plan,
      approval: approvalFor(plan),
      preparedAt: time("2026-09-19T10:00:01Z"),
    }),
  );
  const originalLease = unwrap(
    store.acquireLease({
      scope,
      ownerRunId: "crashed-run",
      now: time("2026-09-19T10:00:02Z"),
      ttlMs: 1_000,
    }),
  );
  const intent = unwrap(
    store.prepareOwnedIntent({
      authority: originalLease,
      lineageId: lineage.lineageId,
      intentId: plan.material.orderIntents[0]!.intentId,
      planHash: plan.materialHash,
      clientOrderId: "crashed-client",
      now: time("2026-09-19T10:00:02Z"),
      preparedAt: time("2026-09-19T10:00:02Z"),
    }),
  );
  const attempt = unwrap(
    createExecutionAttempt({
      attemptId: "crashed-attempt",
      planHash: plan.materialHash,
      intentId: intent.intentId,
      clientOrderId: intent.clientOrderId,
      submittedAt: time("2026-09-19T10:00:02Z"),
      acknowledgement: "accepted",
      terminalStatus: "unverified",
    }),
  );
  unwrap(
    store.appendAttempt({
      authority: originalLease,
      lineageId: lineage.lineageId,
      attempt,
      dispatchedAt: time("2026-09-19T10:00:02Z"),
    }),
  );

  setNow("2026-09-19T10:00:04Z");
  const takeover = unwrap(
    store.acquireLease({
      scope,
      ownerRunId: "recovery-run",
      now: time("2026-09-19T10:00:04Z"),
      ttlMs: 60_000,
    }),
  );
  const failed = unwrap(
    rehydrateReconciliationResult({
      attemptId: attempt.attemptId,
      intentId: intent.intentId,
      planHash: plan.materialHash,
      clientOrderId: intent.clientOrderId,
      status: "FAILED",
      observedAt: time("2026-09-19T10:00:05Z"),
    }),
  );
  const stale = store.appendReconciliation({
    authority: originalLease,
    lineageId: lineage.lineageId,
    result: failed,
    recordedAt: time("2026-09-19T10:00:05Z"),
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, "RUN_LEASE_LOST");
  assert.equal(
    unwrap(
      store.appendReconciliation({
        authority: takeover,
        lineageId: lineage.lineageId,
        result: failed,
        recordedAt: time("2026-09-19T10:00:05Z"),
      }),
    ).result.status,
    "FAILED",
  );
  store.close();
});

test("HALT clearance requires terminal reconciliation and revision-matched evidence", () => {
  const { store, scope } = createStore();
  const prepared = prepareIntent(store, scope);
  const attempt = unwrap(
    createExecutionAttempt({
      attemptId: "attempt-one",
      planHash: prepared.plan.materialHash,
      intentId: prepared.intentId,
      clientOrderId: prepared.clientOrderId,
      submittedAt: time("2026-09-19T10:00:04Z"),
      acknowledgement: "accepted",
      terminalStatus: "unverified",
    }),
  );
  unwrap(
    store.appendAttempt({
      authority: prepared.lease,
      lineageId: prepared.lineage.lineageId,
      attempt,
      dispatchedAt: time("2026-09-19T10:00:04Z"),
    }),
  );
  const unresolved = unwrap(
    reconcileAttempt(attempt, undefined, prepared.plan),
  );
  unwrap(
    store.appendReconciliation({
      authority: prepared.lease,
      lineageId: prepared.lineage.lineageId,
      result: unresolved,
      recordedAt: time("2026-09-19T10:00:05Z"),
    }),
  );
  const halted = unwrap(store.readHalt());
  const notReady = store.clearHalt({
    authority: prepared.lease,
    expectedHaltRevision: halted.revision,
    evidence: {
      evidenceVersion: "clearance/v1",
      actor: "operator",
      source: "manual-reconciliation",
      timestamp: time("2026-09-19T10:00:06Z"),
      reason: "not ready",
      affectedLineageRevision: 1,
      affectedReconciliationRevision: 1,
    },
  });
  assert.equal(notReady.ok, false);
  if (!notReady.ok) assert.equal(notReady.error.code, "UNRESOLVED_STATE");

  const failed = unwrap(
    rehydrateReconciliationResult({
      attemptId: attempt.attemptId,
      intentId: prepared.intentId,
      planHash: prepared.plan.materialHash,
      clientOrderId: prepared.clientOrderId,
      status: "FAILED",
      observedAt: time("2026-09-19T10:00:07Z"),
    }),
  );
  unwrap(
    store.appendReconciliation({
      authority: prepared.lease,
      lineageId: prepared.lineage.lineageId,
      result: failed,
      recordedAt: time("2026-09-19T10:00:07Z"),
    }),
  );
  const latestHalt = unwrap(store.readHalt());
  const cleared = unwrap(
    store.clearHalt({
      authority: prepared.lease,
      expectedHaltRevision: latestHalt.revision,
      evidence: {
        evidenceVersion: "clearance/v1",
        actor: "operator",
        source: "manual-reconciliation",
        timestamp: time("2026-09-19T10:00:08Z"),
        reason: "all owned intents reconciled",
        affectedLineageRevision: 1,
        affectedReconciliationRevision: 2,
      },
    }),
  );
  assert.equal(cleared.active, false);
  assert.equal(cleared.reconciliationRequired, false);
  store.close();
});
