import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeHistoryTransaction,
  selectCanonicalHistoryEvidence,
} from "../src/application/history-accounting-normalization.js";
import { createHistorySourceFact } from "../src/domain/accounting/history-source-fact.js";
import type {
  HistorySourceFact,
  TransactionHistorySourceFact,
} from "../src/domain/accounting/history-source-fact.js";
import type { Result } from "../src/domain/shared/result.js";
import type { UtcTimestamp } from "../src/domain/shared/time.js";
import type {
  HistoryConflictSummary,
  HistoryStoredObservation,
} from "../src/ports/history-store.js";

const scope = {
  exchange: "bybit",
  environment: "mainnet" as const,
  accountId: `sha256:${"a".repeat(64)}`,
};

function unwrap<T>(result: Result<T>): T {
  if (!result.ok)
    throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function transaction(
  overrides: Partial<{
    transactionId: string;
    category: string | null;
    symbol: string | null;
    currency: string | null;
    type: string | null;
    transSubType: string | null;
    cashFlow: string | null;
    funding: string | null;
    fee: string | null;
    change: string | null;
    bonusChange: string | null;
    cashBalance: string | null;
    providerRevisionTime: string | null;
    collectedAt: string;
  }> = {},
  observationId = "observation-tx-1",
): HistoryStoredObservation {
  const input = {
    factKind: "transaction" as const,
    source: "transaction-log" as const,
    transactionId: "tx-1",
    category: "linear",
    symbol: "DOGEUSDT",
    side: "Buy",
    currency: "USDT",
    type: "TRADE",
    transSubType: null,
    qty: "1",
    size: "1",
    tradePrice: "0.1",
    cashFlow: "1",
    funding: "0",
    fee: "0.1",
    feeRate: null,
    change: "0.9",
    bonusChange: null,
    cashBalance: "10",
    tradeId: null,
    orderId: "order-1",
    orderLinkId: null,
    displayType: null,
    extraFees: null,
    providerEventTime: "2026-10-27T10:00:00.000Z",
    providerRevisionTime: null,
    collectedAt: "2026-10-27T10:01:00.000Z",
    ...overrides,
  };
  const fact = createHistorySourceFact(input);
  if (!fact.ok) throw new Error(fact.error.message);
  return stored(fact.value, observationId);
}

function closedPnl(
  overrides: Partial<{
    closedPnl: string | null;
    fundingFee: string | null;
    providerRevisionTime: string | null;
    collectedAt: string;
  }> = {},
  observationId = "observation-close-1",
): HistoryStoredObservation {
  const input = {
    factKind: "closed-pnl" as const,
    source: "closed-pnl" as const,
    category: "linear",
    symbol: "DOGEUSDT",
    orderId: "order-1",
    side: "Sell",
    orderType: "Market",
    execType: "Trade",
    qty: "10",
    orderPrice: "0.1",
    closedSize: "10",
    cumEntryValue: "1",
    avgEntryPrice: "0.1",
    cumExitValue: "1.2",
    avgExitPrice: "0.12",
    closedPnl: "0.2",
    openFee: null,
    closeFee: null,
    fundingFee: null,
    fillCount: "2",
    leverage: "1",
    providerEventTime: "2026-10-27T09:00:00.000Z",
    providerRevisionTime: "2026-10-27T10:01:00.000Z",
    collectedAt: "2026-10-27T10:02:00.000Z",
    ...overrides,
  };
  const fact = createHistorySourceFact(input);
  if (!fact.ok) throw new Error(fact.error.message);
  return stored(fact.value, observationId);
}

function stored(
  fact: HistorySourceFact,
  observationId: string,
): HistoryStoredObservation {
  const eventIdentity =
    fact.factKind === "transaction"
      ? `transaction:${fact.transactionId}`
      : fact.factKind === "closed-pnl"
        ? `closed-pnl-group:${fact.groupingKey.orderId}:${fact.groupingKey.createdTime}`
        : `fact:${fact.providerEventTime}`;
  return {
    observationId,
    scope,
    source: fact.source,
    eventIdentity,
    contentHash: fact.contentHash,
    canonicalHash: fact.contentHash,
    providerEventTime: fact.providerEventTime,
    providerRevisionTime: fact.providerRevisionTime,
    collectedAt: fact.collectedAt,
    fact,
  };
}

function transactionConflict(transactionId: string): HistoryConflictSummary {
  return {
    conflictId: `conflict-${transactionId}`,
    source: "transaction-log",
    eventIdentity: `transaction:${transactionId}`,
    existingHash: `sha256:${"b".repeat(64)}`,
    incomingHash: `sha256:${"c".repeat(64)}`,
    reason: "IMMUTABLE_ID_CONTENT_CHANGED",
    recordedAt: "2026-10-27T10:05:00.000Z" as UtcTimestamp,
  };
}

test("normalizes trade cash movement once and checks exact signed fee components", () => {
  const row = unwrap(normalizeHistoryTransaction(transaction()));

  assert.equal(row.movementKind, "trade");
  assert.equal(row.cashFlow, "1");
  assert.equal(row.funding, "0");
  assert.equal(row.fee, "0.1");
  assert.equal(row.expectedChange, "0.9");
  assert.equal(row.change, "0.9");
  assert.equal(row.componentCheck, "matched");
  assert.equal(row.cashBalance, "10");
  assert.equal(row.strategyDisposition, "corroboration-only");
});

test("TRADE may omit funding while preserving null and still checking cashFlow minus fee", () => {
  const row = unwrap(
    normalizeHistoryTransaction(
      transaction({
        transactionId: "trade-without-funding-field",
        type: "TRADE",
        cashFlow: "0",
        funding: null,
        fee: "0.0125",
        change: "-0.0125",
      }),
    ),
  );

  assert.equal(row.funding, null);
  assert.equal(row.expectedChange, "-0.0125");
  assert.equal(row.componentCheck, "matched");
});

test("settlement with missing funding remains incomplete", () => {
  const row = unwrap(
    normalizeHistoryTransaction(
      transaction({
        transactionId: "settlement-without-funding-field",
        type: "SETTLEMENT",
        cashFlow: "0",
        funding: null,
        fee: "0.0125",
        change: "-0.0125",
      }),
    ),
  );

  assert.equal(row.funding, null);
  assert.equal(row.expectedChange, null);
  assert.equal(row.componentCheck, "incomplete");
});

test("component mismatch remains visible without a guessed tolerance", () => {
  const row = unwrap(
    normalizeHistoryTransaction(
      transaction({ change: "0.89999999999999999999" }),
    ),
  );

  assert.equal(row.expectedChange, "0.9");
  assert.equal(row.change, "0.89999999999999999999");
  assert.equal(row.componentCheck, "mismatched");
});

test("a negative transaction fee remains a rebate and increases the exact expected change", () => {
  const row = unwrap(
    normalizeHistoryTransaction(
      transaction({
        transactionId: "rebate-1",
        cashFlow: "0",
        funding: "0",
        fee: "-0.00000003",
        change: "0.00000003",
      }),
    ),
  );

  assert.equal(row.fee, "-0.00000003");
  assert.equal(row.expectedChange, "0.00000003");
  assert.equal(row.componentCheck, "matched");
});

test("funding receipts and payments preserve their native signed amounts", () => {
  const received = unwrap(
    normalizeHistoryTransaction(
      transaction({
        transactionId: "funding-in",
        type: "SETTLEMENT",
        cashFlow: "0",
        funding: "0.0002",
        fee: "0",
        change: "0.0002",
      }),
    ),
  );
  const paid = unwrap(
    normalizeHistoryTransaction(
      transaction({
        transactionId: "funding-out",
        type: "SETTLEMENT",
        cashFlow: "0",
        funding: "-0.0002",
        fee: "0",
        change: "-0.0002",
      }),
    ),
  );

  assert.equal(received.movementKind, "funding");
  assert.equal(received.change, "0.0002");
  assert.equal(paid.movementKind, "funding");
  assert.equal(paid.change, "-0.0002");
  assert.equal(paid.strategyDisposition, "corroboration-only");
});

test("known transfers and unknown transaction types stay outside strategy result", () => {
  const transfer = unwrap(
    normalizeHistoryTransaction(
      transaction({
        transactionId: "manual-transfer",
        type: "TRANSFER_IN",
        transSubType: "MANUAL",
        category: "UNIFIED",
        symbol: null,
        cashFlow: "5",
        funding: "0",
        fee: "0",
        change: "5",
      }),
    ),
  );
  const unknown = unwrap(
    normalizeHistoryTransaction(
      transaction({
        transactionId: "future-type",
        type: "FUTURE_PROVIDER_TYPE",
        currency: null,
        cashFlow: "2",
        funding: "0.25",
        fee: "0",
        change: "2.25",
      }),
    ),
  );

  assert.equal(transfer.movementKind, "transfer");
  assert.equal(transfer.change, "5");
  assert.equal(transfer.strategyDisposition, "account-movement-only");
  assert.equal(unknown.movementKind, "unknown");
  assert.equal(unknown.change, "2.25");
  assert.equal(unknown.funding, "0.25");
  assert.equal(unknown.currency, null);
  assert.equal(unknown.strategyDisposition, "account-movement-only");
});

test("transaction normalization preserves provider category for readiness checks", () => {
  const row = unwrap(
    normalizeHistoryTransaction(
      transaction({ transactionId: "spot-trade", category: "spot" }),
    ),
  );
  assert.equal(row.category, "spot");
});

test("zero reported change is retained when components are incomplete instead of zero-filling them", () => {
  const row = unwrap(
    normalizeHistoryTransaction(
      transaction({
        transactionId: "incomplete-zero",
        type: "FUTURE_PROVIDER_TYPE",
        cashFlow: null,
        funding: null,
        fee: null,
        change: "0",
        cashBalance: null,
      }),
    ),
  );

  assert.equal(row.change, "0");
  assert.equal(row.expectedChange, null);
  assert.equal(row.componentCheck, "incomplete");
  assert.equal(row.cashFlow, null);
  assert.equal(row.cashBalance, null);
});

test("normalization rejects malformed exact-decimal source data", () => {
  const observation = transaction() as HistoryStoredObservation & {
    fact: TransactionHistorySourceFact;
  };
  const malformed = {
    ...observation,
    fact: { ...observation.fact, change: "NaN" },
  } as HistoryStoredObservation;

  const result = normalizeHistoryTransaction(malformed);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "INVALID_ACCOUNTING");
});

