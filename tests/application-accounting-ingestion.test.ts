import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openSqlitePersistence } from "../src/adapters/sqlite/sqlite-persistence.js";
import { rehydrateArtifact } from "../src/domain/identity/canonical-artifact.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";
import {
  parseUtcTimestamp,
  type UtcTimestamp,
} from "../src/domain/shared/time.js";
import type { Result } from "../src/domain/shared/result.js";
import type { ExchangeFillObservation } from "../src/ports/exchange-execution.js";
import type {
  PersistencePort,
  PersistenceScope,
} from "../src/ports/persistence.js";
import {
  ingestExchangeFillObservation,
  type AccountingEventIdentityInputs,
} from "../src/application/accounting-ingestion.js";

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

function decimal(value: string): DecimalValue {
  return unwrap(DecimalValue.fromString(value));
}

function createPersistence(): {
  readonly persistence: PersistencePort;
  readonly scope: PersistenceScope;
} {
  const root = mkdtempSync(join(tmpdir(), "application-accounting-ingestion-"));
  const scope: PersistenceScope = {
    exchange: "bybit",
    environment: "demo",
    accountId: "demo:accounting-ingestion",
    category: "linear",
    positionMode: "one-way",
  };
  const opened = openSqlitePersistence({
    environment: "demo",
    databasePath: join(root, "execution.db"),
    runtime: supportedRuntime,
    scope,
  });
  return { persistence: unwrap(opened), scope };
}

function observation(
  overrides: Partial<ExchangeFillObservation> = {},
): ExchangeFillObservation {
  return {
    executionId: "execution-1",
    exchangeOrderId: "order-1",
    clientOrderId: "demo-client-1",
    instrument: "DOGEUSDT",
    side: "buy",
    quantity: decimal("57"),
    price: decimal("0.0887"),
    executedAt: time("2026-09-22T10:00:01Z"),
    source: "bybit-demo/execution",
    fee: decimal("0.001"),
    feeCurrency: "USDT",
    ...overrides,
  };
}

function observationWithoutFee(): ExchangeFillObservation {
  const withoutFee = { ...observation() };
  delete withoutFee.fee;
  delete withoutFee.feeCurrency;
  return withoutFee;
}

function identities(
  overrides: Partial<AccountingEventIdentityInputs> = {},
): AccountingEventIdentityInputs {
  return {
    eventKey: "execution-1",
    revision: "1",
    ledgerCurrency: "USDT",
    ...overrides,
  };
}

test("maps one execution to canonical fill, fee and signed ledger facts", () => {
  const { persistence, scope } = createPersistence();
  const result = ingestExchangeFillObservation(
    persistence,
    scope,
    observation(),
    "attempt-1",
    identities(),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.fill.status, "inserted");
  assert.equal(result.value.fee?.status, "inserted");
  assert.equal(result.value.ledgerEntries.length, 2);
  for (const entry of [
    result.value.fill,
    ...(result.value.fee === undefined ? [] : [result.value.fee]),
    ...result.value.ledgerEntries,
  ]) {
    assert.ok(entry.fact.eventIdentity.length <= 128);
    assert.ok(entry.fact.artifact.artifactId.length <= 128);
    assert.equal(
      entry.fact.canonicalHash,
      entry.fact.artifact.envelope.canonicalHash,
    );
  }

  const fill = unwrap(
    persistence.readFact("fill", result.value.fill.fact.eventIdentity),
  );
  assert.ok(fill);
  const fillArtifact = unwrap(
    rehydrateArtifact("fill", fill.artifact.envelope),
  );
  if ("attemptId" in fillArtifact && "quantity" in fillArtifact) {
    assert.equal(fillArtifact.attemptId, "attempt-1");
    assert.equal(fillArtifact.quantity.toString(), "57");
    assert.equal("executionId" in fillArtifact, false);
    assert.equal("clientOrderId" in fillArtifact, false);
  }

  const ledgerFacts = result.value.ledgerEntries.map((entry) =>
    unwrap(rehydrateArtifact("ledger-entry", entry.fact.artifact.envelope)),
  );
  const fillLedger = ledgerFacts.find(
    (entry) => "kind" in entry && entry.kind === "fill",
  );
  const feeLedger = ledgerFacts.find(
    (entry) => "kind" in entry && entry.kind === "fee",
  );
  assert.equal(
    fillLedger && "amount" in fillLedger
      ? fillLedger.amount.toString()
      : undefined,
    "-5.0559",
  );
  assert.equal(
    feeLedger && "amount" in feeLedger
      ? feeLedger.amount.toString()
      : undefined,
    "-0.001",
  );
  persistence.close();
});

