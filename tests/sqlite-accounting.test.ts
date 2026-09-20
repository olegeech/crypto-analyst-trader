import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createSqliteAccountingStore,
  type SqliteAccountingStore,
} from "../src/adapters/sqlite/accounting-store.js";
import { openSqliteConnection } from "../src/adapters/sqlite/connection.js";
import {
  encodeCanonicalArtifact,
  rehydrateArtifact,
} from "../src/domain/identity/canonical-artifact.js";
import { createFill } from "../src/domain/accounting/fill.js";
import {
  parseUtcTimestamp,
  type UtcTimestamp,
} from "../src/domain/shared/time.js";
import type { Result } from "../src/domain/shared/result.js";
import type {
  IngestionFact,
  PersistenceScope,
} from "../src/ports/persistence.js";
import {
  createSqliteExecutionStore,
  type SqliteExecutionStore,
} from "../src/adapters/sqlite/execution-store.js";

const supportedRuntime = {
  nodeVersion: "22.22.3",
  sqliteVersion: "3.51.3",
} as const;

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

function time(value: string): UtcTimestamp {
  return unwrap(parseUtcTimestamp(value));
}

function createStores(): {
  readonly execution: SqliteExecutionStore;
  readonly accounting: SqliteAccountingStore;
  readonly database: DatabaseSync;
  readonly scope: PersistenceScope;
  readonly setNow: (value: string) => void;
} {
  const root = mkdtempSync(join(tmpdir(), "sqlite-accounting-"));
  const clockState = { value: time("2026-09-19T10:00:03Z") };
  const connection = unwrap(
    openSqliteConnection({
      environment: "demo",
      databasePath: join(root, "accounting.db"),
      runtime: supportedRuntime,
      clock: { now: () => clockState.value },
    }),
  );
  const scope: PersistenceScope = {
    exchange: "bybit",
    environment: "demo",
    accountId: "demo:accounting",
    category: "linear",
    positionMode: "one-way",
  };
  const execution = unwrap(createSqliteExecutionStore(connection, scope));
  const accounting = unwrap(
    createSqliteAccountingStore(connection, scope, execution.scope),
  );
  return {
    execution,
    accounting,
    database: connection.db,
    scope,
    setNow(value: string): void {
      clockState.value = time(value);
    },
  };
}

function fillFact(
  scope: PersistenceScope,
  eventIdentity: string,
  quantity = "57.000000000000000000000000000001",
): IngestionFact {
  const fill = unwrap(
    createFill({
      fillId: `fill-${eventIdentity}`,
      attemptId: "attempt-accounting",
      exchangeOrderId: "exchange-accounting",
      instrument: "DOGEUSDT",
      side: "buy",
      quantity,
      price: "0.000000000000000000000000000887",
      executedAt: "2026-09-19T10:00:01Z",
      source: "trade-history",
    }),
  );
  const envelope = unwrap(encodeCanonicalArtifact("fill", fill));
  return {
    factKind: "fill",
    eventIdentity,
    scope,
    observedAt: time("2026-09-19T10:00:02Z"),
    canonicalHash: envelope.canonicalHash,
    artifact: {
      artifactId: fill.fillId,
      artifactKind: "fill",
      envelope,
    },
  };
}

function checkpoint(
  scope: PersistenceScope,
  cursor: string,
  expectedRevision: number,
  authority: { readonly ownerRunId: string; readonly epoch: number },
) {
  return {
    authority,
    expectedRevision,
    checkpoint: {
      stream: "trade-history",
      scope,
      cursor,
      observedThrough: time("2026-09-19T10:00:03Z"),
      overlapFrom: time("2026-09-19T09:59:03Z"),
      updatedAt: time("2026-09-19T10:00:03Z"),
    },
  };
}

test("accounting facts are idempotent, rehydratable and exact-decimal TEXT", () => {
  const { execution, accounting, database, scope } = createStores();
  const fact = fillFact(scope, "trade-1");
  assert.equal(unwrap(accounting.ingestFact(fact)), "inserted");
  assert.equal(unwrap(accounting.ingestFact(fact)), "duplicate");

  const stored = unwrap(accounting.readFact("fill", "trade-1"));
  assert.ok(stored);
  assert.equal(stored.artifact.artifactId, fact.artifact.artifactId);
  const rehydrated = unwrap(
    rehydrateArtifact("fill", stored.artifact.envelope),
  );
  if (!("quantity" in rehydrated) || !("price" in rehydrated)) {
    assert.fail("fill did not rehydrate as a fill");
  }
  assert.equal(
    rehydrated.quantity.toString(),
    "57.000000000000000000000000000001",
  );
  assert.equal(rehydrated.price.toString(), "0.000000000000000000000000000887");

  const columns = database
    .prepare("PRAGMA table_info(accounting_facts)")
    .all() as Array<{
    readonly name: string;
    readonly type: string;
  }>;
  const types = new Map(columns.map((column) => [column.name, column.type]));
  for (const name of [
    "quantity",
    "price",
    "amount",
    "fee",
    "funding_amount",
    "balance_before",
    "balance_after",
  ]) {
    assert.equal(types.get(name), "TEXT", name);
  }
  execution.close();
});

