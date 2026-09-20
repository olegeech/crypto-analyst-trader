import assert from "node:assert/strict";
import test from "node:test";

import {
  createAccountSnapshot,
  createMarketSnapshot,
} from "../src/domain/market/snapshots.js";

const evidence = {
  kind: "market-snapshot",
  schemaVersion: "market-snapshot/v1",
  producer: "fixture",
  sourceId: "run-1",
  asOf: "2026-09-19T10:00:00Z",
  validForMs: 60_000,
  contentHash: `sha256:${"c".repeat(64)}`,
};

const constraints = {
  instrument: "DOGEUSDT",
  priceTickSize: "0.0001",
  quantityStep: "1",
  minQuantity: "1",
  minNotional: "5",
};

test("market and account snapshots validate nested exact values", () => {
  const market = createMarketSnapshot({
    snapshotId: "market-1",
    instrument: "DOGEUSDT",
    scope: {
      exchange: "bybit",
      environment: "demo",
      category: "linear",
      positionMode: "one-way",
    },
    asOf: "2026-09-19T10:00:00Z",
    bid: "0.0887",
    ask: "0.0888",
    last: "0.08875",
    constraints,
    evidence: [evidence],
    futureExchangeField: { additive: true },
  });
  assert.equal(market.ok, true);
  if (!market.ok) return;
  assert.equal(market.value.bid.toString(), "0.0887");
  assert.equal(market.value.constraints.quantityStep.toString(), "1");

  const account = createAccountSnapshot({
    snapshotId: "account-1",
    accountScope: "demo:1c58c10f6d80",
    scope: {
      exchange: "bybit",
      environment: "demo",
      category: "linear",
      positionMode: "one-way",
    },
    asOf: "2026-09-19T10:00:00Z",
    availableBalance: "1000.00",
    positions: [
      {
        instrument: "DOGEUSDT",
        side: "flat",
        quantity: "0",
      },
    ],
    ownedOrders: [],
    evidence: [evidence],
  });
  assert.equal(account.ok, true);
  if (account.ok)
    assert.equal(account.value.positions[0]?.quantity.toString(), "0");
});

test("snapshot boundary rejects malformed and unsafe nested input", () => {
  const result = createMarketSnapshot({
    snapshotId: "market-1",
    instrument: "DOGEUSDT",
    scope: {
      exchange: "bybit",
      environment: "demo",
      category: "linear",
      positionMode: "one-way",
    },
    asOf: "2026-09-19T10:00:00Z",
    bid: 0.0887,
    ask: "0.0888",
    last: "0.08875",
    constraints,
    evidence: [evidence],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "INVALID_DECIMAL");
});

test("instrument constraint versions accept the canonical version format", () => {
  const result = createMarketSnapshot({
    snapshotId: "market-versioned",
    instrument: "DOGEUSDT",
    scope: {
      exchange: "bybit",
      environment: "demo",
      category: "linear",
      positionMode: "one-way",
    },
    asOf: "2026-09-19T10:00:00Z",
    bid: "0.0887",
    ask: "0.0888",
    last: "0.08875",
    constraints: { ...constraints, version: "instrument-constraints/v2" },
    evidence: [evidence],
  });
  assert.equal(result.ok, true);
  if (result.ok)
    assert.equal(result.value.constraints.version, "instrument-constraints/v2");
});

test("snapshots reject evidence stamped after the snapshot", () => {
  const snapshot = createMarketSnapshot({
    snapshotId: "market-future-evidence",
    instrument: "DOGEUSDT",
    scope: {
      exchange: "bybit",
      environment: "demo",
      category: "linear",
      positionMode: "one-way",
    },
    asOf: "2026-09-19T10:00:00Z",
    bid: "0.0887",
    ask: "0.0888",
    last: "0.08875",
    constraints,
    evidence: [
      {
        ...evidence,
        sourceId: "future",
        asOf: "2026-09-19T10:00:01Z",
      },
    ],
  });
  assert.equal(snapshot.ok, false);
  if (!snapshot.ok) assert.equal(snapshot.error.code, "INVALID_VALUE");

  const account = createAccountSnapshot({
    snapshotId: "account-future-evidence",
    accountScope: "demo:1c58c10f6d80",
    scope: {
      exchange: "bybit",
      environment: "demo",
      category: "linear",
      positionMode: "one-way",
    },
    asOf: "2026-09-19T10:00:00Z",
    availableBalance: "1000",
    positions: [],
    ownedOrders: [],
    evidence: [
      {
        ...evidence,
        kind: "account-snapshot",
        sourceId: "future-account",
        asOf: "2026-09-19T10:00:01Z",
      },
    ],
  });
  assert.equal(account.ok, false);
  if (!account.ok) assert.equal(account.error.code, "INVALID_VALUE");
});
