import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createHistoryAccountingReport,
  decodeHistoryAccountingReport,
  encodeHistoryAccountingReport,
  type HistoryAccountingReconciliationReportV2,
} from "../src/application/history-accounting-report.js";
import {
  canonicalSerialize,
  hashCanonical,
} from "../src/domain/identity/canonical-serialization.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";
import { createHistorySourceFact } from "../src/domain/accounting/history-source-fact.js";
import { resolveHistoryAccountingScope } from "../src/application/history-accounting-scope.js";
import { OPERATOR_MAINNET_TEST_POLICY_VERSION } from "../src/domain/execution/operator-mainnet-test-plan.js";
import { PROVISIONAL_M1_POLICY_VERSION } from "../src/application/policies/provisional-m1.js";
import { HISTORY_READ_SOURCES } from "../src/ports/history-read.js";
import type {
  HistoryConflictSummary,
  HistoryCheckpoint,
  HistoryStoredObservation,
} from "../src/ports/history-store.js";
import type {
  PersistenceScope,
  PreparedLegRunSnapshot,
} from "../src/ports/persistence.js";
import type { UtcTimestamp } from "../src/domain/shared/time.js";
import {
  closingBoundary,
  completeReportInput,
  historyAccountingScope,
  openingBoundary,
  capturedWalletAnchorForStoreTest,
  walletAnchor,
} from "./history-accounting-fixtures.js";

test("report replay is deterministic, period-scoped, and keeps prehistory unknown", () => {
  const input = completeReportInput();
  const first = createHistoryAccountingReport(input);
  const replay = createHistoryAccountingReport(input);
  assert.equal(first.ok, true, first.ok ? "" : first.error.message);
  assert.equal(replay.ok, true, replay.ok ? "" : replay.error.message);
  if (!first.ok || !replay.ok) return;
  assert.equal(first.value.status, "ACCOUNTING_READY");
  assert.equal(first.value.epoch.status, "RECONCILED");
  assert.equal(first.value.preEpochHistory, "UNKNOWN");
  assert.deepEqual(first.value, replay.value);
  assert.equal(first.value.reportId, replay.value.reportId);
  assert.equal(first.value.contentHash, replay.value.contentHash);
  assert.equal(first.value.epoch.currencies[0]?.transactionChange, "0");
  assert.equal(
    first.value.accountUnrealizedPnlUsd.allocation,
    "account-wide-unallocated",
  );
});

test("unqualified v1 report identity and canonical payload bytes stay unchanged", () => {
  const report = createHistoryAccountingReport(completeReportInput());
  assert.equal(report.ok, true, report.ok ? "" : report.error.message);
  if (!report.ok) return;
  const encoded = encodeHistoryAccountingReport(report.value);
  assert.equal(encoded.ok, true, encoded.ok ? "" : encoded.error.message);
  if (!encoded.ok) return;
  assert.equal(
    report.value.reportId,
    "history-accounting-report:d96ea9ac26dbaa65b2c3bc04e1f2f06d2d5a5b41355d8ec5823c8fab5a6b684e",
  );
  assert.equal(
    report.value.contentHash,
    "sha256:4eee0968a4f47fcf9b886d0035a1d75ac94908ff8172187a030317dd1be6a51c",
  );
  assert.equal(
    `sha256:${createHash("sha256").update(encoded.value.canonicalJson, "utf8").digest("hex")}`,
    "sha256:d5601cd62900f0341f537cccde2ae09546d3e63d5bdbd14c90c79a127ebf64b3",
  );
  const decoded = decodeHistoryAccountingReport(encoded.value);
  assert.equal(decoded.ok, true);
  assert.deepEqual(decoded.ok && decoded.value, report.value);
});

test("out-of-epoch coverage does not invalidate a period report but relevant revisions do", () => {
  const baseline = createHistoryAccountingReport(completeReportInput());
  assert.equal(baseline.ok, true, baseline.ok ? "" : baseline.error.message);
  if (!baseline.ok) return;

  const outFrom = Date.parse(closingBoundary) + 60_000;
  const outTo = outFrom + 60_000;
  const filters = {
    category: "linear",
    purpose: "backfill",
    rangeStartMs: outFrom,
    rangeEndMs: outTo,
  };
  const filterHash = hashCanonical(filters);
  assert.equal(filterHash.ok, true);
  if (!filterHash.ok) return;
  const unrelated: HistoryCheckpoint = {
    scope: historyAccountingScope,
    source: "order-history",
    filters,
    window: { fromMs: outFrom, toMs: outTo },
    filterHash: filterHash.value,
    cursor: null,
    status: "traversed",
    rowCount: 0,
    insertedCount: 0,
    duplicateCount: 0,
    conflictCount: 0,
    reasonCode: null,
    updatedAt: closingBoundary,
    revision: 2,
  };
  const afterUnrelated = createHistoryAccountingReport(
    completeReportInput({
      coverage: [...completeReportInput().coverage, unrelated],
    }),
  );
  assert.equal(
    afterUnrelated.ok,
    true,
    afterUnrelated.ok ? "" : afterUnrelated.error.message,
  );
  if (!afterUnrelated.ok) return;
  assert.equal(
    afterUnrelated.value.dependencyHash,
    baseline.value.dependencyHash,
  );
  assert.equal(afterUnrelated.value.reportId, baseline.value.reportId);

  const relevantCoverage = completeReportInput().coverage.map((checkpoint) =>
    checkpoint.source === HISTORY_READ_SOURCES[0]
      ? {
          ...checkpoint,
          revision: checkpoint.revision + 1,
          updatedAt: closingBoundary,
        }
      : checkpoint,
  );
  const afterRelevant = createHistoryAccountingReport(
    completeReportInput({ coverage: relevantCoverage }),
  );
  assert.equal(
    afterRelevant.ok,
    true,
    afterRelevant.ok ? "" : afterRelevant.error.message,
  );
  if (!afterRelevant.ok) return;
  assert.notEqual(
    afterRelevant.value.dependencyHash,
    baseline.value.dependencyHash,
  );
  assert.notEqual(afterRelevant.value.reportId, baseline.value.reportId);
});