test("same event identity with different bytes preserves the fact and raises HALT", () => {
  const { execution, accounting, database, scope } = createStores();
  const original = fillFact(scope, "trade-conflict", "57");
  const conflicting = fillFact(scope, "trade-conflict", "58");
  assert.equal(unwrap(accounting.ingestFact(original)), "inserted");
  const result = accounting.ingestFact(conflicting);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "PERSISTENCE_CONFLICT");
  assert.equal(
    unwrap(accounting.readFact("fill", "trade-conflict"))?.canonicalHash,
    original.canonicalHash,
  );
  assert.equal(unwrap(execution.readHalt()).active, true);
  const conflictCount = database
    .prepare("SELECT COUNT(*) AS count FROM accounting_conflicts")
    .get() as { readonly count: number };
  assert.equal(conflictCount.count, 1);
  execution.close();
});

test("linked accounting correction resolves the conflict before HALT clearance", () => {
  const { execution, accounting, database, scope } = createStores();
  const authority = unwrap(
    execution.acquireLease({
      scope,
      ownerRunId: "accounting-recovery-run",
      now: time("2026-09-19T10:00:00Z"),
      ttlMs: 60_000,
    }),
  );
  const original = fillFact(scope, "trade-resolution:1", "57");
  const conflicting = fillFact(scope, "trade-resolution:1", "58");
  assert.equal(unwrap(accounting.ingestFact(original)), "inserted");
  const originalRow = unwrap(accounting.readFact("fill", "trade-resolution:1"));
  assert.ok(originalRow?.factId);
  const conflict = accounting.ingestFact(conflicting);
  assert.equal(conflict.ok, false);

  const correction = {
    ...conflicting,
    eventIdentity: "trade-resolution:2",
    artifact: {
      ...conflicting.artifact,
      artifactId: "fill-trade-resolution-correction",
    },
    observationRevision: "2",
    linkedFactId: originalRow.factId,
    adjustmentReason: "exchange supplied a corrected immutable observation",
  };
  assert.equal(unwrap(accounting.ingestFact(correction)), "inserted");
  const halted = unwrap(execution.readHalt());
  assert.equal(halted.active, true);

  const cleared = execution.clearHalt({
    authority,
    expectedHaltRevision: halted.revision,
    evidence: {
      evidenceVersion: "clearance/v1",
      actor: "operator",
      source: "accounting-reconciliation",
      timestamp: time("2026-09-19T10:00:08Z"),
      reason: "corrected immutable accounting observation",
      affectedLineageRevision: 0,
      affectedReconciliationRevision: 0,
    },
  });
  if (!cleared.ok) {
    assert.fail(`${cleared.error.code}: ${cleared.error.message}`);
  }
  assert.equal(unwrap(execution.readHalt()).active, false);
  assert.equal(
    (
      database
        .prepare("SELECT COUNT(*) AS count FROM accounting_conflicts")
        .get() as { readonly count: number }
    ).count,
    1,
  );
  execution.close();
});

test("immutable observations and corrections use a new linked fact", () => {
  const { execution, accounting, database, scope } = createStores();
  const original = fillFact(scope, "trade-revision:1", "57");
  assert.equal(unwrap(accounting.ingestFact(original)), "inserted");
  const originalRow = database
    .prepare("SELECT fact_id FROM accounting_facts WHERE event_identity = ?")
    .get("trade-revision:1") as { readonly fact_id: string };

  const revised = {
    ...fillFact(scope, "trade-revision:2", "58"),
    observationRevision: "2",
    linkedFactId: originalRow.fact_id,
    adjustmentReason: "exchange supplied a later cumulative observation",
  };
  assert.equal(unwrap(accounting.ingestFact(revised)), "inserted");
  assert.equal(
    unwrap(accounting.readFact("fill", "trade-revision:1"))?.artifact.envelope
      .canonicalHash,
    original.canonicalHash,
  );
  const storedRevision = unwrap(
    accounting.readFact("fill", "trade-revision:2"),
  );
  assert.equal(storedRevision?.observationRevision, "2");
  assert.equal(storedRevision?.linkedFactId, originalRow.fact_id);
  assert.equal(
    storedRevision?.adjustmentReason,
    "exchange supplied a later cumulative observation",
  );
  execution.close();
});

