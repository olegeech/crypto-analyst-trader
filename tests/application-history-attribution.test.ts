import assert from "node:assert/strict";
import test from "node:test";

import { attributeHistoryObservations } from "../src/application/history-attribution.js";
import { createHistorySourceFact } from "../src/domain/accounting/history-source-fact.js";
import {
  createOperatorMainnetQuote,
  createOperatorMainnetTestApproval,
  createOperatorMainnetTestPlan,
  deriveOperatorMainnetTestSourceId,
} from "../src/domain/execution/operator-mainnet-test-plan.js";
import { createInstrumentConstraints } from "../src/domain/market/instrument-constraints.js";
import type { PlanHash } from "../src/domain/identity/canonical-serialization.js";
import { hashCanonical } from "../src/domain/identity/canonical-serialization.js";
import type { Result } from "../src/domain/shared/result.js";
import type { UtcTimestamp } from "../src/domain/shared/time.js";
import type { HistorySourceFact } from "../src/domain/accounting/history-source-fact.js";
import type { HistoryStoredObservation } from "../src/ports/history-store.js";
import type { OperatorMainnetTestSnapshot } from "../src/ports/operator-mainnet-test-persistence.js";
import type {
  PreparedLegRunSnapshot,
  PersistenceScope,
} from "../src/ports/persistence.js";

const ACCOUNT = `sha256:${"a".repeat(64)}`;
const NOW = "2026-10-27T12:00:00.000Z" as UtcTimestamp;
const storeScope = {
  exchange: "bybit",
  environment: "mainnet" as const,
  accountId: ACCOUNT,
};
const persistenceScope: PersistenceScope = {
  ...storeScope,
  category: "linear",
  positionMode: "one-way",
};