test("replaying identical normalized evidence is a duplicate no-op", () => {
  const { persistence, scope } = createPersistence();
  const first = unwrap(
    ingestExchangeFillObservation(
      persistence,
      scope,
      observation(),
      "attempt-1",
      identities(),
    ),
  );
  const second = unwrap(
    ingestExchangeFillObservation(
      persistence,
      scope,
      observation(),
      "attempt-1",
      identities(),
    ),
  );
  assert.equal(first.fill.status, "inserted");
  assert.equal(first.fee?.status, "inserted");
  assert.deepEqual(
    [
      second.fill.status,
      second.fee?.status,
      ...second.ledgerEntries.map((entry) => entry.status),
    ],
    ["duplicate", "duplicate", "duplicate", "duplicate"],
  );
  assert.equal(unwrap(persistence.readFacts()).length, 4);
  persistence.close();
});

test("a conflicting replay is delegated to SQLite and preserves the original fact", () => {
  const { persistence, scope } = createPersistence();
  const first = unwrap(
    ingestExchangeFillObservation(
      persistence,
      scope,
      observation(),
      "attempt-1",
      identities(),
    ),
  );
  const conflicting = ingestExchangeFillObservation(
    persistence,
    scope,
    observation({ price: decimal("0.0888") }),
    "attempt-1",
    identities(),
  );
  assert.equal(conflicting.ok, false);
  if (!conflicting.ok)
    assert.equal(conflicting.error.code, "PERSISTENCE_CONFLICT");
  assert.equal(
    unwrap(persistence.readFact("fill", first.fill.fact.eventIdentity))
      ?.canonicalHash,
    first.fill.fact.canonicalHash,
  );
  assert.equal(unwrap(persistence.readHalt()).active, true);
  persistence.close();
});

test("invalid fee and mismatched scope are rejected before ingestion", () => {
  const { persistence, scope } = createPersistence();
  const feeWithoutCurrency = { ...observation() };
  delete feeWithoutCurrency.feeCurrency;
  const invalidFee = ingestExchangeFillObservation(
    persistence,
    scope,
    feeWithoutCurrency,
    "attempt-1",
    identities(),
  );
  assert.equal(invalidFee.ok, false);
  if (!invalidFee.ok) assert.equal(invalidFee.error.code, "INVALID_ACCOUNTING");
  assert.equal(unwrap(persistence.readFacts()).length, 0);

  const mismatchedScope = ingestExchangeFillObservation(
    persistence,
    { ...scope, accountId: "demo:other-account" },
    observation(),
    "attempt-1",
    identities(),
  );
  assert.equal(mismatchedScope.ok, false);
  if (!mismatchedScope.ok) {
    assert.equal(mismatchedScope.error.code, "PERSISTENCE_ENVIRONMENT");
  }
  assert.equal(unwrap(persistence.readFacts()).length, 0);
  persistence.close();
});

test("fee-free execution emits one fill ledger fact and no fee fact", () => {
  const { persistence, scope } = createPersistence();
  const result = unwrap(
    ingestExchangeFillObservation(
      persistence,
      scope,
      observationWithoutFee(),
      "attempt-2",
      identities({ eventKey: "execution-2" }),
    ),
  );
  assert.equal(result.fee, undefined);
  assert.equal(result.ledgerEntries.length, 1);
  assert.equal(unwrap(persistence.readFacts()).length, 2);
  persistence.close();
});