test("checkpoint CAS and fact ingestion commit together", () => {
  const { execution, accounting, scope } = createStores();
  const authority = unwrap(
    execution.acquireLease({
      scope,
      ownerRunId: "accounting-run",
      now: time("2026-09-19T10:00:00Z"),
      ttlMs: 60_000,
    }),
  );
  const first = unwrap(
    accounting.updateCheckpoint(checkpoint(scope, "cursor-1", 0, authority)),
  );
  assert.equal(first.revision, 1);

  const secondFact = fillFact(scope, "trade-2", "58");
  assert.equal(
    unwrap(
      accounting.ingestFactAndAdvanceCheckpoint(
        secondFact,
        checkpoint(scope, "cursor-2", 1, authority),
      ),
    ),
    "inserted",
  );
  assert.equal(unwrap(accounting.readCheckpoint("trade-history"))?.revision, 2);
  assert.ok(unwrap(accounting.readFact("fill", "trade-2")));

  const stale = accounting.updateCheckpoint(
    checkpoint(scope, "cursor-stale", 1, authority),
  );
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, "CHECKPOINT_STALE");
  assert.equal(
    unwrap(accounting.readCheckpoint("trade-history"))?.cursor,
    "cursor-2",
  );

  const rolledBackFact = fillFact(scope, "trade-rollback", "59");
  const rolledBack = accounting.ingestFactAndAdvanceCheckpoint(
    rolledBackFact,
    checkpoint(scope, "cursor-rollback", 1, authority),
  );
  assert.equal(rolledBack.ok, false);
  assert.equal(
    unwrap(accounting.readFact("fill", "trade-rollback")),
    undefined,
  );
  execution.close();
});

test("checkpoint partial updates preserve durable watermarks", () => {
  const { execution, accounting, scope } = createStores();
  const authority = unwrap(
    execution.acquireLease({
      scope,
      ownerRunId: "partial-checkpoint-run",
      now: time("2026-09-19T10:00:00Z"),
      ttlMs: 60_000,
    }),
  );
  unwrap(
    accounting.updateCheckpoint(checkpoint(scope, "cursor-1", 0, authority)),
  );

  const updated = unwrap(
    accounting.updateCheckpoint({
      authority,
      expectedRevision: 1,
      checkpoint: {
        stream: "trade-history",
        scope,
        cursor: "cursor-2",
        updatedAt: time("2026-09-19T10:00:04Z"),
      },
    }),
  );
  assert.equal(updated.cursor, "cursor-2");
  assert.equal(updated.observedThrough, "2026-09-19T10:00:03.000Z");
  assert.equal(updated.overlapFrom, "2026-09-19T09:59:03.000Z");
  assert.equal(unwrap(accounting.readCheckpoint("trade-history"))?.revision, 2);
  execution.close();
});

test("accounting reads fail closed for relational or artifact corruption", () => {
  const { execution, accounting, database, scope } = createStores();
  const fact = fillFact(scope, "read-corruption");
  assert.equal(unwrap(accounting.ingestFact(fact)), "inserted");
  const stored = unwrap(accounting.readFact("fill", "read-corruption"));
  assert.ok(stored?.factId);

  database
    .prepare("UPDATE accounting_facts SET fact_kind = 'fee' WHERE fact_id = ?")
    .run(stored.factId);
  const kindMismatch = accounting.readFact("fee", "read-corruption");
  assert.equal(kindMismatch.ok, false);
  if (!kindMismatch.ok)
    assert.equal(kindMismatch.error.code, "PERSISTENCE_INTEGRITY");

  database
    .prepare("UPDATE accounting_facts SET fact_kind = 'fill' WHERE fact_id = ?")
    .run(stored.factId);
  database
    .prepare("DELETE FROM artifacts WHERE artifact_id = ?")
    .run(fact.artifact.artifactId);
  const missingArtifact = accounting.readFact("fill", "read-corruption");
  assert.equal(missingArtifact.ok, false);
  if (!missingArtifact.ok)
    assert.equal(missingArtifact.error.code, "PERSISTENCE_INTEGRITY");
  execution.close();
});

test("stale lease authority cannot advance a checkpoint", () => {
  const { execution, accounting, scope, setNow } = createStores();
  setNow("2026-09-19T10:00:00Z");
  const first = unwrap(
    execution.acquireLease({
      scope,
      ownerRunId: "old-run",
      now: time("2026-09-19T10:00:00Z"),
      ttlMs: 1_000,
    }),
  );
  setNow("2026-09-19T10:00:01Z");
  unwrap(
    execution.acquireLease({
      scope,
      ownerRunId: "new-run",
      now: time("2026-09-19T10:00:01Z"),
      ttlMs: 60_000,
    }),
  );
  setNow("2026-09-19T10:00:01Z");
  const result = accounting.updateCheckpoint(
    checkpoint(scope, "stale-cursor", 0, first),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "RUN_LEASE_LOST");
  assert.equal(unwrap(accounting.readCheckpoint("trade-history")), undefined);
  execution.close();
});
