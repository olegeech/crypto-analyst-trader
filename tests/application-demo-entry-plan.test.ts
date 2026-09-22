import assert from "node:assert/strict";
import test from "node:test";

import { fixedClock } from "../src/domain/shared/time.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";
import { buildDemoEntryPlan } from "../src/application/demo-entry-plan.js";
import { createDemoEntryInput } from "../src/application/demo-entry-input.js";
import type { ExchangeReadState } from "../src/ports/exchange-execution.js";
import { createAdapterCapabilityObservation } from "../src/domain/capabilities/capability.js";
import { createEvidenceRef } from "../src/domain/evidence/evidence-ref.js";
import {
  createAccountSnapshot,
  createMarketSnapshot,
} from "../src/domain/market/snapshots.js";
import { createExchangeOrder } from "../src/domain/execution/exchange-order.js";

function unwrap<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | {
        readonly ok: false;
        readonly error: { readonly code: string; readonly message: string };
      },
): T {
  if (!result.ok)
    throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function state(): ExchangeReadState {
  const clock = unwrap(fixedClock("2026-09-22T10:00:00.000Z"));
  const scope = {
    exchange: "bybit",
    environment: "demo",
    category: "linear",
    positionMode: "one-way" as const,
  };
  const evidence = unwrap(
    createEvidenceRef({
      kind: "market-snapshot",
      schemaVersion: "fixture/v1",
      producer: "fixture",
      sourceId: "fixture-market",
      asOf: clock.now(),
      validForMs: 60_000,
      contentHash: `sha256:${"1".repeat(64)}`,
    }),
  );
  const accountEvidence = unwrap(
    createEvidenceRef({
      kind: "account-snapshot",
      schemaVersion: "fixture/v1",
      producer: "fixture",
      sourceId: "fixture-account",
      asOf: clock.now(),
      validForMs: 60_000,
      contentHash: `sha256:${"2".repeat(64)}`,
    }),
  );
  const market = unwrap(
    createMarketSnapshot({
      snapshotId: "fixture-market",
      instrument: "DOGEUSDT",
      scope,
      asOf: clock.now(),
      bid: "0.0999",
      ask: "0.1",
      last: "0.1",
      constraints: {
        instrument: "DOGEUSDT",
        version: "fixture-constraints",
        priceTickSize: "0.0001",
        quantityStep: "1",
        minQuantity: "1",
        minNotional: "5",
      },
      evidence: [evidence],
    }),
  );
  const account = unwrap(
    createAccountSnapshot({
      snapshotId: "fixture-account",
      accountScope: "demo:account",
      scope,
      asOf: clock.now(),
      availableBalance: "1000",
      positions: [{ instrument: "DOGEUSDT", side: "flat", quantity: "0" }],
      ownedOrders: [],
      evidence: [accountEvidence],
    }),
  );
  const capabilities = [
    "order-create",
    "attached-protection",
    "reconciliation-reads",
    "set-leverage",
  ].map((capability) =>
    unwrap(
      createAdapterCapabilityObservation({
        capability,
        status: "supported",
        observedAt: clock.now(),
        source: "fixture",
        evidence: unwrap(
          createEvidenceRef({
            kind: "capability-probe",
            schemaVersion: "fixture/v1",
            producer: "fixture",
            sourceId: `fixture-${capability}`,
            asOf: clock.now(),
            validForMs: 60_000,
            contentHash: `sha256:${"3".repeat(64)}`,
          }),
        ),
        scope,
      }),
    ),
  );
  return {
    serverTime: clock.now(),
    market,
    account,
    openOrders: [],
    accountReadiness: { status: "ready" },
    leverage: {
      buy: unwrap(DecimalValue.fromString("1")),
      sell: unwrap(DecimalValue.fromString("1")),
      effective: unwrap(DecimalValue.fromString("1")),
    },
    accountMetadata: {
      accountId: "account",
      userId: "account",
      apiKey: {
        readOnly: false,
        contractTrade: { order: true, position: true },
        wallet: { withdraw: false, transfer: false },
        ips: [],
        ipBinding: "unbound",
        warningCodes: ["API_KEY_IP_UNBOUND"],
      },
    },
    capabilities,
  };
}

test("plan uses one normalized TP-protected Limit + GTC entry and derives identity after hash", () => {
  const clock = unwrap(fixedClock("2026-09-22T10:00:00.000Z"));
  const input = unwrap(
    createDemoEntryInput({
      symbol: "DOGEUSDT",
      side: "buy",
      notional: "10",
      takeProfitPercent: "3",
    }),
  );
  const result = buildDemoEntryPlan(input, state(), clock);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.orderType, "Limit");
  assert.equal(result.value.timeInForce, "GTC");
  assert.equal(
    result.value.intent.protection?.takeProfit?.compare(
      result.value.intent.price,
    ),
    1,
  );
  assert.ok(result.value.clientOrderId.startsWith("demo-"));
  assert.equal(
    result.value.plan.material.desiredCurrentDiff.timeInForce,
    "GTC",
  );
});

test("dirty baseline blocks before plan creation", () => {
  const clock = unwrap(fixedClock("2026-09-22T10:00:00.000Z"));
  const input = unwrap(
    createDemoEntryInput({
      symbol: "DOGEUSDT",
      side: "sell",
      notional: "10",
      takeProfitPrice: "0.09",
    }),
  );
  const dirty = {
    ...state(),
    openOrders: [
      unwrap(
        createExchangeOrder({
          exchangeOrderId: "foreign",
          clientOrderId: "foreign",
          instrument: "DOGEUSDT",
          side: "sell",
          requestedQuantity: "100",
          filledQuantity: "0",
          status: "open",
          observedAt: clock.now(),
          source: "fixture",
        }),
      ),
    ],
  };
  const result = buildDemoEntryPlan(input, dirty, clock);
  assert.equal(result.ok, false);
});
