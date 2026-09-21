import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { openSqlitePersistence } from "../src/adapters/sqlite/sqlite-persistence.js";
import { encodeCanonicalArtifact } from "../src/domain/identity/canonical-artifact.js";
import { createApproval } from "../src/domain/execution/approval.js";
import { createExecutionAttempt } from "../src/domain/execution/execution-attempt.js";
import { rehydrateReconciliationResult } from "../src/domain/execution/reconciliation.js";
import { createFill } from "../src/domain/accounting/fill.js";
import {
  parseUtcTimestamp,
  type UtcTimestamp,
} from "../src/domain/shared/time.js";
import type { Result } from "../src/domain/shared/result.js";
import {
  persistenceRecoveryMetadata,
  type PersistenceScope,
} from "../src/ports/persistence.js";
import {
  domainError,
  type DomainErrorCode,
} from "../src/domain/shared/errors.js";
import { createPlanFixture } from "./domain-plan-fixture.js";

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

function createScope(): PersistenceScope {
  return {
    exchange: "bybit",
    environment: "demo",
    accountId: "demo:fixture",
    category: "linear",
    positionMode: "one-way",
  };
}

function approvalFor(plan: ReturnType<typeof createPlanFixture>) {
  return unwrap(
    createApproval({
      approvalId: "recovery-approval",
      planHash: plan.materialHash,
      actor: "operator",
      approvedAt: time("2026-09-19T10:00:00Z"),
      expiresAt: time("2026-09-19T10:05:00Z"),
    }),
  );
}

function fillArtifact() {
  const fill = unwrap(
    createFill({
      fillId: "recovery-fill",
      attemptId: "recovery-attempt",
      exchangeOrderId: "recovery-order",
      instrument: "DOGEUSDT",
      side: "buy",
      quantity: "57.000000000000000000000001",
      price: "0.088700000000000000000001",
      executedAt: "2026-09-19T10:00:04Z",
      source: "fixture",
    }),
  );
  const envelope = unwrap(encodeCanonicalArtifact("fill", fill));
  return {
    artifactId: fill.fillId,
    artifactKind: "fill" as const,
    envelope,
  };
}

function open(
  databasePath: string,
  environment: PersistenceScope["environment"] = "demo",
  accountId = "demo:fixture",
) {
  const scope = { ...createScope(), environment, accountId };
  return unwrap(
    openSqlitePersistence({
      environment,
      databasePath,
      runtime: supportedRuntime,
      clock: { now: () => time("2026-09-19T10:00:03Z") },
      scope,
    }),
  );
}

