import assert from "node:assert/strict";
import test from "node:test";

import {
  createHistoryAccountingReport,
  decodeHistoryAccountingReport,
  encodeHistoryAccountingReport,
} from "../src/application/history-accounting-report.js";
import {
  canonicalSerialize,
  hashCanonical,
} from "../src/domain/identity/canonical-serialization.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";
import { HISTORY_READ_SOURCES } from "../src/ports/history-read.js";
import type { HistoryCheckpoint } from "../src/ports/history-store.js";
import {
  closingBoundary,
  completeReportInput,
  historyAccountingScope,
  openingBoundary,
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