test("missing anchors, missing source coverage, and wallet drift cannot claim readiness", () => {
  const input = completeReportInput();
  const missingAnchor = createHistoryAccountingReport({
    ...input,
    opening: { ...input.opening, kind: "closing" },
  });
  assert.equal(missingAnchor.ok, true);
  assert.equal(missingAnchor.ok && missingAnchor.value.status, "NOT_READY");

  const missingCoverage = createHistoryAccountingReport({
    ...input,
    coverage: input.coverage.filter(
      (checkpoint) => checkpoint.source !== "transaction-log",
    ),
  });
  assert.equal(missingCoverage.ok, true);
  assert.equal(missingCoverage.ok && missingCoverage.value.status, "NOT_READY");

  const unsupportedOpening = createHistoryAccountingReport({
    ...input,
    opening: {
      ...input.opening,
      assets: input.opening.assets.map((coin) => ({ ...coin, coin: "BTC" })),
    },
  });
  assert.equal(unsupportedOpening.ok, true);
  assert.equal(
    unsupportedOpening.ok && unsupportedOpening.value.status,
    "NOT_READY",
  );

  const drift = createHistoryAccountingReport({
    ...input,
    closing: {
      ...input.closing,
      assets: input.closing.assets.map((coin) => ({
        ...coin,
        walletBalance:
          coin.walletBalance.state === "known"
            ? {
                ...coin.walletBalance,
                value: coin.walletBalance.value.add(unwrapDecimal("1")),
              }
            : coin.walletBalance,
      })),
    },
  });
  assert.equal(drift.ok, true);
  assert.equal(drift.ok && drift.value.status, "NOT_READY");
});

function unwrapDecimal(value: string): DecimalValue {
  const parsed = DecimalValue.fromString(value);
  if (!parsed.ok) throw new Error("invalid test decimal");
  return parsed.value;
}

test("report epoch boundaries use the verified provider response times", () => {
  const result = createHistoryAccountingReport(completeReportInput());
  assert.equal(result.ok, true);
  assert.equal(
    result.ok && result.value.epoch.epoch.openingBoundary,
    openingBoundary,
  );
  assert.equal(
    result.ok && result.value.epoch.epoch.closingBoundary,
    closingBoundary,
  );
});

test("a persisted incomplete report remains NOT_READY after decoding", () => {
  const input = completeReportInput();
  const report = createHistoryAccountingReport({
    ...input,
    coverage: input.coverage.filter(
      (checkpoint) => checkpoint.source !== "transaction-log",
    ),
  });
  assert.equal(report.ok, true);
  if (!report.ok) return;
  assert.equal(report.value.status, "NOT_READY");

  const encoded = encodeHistoryAccountingReport(report.value);
  assert.equal(encoded.ok, true);
  if (!encoded.ok) return;
  const decoded = decodeHistoryAccountingReport(encoded.value);
  assert.equal(decoded.ok, true, decoded.ok ? "" : decoded.error.message);
  assert.equal(decoded.ok && decoded.value.status, "NOT_READY");
  assert.equal(decoded.ok && decoded.value.preEpochHistory, "UNKNOWN");
});

test("report decoder rejects a correctly rehashed payload with an invalid domain shape", () => {
  const report = createHistoryAccountingReport(completeReportInput());
  assert.equal(report.ok, true);
  if (!report.ok) return;
  const encoded = encodeHistoryAccountingReport(report.value);
  assert.equal(encoded.ok, true);
  if (!encoded.ok) return;

  const { contentHash: _contentHash, ...payload } = report.value;
  void _contentHash;
  const malformedPayload = {
    ...payload,
    preEpochHistory: "KNOWN",
  } as Record<string, unknown>;
  delete malformedPayload.performance;
  delete malformedPayload.transactions;
  const contentHash = hashCanonical(malformedPayload);
  assert.equal(contentHash.ok, true);
  if (!contentHash.ok) return;
  const malformedReport = {
    ...malformedPayload,
    contentHash: contentHash.value,
  };
  const canonicalJson = canonicalSerialize(malformedReport);
  assert.equal(canonicalJson.ok, true);
  if (!canonicalJson.ok) return;

  const decoded = decodeHistoryAccountingReport({
    ...encoded.value,
    contentHash: contentHash.value,
    canonicalJson: canonicalJson.value,
  });
  assert.equal(decoded.ok, false);
});

