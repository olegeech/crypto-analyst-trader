import assert from "node:assert/strict";
import test from "node:test";

import { attributeHistoryObservations } from "../src/application/history-attribution.js";
import { projectHistoryAccountingPerformance } from "../src/application/history-accounting-performance.js";
import { createHistorySourceFact } from "../src/domain/accounting/history-source-fact.js";
import {
  hashCanonical,
  type PlanHash,
} from "../src/domain/identity/canonical-serialization.js";
import type { Result } from "../src/domain/shared/result.js";
import type { UtcTimestamp } from "../src/domain/shared/time.js";
import type { HistorySourceFact } from "../src/domain/accounting/history-source-fact.js";
import type { HistoryAttributionProjection } from "../src/application/history-attribution.js";
import type { HistoryStoredObservation } from "../src/ports/history-store.js";
import type {
  PreparedLegRunSnapshot,
  PersistenceScope,
} from "../src/ports/persistence.js";
import type { HistoryPositionUplEvidence } from "../src/application/history-accounting-performance.js";

const ACCOUNT = `sha256:${"a".repeat(64)}`;
const OTHER_ACCOUNT = `sha256:${"b".repeat(64)}`;
const NOW = "2026-10-27T12:00:00.000Z" as UtcTimestamp;
const HISTORY_SCOPE = {
  exchange: "bybit",
  environment: "mainnet" as const,
  accountId: ACCOUNT,
};
const PERSISTENCE_SCOPE: PersistenceScope = {
  ...HISTORY_SCOPE,
  category: "linear",
  positionMode: "one-way",
};
const SETTLEMENT = {
  DOGEUSDT: {
    currency: "USDT",
    verified: true,
    evidence: "bybit-instrument-info",
  },
  BTCUSD: {
    currency: "BTC",
    verified: true,
    evidence: "bybit-instrument-info",
  },
} as const;

