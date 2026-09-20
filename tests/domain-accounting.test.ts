import assert from "node:assert/strict";
import test from "node:test";

import { createFee } from "../src/domain/accounting/fee.js";
import { createFill } from "../src/domain/accounting/fill.js";
import { createFunding } from "../src/domain/accounting/funding.js";
import { createLedgerEntry } from "../src/domain/accounting/ledger-entry.js";

test("fills, fees and funding preserve exact values and source identity", () => {
  const fill = createFill({
    fillId: "fill-1",
    attemptId: "attempt-1",
    exchangeOrderId: "exchange-1",
    instrument: "DOGEUSDT",
    side: "buy",
    quantity: "57",
    price: "0.0887",
    executedAt: "2026-09-19T10:00:01Z",
    source: "trade-history",
  });
  assert.equal(fill.ok, true);
  if (fill.ok) {
    assert.equal(fill.value.quantity.toString(), "57");
    assert.equal(fill.value.price.toString(), "0.0887");
  }
  const fee = createFee({
    feeId: "fee-1",
    amount: "0.001",
    currency: "USDT",
    kind: "trading",
    chargedAt: "2026-09-19T10:00:01Z",
    source: "trade-history",
  });
  assert.equal(fee.ok, true);
  const funding = createFunding({
    fundingId: "funding-1",
    amount: "-0.02",
    currency: "USDT",
    occurredAt: "2026-09-19T10:00:01Z",
    source: "transaction-history",
  });
  assert.equal(funding.ok, true);
  if (funding.ok) assert.equal(funding.value.amount.toString(), "-0.02");
});

test("accounting contracts reject invalid amounts and preserve signed ledger events", () => {
  const invalidFill = createFill({
    fillId: "fill-zero",
    attemptId: "attempt-1",
    exchangeOrderId: "exchange-1",
    instrument: "DOGEUSDT",
    side: "buy",
    quantity: "0",
    price: "0.0887",
    executedAt: "2026-09-19T10:00:01Z",
    source: "trade-history",
  });
  assert.equal(invalidFill.ok, false);
  if (!invalidFill.ok)
    assert.equal(invalidFill.error.code, "INVALID_ACCOUNTING");

  const entry = createLedgerEntry({
    entryId: "ledger-1",
    kind: "fee",
    amount: "-0.001",
    currency: "USDT",
    occurredAt: "2026-09-19T10:00:01Z",
    source: "fee",
    referenceId: "fee-1",
  });
  assert.equal(entry.ok, true);
  const invalidKind = createLedgerEntry({
    entryId: "ledger-2",
    amount: "0.001",
    currency: "USDT",
    occurredAt: "2026-09-19T10:00:01Z",
    source: "fee",
    referenceId: "fee-1",
    kind: "unknown",
  });
  assert.equal(invalidKind.ok, false);
  if (!invalidKind.ok)
    assert.equal(invalidKind.error.code, "INVALID_ACCOUNTING");
});