function scopedInput(
  policyVersion: string = OPERATOR_MAINNET_TEST_POLICY_VERSION,
) {
  const accountingScope = resolveHistoryAccountingScope(policyVersion);
  assert.equal(accountingScope.ok, true);
  if (!accountingScope.ok) throw new Error("test policy scope is unavailable");
  const base = completeReportInput();
  const mnt = {
    ...base.opening.assets[0]!,
    coin: "MNT",
    walletBalance: {
      state: "known" as const,
      value: unwrapDecimal("5"),
      unit: "coin" as const,
    },
  };
  const closingMnt = {
    ...mnt,
    walletBalance: { ...mnt.walletBalance, value: unwrapDecimal("8") },
  };
  return {
    ...base,
    opening: capturedWalletAnchorForStoreTest({
      ...base.opening,
      assets: [...base.opening.assets, mnt],
    }),
    closing: capturedWalletAnchorForStoreTest({
      ...base.closing,
      assets: [...base.closing.assets, closingMnt],
    }),
    accountingScope: accountingScope.value,
  };
}

function transactionObservation(input: {
  readonly id: string;
  readonly currency: string;
  readonly type: string;
  readonly change: string;
  readonly bonusChange: string | null;
  readonly category?: string;
  readonly symbol?: string | null;
  readonly cashFlow?: string | null;
  readonly funding?: string | null;
  readonly fee?: string | null;
  readonly cashBalance?: string;
  readonly orderId?: string | null;
  readonly tradeId?: string | null;
  readonly side?: string | null;
  readonly qty?: string | null;
  readonly tradePrice?: string | null;
  readonly observationId?: string;
}): HistoryStoredObservation {
  const fact = createHistorySourceFact({
    factKind: "transaction",
    source: "transaction-log",
    transactionId: input.id,
    category: input.category ?? "UNIFIED",
    symbol: input.symbol ?? null,
    side: input.side ?? null,
    currency: input.currency,
    type: input.type,
    transSubType: null,
    qty: input.qty ?? null,
    size: null,
    tradePrice: input.tradePrice ?? null,
    cashFlow: input.cashFlow === undefined ? input.change : input.cashFlow,
    funding: input.funding ?? null,
    fee: input.fee ?? null,
    feeRate: null,
    change: input.change,
    bonusChange: input.bonusChange,
    cashBalance: input.cashBalance ?? "8",
    tradeId: input.tradeId ?? null,
    orderId: input.orderId ?? null,
    orderLinkId: null,
    displayType: null,
    extraFees: null,
    providerEventTime: "2026-10-27T10:05:00.000Z",
    providerRevisionTime: null,
    collectedAt: "2026-10-27T10:06:00.000Z",
  });
  assert.equal(fact.ok, true, fact.ok ? "" : fact.error.message);
  if (!fact.ok) throw new Error("technical transaction fixture is invalid");
  return {
    observationId: input.observationId ?? `${input.id}-observation`,
    scope: scopedInput().scope,
    source: "transaction-log",
    eventIdentity: `transaction:${input.id}`,
    contentHash: fact.value.contentHash,
    canonicalHash: fact.value.contentHash,
    providerEventTime: fact.value.providerEventTime,
    providerRevisionTime: null,
    collectedAt: fact.value.collectedAt,
    fact: fact.value,
  };
}

function scopedPreparedSource(
  sourceId: string,
  exchangeOrderId: string,
  haltRevision = 0,
): PreparedLegRunSnapshot {
  const persistenceScope: PersistenceScope = {
    ...historyAccountingScope,
    category: "linear",
    positionMode: "one-way",
  };
  const canonicalHash = hashCanonical({ sourceId, exchangeOrderId });
  assert.equal(canonicalHash.ok, true);
  if (!canonicalHash.ok) throw new Error("lineage fixture hash failed");
  const clientOrderId = `client-${sourceId}`;
  return {
    lineage: {
      sourceId,
      scope: persistenceScope,
      preparedHash: canonicalHash.value,
      legId: `leg-${sourceId}`,
      clientOrderId,
      selectionCanonicalJson: "{}",
      selectionHash: canonicalHash.value,
      createdAt: "2026-10-27T10:00:00.000Z" as UtcTimestamp,
    },
    approvalHashes: [canonicalHash.value],
    createIntent: {
      writeIntentId: `intent-${sourceId}`,
      sourceId,
      operation: "create",
      runId: `run-${sourceId}`,
      leaseEpoch: 1,
      clientOrderId,
      exchangeOrderId,
      canonicalJson: "{}",
      canonicalHash: canonicalHash.value,
      preparedAt: "2026-10-27T10:00:00.000Z" as UtcTimestamp,
    },
    reconciliations: [],
    halt: {
      scope: persistenceScope,
      active: false,
      revision: haltRevision,
      reconciliationRequired: false,
    },
  };
}