test("public facade reopens the complete local lifecycle and read model", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlite-recovery-"));
  const databasePath = join(root, "demo.db");
  const plan = createPlanFixture();
  const first = open(databasePath);
  const lineage = unwrap(
    first.prepareLineage({
      scope: first.scope,
      runId: "recovery-run",
      plan,
      approval: approvalFor(plan),
      preparedAt: time("2026-09-19T10:00:01Z"),
    }),
  );
  const authority = unwrap(
    first.acquireLease({
      scope: first.scope,
      ownerRunId: "recovery-run",
      now: time("2026-09-19T10:00:02Z"),
      ttlMs: 60_000,
    }),
  );
  const intent = unwrap(
    first.prepareOwnedIntent({
      authority,
      lineageId: lineage.lineageId,
      intentId: plan.material.orderIntents[0]!.intentId,
      planHash: plan.materialHash,
      clientOrderId: "recovery-client",
      now: time("2026-09-19T10:00:03Z"),
      preparedAt: time("2026-09-19T10:00:03Z"),
    }),
  );
  const attempt = unwrap(
    createExecutionAttempt({
      attemptId: "recovery-attempt",
      planHash: plan.materialHash,
      intentId: intent.intentId,
      clientOrderId: intent.clientOrderId,
      submittedAt: time("2026-09-19T10:00:04Z"),
      acknowledgement: "accepted",
      terminalStatus: "unverified",
    }),
  );
  unwrap(
    first.appendAttempt({
      authority,
      lineageId: lineage.lineageId,
      attempt,
      dispatchedAt: time("2026-09-19T10:00:04Z"),
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
  unwrap(
    first.appendReconciliation({
      authority,
      lineageId: lineage.lineageId,
      result: failed,
      recordedAt: time("2026-09-19T10:00:05Z"),
    }),
  );
  const artifact = fillArtifact();
  unwrap(first.writeArtifact(artifact));
  const fact = {
    factKind: "fill" as const,
    eventIdentity: "recovery-event-1",
    scope: first.scope,
    observedAt: time("2026-09-19T10:00:06Z"),
    canonicalHash: artifact.envelope.canonicalHash,
    artifact,
  };
  unwrap(first.ingestFact(fact));
  const diagnostics = first.diagnostics();
  assert.equal(diagnostics.environment, "demo");
  assert.equal(diagnostics.schemaVersion, 4);
  assert.equal("db" in diagnostics, false);
  first.close();

  const reopened = open(databasePath);
  const run = unwrap(reopened.readRun(lineage.lineageId));
  assert.ok(run);
  assert.equal(run.lineage.lineageId, lineage.lineageId);
  assert.equal(run.plan.materialHash, plan.materialHash);
  assert.equal(run.approval.planHash, plan.materialHash);
  assert.equal(run.ownedIntents[0]?.clientOrderId, "recovery-client");
  assert.equal(run.attempts[0]?.attempt.attemptId, "recovery-attempt");
  assert.equal(run.reconciliations[0]?.result.status, "FAILED");
  const scopeSnapshot = unwrap(reopened.readScopeSnapshot());
  assert.equal(
    scopeSnapshot.accountingFacts[0]?.eventIdentity,
    "recovery-event-1",
  );
  assert.equal(
    unwrap(reopened.readArtifact("recovery-fill"))?.artifactKind,
    "fill",
  );
  reopened.close();
});

test("facade rejects cross-environment database reuse before exposing state", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlite-environment-"));
  const databasePath = join(root, "demo.db");
  const demo = open(databasePath, "demo");
  demo.close();
  const result = openSqlitePersistence({
    environment: "testnet",
    databasePath,
    runtime: supportedRuntime,
    clock: { now: () => time("2026-09-19T10:00:03Z") },
    scope: { ...createScope(), environment: "testnet" },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "PERSISTENCE_ENVIRONMENT");
});

test("typed persistence failures expose bounded recovery metadata", () => {
  const cases: readonly (readonly [
    DomainErrorCode,
    ReturnType<typeof persistenceRecoveryMetadata>,
  ])[] = [
    [
      "PERSISTENCE_SCHEMA",
      {
        category: "schema",
        canRead: false,
        canWrite: false,
        canAppendReconciliation: false,
        retryable: false,
        nextAction: "inspect-schema",
        requiredEvidence: ["schema-version", "migration-result"],
        redactedDiagnosticFields: ["code"],
      },
    ],
    [
      "PERSISTENCE_RUNTIME",
      {
        category: "runtime",
        canRead: false,
        canWrite: false,
        canAppendReconciliation: false,
        retryable: false,
        nextAction: "run-supported-runtime",
        requiredEvidence: ["node-version", "sqlite-version"],
        redactedDiagnosticFields: ["code"],
      },
    ],
    [
      "PERSISTENCE_ENVIRONMENT",
      {
        category: "environment",
        canRead: false,
        canWrite: false,
        canAppendReconciliation: false,
        retryable: false,
        nextAction: "open-selected-environment",
        requiredEvidence: ["environment", "database-identity"],
        redactedDiagnosticFields: ["code"],
      },
    ],
    [
      "PERSISTENCE_BUSY",
      {
        category: "contention",
        canRead: true,
        canWrite: false,
        canAppendReconciliation: false,
        retryable: true,
        nextAction: "retry-after-contention",
        requiredEvidence: ["scope"],
        redactedDiagnosticFields: ["code", "scope"],
      },
    ],
    [
      "CHECKPOINT_STALE",
      {
        category: "contention",
        canRead: true,
        canWrite: false,
        canAppendReconciliation: false,
        retryable: true,
        nextAction: "retry-after-contention",
        requiredEvidence: ["scope"],
        redactedDiagnosticFields: ["code", "scope"],
      },
    ],
    [
      "RUN_LEASE_HELD",
      {
        category: "lease-held",
        canRead: true,
        canWrite: false,
        canAppendReconciliation: false,
        retryable: true,
        nextAction: "wait-for-lease",
        requiredEvidence: ["scope", "expires-at"],
        redactedDiagnosticFields: ["code", "scope", "expiresAt"],
      },
    ],
    [
      "RUN_LEASE_LOST",
      {
        category: "lease-lost",
        canRead: true,
        canWrite: false,
        canAppendReconciliation: true,
        retryable: true,
        nextAction: "reconcile-before-reacquire",
        requiredEvidence: ["scope", "owner-run-id", "epoch"],
        redactedDiagnosticFields: ["code", "scope"],
      },
    ],
    [
      "DUPLICATE_LINEAGE",
      {
        category: "duplicate-conflict",
        canRead: true,
        canWrite: false,
        canAppendReconciliation: true,
        retryable: false,
        nextAction: "preserve-and-reconcile",
        requiredEvidence: ["scope", "identity", "canonical-hash"],
        redactedDiagnosticFields: ["code", "scope"],
      },
    ],
    [
      "PERSISTENCE_CONFLICT",
      {
        category: "duplicate-conflict",
        canRead: true,
        canWrite: false,
        canAppendReconciliation: true,
        retryable: false,
        nextAction: "preserve-and-reconcile",
        requiredEvidence: ["scope", "identity", "canonical-hash"],
        redactedDiagnosticFields: ["code", "scope"],
      },
    ],
    [
      "HALT_ACTIVE",
      {
        category: "halt",
        canRead: true,
        canWrite: false,
        canAppendReconciliation: true,
        retryable: false,
        nextAction: "reconcile-and-clear-halt",
        requiredEvidence: [
          "halt-revision",
          "lineage-revision",
          "reconciliation-revision",
        ],
        redactedDiagnosticFields: ["code", "scope"],
      },
    ],
    [
      "UNRESOLVED_STATE",
      {
        category: "unresolved",
        canRead: true,
        canWrite: false,
        canAppendReconciliation: true,
        retryable: false,
        nextAction: "reconcile-before-exposure",
        requiredEvidence: ["owned-intent", "attempt", "reconciliation-result"],
        redactedDiagnosticFields: ["code", "scope"],
      },
    ],
    [
      "UNRESOLVED_RECONCILIATION",
      {
        category: "unresolved",
        canRead: true,
        canWrite: false,
        canAppendReconciliation: true,
        retryable: false,
        nextAction: "reconcile-before-exposure",
        requiredEvidence: ["owned-intent", "attempt", "reconciliation-result"],
        redactedDiagnosticFields: ["code", "scope"],
      },
    ],
    [
      "PERSISTENCE_INTEGRITY",
      {
        category: "integrity",
        canRead: true,
        canWrite: false,
        canAppendReconciliation: false,
        retryable: false,
        nextAction: "inspect-and-correct-input",
        requiredEvidence: ["typed-error-code"],
        redactedDiagnosticFields: ["code"],
      },
    ],
    [
      "INVALID_ARGUMENT",
      {
        category: "input",
        canRead: false,
        canWrite: false,
        canAppendReconciliation: false,
        retryable: false,
        nextAction: "inspect-and-correct-input",
        requiredEvidence: ["typed-error-code"],
        redactedDiagnosticFields: ["code"],
      },
    ],
  ];

  for (const [code, expected] of cases) {
    assert.deepEqual(
      persistenceRecoveryMetadata(domainError(code, "ignored detail")),
      expected,
      code,
    );
  }
});

test("process crash keeps committed artifact and rolls back an uncommitted row", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlite-crash-"));
  const databasePath = join(root, "demo.db");
  const persistenceModule = pathToFileURL(
    resolve(process.cwd(), "src/adapters/sqlite/sqlite-persistence.ts"),
  ).href;
  const artifactModule = pathToFileURL(
    resolve(process.cwd(), "src/domain/identity/canonical-artifact.ts"),
  ).href;
  const fillModule = pathToFileURL(
    resolve(process.cwd(), "src/domain/accounting/fill.ts"),
  ).href;
  const script = `
    import { DatabaseSync } from "node:sqlite";
    import { openSqlitePersistence } from ${JSON.stringify(persistenceModule)};
    import { encodeCanonicalArtifact } from ${JSON.stringify(artifactModule)};
    import { createFill } from ${JSON.stringify(fillModule)};
    const databasePath = ${JSON.stringify(databasePath)};
    const scope = { exchange: "bybit", environment: "demo", accountId: "demo:crash", category: "linear", positionMode: "one-way" };
    const opened = openSqlitePersistence({ environment: "demo", databasePath, runtime: { nodeVersion: "22.22.3", sqliteVersion: "3.51.3" }, scope });
    if (!opened.ok) process.exit(11);
    const fill = createFill({ fillId: "crash-fill", attemptId: "crash-attempt", exchangeOrderId: "crash-order", instrument: "DOGEUSDT", side: "buy", quantity: "57", price: "0.0887", executedAt: "2026-09-19T10:00:01Z", source: "crash-fixture" });
    if (!fill.ok) process.exit(12);
    const envelope = encodeCanonicalArtifact("fill", fill.value);
    if (!envelope.ok || !opened.value.writeArtifact({ artifactId: "crash-fill", artifactKind: "fill", envelope: envelope.value }).ok) process.exit(13);
    const raw = new DatabaseSync(databasePath);
    raw.exec("BEGIN IMMEDIATE");
    raw.prepare("INSERT INTO audit_events (event_id, exchange, environment, account_id, category, position_mode, event_kind, event_identity, recorded_at, canonical_json, canonical_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("uncommitted-event", "bybit", "demo", "demo:crash", "linear", "one-way", "fixture", "uncommitted", "2026-09-19T10:00:02Z", "{}", "sha256:${"0".repeat(64)}");
    process.kill(process.pid, "SIGKILL");
  `;
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(child.signal, "SIGKILL");

  const reopened = open(databasePath, "demo", "demo:crash");
  assert.equal(
    unwrap(reopened.readArtifact("crash-fill"))?.artifactKind,
    "fill",
  );
  reopened.close();
  const database = new DatabaseSync(databasePath);
  const row = database
    .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_id = ?")
    .get("uncommitted-event") as { readonly count: number };
  assert.equal(row.count, 0);
  database.close();
});