test("overlapping reads of one immutable transaction produce one selected movement", () => {
  const first = transaction({}, "observation-a");
  const replay = transaction(
    { collectedAt: "2026-10-27T10:04:00.000Z" },
    "observation-b",
  );
  const selection = unwrap(
    selectCanonicalHistoryEvidence({
      scope,
      observations: [first, replay],
      conflicts: [],
    }),
  );

  assert.equal(selection.observations.length, 1);
  assert.equal(selection.observations[0]?.observationId, "observation-b");
  const row = unwrap(normalizeHistoryTransaction(selection.observations[0]!));
  assert.equal(row.change, "0.9");
});

test("changed immutable transaction content is a conflict and contributes no selected credit", () => {
  const first = transaction({}, "observation-a");
  const changed = transaction(
    { cashFlow: "2", change: "1.9", collectedAt: "2026-10-27T10:04:00.000Z" },
    "observation-b",
  );
  const selection = unwrap(
    selectCanonicalHistoryEvidence({
      scope,
      observations: [first, changed],
      conflicts: [],
    }),
  );

  assert.equal(selection.observations.length, 0);
  assert.equal(selection.conflicts.length, 1);
  assert.equal(selection.conflicts[0]?.kind, "transaction-identity-conflict");
  if (selection.conflicts[0]?.kind === "transaction-identity-conflict")
    assert.equal(selection.conflicts[0].transactionId, "tx-1");
});