function scopedClosedPnlObservation(
  orderId: string,
  observationId: string,
): HistoryStoredObservation {
  const fact = createHistorySourceFact({
    factKind: "closed-pnl",
    source: "closed-pnl",
    category: "linear",
    symbol: "DOGEUSDT",
    orderId,
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
    openFee: "0.01",
    closeFee: "0.01",
    fundingFee: "0",
    fillCount: "1",
    leverage: "1",
    providerEventTime: "2026-10-27T10:05:00.000Z",
    providerRevisionTime: "2026-10-27T10:06:00.000Z",
    collectedAt: "2026-10-27T10:07:00.000Z",
  });
  assert.equal(fact.ok, true, fact.ok ? "" : fact.error.message);
  if (!fact.ok) throw new Error("closed PnL fixture is invalid");
  if (fact.value.factKind !== "closed-pnl")
    throw new Error("closed PnL fixture has the wrong fact kind");
  return {
    observationId,
    scope: historyAccountingScope,
    source: "closed-pnl",
    eventIdentity: `closed-pnl:${orderId}:${fact.value.groupingKey.createdTime}`,
    contentHash: fact.value.contentHash,
    canonicalHash: fact.value.contentHash,
    providerEventTime: fact.value.providerEventTime,
    providerRevisionTime: fact.value.providerRevisionTime,
    collectedAt: fact.value.collectedAt,
    fact: fact.value,
  };
}

function scopedExecutionObservation(
  orderId: string,
  execId: string,
): HistoryStoredObservation {
  const fact = createHistorySourceFact({
    factKind: "execution",
    source: "executions",
    category: "linear",
    symbol: "DOGEUSDT",
    orderId,
    orderLinkId: null,
    execId,
    side: "Sell",
    execType: "Trade",
    execPrice: "0.12",
    execQty: "10",
    execValue: "1.2",
    execFee: "0.01",
    execFeeV2: null,
    feeCurrency: "USDT",
    feeRate: null,
    execPnl: "0.2",
    closedSize: "10",
    isMaker: true,
    seq: "1",
    leavesQty: null,
    markPrice: null,
    indexPrice: null,
    underlyingPrice: null,
    createType: null,
    blockTradeId: null,
    extraFees: null,
    orderPrice: "0.12",
    orderQty: "10",
    providerEventTime: "2026-10-27T10:05:00.000Z",
    providerRevisionTime: null,
    collectedAt: "2026-10-27T10:07:00.000Z",
  });
  assert.equal(fact.ok, true, fact.ok ? "" : fact.error.message);
  if (!fact.ok) throw new Error("execution fixture is invalid");
  return {
    observationId: `execution-${execId}`,
    scope: historyAccountingScope,
    source: "executions",
    eventIdentity: `execution:${execId}`,
    contentHash: fact.value.contentHash,
    canonicalHash: fact.value.contentHash,
    providerEventTime: fact.value.providerEventTime,
    providerRevisionTime: fact.value.providerRevisionTime,
    collectedAt: fact.value.collectedAt,
    fact: fact.value,
  };
}

test("scoped report roundtrips v2, excludes technical balances, and binds policy identity", () => {
  const input = scopedInput();
  const scoped = createHistoryAccountingReport(input);
  assert.equal(scoped.ok, true, scoped.ok ? "" : scoped.error.message);
  if (!scoped.ok) return;
  const scopedReport = scoped.value as HistoryAccountingReconciliationReportV2;
  assert.equal(
    scopedReport.schemaVersion,
    "history-accounting-reconciliation-report/v2",
  );
  assert.equal(scopedReport.status, "ACCOUNTING_READY");
  assert.equal(
    scopedReport.epoch.schemaVersion,
    "history-accounting-epoch-projection/v2",
  );
  assert.deepEqual(scopedReport.dependencies.sourceDependencies, []);
  assert.equal(
    scopedReport.dependencies.anchors.opening.anchorId,
    input.opening.anchorId,
  );
  assert.equal(
    scopedReport.dependencies.anchors.opening.contentHash,
    input.opening.contentHash,
  );
  assert.equal(
    scopedReport.dependencies.anchors.closing.anchorId,
    input.closing.anchorId,
  );
  assert.equal(
    scopedReport.dependencies.anchors.closing.contentHash,
    input.closing.contentHash,
  );
  assert.equal(scopedReport.epoch.currencies.length, 1);
  assert.deepEqual(scopedReport.epoch.exclusions, [
    {
      kind: "anchor-balance",
      currency: "MNT",
      openingBalance: "5",
      closingBalance: "8",
    },
  ]);

  const encoded = encodeHistoryAccountingReport(scopedReport);
  assert.equal(encoded.ok, true, encoded.ok ? "" : encoded.error.message);
  if (!encoded.ok) return;
  const decoded = decodeHistoryAccountingReport(encoded.value);
  assert.equal(decoded.ok, true, decoded.ok ? "" : decoded.error.message);
  assert.deepEqual(decoded.ok && decoded.value, scopedReport);

  const otherPolicy = createHistoryAccountingReport(
    scopedInput(PROVISIONAL_M1_POLICY_VERSION as string),
  );
  assert.equal(
    otherPolicy.ok,
    true,
    otherPolicy.ok ? "" : otherPolicy.error.message,
  );
  if (!otherPolicy.ok) return;
  assert.equal(
    (
      otherPolicy.value as HistoryAccountingReconciliationReportV2
    ).accountingScope.nativeCurrencies.join(","),
    scopedReport.accountingScope.nativeCurrencies.join(","),
  );
  assert.notEqual(
    otherPolicy.value.dependencyHash,
    scopedReport.dependencyHash,
  );
  assert.notEqual(otherPolicy.value.reportId, scopedReport.reportId);

  const legacy = createHistoryAccountingReport(completeReportInput());
  assert.equal(legacy.ok, true);
  assert.equal(
    legacy.ok && legacy.value.schemaVersion,
    "history-accounting-reconciliation-report/v1",
  );
});