function unwrap<T>(result: Result<T>): T {
  if (!result.ok)
    throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function hash(value: unknown): PlanHash {
  return unwrap(hashCanonical(value));
}

function operatorSource(): OperatorMainnetTestSnapshot {
  const quoteAt = "2026-10-27T11:59:59.000Z" as UtcTimestamp;
  const quote = unwrap(
    createOperatorMainnetQuote({
      symbol: "DOGEUSDT",
      exchange: "bybit",
      environment: "mainnet",
      category: "linear",
      origin: "https://api.bybit.com",
      observedAt: quoteAt,
      collectionStartedAt: "2026-10-27T11:59:58.900Z",
      collectionCompletedAt: "2026-10-27T11:59:59.100Z",
      bid: "0.0769",
      ask: "0.0770",
      last: "0.0769",
    }),
  );
  const constraints = unwrap(
    createInstrumentConstraints({
      instrument: "DOGEUSDT",
      version: "bybit-linear-instrument/v1",
      priceTickSize: "0.00001",
      quantityStep: "1",
      minQuantity: "1",
      minNotional: "5",
      minPrice: "0.00001",
      maxPrice: "1000",
      maxLimitQuantity: "1000000",
    }),
  );
  const plan = unwrap(
    createOperatorMainnetTestPlan({
      accountIdentityHash: ACCOUNT,
      symbol: "DOGEUSDT",
      nonce: "history-attribution-test",
      allocation: "10",
      grossNotionalCap: "8",
      maxDeviationBps: "10",
      quote,
      warningCodes: [],
      constraints,
      preparedAt: NOW,
    }),
  );
  const approval = unwrap(
    createOperatorMainnetTestApproval({
      plan,
      planHash: plan.contentHash,
      actor: "fixture-operator",
      consent: true,
      approvedAt: NOW,
    }),
  );
  const sourceId = unwrap(deriveOperatorMainnetTestSourceId(plan.contentHash));
  return {
    source: {
      sourceId,
      scope: persistenceScope,
      planHash: plan.contentHash,
      planArtifactId: `operator-mainnet-test:${plan.contentHash}`,
      approvalHash: approval.contentHash,
      approvalArtifactId: `operator-mainnet-test-approval:${approval.contentHash}`,
      clientOrderId: plan.clientOrderId,
      payloadJson: "{}",
      payloadHash: hash({ payload: "fixture" }),
      createdAt: NOW,
    },
    plan,
    approval,
    intent: {
      writeIntentId: "intent-entry-1",
      sourceId,
      operation: "CREATE",
      runId: "run-entry-1",
      canonicalJson: "{}",
      canonicalHash: hash({ intent: "fixture" }),
      preparedAt: NOW,
    },
    attempt: {
      attemptId: "attempt-entry-1",
      writeIntentId: "intent-entry-1",
      outcome: "accepted",
      exchangeOrderId: "exchange-entry-1",
      canonicalJson: "{}",
      canonicalHash: hash({ attempt: "fixture" }),
      recordedAt: NOW,
    },
    reconciliations: [],
    manualActions: [],
    halt: {
      scope: persistenceScope,
      active: false,
      revision: 0,
      reconciliationRequired: false,
    },
  };
}

function preparedSource(): PreparedLegRunSnapshot {
  const sourceId = "prepared-leg:fixture-1";
  const clientOrderId = "m1-fixture-client-order-1";
  const canonicalHash = hash({ prepared: "fixture" });
  return {
    lineage: {
      sourceId,
      scope: persistenceScope,
      preparedHash: canonicalHash,
      legId: "leg-1",
      clientOrderId,
      selectionCanonicalJson: "{}",
      selectionHash: canonicalHash,
      createdAt: NOW,
    },
    approvalHashes: [canonicalHash],
    createIntent: {
      writeIntentId: "prepared-intent-1",
      sourceId,
      operation: "create",
      runId: "prepared-run-1",
      leaseEpoch: 1,
      clientOrderId,
      exchangeOrderId: "prepared-entry-exchange-1",
      canonicalJson: "{}",
      canonicalHash,
      preparedAt: NOW,
    },
    reconciliations: [],
    halt: {
      scope: persistenceScope,
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
    scope: storeScope,
    source: fact.source,
    eventIdentity:
      fact.factKind === "order" ||
      fact.factKind === "execution" ||
      fact.factKind === "closed-pnl"
        ? fact.orderId
        : fact.transactionId,
    contentHash: fact.contentHash,
    canonicalHash: fact.contentHash,
    providerEventTime: fact.providerEventTime,
    providerRevisionTime: fact.providerRevisionTime,
    collectedAt: fact.collectedAt,
    fact,
  };
}

function orderFact(input: {
  orderId: string;
  orderLinkId?: string | null;
  parentOrderLinkId?: string | null;
}): HistorySourceFact {
  return unwrap(
    createHistorySourceFact({
      factKind: "order",
      source: "order-history",
      category: "linear",
      symbol: "DOGEUSDT",
      orderId: input.orderId,
      orderLinkId: input.orderLinkId ?? null,
      parentOrderLinkId: input.parentOrderLinkId ?? null,
      side: "Buy",
      orderType: "Limit",
      orderStatus: "Filled",
      timeInForce: "GTC",
      qty: "10",
      price: "0.0769",
      avgPrice: "0.0769",
      cumExecQty: "10",
      cumExecValue: "0.769",
      cumExecFee: null,
      feeDetails: [],
      leavesQty: "0",
      leavesValue: "0",
      createType: null,
      cancelType: null,
      rejectReason: null,
      tpslMode: null,
      tpTriggerBy: null,
      slTriggerBy: null,
      triggerBy: null,
      triggerPrice: null,
      takeProfit: null,
      stopLoss: null,
      stopOrderType: null,
      marketUnit: null,
      isLeverage: null,
      blockTradeId: null,
      reduceOnly: false,
      closeOnTrigger: false,
      positionIdx: "0",
      providerEventTime: "2026-10-27T11:00:00.000Z",
      providerRevisionTime: null,
      collectedAt: NOW,
    }),
  );
}

function executionFact(input: {
  orderId: string;
  execId: string;
  orderLinkId?: string | null;
}): HistorySourceFact {
  return unwrap(
    createHistorySourceFact({
      factKind: "execution",
      source: "executions",
      category: "linear",
      symbol: "DOGEUSDT",
      orderId: input.orderId,
      orderLinkId: input.orderLinkId ?? null,
      execId: input.execId,
      side: "Buy",
      execType: "Trade",
      execPrice: "0.0769",
      execQty: "10",
      execValue: "0.769",
      execFee: "-0.001",
      execFeeV2: null,
      feeCurrency: "USDT",
      feeRate: null,
      execPnl: null,
      closedSize: null,
      isMaker: true,
      seq: "1",
      leavesQty: null,
      markPrice: null,
      indexPrice: null,
      underlyingPrice: null,
      createType: null,
      blockTradeId: null,
      extraFees: null,
      orderPrice: null,
      orderQty: null,
      providerEventTime: "2026-10-27T11:00:00.000Z",
      providerRevisionTime: null,
      collectedAt: NOW,
    }),
  );
}

function transactionFact(): HistorySourceFact {
  return unwrap(
    createHistorySourceFact({
      factKind: "transaction",
      source: "transaction-log",
      transactionId: "transfer-unrelated-1",
      category: "UNIFIED",
      symbol: null,
      side: null,
      currency: "USDT",
      type: "TRANSFER_IN",
      transSubType: null,
      qty: null,
      size: null,
      tradePrice: null,
      cashFlow: "15.25",
      funding: null,
      fee: null,
      feeRate: null,
      change: "15.25",
      bonusChange: null,
      cashBalance: "100.25",
      tradeId: null,
      orderId: null,
      orderLinkId: null,
      displayType: null,
      extraFees: null,
      providerEventTime: "2026-10-27T11:00:00.000Z",
      providerRevisionTime: null,
      collectedAt: NOW,
    }),
  );
}

test("#31 entry, attached TP and fills link through exact IDs when child orderLinkId is empty", () => {
  const source = operatorSource();
  const entry = stored(
    orderFact({
      orderId: "exchange-entry-1",
      orderLinkId: source.source.clientOrderId,
    }),
    "entry-order",
  );
  const child = stored(
    orderFact({
      orderId: "exchange-tp-1",
      parentOrderLinkId: source.source.clientOrderId,
    }),
    "tp-order",
  );
  const entryFill = stored(
    executionFact({
      orderId: "exchange-entry-1",
      execId: "entry-exec-1",
      orderLinkId: source.source.clientOrderId,
    }),
    "entry-fill",
  );
  const childFill = stored(
    executionFact({ orderId: "exchange-tp-1", execId: "tp-exec-1" }),
    "tp-fill",
  );

  const projection = unwrap(
    attributeHistoryObservations({
      observations: [entry, child, entryFill, childFill],
      operatorSources: [source],
      preparedSources: [],
    }),
  );
  assert.deepEqual(
    projection.observations.map((row) => row.ownership.status),
    ["matched", "matched", "matched", "matched"],
  );
  assert.equal(child.fact.factKind, "order");
  if (child.fact.factKind === "order")
    assert.equal(child.fact.orderLinkId, null);
  const attributedChildFill = projection.observations.find(
    (row) => row.observation.observationId === "tp-fill",
  );
  assert.equal(attributedChildFill?.ownership.status, "matched");
  assert.ok(
    attributedChildFill?.ownership.evidence.some(
      (row) => row.observationId === "tp-order",
    ),
  );
});

test("foreign activity, ambiguous parent linkage and unrelated transfers are not silently owned", () => {
  const source = operatorSource();
  const foreign = stored(
    orderFact({ orderId: "foreign-order", orderLinkId: "manual-client" }),
    "foreign",
  );
  const child = stored(
    orderFact({
      orderId: "ambiguous-tp",
      parentOrderLinkId: source.source.clientOrderId,
    }),
    "ambiguous-child",
  );
  const transfer = stored(transactionFact(), "transfer");
  const duplicateId = "operator-mainnet-test:second";
  const duplicateSource = {
    ...source,
    source: { ...source.source, sourceId: duplicateId },
    intent: { ...source.intent, sourceId: duplicateId },
  };
  const projection = unwrap(
    attributeHistoryObservations({
      observations: [foreign, child, transfer],
      operatorSources: [source, duplicateSource],
      preparedSources: [],
    }),
  );
  assert.equal(projection.observations[0]?.ownership.status, "unmatched");
  assert.equal(projection.observations[1]?.ownership.status, "ambiguous");
  assert.equal(projection.observations[2]?.ownership.status, "unmatched");
});

test("ownership is recomputed when typed prepared-source lineage becomes available", () => {
  const prepared = preparedSource();
  const fact = stored(
    orderFact({
      orderId: "prepared-entry-exchange-1",
      orderLinkId: prepared.lineage.clientOrderId,
    }),
    "prepared-entry",
  );
  const before = unwrap(
    attributeHistoryObservations({
      observations: [fact],
      operatorSources: [],
      preparedSources: [],
    }),
  );
  const after = unwrap(
    attributeHistoryObservations({
      observations: [fact],
      operatorSources: [],
      preparedSources: [prepared],
    }),
  );
  assert.equal(before.observations[0]?.ownership.status, "unmatched");
  assert.equal(after.observations[0]?.ownership.status, "matched");
  assert.equal(
    after.observations[0]?.ownership.source?.sourceId,
    prepared.lineage.sourceId,
  );
});

test("a matching client ID in another account scope stays unowned", () => {
  const source = operatorSource();
  const foreignAccountFact = {
    ...stored(
      orderFact({
        orderId: "exchange-entry-1",
        orderLinkId: source.source.clientOrderId,
      }),
      "foreign-account-order",
    ),
    scope: { ...storeScope, accountId: `sha256:${"c".repeat(64)}` },
  };
  const projection = unwrap(
    attributeHistoryObservations({
      observations: [foreignAccountFact],
      operatorSources: [source],
      preparedSources: [],
    }),
  );
  assert.equal(projection.observations[0]?.ownership.status, "unmatched");
});

test("mixed account observations are rejected before cross-account order linking", () => {
  const source = operatorSource();
  const localOrder = stored(
    orderFact({
      orderId: "shared-exchange-order-id",
      orderLinkId: source.source.clientOrderId,
    }),
    "local-order",
  );
  const foreignOrder = {
    ...stored(
      orderFact({ orderId: "shared-exchange-order-id" }),
      "foreign-order",
    ),
    scope: { ...storeScope, accountId: `sha256:${"c".repeat(64)}` },
  };
  const projection = attributeHistoryObservations({
    observations: [localOrder, foreignOrder],
    operatorSources: [source],
    preparedSources: [],
  });

  assert.equal(projection.ok, false);
});

test("money remains source-separated with exact signs and missing currency stays incomplete", () => {
  const source = operatorSource();
  const fee = stored(
    executionFact({
      orderId: "exchange-entry-1",
      execId: "fee-exec",
      orderLinkId: source.source.clientOrderId,
    }),
    "fee-fill",
  );
  const projection = unwrap(
    attributeHistoryObservations({
      observations: [fee],
      operatorSources: [source],
      preparedSources: [],
    }),
  );
  const row = projection.observations[0]!;
  assert.equal(row.moneyComponents[0]?.amount, "-0.001");
  assert.equal(row.moneyComponents[0]?.currency, "USDT");
  assert.equal(row.moneyComponents[0]?.provenance.observationId, "fee-fill");
  assert.equal("ledgerPostings" in row, false);
  assert.equal("accountingReady" in projection, false);
});