test("a persisted immutable transaction conflict excludes its one retained observation", () => {
  const selection = unwrap(
    selectCanonicalHistoryEvidence({
      scope,
      observations: [transaction()],
      conflicts: [transactionConflict("tx-1")],
    }),
  );

  assert.equal(selection.observations.length, 0);
  assert.equal(selection.conflicts[0]?.kind, "transaction-identity-conflict");
  if (selection.conflicts[0]?.kind === "transaction-identity-conflict")
    assert.deepEqual(selection.conflicts[0].conflictIds, ["conflict-tx-1"]);
});

test("closed-PnL mutable groups select the greatest provider revision, not the latest read", () => {
  const olderRevision = closedPnl(
    {
      closedPnl: "0.2",
      providerRevisionTime: "2026-10-27T10:01:00.000Z",
      collectedAt: "2026-10-27T10:05:00.000Z",
    },
    "closed-old",
  );
  const latestRevision = closedPnl(
    {
      closedPnl: "0.3",
      providerRevisionTime: "2026-10-27T10:02:00.000Z",
      collectedAt: "2026-10-27T10:03:00.000Z",
    },
    "closed-new",
  );
  const selection = unwrap(
    selectCanonicalHistoryEvidence({
      scope,
      observations: [olderRevision, latestRevision],
      conflicts: [],
    }),
  );

  assert.equal(selection.observations.length, 1);
  assert.equal(selection.observations[0]?.observationId, "closed-new");
  const selected = selection.observations[0]?.fact;
  assert.equal(selected?.factKind, "closed-pnl");
  if (selected?.factKind === "closed-pnl") {
    assert.equal(selected.closedPnl, "0.3");
    assert.equal(selected.fundingFee, null);
  }
});

test("different closed-PnL rows without an ordered revision remain ambiguous", () => {
  const first = closedPnl(
    {
      closedPnl: "0.2",
      providerRevisionTime: null,
      collectedAt: "2026-10-27T10:03:00.000Z",
    },
    "closed-a",
  );
  const second = closedPnl(
    {
      closedPnl: "0.3",
      providerRevisionTime: null,
      collectedAt: "2026-10-27T10:04:00.000Z",
    },
    "closed-b",
  );
  const selection = unwrap(
    selectCanonicalHistoryEvidence({
      scope,
      observations: [first, second],
      conflicts: [],
    }),
  );

  assert.equal(selection.observations.length, 0);
  assert.equal(selection.conflicts[0]?.kind, "closed-pnl-revision-conflict");
});

test("selection rejects observations from a different account scope", () => {
  const result = selectCanonicalHistoryEvidence({
    scope,
    observations: [
      {
        ...transaction(),
        scope: { ...scope, accountId: `sha256:${"d".repeat(64)}` },
      },
    ],
    conflicts: [],
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "INVALID_VALUE");
});