test("scoped report preserves the full excluded-anchor count when its sample is bounded", () => {
  const base = scopedInput();
  const template = base.opening.assets[0]!;
  const technicalAssets = Array.from({ length: 128 }, (_, index) => ({
    ...template,
    coin: `TECH${String(index).padStart(3, "0")}`,
  }));
  const input = {
    ...base,
    opening: capturedWalletAnchorForStoreTest({
      ...base.opening,
      assets: [...base.opening.assets, ...technicalAssets],
    }),
    closing: capturedWalletAnchorForStoreTest({
      ...base.closing,
      assets: [...base.closing.assets, ...technicalAssets],
    }),
  };

  const report = createHistoryAccountingReport(input);
  assert.equal(report.ok, true, report.ok ? "" : report.error.message);
  if (!report.ok) return;
  const scopedReport = report.value as HistoryAccountingReconciliationReportV2;
  assert.equal(scopedReport.status, "ACCOUNTING_READY");
  assert.equal(scopedReport.epoch.exclusions.length, 128);
  assert.equal(scopedReport.epoch.exclusionCount, 129);
  assert.equal(scopedReport.epoch.exclusionsTruncated, true);

  const encoded = encodeHistoryAccountingReport(scopedReport);
  assert.equal(encoded.ok, true, encoded.ok ? "" : encoded.error.message);
  if (!encoded.ok) return;
  const decoded = decodeHistoryAccountingReport(encoded.value);
  assert.equal(decoded.ok, true, decoded.ok ? "" : decoded.error.message);
  assert.deepEqual(decoded.ok && decoded.value, scopedReport);
});

test("scoped dependencies ignore technical arrivals and incidental coverage metadata but bind relevant evidence", () => {
  const input = scopedInput();
  const baseline = createHistoryAccountingReport(input);
  assert.equal(baseline.ok, true, baseline.ok ? "" : baseline.error.message);
  if (!baseline.ok) return;

  const technical = transactionObservation({
    id: "mnt-bonus-1",
    currency: "MNT",
    type: "BONUS",
    change: "1",
    bonusChange: "1",
  });
  const afterTechnical = createHistoryAccountingReport({
    ...input,
    observations: [...input.observations, technical],
    coverage: input.coverage.map((checkpoint) => ({
      ...checkpoint,
      rowCount: checkpoint.rowCount + 3,
      insertedCount: checkpoint.insertedCount + 2,
      duplicateCount: checkpoint.duplicateCount + 1,
      revision: checkpoint.revision + 9,
      updatedAt: "2026-10-28T12:00:00.000Z" as typeof closingBoundary,
    })),
  });
  assert.equal(
    afterTechnical.ok,
    true,
    afterTechnical.ok ? "" : afterTechnical.error.message,
  );
  if (!afterTechnical.ok) return;
  assert.equal(
    afterTechnical.value.dependencyHash,
    baseline.value.dependencyHash,
  );
  assert.equal(afterTechnical.value.reportId, baseline.value.reportId);
  const baselineRecord = encodeHistoryAccountingReport(baseline.value);
  const technicalRecord = encodeHistoryAccountingReport(afterTechnical.value);
  assert.equal(baselineRecord.ok, true);
  assert.equal(technicalRecord.ok, true);
  if (!baselineRecord.ok || !technicalRecord.ok) return;
  assert.equal(
    technicalRecord.value.canonicalJson,
    baselineRecord.value.canonicalJson,
  );

  const relevant = transactionObservation({
    id: "usdt-transfer-1",
    currency: "USDT",
    type: "TRANSFER_IN",
    change: "1",
    bonusChange: null,
  });
  const changedEvidence = createHistoryAccountingReport({
    ...input,
    observations: [relevant],
  });
  assert.equal(
    changedEvidence.ok,
    true,
    changedEvidence.ok ? "" : changedEvidence.error.message,
  );
  assert.notEqual(
    changedEvidence.ok && changedEvidence.value.dependencyHash,
    baseline.value.dependencyHash,
  );
});