function unwrap<T>(result: Result<T>): T {
  if (!result.ok)
    throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function hash(value: unknown): PlanHash {
  return unwrap(hashCanonical(value));
}

function preparedRun(
  runId: string,
  orderIds: readonly string[],
): PreparedLegRunSnapshot {
  const sourceId = `prepared-leg:${runId}`;
  const canonicalHash = hash({ sourceId });
  const clientOrderId = `client-${runId}`;
  return {
    lineage: {
      sourceId,
      scope: PERSISTENCE_SCOPE,
      preparedHash: canonicalHash,
      legId: `leg-${runId}`,
      clientOrderId,
      selectionCanonicalJson: "{}",
      selectionHash: canonicalHash,
      createdAt: NOW,
    },
    approvalHashes: [canonicalHash],
    createIntent: {
      writeIntentId: `intent-${runId}`,
      sourceId,
      operation: "create",
      runId,
      leaseEpoch: 1,
      clientOrderId,
      ...(orderIds[0] === undefined ? {} : { exchangeOrderId: orderIds[0] }),
      canonicalJson: "{}",
      canonicalHash,
      preparedAt: NOW,
    },
    reconciliations: orderIds.slice(1).map((exchangeOrderId, index) => ({
      reconciliationId: `reconciliation-${runId}-${index}`,
      sourceId,
      revision: index + 1,
      status: "VERIFIED_CLOSED" as const,
      observedAt: NOW,
      exchangeOrderId,
      canonicalJson: "{}",
      canonicalHash,
    })),
    halt: {
      scope: PERSISTENCE_SCOPE,
      active: false,
      revision: 0,
      reconciliationRequired: false,
    },
  };
}

function stored(
  fact: HistorySourceFact,
  observationId: string,
): HistoryStoredObservation {
  return {
    observationId,
    scope: HISTORY_SCOPE,
    source: fact.source,
    eventIdentity:
      fact.factKind === "transaction"
        ? `transaction:${fact.transactionId}`
        : fact.factKind === "closed-pnl"
          ? `closed-pnl:${fact.orderId}:${fact.groupingKey.createdTime}`
          : fact.factKind === "execution"
            ? `execution:${fact.execId}`
            : `order:${fact.orderId}`,
    contentHash: fact.contentHash,
    canonicalHash: fact.contentHash,
    providerEventTime: fact.providerEventTime,
    providerRevisionTime: fact.providerRevisionTime,
    collectedAt: fact.collectedAt,
    fact,
  };
}

function closedPnl(
  input: {
    orderId: string;
    symbol?: string;
    closedPnl?: string | null;
    openFee?: string | null;
    closeFee?: string | null;
    fundingFee?: string | null;
    providerEventTime?: string;
    providerRevisionTime?: string | null;
  },
  observationId: string,
): HistoryStoredObservation {
  const fact = unwrap(
    createHistorySourceFact({
      factKind: "closed-pnl",
      source: "closed-pnl",
      category: "linear",
      symbol: input.symbol ?? "DOGEUSDT",
      orderId: input.orderId,
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
      closedPnl: input.closedPnl === undefined ? "0.2" : input.closedPnl,
      openFee: input.openFee === undefined ? "0.01" : input.openFee,
      closeFee: input.closeFee === undefined ? "0.01" : input.closeFee,
      fundingFee: input.fundingFee === undefined ? "0" : input.fundingFee,
      fillCount: "2",
      leverage: "1",
      providerEventTime: input.providerEventTime ?? "2026-10-27T10:00:00.000Z",
      providerRevisionTime:
        input.providerRevisionTime ?? "2026-10-27T10:01:00.000Z",
      collectedAt: "2026-10-27T10:02:00.000Z",
    }),
  );
  return stored(fact, observationId);
}

function execution(
  orderId: string,
  execId: string,
  observationId: string,
  execPnl = "0.1",
): HistoryStoredObservation {
  const fact = unwrap(
    createHistorySourceFact({
      factKind: "execution",
      source: "executions",
      category: "linear",
      symbol: "DOGEUSDT",
      orderId,
      orderLinkId: null,
      execId,
      orderPrice: null,
      orderQty: null,
      side: "Sell",
      execType: "Trade",
      execPrice: "0.12",
      execQty: "5",
      execValue: "0.6",
      execFee: "-0.001",
      execFeeV2: null,
      feeCurrency: "USDT",
      feeRate: null,
      execPnl,
      closedSize: "5",
      isMaker: true,
      seq: null,
      leavesQty: null,
      markPrice: null,
      indexPrice: null,
      underlyingPrice: null,
      createType: null,
      blockTradeId: null,
      extraFees: null,
      providerEventTime: "2026-10-27T10:00:00.000Z",
      providerRevisionTime: null,
      collectedAt: "2026-10-27T10:02:00.000Z",
    }),
  );
  return stored(fact, observationId);
}

function transaction(observationId: string): HistoryStoredObservation {
  const fact = unwrap(
    createHistorySourceFact({
      factKind: "transaction",
      source: "transaction-log",
      transactionId: "transaction-tp-1",
      category: "linear",
      symbol: "DOGEUSDT",
      side: "Sell",
      currency: "USDT",
      type: "TRADE",
      transSubType: null,
      qty: "10",
      size: "10",
      tradePrice: "0.12",
      cashFlow: "0.2",
      funding: "0",
      fee: "0.01",
      feeRate: null,
      change: "0.19",
      bonusChange: null,
      cashBalance: "1",
      tradeId: null,
      orderId: "tp-order",
      orderLinkId: null,
      displayType: null,
      extraFees: null,
      providerEventTime: "2026-10-27T10:00:00.000Z",
      providerRevisionTime: null,
      collectedAt: "2026-10-27T10:02:00.000Z",
    }),
  );
  return stored(fact, observationId);
}

function attribution(
  observations: readonly HistoryStoredObservation[],
  runs: readonly PreparedLegRunSnapshot[],
): HistoryAttributionProjection {
  return unwrap(
    attributeHistoryObservations({
      observations,
      operatorSources: [],
      preparedSources: runs,
    }),
  );
}

function project(
  history: HistoryAttributionProjection,
  overrides: Partial<
    Parameters<typeof projectHistoryAccountingPerformance>[0]
  > = {},
) {
  return projectHistoryAccountingPerformance({
    scope: HISTORY_SCOPE,
    attribution: history,
    sourceConflicts: [],
    settlementCurrencyBySymbol: SETTLEMENT,
    ...overrides,
  });
}

function positionUpl(
  input: {
    amount?: string;
    ownerEvidence?: {
      sourceKind: "prepared-leg";
      sourceId: string;
      executionObservationIds: readonly string[];
    };
  } = {},
): HistoryPositionUplEvidence {
  return {
    scope: HISTORY_SCOPE,
    asOf: "2026-10-27T12:05:00.000Z" as UtcTimestamp,
    positions: [
      {
        positionId: "DOGEUSDT:0",
        symbol: "DOGEUSDT",
        unrealizedPnl: input.amount ?? "0.03",
        currency: {
          currency: "USDT",
          verified: true as const,
          evidence: "bybit-position-scope",
        },
        ...(input.ownerEvidence === undefined
          ? {}
          : { ownerEvidence: input.ownerEvidence }),
      },
    ],
  };
}

test("an exact-lineage TP reports closedPnl as provider net and keeps fee/funding corroboration non-additive", () => {
  const close = closedPnl({ orderId: "tp-order" }, "closed-tp");
  const history = attribution([close], [preparedRun("run-tp", ["tp-order"])]);
  const result = unwrap(project(history));

  assert.equal(result.ownedClosedPnl[0]?.reportedClosedPnl, "0.2");
  assert.equal(result.ownedClosedPnl[0]?.currency, "USDT");
  assert.equal(result.ownedClosedPnl[0]?.feeFunding.openFee, "0.01");
  assert.equal(result.ownedClosedPnl[0]?.feeFunding.closeFee, "0.01");
  assert.equal(result.ownedClosedPnl[0]?.feeFunding.fundingFee, "0");
  assert.equal(
    result.ownedClosedPnl[0]?.feeFunding.includedInReportedClosedPnl,
    false,
  );
  assert.equal(result.ownedRunSymbolDays[0]?.amount, "0.2");
  assert.equal(result.ownedRunSymbolDays[0]?.status, "complete");
});

test("same-timestamp execution fills and duplicate closed-PnL observations do not duplicate realized PnL", () => {
  const close = closedPnl({ orderId: "tp-order" }, "closed-tp");
  const history = attribution(
    [
      execution("tp-order", "exec-1", "execution-1"),
      execution("tp-order", "exec-2", "execution-2"),
      transaction("transaction-observation"),
      close,
      { ...close, observationId: "closed-tp-replay" },
    ],
    [preparedRun("run-tp", ["tp-order"])],
  );
  const result = unwrap(project(history));

  assert.equal(result.ownedRunSymbolDays[0]?.amount, "0.2");
  assert.equal(result.ownedRunSymbolDays[0]?.observationIds.length, 1);
  assert.equal(result.ownedClosedPnl.length, 1);
});

test("conflicting closed-PnL revisions are exposed and never selected for realized performance", () => {
  const first = closedPnl(
    { orderId: "tp-order", closedPnl: "0.2" },
    "closed-revision-one",
  );
  const second = closedPnl(
    { orderId: "tp-order", closedPnl: "0.25" },
    "closed-revision-two",
  );
  const history = attribution(
    [first, second],
    [preparedRun("run-tp", ["tp-order"])],
  );
  const result = unwrap(project(history));

  assert.equal(result.ownedClosedPnl.length, 0);
  assert.equal(result.ownedRunSymbolDays.length, 0);
  assert.equal(result.selectionConflicts.length, 1);
  assert.equal(
    result.selectionConflicts[0]?.kind,
    "closed-pnl-revision-conflict",
  );
});

test("partial-close realized PnL and remaining account-level UPL stay separate", () => {
  const close = closedPnl(
    { orderId: "partial-tp", closedPnl: "0.4" },
    "closed-partial",
  );
  const history = attribution(
    [close],
    [preparedRun("run-partial", ["partial-tp"])],
  );
  const result = unwrap(
    project(history, { positionUplEvidence: positionUpl() }),
  );

  assert.equal(result.ownedRunSymbolDays[0]?.amount, "0.4");
  assert.equal(result.positionUpl?.positions[0]?.unrealizedPnl, "0.03");
  assert.equal(
    result.positionUpl?.positions[0]?.allocation,
    "account-level-unallocated",
  );
});

test("two run IDs on the same symbol remain separate while account-day aggregation is explicit", () => {
  const closeOne = closedPnl(
    { orderId: "tp-one", closedPnl: "0.2" },
    "closed-one",
  );
  const closeTwo = closedPnl(
    { orderId: "tp-two", closedPnl: "0.3" },
    "closed-two",
  );
  const history = attribution(
    [closeOne, closeTwo],
    [preparedRun("run-one", ["tp-one"]), preparedRun("run-two", ["tp-two"])],
  );
  const result = unwrap(project(history));

  assert.deepEqual(
    result.ownedRunSymbolDays.map((row) => row.source?.sourceId),
    ["prepared-leg:run-one", "prepared-leg:run-two"],
  );
  assert.deepEqual(
    result.ownedRunSymbolDays.map((row) => row.amount),
    ["0.2", "0.3"],
  );
  assert.equal(result.accountDays[0]?.amount, "0.5");
});

test("an unrelated manual close remains visible as non-strategy performance", () => {
  const manual = closedPnl({ orderId: "manual-order" }, "closed-manual");
  const history = attribution([manual], []);
  const result = unwrap(project(history));

  assert.equal(result.ownedRunSymbolDays.length, 0);
  assert.equal(result.notStrategyPerformance[0]?.ownership, "unmatched");
  assert.equal(result.notStrategyPerformance[0]?.reportedClosedPnl, "0.2");
});

test("ambiguous exact lineage is excluded from strategy performance", () => {
  const close = closedPnl({ orderId: "shared-order" }, "closed-ambiguous");
  const history = attribution(
    [close],
    [
      preparedRun("run-a", ["shared-order"]),
      preparedRun("run-b", ["shared-order"]),
    ],
  );
  const result = unwrap(project(history));

  assert.equal(result.ownedRunSymbolDays.length, 0);
  assert.equal(result.notStrategyPerformance[0]?.ownership, "ambiguous");
});

test("missing verified settlement currency keeps closed-PnL amount and denomination unknown", () => {
  const close = closedPnl({ orderId: "tp-order" }, "closed-tp");
  const history = attribution([close], [preparedRun("run-tp", ["tp-order"])]);
  const result = unwrap(project(history, { settlementCurrencyBySymbol: {} }));

  assert.equal(result.ownedClosedPnl[0]?.reportedClosedPnl, null);
  assert.equal(result.ownedClosedPnl[0]?.currency, null);
  assert.equal(result.ownedClosedPnl[0]?.status, "unknown");
  assert.equal(result.ownedClosedPnl[0]?.feeFunding.status, "incomplete");
  assert.equal(result.ownedRunSymbolDays[0]?.amount, null);
});

test("mark changes affect only as-of UPL and do not create realized trade results", () => {
  const history = attribution([], []);
  const first = unwrap(
    project(history, { positionUplEvidence: positionUpl({ amount: "0.1" }) }),
  );
  const second = unwrap(
    project(history, { positionUplEvidence: positionUpl({ amount: "0.9" }) }),
  );

  assert.equal(first.ownedRunSymbolDays.length, 0);
  assert.equal(second.ownedRunSymbolDays.length, 0);
  assert.equal(first.positionUpl?.positions[0]?.unrealizedPnl, "0.1");
  assert.equal(second.positionUpl?.positions[0]?.unrealizedPnl, "0.9");
});

test("incomplete fee or funding fields mark the breakdown partial without recalculating closedPnl", () => {
  const close = closedPnl(
    {
      orderId: "tp-order",
      closedPnl: "0.2",
      openFee: "0.01",
      closeFee: null,
      fundingFee: null,
    },
    "closed-incomplete-fees",
  );
  const history = attribution([close], [preparedRun("run-tp", ["tp-order"])]);
  const result = unwrap(project(history));

  assert.equal(result.ownedClosedPnl[0]?.reportedClosedPnl, "0.2");
  assert.equal(result.ownedClosedPnl[0]?.feeFunding.status, "incomplete");
  assert.equal(result.ownedClosedPnl[0]?.status, "partial");
  assert.equal(result.ownedRunSymbolDays[0]?.amount, "0.2");
  assert.equal(result.ownedRunSymbolDays[0]?.status, "partial");
});

test("mixed settlement currencies remain separate by symbol and unknown in account total", () => {
  const doge = closedPnl(
    { orderId: "doge-close", symbol: "DOGEUSDT", closedPnl: "0.2" },
    "closed-doge",
  );
  const btc = closedPnl(
    { orderId: "btc-close", symbol: "BTCUSD", closedPnl: "0.01" },
    "closed-btc",
  );
  const history = attribution(
    [doge, btc],
    [
      preparedRun("doge-run", ["doge-close"]),
      preparedRun("btc-run", ["btc-close"]),
    ],
  );
  const result = unwrap(project(history));

  assert.deepEqual(
    result.ownedRunSymbolDays.map((row) => row.currency),
    ["BTC", "USDT"],
  );
  assert.equal(result.accountDays[0]?.amount, null);
  assert.equal(result.accountDays[0]?.currency, null);
  assert.equal(result.accountDays[0]?.status, "unknown");
  assert.ok(result.accountDays[0]?.reasonCodes.includes("MIXED_CURRENCY"));
});

test("exact owner evidence may allocate position UPL to its matched run", () => {
  const close = closedPnl({ orderId: "tp-order" }, "closed-tp");
  const fill = execution("tp-order", "exec-open", "execution-owned");
  const run = preparedRun("run-tp", ["tp-order"]);
  const history = attribution([close, fill], [run]);
  const result = unwrap(
    project(history, {
      positionUplEvidence: positionUpl({
        ownerEvidence: {
          sourceKind: "prepared-leg",
          sourceId: "prepared-leg:run-tp",
          executionObservationIds: ["execution-owned"],
        },
      }),
    }),
  );

  assert.equal(result.positionUpl?.positions[0]?.allocation, "owned-run");
  assert.equal(
    result.positionUpl?.positions[0]?.source?.sourceId,
    "prepared-leg:run-tp",
  );
});

test("malformed account scope and decimal values are rejected", () => {
  const close = closedPnl({ orderId: "tp-order" }, "closed-tp");
  const history = attribution([close], [preparedRun("run-tp", ["tp-order"])]);
  const wrongScope = project(history, {
    positionUplEvidence: {
      ...positionUpl(),
      scope: { ...HISTORY_SCOPE, accountId: OTHER_ACCOUNT },
    },
  });
  const malformedAmount = project(history, {
    positionUplEvidence: positionUpl({ amount: "1e-8" }),
  });

  assert.equal(wrongScope.ok, false);
  assert.equal(malformedAmount.ok, false);
});
