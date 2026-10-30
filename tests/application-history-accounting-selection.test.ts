import assert from "node:assert/strict";
import test from "node:test";

import { selectScopedHistoryAccountingEvidence } from "../src/application/history-accounting-selection.js";
import { resolveHistoryAccountingScope } from "../src/application/history-accounting-scope.js";
import { createHistorySourceFact } from "../src/domain/accounting/history-source-fact.js";
import type { Result } from "../src/domain/shared/result.js";
import type { UtcTimestamp } from "../src/domain/shared/time.js";
import type {
  HistoryConflictSummary,
  HistoryStoredObservation,
  HistoryStoreScope,
} from "../src/ports/history-store.js";

const accountScope: HistoryStoreScope = {
  exchange: "bybit",
  environment: "mainnet",
  accountId: `sha256:${"a".repeat(64)}`,
};
const openingBoundary = "2026-10-27T10:00:00.000Z";
const closingBoundary = "2026-10-27T10:10:00.000Z";
const accountingScope = unwrap(
  resolveHistoryAccountingScope("provisional-m1-v1"),
);

function unwrap<T>(result: Result<T>): T {
  if (!result.ok)
    throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function transaction(
  transactionId: string,
  overrides: Partial<{
    currency: string | null;
    type: string | null;
    transSubType: string | null;
    orderId: string | null;
    tradeId: string | null;
    orderLinkId: string | null;
    change: string | null;
    cashFlow: string | null;
    funding: string | null;
    fee: string | null;
  }> = {},
  observationId = `obs-${transactionId}`,
): HistoryStoredObservation {
  const input = {
    factKind: "transaction" as const,
    source: "transaction-log" as const,
    transactionId,
    category: "linear",
    symbol: "DOGEUSDT",
    side: "Buy",
    currency: "MNT",
    type: "TRANSFER_IN",
    transSubType: null,
    qty: null,
    size: null,
    tradePrice: null,
    cashFlow: "1",
    funding: "0",
    fee: "0",
    feeRate: null,
    change: "1",
    bonusChange: null,
    cashBalance: null,
    tradeId: null,
    orderId: null,
    orderLinkId: null,
    displayType: null,
    extraFees: null,
    providerEventTime: "2026-10-27T10:05:00.000Z",
    providerRevisionTime: null,
    collectedAt: "2026-10-27T10:06:00.000Z",
    ...overrides,
  };
  const fact = unwrap(createHistorySourceFact(input));
  if (fact.factKind !== "transaction")
    throw new Error("fixture did not produce a transaction fact");
  return {
    observationId,
    scope: accountScope,
    source: fact.source,
    eventIdentity: `transaction:${fact.transactionId}`,
    contentHash: fact.contentHash,
    canonicalHash: fact.contentHash,
    providerEventTime: fact.providerEventTime,
    providerRevisionTime: fact.providerRevisionTime,
    collectedAt: fact.collectedAt,
    fact,
  };
}

function select(
  observations: readonly HistoryStoredObservation[],
  conflicts: readonly HistoryConflictSummary[] = [],
) {
  return unwrap(
    selectScopedHistoryAccountingEvidence({
      scope: accountScope,
      accountingScope,
      epoch: {
        openingBoundary: openingBoundary as UtcTimestamp,
        closingBoundary: closingBoundary as UtcTimestamp,
        openingCaptureBracket: {
          fromMs: Date.parse(openingBoundary) - 100,
          toMs: Date.parse(openingBoundary) + 100,
        },
        closingCaptureBracket: {
          fromMs: Date.parse(closingBoundary) - 100,
          toMs: Date.parse(closingBoundary) + 100,
        },
      },
      observations,
      conflicts,
    }),
  );
}

test("excludes only a located independent outside-currency transfer", () => {
  const usdt = transaction("tx-usdt", {
    currency: "USDT",
    type: "SETTLEMENT",
    change: "0",
    cashFlow: "0",
  });
  const mnt = transaction("tx-mnt-independent");
  const selected = select([mnt, usdt]);

  assert.deepEqual(
    selected.selectedObservations.map(({ observationId }) => observationId),
    [usdt.observationId],
  );
  assert.equal(selected.exclusions[0]?.currency, "MNT");
  assert.deepEqual(select([usdt, mnt]).identities, selected.identities);
});

test("retains an outside-currency transaction linked by exact order identity", () => {
  const usdt = transaction("tx-usdt-trade", {
    currency: "USDT",
    type: "SETTLEMENT",
    orderId: "order-42",
  });
  const mnt = transaction("tx-mnt-linked", { orderId: "order-42" });
  const selected = select([mnt, usdt]);

  assert.deepEqual(
    selected.selectedObservations.map(({ observationId }) => observationId),
    [usdt.observationId, mnt.observationId].sort(),
  );
  assert.equal(selected.exclusions.length, 0);
});

test("keeps a linked MNT trade fee with the selected USDT order", () => {
  const usdtTrade = transaction("tx-usdt-trade", {
    currency: "USDT",
    type: "TRADE",
    orderId: "order-42",
    change: "-0.01",
    cashFlow: "0",
    fee: "0.01",
  });
  const mntFee = transaction("tx-mnt-fee", {
    currency: "MNT",
    type: "TRADE",
    orderId: "order-42",
    change: "-0.1",
    cashFlow: "0",
    fee: "0.1",
  });
  const selected = select([usdtTrade, mntFee]);

  assert.deepEqual(
    selected.selectedObservations.map(({ observationId }) => observationId),
    [mntFee.observationId, usdtTrade.observationId].sort(),
  );
  assert.equal(selected.exclusions.length, 0);
});

test("blocks a same-ID revision that moves from MNT into USDT", () => {
  const mntRevision = transaction(
    "tx-currency-revision",
    {
      currency: "MNT",
      type: "TRANSFER_IN",
    },
    "obs-revision-mnt",
  );
  const usdtRevision = transaction(
    "tx-currency-revision",
    {
      currency: "USDT",
      type: "TRANSFER_IN",
    },
    "obs-revision-usdt",
  );
  const selected = select([mntRevision, usdtRevision]);

  assert.equal(selected.conflicts[0]?.disposition, "blocking");
  assert.equal(selected.exclusions.length, 0);
});

test("keeps a hash-only conflict potentially relevant even for a safe transfer type", () => {
  const mnt = transaction("tx-mnt-conflicted");
  const conflict: HistoryConflictSummary = {
    conflictId: "conflict-mnt",
    source: "transaction-log",
    eventIdentity: mnt.eventIdentity,
    existingHash: mnt.contentHash,
    incomingHash: `sha256:${"f".repeat(64)}`,
    reason: "IMMUTABLE_ID_CONTENT_CHANGED",
    recordedAt: "2026-10-27T10:07:00.000Z" as UtcTimestamp,
    windows: [],
  };
  const selected = select([mnt], [conflict]);

  assert.equal(selected.conflicts[0]?.disposition, "blocking");
  assert.equal(selected.exclusions.length, 0);
});

test("retains unknown outside-currency transaction types as potentially relevant", () => {
  const unknown = transaction("tx-mnt-unknown", { type: "NEW_PROVIDER_TYPE" });
  const selected = select([unknown]);

  assert.deepEqual(
    selected.selectedObservations.map(({ observationId }) => observationId),
    [unknown.observationId],
  );
  assert.equal(selected.exclusions.length, 0);
});

test("bounds exclusion samples while retaining deterministic total counts", () => {
  const observations = Array.from({ length: 130 }, (_, index) =>
    transaction(`tx-${String(index).padStart(3, "0")}`),
  );
  const selected = select([...observations].reverse());
  const reordered = select(observations);

  assert.equal(selected.exclusionCount, 130);
  assert.equal(selected.exclusionsTruncated, true);
  assert.deepEqual(
    selected.exclusions.map(({ eventIdentity }) => eventIdentity),
    reordered.exclusions.map(({ eventIdentity }) => eventIdentity),
  );
  assert.equal(selected.exclusions.length, 128);
  assert.equal(selected.exclusions[0]?.eventIdentity, "transaction:tx-000");
  assert.equal(selected.exclusions.at(-1)?.eventIdentity, "transaction:tx-127");
});