test("scoped dependencies bind changed USDT costs and conflicting revisions", () => {
  const input = scopedInput();
  const originalFee = transactionObservation({
    id: "usdt-trade-fee",
    observationId: "usdt-trade-fee-original",
    currency: "USDT",
    type: "TRADE",
    category: "linear",
    symbol: "DOGEUSDT",
    orderId: "exchange-order-fee",
    change: "-0.01",
    cashFlow: "0",
    funding: "0",
    fee: "0.01",
    bonusChange: null,
  });
  const changedFee = transactionObservation({
    id: "usdt-trade-fee",
    observationId: "usdt-trade-fee-revised",
    currency: "USDT",
    type: "TRADE",
    category: "linear",
    symbol: "DOGEUSDT",
    orderId: "exchange-order-fee",
    change: "-0.02",
    cashFlow: "0",
    funding: "0",
    fee: "0.02",
    bonusChange: null,
  });
  const original = createHistoryAccountingReport({
    ...input,
    observations: [originalFee],
  });
  assert.equal(original.ok, true, original.ok ? "" : original.error.message);
  if (!original.ok) return;

  const transactionCheckpoint = input.coverage.find(
    ({ source }) => source === "transaction-log",
  );
  assert.ok(transactionCheckpoint);
  if (!transactionCheckpoint) return;
  const conflict: HistoryConflictSummary = {
    conflictId: "usdt-trade-fee-revision",
    source: "transaction-log",
    eventIdentity: originalFee.eventIdentity,
    existingHash: originalFee.contentHash,
    incomingHash: changedFee.contentHash,
    reason: "IMMUTABLE_ID_CONTENT_CHANGED",
    recordedAt: "2026-10-27T10:07:00.000Z" as UtcTimestamp,
    windows: [
      {
        filterHash: transactionCheckpoint.filterHash,
        window: transactionCheckpoint.window,
      },
    ],
  };
  const revisedCoverage = input.coverage.map((checkpoint) =>
    checkpoint.source === "transaction-log"
      ? { ...checkpoint, conflictCount: 1 }
      : checkpoint,
  );
  const revised = createHistoryAccountingReport({
    ...input,
    observations: [originalFee, changedFee],
    conflicts: [conflict],
    coverage: revisedCoverage,
  });
  assert.equal(revised.ok, true, revised.ok ? "" : revised.error.message);
  if (!revised.ok) return;
  assert.equal(revised.value.status, "NOT_READY");
  assert.ok(
    revised.value.epoch.reasonCodes.includes("TRANSACTION_IDENTITY_CONFLICT"),
  );
  assert.notEqual(revised.value.dependencyHash, original.value.dependencyHash);
  assert.notEqual(revised.value.reportId, original.value.reportId);
});

test("independent outside-currency revisions do not change a scoped report identity", () => {
  const input = scopedInput();
  const baseline = createHistoryAccountingReport(input);
  assert.equal(baseline.ok, true, baseline.ok ? "" : baseline.error.message);
  if (!baseline.ok) return;

  const original = transactionObservation({
    id: "mnt-independent-transfer",
    observationId: "mnt-independent-transfer-original",
    currency: "MNT",
    type: "TRANSFER_IN",
    change: "1",
    bonusChange: null,
    cashBalance: "8",
  });
  const revised = transactionObservation({
    id: "mnt-independent-transfer",
    observationId: "mnt-independent-transfer-revised",
    currency: "MNT",
    type: "TRANSFER_IN",
    change: "1",
    bonusChange: null,
    cashBalance: "9",
  });
  const checkpoint = input.coverage.find(
    (candidate) => candidate.source === "transaction-log",
  );
  assert.ok(checkpoint);
  if (!checkpoint) return;
  const conflict: HistoryConflictSummary = {
    conflictId: "mnt-independent-transfer-revision",
    source: "transaction-log",
    eventIdentity: original.eventIdentity,
    existingHash: original.contentHash,
    incomingHash: revised.contentHash,
    reason: "IMMUTABLE_ID_CONTENT_CHANGED",
    recordedAt: "2026-10-27T10:07:00.000Z" as UtcTimestamp,
    windows: [{ filterHash: checkpoint.filterHash, window: checkpoint.window }],
  };
  const revisedReport = createHistoryAccountingReport({
    ...input,
    observations: [original, revised],
    conflicts: [conflict],
    coverage: input.coverage.map((candidate) =>
      candidate.source === "transaction-log"
        ? { ...candidate, conflictCount: 1 }
        : candidate,
    ),
  });
  assert.equal(
    revisedReport.ok,
    true,
    revisedReport.ok ? "" : revisedReport.error.message,
  );
  if (!revisedReport.ok) return;
  assert.equal(revisedReport.value.status, "ACCOUNTING_READY");
  assert.equal(revisedReport.value.reportId, baseline.value.reportId);
  assert.equal(
    revisedReport.value.dependencyHash,
    baseline.value.dependencyHash,
  );
  assert.deepEqual(
    (revisedReport.value as HistoryAccountingReconciliationReportV2).epoch
      .conflictDispositions,
    [],
  );
  const baselineRecord = encodeHistoryAccountingReport(baseline.value);
  const revisedRecord = encodeHistoryAccountingReport(revisedReport.value);
  assert.equal(baselineRecord.ok, true);
  assert.equal(revisedRecord.ok, true);
  if (!baselineRecord.ok || !revisedRecord.ok) return;
  assert.equal(
    revisedRecord.value.canonicalJson,
    baselineRecord.value.canonicalJson,
  );
});

