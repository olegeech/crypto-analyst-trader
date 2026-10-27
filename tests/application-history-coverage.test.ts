import assert from "node:assert/strict";
import test from "node:test";

import { projectHistoryCoverage } from "../src/application/history-coverage.js";
import { createHistorySourceFact } from "../src/domain/accounting/history-source-fact.js";
import type { HistorySourceFact } from "../src/domain/accounting/history-source-fact.js";
import type { Result } from "../src/domain/shared/result.js";
import type { UtcTimestamp } from "../src/domain/shared/time.js";
import type {
  HistoryStoredObservation,
  HistoryCheckpoint,
} from "../src/ports/history-store.js";

const NOW = "2026-10-27T12:00:00.000Z" as UtcTimestamp;
const scope = {
  exchange: "bybit",
  environment: "mainnet" as const,
  accountId: `sha256:${"a".repeat(64)}`,
};
const window = {
  fromMs: Date.parse("2024-10-27T12:00:00.000Z"),
  toMs: Date.parse("2026-10-27T12:00:00.000Z"),
};

function unwrap<T>(result: Result<T>): T {
  if (!result.ok)
    throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function checkpoint(
  source: HistoryCheckpoint["source"],
  status: HistoryCheckpoint["status"],
  reasonCode: string | null = null,
): HistoryCheckpoint {
  return {
    scope,
    source,
    filters: { category: "linear" },
    window,
    filterHash: `sha256:${"b".repeat(64)}`,
    cursor: null,
    status,
    rowCount: 2,
    insertedCount: 2,
    duplicateCount: 0,
    conflictCount: 0,
    reasonCode,
    updatedAt: NOW,
    revision: 1,
  };
}

function transactionObservation(): HistoryStoredObservation {
  const result = createHistorySourceFact({
    factKind: "transaction",
    source: "transaction-log",
    transactionId: "transfer-1",
    category: "UNIFIED",
    symbol: null,
    side: null,
    currency: null,
    type: "TRANSFER_IN",
    transSubType: null,
    qty: null,
    size: null,
    tradePrice: null,
    cashFlow: "0",
    funding: null,
    fee: null,
    feeRate: null,
    change: "0",
    bonusChange: null,
    cashBalance: null,
    tradeId: null,
    orderId: null,
    orderLinkId: null,
    displayType: null,
    extraFees: null,
    providerEventTime: "2026-10-26T12:00:00.000Z",
    providerRevisionTime: null,
    collectedAt: NOW,
  });
  if (!result.ok) throw new Error(result.error.message);
  return {
    observationId: "transfer-observation-1",
    scope,
    source: "transaction-log",
    eventIdentity: "transfer-1",
    contentHash: result.value.contentHash,
    canonicalHash: result.value.contentHash,
    providerEventTime: result.value.providerEventTime,
    providerRevisionTime: result.value.providerRevisionTime,
    collectedAt: result.value.collectedAt,
    fact: result.value,
  };
}

function storedFact(
  fact: HistorySourceFact,
  observationId: string,
): HistoryStoredObservation {
  return {
    observationId,
    scope,
    source: fact.source,
    eventIdentity:
      fact.factKind === "transaction"
        ? fact.transactionId
        : fact.factKind === "execution"
          ? fact.execId
          : fact.orderId,
    contentHash: fact.contentHash,
    canonicalHash: fact.contentHash,
    providerEventTime: fact.providerEventTime,
    providerRevisionTime: fact.providerRevisionTime,
    collectedAt: fact.collectedAt,
    fact,
  };
}

test("expired history, missing opening balance, unknown currency and missing funding remain explicit", () => {
  const report = unwrap(
    projectHistoryCoverage({
      scope,
      checkpoints: [
        checkpoint("order-history", "unavailable", "HISTORY_EXPIRED"),
        checkpoint("executions", "traversed"),
        checkpoint("closed-pnl", "traversed"),
        checkpoint("transaction-log", "traversed"),
      ],
      observations: [transactionObservation()],
    }),
  );

  assert.equal(
    report.streams.find((row) => row.source === "order-history")?.windows[0]
      ?.status,
    "unavailable",
  );
  assert.ok(
    report.gaps.some(
      (gap) => gap.kind === "history-expired" && gap.source === "order-history",
    ),
  );
  assert.equal(report.openingBalance.status, "unknown");
  assert.ok(report.gaps.some((gap) => gap.kind === "opening-balance-unknown"));
  assert.ok(
    report.gaps.some(
      (gap) =>
        gap.kind === "unknown-currency" &&
        gap.observationId === "transfer-observation-1",
    ),
  );
  assert.equal(report.funding.status, "not-observed");
  assert.ok(report.gaps.some((gap) => gap.kind === "funding-not-observed"));
  assert.equal("netPnl" in report, false);
  assert.equal("accountingReady" in report, false);
});

test("money evidence keeps a reported zero distinct from missing amount and carries source provenance", () => {
  const report = unwrap(
    projectHistoryCoverage({
      scope,
      checkpoints: [checkpoint("transaction-log", "traversed")],
      observations: [transactionObservation()],
    }),
  );
  const cashFlow = report.moneyComponents.find(
    (row) => row.component === "cash-flow",
  );
  assert.equal(cashFlow?.amount, "0");
  assert.equal(cashFlow?.currency, null);
  assert.equal(cashFlow?.provenance.observationId, "transfer-observation-1");
  assert.equal(cashFlow?.completeness, "incomplete");
  assert.equal(report.openingBalance.status, "unknown");
});

test("coverage rejects facts and checkpoints from a different account scope", () => {
  const foreign = { ...scope, accountId: `sha256:${"c".repeat(64)}` };
  const report = projectHistoryCoverage({
    scope,
    checkpoints: [checkpoint("transaction-log", "traversed")],
    observations: [{ ...transactionObservation(), scope: foreign }],
  });
  assert.equal(report.ok, false);
});

test("coverage reports deliberate gaps between windows with matching filters", () => {
  const first = checkpoint("executions", "traversed");
  const second = {
    ...checkpoint("executions", "traversed"),
    window: { fromMs: window.toMs + 2, toMs: window.toMs + 3 },
  };
  const report = unwrap(
    projectHistoryCoverage({
      scope,
      checkpoints: [first, second],
      observations: [],
    }),
  );

  assert.ok(
    report.gaps.some(
      (gap) =>
        gap.kind === "unqueried-window" &&
        gap.source === "executions" &&
        gap.window.fromMs === window.toMs + 1 &&
        gap.window.toMs === window.toMs + 1,
    ),
  );
});

test("fee rebates, funding and cash movement components retain their separate signed source values", () => {
  const transaction = createHistorySourceFact({
    factKind: "transaction",
    source: "transaction-log",
    transactionId: "rebate-and-funding-1",
    category: "UNIFIED",
    symbol: "DOGEUSDT",
    side: null,
    currency: "USDT",
    type: "TRADE_REBATE",
    transSubType: "FUNDING",
    qty: null,
    size: null,
    tradePrice: null,
    cashFlow: "0.25",
    funding: "-0.005",
    fee: "-0.002",
    feeRate: null,
    change: "0.25",
    bonusChange: null,
    cashBalance: "1.25",
    tradeId: null,
    orderId: null,
    orderLinkId: null,
    displayType: null,
    extraFees: null,
    providerEventTime: "2026-10-26T12:00:00.000Z",
    providerRevisionTime: null,
    collectedAt: NOW,
  });
  const closedPnl = createHistorySourceFact({
    factKind: "closed-pnl",
    source: "closed-pnl",
    category: "linear",
    symbol: "DOGEUSDT",
    orderId: "closed-order-1",
    side: "Sell",
    orderType: "Market",
    execType: "Trade",
    qty: "1",
    orderPrice: "0.077",
    closedSize: "1",
    cumEntryValue: "0.076",
    avgEntryPrice: "0.076",
    cumExitValue: "0.077",
    avgExitPrice: "0.077",
    closedPnl: "0.001",
    openFee: "0.0001",
    closeFee: "0.0002",
    fundingFee: "-0.0003",
    fillCount: "2",
    leverage: "1",
    providerEventTime: "2026-10-26T12:00:00.000Z",
    providerRevisionTime: null,
    collectedAt: NOW,
  });
  assert.equal(transaction.ok, true);
  assert.equal(closedPnl.ok, true);
  if (!transaction.ok || !closedPnl.ok) return;

  const report = unwrap(
    projectHistoryCoverage({
      scope,
      checkpoints: [checkpoint("transaction-log", "traversed")],
      observations: [
        storedFact(transaction.value, "rebate-and-funding"),
        storedFact(closedPnl.value, "closed-pnl"),
      ],
    }),
  );
  const component = (name: string) =>
    report.moneyComponents.find((row) => row.component === name);
  assert.equal(component("fee")?.amount, "-0.002");
  assert.equal(component("funding")?.amount, "-0.005");
  assert.equal(component("cash-flow")?.amount, "0.25");
  assert.equal(component("change")?.amount, "0.25");
  assert.equal(component("closed-pnl")?.amount, "0.001");
  assert.equal(component("open-fee")?.amount, "0.0001");
  assert.equal(component("close-fee")?.amount, "0.0002");
  assert.equal(component("funding-fee")?.amount, "-0.0003");
  assert.equal(report.funding.status, "observed");
  assert.equal("netPnl" in report, false);
});