test("scoped dependencies bind owned lineage while preserving two sources and USDT transfers", () => {
  const input = scopedInput();
  const transfer = transactionObservation({
    id: "usdt-transfer-between-anchors",
    currency: "USDT",
    type: "TRANSFER_IN",
    change: "15.25",
    cashFlow: "15.25",
    funding: "0",
    fee: "0",
    bonusChange: null,
  });
  const sourceA = scopedPreparedSource("prepared-source-a", "exchange-order-a");
  const sourceB = scopedPreparedSource("prepared-source-b", "exchange-order-b");
  const closingBalance = walletAnchor("closing", closingBoundary, "115.63");
  const closingMnt = input.closing.assets.find(({ coin }) => coin === "MNT");
  assert.ok(closingMnt);
  if (!closingMnt) return;
  const closingContentHash = hashCanonical({
    anchorId: input.closing.anchorId,
    balance: "115.63",
  });
  assert.equal(closingContentHash.ok, true);
  if (!closingContentHash.ok) return;
  const adjustedClosing = capturedWalletAnchorForStoreTest({
    ...closingBalance,
    anchorId: input.closing.anchorId,
    contentHash: closingContentHash.value,
    recordedAt: input.closing.recordedAt,
    assets: [...closingBalance.assets, closingMnt],
  });
  const observations = [
    transfer,
    transactionObservation({
      id: "trade-usdt-a",
      currency: "USDT",
      type: "TRADE",
      category: "linear",
      symbol: "DOGEUSDT",
      side: "Sell",
      qty: "10",
      tradePrice: "0.12",
      orderId: "exchange-order-a",
      change: "0.19",
      cashFlow: "0.2",
      funding: "0",
      fee: "0.01",
      bonusChange: null,
    }),
    transactionObservation({
      id: "trade-usdt-b",
      currency: "USDT",
      type: "TRADE",
      category: "linear",
      symbol: "DOGEUSDT",
      side: "Sell",
      qty: "10",
      tradePrice: "0.12",
      orderId: "exchange-order-b",
      change: "0.19",
      cashFlow: "0.2",
      funding: "0",
      fee: "0.01",
      bonusChange: null,
    }),
    scopedExecutionObservation("exchange-order-a", "exec-a"),
    scopedExecutionObservation("exchange-order-b", "exec-b"),
    scopedClosedPnlObservation("exchange-order-a", "closed-pnl-a"),
    scopedClosedPnlObservation("exchange-order-b", "closed-pnl-b"),
  ];
  const report = createHistoryAccountingReport({
    ...input,
    closing: adjustedClosing,
    observations,
    preparedSources: [sourceA, sourceB],
  });
  assert.equal(report.ok, true, report.ok ? "" : report.error.message);
  if (!report.ok) return;
  const scopedReport = report.value as HistoryAccountingReconciliationReportV2;
  assert.equal(
    report.value.status,
    "ACCOUNTING_READY",
    report.value.epoch.reasonCodes.join(","),
  );
  assert.equal(report.value.epoch.currencies[0]?.closingBalance, "115.63");
  assert.deepEqual(
    scopedReport.dependencies.lineageDependencies.map((row) => row.sourceId),
    ["prepared-source-a", "prepared-source-b"],
  );
  assert.deepEqual(
    report.value.performance.ownedRunSymbolDays.map(
      (row) => row.source?.sourceId,
    ),
    ["prepared-source-a", "prepared-source-b"],
  );

  const changedSourceA = scopedPreparedSource(
    "prepared-source-a",
    "exchange-order-a",
    1,
  );
  const changedLineage = createHistoryAccountingReport({
    ...input,
    closing: adjustedClosing,
    observations,
    preparedSources: [changedSourceA, sourceB],
  });
  assert.equal(
    changedLineage.ok,
    true,
    changedLineage.ok ? "" : changedLineage.error.message,
  );
  assert.notEqual(
    changedLineage.ok && changedLineage.value.dependencyHash,
    report.value.dependencyHash,
  );
});

test("scoped NOT_READY reports retain v2 coverage semantics and located-conflict failures", () => {
  const input = scopedInput();
  const missingAnchor = createHistoryAccountingReport({
    ...input,
    opening: capturedWalletAnchorForStoreTest({
      ...input.opening,
      kind: "closing",
    }),
  });
  assert.equal(
    missingAnchor.ok,
    true,
    missingAnchor.ok ? "" : missingAnchor.error.message,
  );
  if (!missingAnchor.ok) return;
  assert.equal(missingAnchor.value.status, "NOT_READY");
  const missingAnchorRecord = encodeHistoryAccountingReport(
    missingAnchor.value,
  );
  assert.equal(
    missingAnchorRecord.ok,
    true,
    missingAnchorRecord.ok ? "" : missingAnchorRecord.error.message,
  );
  if (!missingAnchorRecord.ok) return;
  assert.equal(
    decodeHistoryAccountingReport(missingAnchorRecord.value).ok,
    true,
  );

  const [firstCoverage, ...otherCoverage] = input.coverage;
  assert.ok(firstCoverage);
  if (!firstCoverage) return;
  const incomplete = createHistoryAccountingReport({
    ...input,
    coverage: [
      { ...firstCoverage, status: "partial", cursor: "next-page" },
      ...otherCoverage,
    ],
  });
  assert.equal(
    incomplete.ok,
    true,
    incomplete.ok ? "" : incomplete.error.message,
  );
  assert.equal(incomplete.ok && incomplete.value.status, "NOT_READY");

  const unlocatedConflictCount = createHistoryAccountingReport({
    ...input,
    coverage: [{ ...firstCoverage, conflictCount: 1 }, ...otherCoverage],
  });
  assert.equal(
    unlocatedConflictCount.ok,
    true,
    unlocatedConflictCount.ok ? "" : unlocatedConflictCount.error.message,
  );
  if (!unlocatedConflictCount.ok) return;
  assert.equal(unlocatedConflictCount.value.status, "NOT_READY");
  assert.equal(
    (
      unlocatedConflictCount.value as HistoryAccountingReconciliationReportV2
    ).dependencies.coverageWitness.find(
      (witness) => witness.source === firstCoverage.source,
    )?.conflictLocationsValid,
    false,
  );
});

test("scoped report decoder rejects cross-version nesting and modified or forged scope material", () => {
  const report = createHistoryAccountingReport(scopedInput());
  assert.equal(report.ok, true, report.ok ? "" : report.error.message);
  if (!report.ok) return;
  const encoded = encodeHistoryAccountingReport(report.value);
  assert.equal(encoded.ok, true);
  if (!encoded.ok) return;

  const original = JSON.parse(encoded.value.canonicalJson) as Record<
    string,
    unknown
  >;
  const invalidMutations = [
    (value: Record<string, unknown>) => {
      value.epoch = {
        ...(value.epoch as Record<string, unknown>),
        schemaVersion: "history-accounting-epoch-projection/v1",
      };
    },
    (value: Record<string, unknown>) => {
      value.accountingScope = {
        ...(value.accountingScope as Record<string, unknown>),
        scopeHash: `sha256:${"0".repeat(64)}`,
      };
    },
    (value: Record<string, unknown>) => {
      value.schemaVersion = "history-accounting-reconciliation-report/v9";
    },
  ];
  for (const mutate of invalidMutations) {
    const malformed = structuredClone(original);
    mutate(malformed);
    const contentHash = hashCanonical(
      Object.fromEntries(
        Object.entries(malformed).filter(([key]) => key !== "contentHash"),
      ),
    );
    assert.equal(contentHash.ok, true);
    if (!contentHash.ok) return;
    malformed.contentHash = contentHash.value;
    const canonicalJson = canonicalSerialize(malformed);
    assert.equal(canonicalJson.ok, true);
    if (!canonicalJson.ok) return;
    assert.equal(
      decodeHistoryAccountingReport({
        ...encoded.value,
        contentHash: contentHash.value,
        canonicalJson: canonicalJson.value,
      }).ok,
      false,
    );
  }

  // Recompute every public hash after changing the descriptor. Structural
  // self-consistency must not let an unrecognized policy claim code authority.
  const forgedScope = structuredClone(original);
  const originalDescriptor = forgedScope.accountingScope as Record<
    string,
    unknown
  >;
  const forgedDescriptor: Record<string, unknown> = {
    ...originalDescriptor,
    policyIdentity: "forged-policy",
  };
  delete forgedDescriptor.scopeHash;
  const forgedScopeHash = hashCanonical(forgedDescriptor);
  assert.equal(forgedScopeHash.ok, true);
  if (!forgedScopeHash.ok) return;
  forgedDescriptor.scopeHash = forgedScopeHash.value;
  forgedScope.accountingScope = forgedDescriptor;
  forgedScope.accountingScopeHash = forgedScopeHash.value;
  const forgedDependencies = forgedScope.dependencies as Record<
    string,
    unknown
  >;
  forgedDependencies.accountingScope = forgedDescriptor;
  forgedDependencies.accountingScopeHash = forgedScopeHash.value;
  const dependencyHash = hashCanonical(forgedDependencies);
  assert.equal(dependencyHash.ok, true);
  if (!dependencyHash.ok) return;
  forgedScope.dependencyHash = dependencyHash.value;
  const identity = hashCanonical({
    schemaVersion: forgedScope.schemaVersion,
    scope: forgedScope.scope,
    accountingScope: forgedScope.accountingScope,
    dependencyHash: forgedScope.dependencyHash,
  });
  assert.equal(identity.ok, true);
  if (!identity.ok) return;
  forgedScope.reportId = `history-accounting-report:${identity.value.slice(7)}`;
  delete forgedScope.contentHash;
  const contentHash = hashCanonical(forgedScope);
  assert.equal(contentHash.ok, true);
  if (!contentHash.ok) return;
  forgedScope.contentHash = contentHash.value;
  const forgedCanonical = canonicalSerialize(forgedScope);
  assert.equal(forgedCanonical.ok, true);
  if (!forgedCanonical.ok) return;
  assert.equal(
    decodeHistoryAccountingReport({
      ...encoded.value,
      reportId: forgedScope.reportId as string,
      dependencyHash: dependencyHash.value,
      contentHash: contentHash.value,
      canonicalJson: forgedCanonical.value,
    }).ok,
    false,
  );
});
