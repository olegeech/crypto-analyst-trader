import assert from "node:assert/strict";
import test from "node:test";
import {
  mapOrderRecords,
  mapOrderObservation,
} from "../src/adapters/bybit-v5/read-mappers.js";

import {
  createOperatorMainnetQuote,
  createOperatorMainnetTestApproval,
  createOperatorMainnetTestPlan,
  deriveOperatorMainnetTestSourceId,
  type OperatorMainnetTestPlan,
} from "../src/domain/execution/operator-mainnet-test-plan.js";
import { createInstrumentConstraints } from "../src/domain/market/instrument-constraints.js";
import type { PlanHash } from "../src/domain/identity/canonical-serialization.js";
import {
  createExchangeOrder,
  type ExchangeOrderObservation,
} from "../src/domain/execution/exchange-order.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";
import { domainError } from "../src/domain/shared/errors.js";
import { fail, ok, type Result } from "../src/domain/shared/result.js";
import type { UtcTimestamp } from "../src/domain/shared/time.js";
import { requireHash } from "../src/domain/shared/validation.js";
import type {
  OperatorMainnetTestSnapshot,
  OperatorMainnetTestPersistencePort,
} from "../src/ports/operator-mainnet-test-persistence.js";
import type {
  PersistencePort,
  PersistenceScope,
} from "../src/ports/persistence.js";
import {
  runMainnetOperatorTestStatus,
  type MainnetOperatorTestStatusObservation,
} from "../src/application/mainnet-operator-test-status.js";

const NOW = "2026-10-23T12:00:00.000Z" as UtcTimestamp;
const OBSERVED = "2026-10-23T12:00:01.000Z" as UtcTimestamp;
const accountId = `sha256:${"a".repeat(64)}`;
const scope: PersistenceScope = {
  exchange: "bybit",
  environment: "mainnet",
  accountId,
  category: "linear",
  positionMode: "one-way",
};

function unwrap<T>(result: Result<T>): T {
  if (!result.ok)
    throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function decimal(value: string): DecimalValue {
  return unwrap(DecimalValue.fromString(value));
}

function planFixture(): OperatorMainnetTestPlan {
  const quote = unwrap(
    createOperatorMainnetQuote({
      exchange: "bybit",
      environment: "mainnet",
      category: "linear",
      origin: "https://api.bybit.com",
      symbol: "BTCUSDT",
      observedAt: "2026-10-23T11:59:59.500Z",
      collectionStartedAt: "2026-10-23T11:59:59.400Z",
      collectionCompletedAt: "2026-10-23T11:59:59.600Z",
      bid: "100",
      ask: "100.1",
      last: "100",
    }),
  );
  const constraints = unwrap(
    createInstrumentConstraints({
      instrument: "BTCUSDT",
      version: "bybit-linear-instrument/v1",
      priceTickSize: "0.1",
      quantityStep: "0.001",
      minQuantity: "0.001",
      minNotional: "5",
      minPrice: "0.1",
      maxPrice: "1000000",
      maxLimitQuantity: "100000",
    }),
  );
  return unwrap(
    createOperatorMainnetTestPlan({
      accountIdentityHash: accountId,
      symbol: "BTCUSDT",
      nonce: "status-fixture",
      allocation: "10",
      grossNotionalCap: "8",
      maxDeviationBps: "10",
      quote,
      warningCodes: [],
      constraints,
      preparedAt: NOW,
    }),
  );
}

const plan = planFixture();
const sourceId = unwrap(deriveOperatorMainnetTestSourceId(plan.contentHash));
const approved = unwrap(
  createOperatorMainnetTestApproval({
    plan,
    planHash: plan.contentHash,
    actor: "test-operator",
    consent: true,
    approvedAt: NOW,
  }),
);

function nativeFilledChild(overrides: Record<string, unknown> = {}) {
  const records = mapOrderRecords(
    {
      result: {
        category: "linear",
        list: [
          {
            orderId: "exchange-tp-1",
            orderLinkId: "",
            parentOrderLinkId: plan.clientOrderId,
            symbol: plan.symbol,
            side: "Sell",
            qty: "0.08",
            cumExecQty: "0.08",
            orderStatus: "Filled",
            orderType: "Market",
            timeInForce: "IOC",
            price: "101.23",
            triggerPrice: plan.entry.takeProfit.triggerPrice.toString(),
            takeProfit: "0",
            stopLoss: "0",
            stopOrderType: "PartialTakeProfit",
            tpslMode: "Partial",
            triggerBy: "LastPrice",
            tpTriggerBy: "",
            reduceOnly: true,
            positionIdx: 0,
            createdTime: String(Date.parse("2026-10-23T11:59:59.700Z")),
            updatedTime: String(Date.parse("2026-10-23T12:00:00.700Z")),
            ...overrides,
          },
        ],
      },
    },
    plan.symbol,
    "order/history",
  );
  return mapOrderObservation(
    records[0]!,
    OBSERVED,
    "bybit-mainnet/order/history",
  );
}

function parent(options: {
  readonly filled: string;
  readonly status: ExchangeOrderObservation["status"];
}): ExchangeOrderObservation {
  return unwrap(
    createExchangeOrder({
      exchangeOrderId: "exchange-parent-1",
      clientOrderId: plan.clientOrderId,
      instrument: plan.symbol,
      side: "buy",
      requestedQuantity: plan.entry.quantity.toString(),
      filledQuantity: options.filled,
      status: options.status,
      observedAt: OBSERVED,
      source: "bybit-mainnet/order/realtime",
      category: "linear",
      orderType: "limit",
      price: plan.entry.limitPrice.toString(),
      timeInForce: "GTC",
      takeProfit: plan.entry.takeProfit.triggerPrice.toString(),
      stopLoss: null,
      reduceOnly: false,
      positionIdx: 0,
      providerCreatedAt: "2026-10-23T11:59:59.700Z",
      providerUpdatedAt: "2026-10-23T12:00:00.700Z",
    }),
  );
}

function child(options: {
  readonly requested: string;
  readonly filled: string;
  readonly status: ExchangeOrderObservation["status"];
  readonly trigger?: string;
}): ExchangeOrderObservation {
  return unwrap(
    createExchangeOrder({
      exchangeOrderId: "exchange-tp-1",
      clientOrderId: "exchange-tp-client-1",
      providerOrderLinkId: "exchange-tp-client-1",
      parentOrderLinkId: plan.clientOrderId,
      instrument: plan.symbol,
      side: "sell",
      requestedQuantity: options.requested,
      filledQuantity: options.filled,
      status: options.status,
      observedAt: OBSERVED,
      source: "bybit-mainnet/protection/order/realtime",
      category: "linear",
      orderType: "market",
      triggerPrice:
        options.trigger ?? plan.entry.takeProfit.triggerPrice.toString(),
      protectionType: "take-profit",
      providerStopOrderType: "PartialTakeProfit",
      providerTpslMode: "Partial",
      triggerBy: "LastPrice",
      takeProfitTriggerBy: "LastPrice",
      stopLoss: null,
      reduceOnly: true,
      positionIdx: 0,
      providerCreatedAt: "2026-10-23T11:59:59.700Z",
      providerUpdatedAt: "2026-10-23T12:00:00.700Z",
    }),
  );
}

function fill(options: {
  readonly id: string;
  readonly orderId: string;
  readonly clientOrderId?: string;
  readonly side: "buy" | "sell";
  readonly quantity: string;
  readonly executedAt?: string;
}) {
  return {
    executionId: options.id,
    exchangeOrderId: options.orderId,
    clientOrderId: options.clientOrderId ?? "",
    instrument: plan.symbol,
    side: options.side,
    quantity: decimal(options.quantity),
    price: decimal(options.side === "buy" ? "100" : "100.2"),
    executedAt: (options.executedAt ??
      (options.side === "buy"
        ? "2026-10-23T12:00:00.500Z"
        : OBSERVED)) as UtcTimestamp,
    source: "bybit-mainnet/execution",
  } as const;
}

function observation(input: {
  readonly observedAt?: UtcTimestamp;
  readonly parent?: ExchangeOrderObservation;
  readonly entry?: readonly ReturnType<typeof fill>[];
  readonly children?: readonly ExchangeOrderObservation[];
  readonly exits?: readonly ReturnType<typeof fill>[];
  readonly position?: {
    readonly side: "flat" | "long" | "short";
    readonly quantity: string;
  };
  readonly activeOrders?: readonly ExchangeOrderObservation[];
  readonly omitChildFillGroups?: boolean;
}): MainnetOperatorTestStatusObservation {
  const children = input.children ?? [];
  const exits = input.exits ?? [];
  return {
    observedAt: input.observedAt ?? OBSERVED,
    parentLookupComplete: true,
    ...(input.parent === undefined ? {} : { parent: input.parent }),
    entryFills: input.entry ?? [],
    children,
    childFills: (input.omitChildFillGroups ? [] : children).map((row) => ({
      exchangeOrderId: row.exchangeOrderId,
      clientOrderId: row.clientOrderId,
      fills: exits.filter(
        (fillRow) => fillRow.exchangeOrderId === row.exchangeOrderId,
      ),
    })),
    position: {
      instrument: plan.symbol,
      side: input.position?.side ?? "flat",
      quantity: decimal(input.position?.quantity ?? "0"),
    },
    activeOrders: input.activeOrders ?? [],
    exchangeReads: 9,
  };
}

function harness(
  observed: Result<MainnetOperatorTestStatusObservation>,
  options: {
    readonly expiredLease?: boolean;
    readonly now?: UtcTimestamp;
    readonly incidentHalt?: boolean;
  } = {},
) {
  let snapshot: OperatorMainnetTestSnapshot = {
    source: {
      sourceId,
      scope,
      planHash: plan.contentHash,
      planArtifactId: `operator-mainnet-test:${plan.contentHash}`,
      approvalHash: approved.contentHash,
      approvalArtifactId: `operator-mainnet-test-approval:${approved.contentHash}`,
      clientOrderId: plan.clientOrderId,
      payloadJson: "{}",
      payloadHash: hash(`sha256:${"b".repeat(64)}`),
      createdAt: NOW,
    },
    plan,
    approval: approved,
    intent: {
      writeIntentId: "intent-1",
      sourceId,
      operation: "CREATE",
      runId: "operator-run-1",
      canonicalJson: "{}",
      canonicalHash: hash(`sha256:${"c".repeat(64)}`),
      preparedAt: NOW,
    },
    attempt: {
      attemptId: "attempt-1",
      writeIntentId: "intent-1",
      outcome: "accepted",
      exchangeOrderId: "exchange-parent-1",
      canonicalJson: "{}",
      canonicalHash: hash(`sha256:${"d".repeat(64)}`),
      recordedAt: NOW,
    },
    reconciliations: [],
    manualActions: [],
    halt: {
      scope,
      active: options.incidentHalt !== false,
      revision: 1,
      reason: "awaiting operator status",
      raisedAt: NOW,
      reconciliationRequired: true,
    },
  };
  const lease = {
    scope,
    ownerRunId: "operator-run-1",
    epoch: 1,
    acquiredAt: NOW,
    expiresAt: options.expiredLease
      ? ("2026-10-23T11:59:00.000Z" as UtcTimestamp)
      : ("2026-10-23T12:01:00.000Z" as UtcTimestamp),
    reconciliationRequired: false,
  };
  const journal = {
    readOperatorMainnetTestSource: () => ok(snapshot),
    appendManualAction: (
      request: Parameters<
        OperatorMainnetTestPersistencePort["appendManualAction"]
      >[0],
    ) => {
      assert.equal("authority" in request, false);
      const record = {
        actionId: `manual-${snapshot.manualActions.length + 1}`,
        sourceId,
        revision: snapshot.manualActions.length + 1,
        action: request.action,
        canonicalJson: JSON.stringify({ action: request.action }),
        canonicalHash: hash(`sha256:${"e".repeat(64)}`),
        declaredAt: request.declaredAt,
      };
      snapshot = {
        ...snapshot,
        manualActions: [...snapshot.manualActions, record],
      };
      return ok(record);
    },
    appendReconciliation: (
      request: Parameters<
        OperatorMainnetTestPersistencePort["appendReconciliation"]
      >[0],
    ) => {
      assert.equal("authority" in request, false);
      const revision = snapshot.reconciliations.length + 1;
      const record = {
        reconciliationId: `reconciliation-${revision}`,
        sourceId,
        revision,
        lifecycleOutcome: request.lifecycleOutcome,
        cleanupStatus: request.cleanupStatus,
        canonicalJson: JSON.stringify({ evidence: request.evidence }),
        canonicalHash: hash(`sha256:${"f".repeat(64)}`),
        observedAt: request.observedAt,
      };
      snapshot = {
        ...snapshot,
        reconciliations: [...snapshot.reconciliations, record],
      };
      return ok(record);
    },
    raiseHalt: (haltSourceId: string, reason: string, at: UtcTimestamp) => {
      assert.equal(haltSourceId, sourceId);
      if (!snapshot.halt.active) {
        snapshot = {
          ...snapshot,
          halt: { ...snapshot.halt, active: true, reason, raisedAt: at },
        };
      }
      return ok(snapshot.halt);
    },
  } as unknown as OperatorMainnetTestPersistencePort;
  const persistence = {
    scope,
    readScopeSnapshot: () =>
      ok({ scope, lease, halt: snapshot.halt, accountingFacts: [] }),
    renewLease: () => {
      throw new Error("operator status must not renew an account lease");
    },
    acquireLease: () => {
      throw new Error("operator status must not acquire an account lease");
    },
    raiseHalt: () => {
      throw new Error("operator status must use its source journal for HALT");
    },
    readHalt: () => ok(snapshot.halt),
  } as unknown as PersistencePort;
  const exchange = {
    observe: async () => observed,
  };
  return {
    run: (
      manualAction?: "entry-remainder-cancelled" | "position-closed" | "other",
    ) =>
      runMainnetOperatorTestStatus(
        {
          sourceId,
          ...(manualAction === undefined
            ? {}
            : { manualAction, actor: "test-operator" }),
        },
        {
          persistence,
          journal,
          exchange,
          clock: { now: () => options.now ?? OBSERVED },
        },
      ),
    get snapshot() {
      return snapshot;
    },
    get lease() {
      return lease;
    },
  };
}

function hash(value: string): PlanHash {
  const parsed = requireHash(value, "testHash");
  if (!parsed.ok) throw new Error("test hash is invalid");
  return parsed.value as PlanHash;
}

test("native filled TP history with empty own link and attached-TP fields verifies through the Bybit mapper", async () => {
  const tp = nativeFilledChild();
  const entry = parent({ filled: "0.08", status: "filled" });
  const h = harness(
    ok(
      observation({
        parent: entry,
        entry: [
          fill({
            id: "native-entry",
            orderId: entry.exchangeOrderId,
            side: "buy",
            quantity: "0.08",
          }),
        ],
        children: [tp],
        exits: [
          fill({
            id: "native-exit",
            orderId: tp.exchangeOrderId,
            side: "sell",
            quantity: "0.08",
          }),
        ],
      }),
    ),
  );
  const result = unwrap(await h.run());
  assert.equal(result.lifecycleOutcome, "TP_LIFECYCLE_PASS");
  assert.equal(result.cleanupStatus, "verified-clean");
  assert.deepEqual(result.reasons, []);
});

test("native TP shape still requires parent ownership, market identity and unambiguous trigger basis", async () => {
  const invalid: readonly [Record<string, unknown>, string][] = [
    [
      { parentOrderLinkId: "unrelated-parent" },
      "TP_CHILD_PARENT_LINK_MISMATCH",
    ],
    [{ triggerBy: "MarkPrice" }, "TP_CHILD_TRIGGER_BASIS_MISMATCH"],
    [{ tpTriggerBy: "MarkPrice" }, "TP_CHILD_TRIGGER_BASIS_MISMATCH"],
    [{ triggerBy: "" }, "TP_CHILD_TRIGGER_BASIS_MISMATCH"],
    [{ reduceOnly: false }, "TP_CHILD_REDUCTION_MODE_INVALID"],
    [{ stopOrderType: "TakeProfit" }, "TP_CHILD_TYPE_MISMATCH"],
    [{ orderType: "Limit" }, "TP_CHILD_ORDER_TYPE_MISMATCH"],
    [{ triggerPrice: "101" }, "TP_CHILD_TRIGGER_PRICE_MISMATCH"],
  ];
  for (const [overrides, reason] of invalid) {
    const tp = nativeFilledChild(overrides);
    const entry = parent({ filled: "0.08", status: "filled" });
    const h = harness(
      ok(
        observation({
          parent: entry,
          entry: [
            fill({
              id: "native-entry",
              orderId: entry.exchangeOrderId,
              side: "buy",
              quantity: "0.08",
            }),
          ],
          children: [tp],
          exits: [
            fill({
              id: "native-exit",
              orderId: tp.exchangeOrderId,
              side: "sell",
              quantity: "0.08",
            }),
          ],
        }),
      ),
    );
    const result = unwrap(await h.run());
    assert.equal(result.lifecycleOutcome, "UNKNOWN", reason);
    assert.ok(result.reasons.includes(reason), reason);
    assert.equal(h.snapshot.halt.active, true);
  }
});

test("zero entry fill with an open GTC parent is NOT_EXERCISED and cleanup pending", async () => {
  const entry = parent({ filled: "0", status: "open" });
  const h = harness(ok(observation({ parent: entry, activeOrders: [entry] })));
  const result = unwrap(await h.run());
  assert.equal(result.lifecycleOutcome, "NOT_EXERCISED");
  assert.equal(result.cleanupStatus, "pending");
  assert.equal(result.latestSnapshot.reconciliations.length, 1);
});

test("fresh REST proof of an unchanged GTC entry remains pending after ten minutes", async () => {
  const observedAt = "2026-10-23T12:10:00.000Z" as UtcTimestamp;
  const entry = { ...parent({ filled: "0", status: "open" }), observedAt };
  const h = harness(
    ok(observation({ observedAt, parent: entry, activeOrders: [entry] })),
    { now: observedAt },
  );
  const result = unwrap(await h.run());
  assert.equal(result.lifecycleOutcome, "NOT_EXERCISED");
  assert.equal(result.cleanupStatus, "pending");
  assert.deepEqual(result.reasons, []);
});

test("fresh REST proof of historical full TP execution passes after ten minutes", async () => {
  const observedAt = "2026-10-23T12:10:00.000Z" as UtcTimestamp;
  const entry = { ...parent({ filled: "0.08", status: "filled" }), observedAt };
  const tp = {
    ...child({ requested: "0.08", filled: "0.08", status: "filled" }),
    observedAt,
    providerUpdatedAt: "2026-10-23T12:05:00.000Z" as UtcTimestamp,
  };
  const h = harness(
    ok(
      observation({
        observedAt,
        parent: entry,
        entry: [
          fill({
            id: "historical-entry",
            orderId: entry.exchangeOrderId,
            side: "buy",
            quantity: "0.08",
          }),
        ],
        children: [tp],
        exits: [
          fill({
            id: "historical-exit",
            orderId: tp.exchangeOrderId,
            side: "sell",
            quantity: "0.08",
            executedAt: "2026-10-23T12:05:00.000Z",
          }),
        ],
      }),
    ),
    { now: observedAt },
  );
  const result = unwrap(await h.run());
  assert.equal(result.lifecycleOutcome, "TP_LIFECYCLE_PASS");
  assert.equal(result.cleanupStatus, "verified-clean");
  assert.deepEqual(result.reasons, []);
});

test("stale or future REST order observations and inconsistent event times stay UNKNOWN", async () => {
  const invalidTimes: readonly Partial<ExchangeOrderObservation>[] = [
    { observedAt: "2026-10-23T11:58:00.000Z" as UtcTimestamp },
    { observedAt: "2026-10-23T12:00:02.000Z" as UtcTimestamp },
    { providerCreatedAt: "2026-10-23T12:00:00.800Z" as UtcTimestamp },
    { providerUpdatedAt: "2026-10-23T12:00:02.000Z" as UtcTimestamp },
  ];
  for (const invalidTime of invalidTimes) {
    for (const target of ["parent", "child"] as const) {
      const entry = {
        ...parent({ filled: "0.08", status: "filled" }),
        ...(target === "parent" ? invalidTime : {}),
      };
      const tp = {
        ...child({ requested: "0.08", filled: "0.08", status: "filled" }),
        ...(target === "child" ? invalidTime : {}),
      };
      const h = harness(
        ok(
          observation({
            parent: entry,
            entry: [
              fill({
                id: "entry-1",
                orderId: entry.exchangeOrderId,
                side: "buy",
                quantity: "0.08",
              }),
            ],
            children: [tp],
            exits: [
              fill({
                id: "exit-1",
                orderId: tp.exchangeOrderId,
                side: "sell",
                quantity: "0.08",
              }),
            ],
          }),
        ),
      );
      const result = unwrap(await h.run());
      assert.equal(result.lifecycleOutcome, "UNKNOWN");
      assert.equal(result.cleanupStatus, "unknown");
      assert.ok(
        result.reasons.includes(
          target === "parent"
            ? "PARENT_PROOF_INVALID_OR_STALE"
            : "TP_CHILD_PROOF_INVALID_OR_DUPLICATE",
        ),
      );
    }
  }
});

test("partial entry with the exact active TP is PARTIAL_EVIDENCE", async () => {
  const entry = parent({ filled: "0.04", status: "partially-filled" });
  const tp = child({ requested: "0.04", filled: "0", status: "open" });
  const h = harness(
    ok(
      observation({
        parent: entry,
        entry: [
          fill({
            id: "entry-1",
            orderId: entry.exchangeOrderId,
            clientOrderId: plan.clientOrderId,
            side: "buy",
            quantity: "0.04",
          }),
        ],
        children: [tp],
        position: { side: "long", quantity: "0.04" },
        activeOrders: [entry, tp],
      }),
    ),
  );
  const result = unwrap(await h.run());
  assert.equal(result.lifecycleOutcome, "PARTIAL_EVIDENCE");
  assert.equal(result.cleanupStatus, "pending");
});

test("an active zero-fill TP without a fill group remains PARTIAL_EVIDENCE", async () => {
  const entry = parent({ filled: "0.04", status: "partially-filled" });
  const tp = child({ requested: "0.04", filled: "0", status: "open" });
  const h = harness(
    ok(
      observation({
        parent: entry,
        entry: [
          fill({
            id: "entry-1",
            orderId: entry.exchangeOrderId,
            clientOrderId: plan.clientOrderId,
            side: "buy",
            quantity: "0.04",
          }),
        ],
        children: [tp],
        position: { side: "long", quantity: "0.04" },
        activeOrders: [entry, tp],
        omitChildFillGroups: true,
      }),
    ),
  );
  const result = unwrap(await h.run());
  assert.equal(result.lifecycleOutcome, "PARTIAL_EVIDENCE");
  assert.equal(result.cleanupStatus, "pending");
  assert.equal(result.reasons.length, 0);
});

test("full TP exit does not pass while the entry remainder is still open", async () => {
  const entry = parent({ filled: "0.04", status: "partially-filled" });
  const tp = child({ requested: "0.04", filled: "0.04", status: "filled" });
  const exit = fill({
    id: "exit-1",
    orderId: tp.exchangeOrderId,
    clientOrderId: tp.clientOrderId,
    side: "sell",
    quantity: "0.04",
  });
  const h = harness(
    ok(
      observation({
        parent: entry,
        entry: [
          fill({
            id: "entry-1",
            orderId: entry.exchangeOrderId,
            clientOrderId: plan.clientOrderId,
            side: "buy",
            quantity: "0.04",
          }),
        ],
        children: [tp],
        exits: [exit],
        activeOrders: [entry],
      }),
    ),
  );
  const result = unwrap(await h.run());
  assert.equal(result.lifecycleOutcome, "PARTIAL_EVIDENCE");
  assert.equal(result.cleanupStatus, "pending");
});

test("fresh clean all-TP execution passes and does not clear HALT", async () => {
  const entry = parent({ filled: "0.08", status: "filled" });
  const tp = child({ requested: "0.08", filled: "0.08", status: "filled" });
  const h = harness(
    ok(
      observation({
        parent: entry,
        entry: [
          fill({
            id: "entry-1",
            orderId: entry.exchangeOrderId,
            side: "buy",
            quantity: "0.08",
          }),
        ],
        children: [tp],
        exits: [
          fill({
            id: "exit-1",
            orderId: tp.exchangeOrderId,
            clientOrderId: tp.clientOrderId,
            side: "sell",
            quantity: "0.08",
          }),
        ],
      }),
    ),
  );
  const result = unwrap(await h.run());
  assert.equal(result.lifecycleOutcome, "TP_LIFECYCLE_PASS");
  assert.equal(result.cleanupStatus, "verified-clean");
  assert.equal(result.halt.active, true);
});

test("TP executions must follow entry fills and precede the observation time", async () => {
  const entry = parent({ filled: "0.08", status: "filled" });
  const tp = child({ requested: "0.08", filled: "0.08", status: "filled" });
  for (const exitTime of [
    "2026-10-23T12:00:00.400Z",
    "2026-10-23T12:00:02.000Z",
  ]) {
    const h = harness(
      ok(
        observation({
          parent: entry,
          entry: [
            fill({
              id: `entry-${exitTime}`,
              orderId: entry.exchangeOrderId,
              side: "buy",
              quantity: "0.08",
            }),
          ],
          children: [tp],
          exits: [
            fill({
              id: `exit-${exitTime}`,
              orderId: tp.exchangeOrderId,
              clientOrderId: tp.clientOrderId,
              side: "sell",
              quantity: "0.08",
              executedAt: exitTime,
            }),
          ],
        }),
      ),
    );
    const result = unwrap(await h.run());
    assert.equal(result.lifecycleOutcome, "UNKNOWN");
    assert.equal(result.cleanupStatus, "unknown");
    assert.ok(result.reasons.includes("EXECUTION_TIMELINE_INVALID"));
  }
});

test("empty execution orderLinkId is attributable only through the exact TP orderId", async () => {
  const entry = parent({ filled: "0.08", status: "filled" });
  const tp = child({ requested: "0.08", filled: "0.08", status: "filled" });
  const h = harness(
    ok(
      observation({
        parent: entry,
        entry: [
          fill({
            id: "entry-1",
            orderId: entry.exchangeOrderId,
            side: "buy",
            quantity: "0.08",
          }),
        ],
        children: [tp],
        exits: [
          fill({
            id: "exit-1",
            orderId: tp.exchangeOrderId,
            side: "sell",
            quantity: "0.08",
          }),
        ],
      }),
    ),
  );
  const result = unwrap(await h.run());
  assert.equal(result.lifecycleOutcome, "TP_LIFECYCLE_PASS");
  assert.equal(result.cleanupStatus, "verified-clean");
});

test("empty execution orderLinkId with a different orderId stays UNKNOWN", async () => {
  const entry = parent({ filled: "0.08", status: "filled" });
  const tp = child({ requested: "0.08", filled: "0.08", status: "filled" });
  const h = harness(
    ok(
      observation({
        parent: entry,
        entry: [
          fill({
            id: "entry-1",
            orderId: entry.exchangeOrderId,
            side: "buy",
            quantity: "0.08",
          }),
        ],
        children: [tp],
        exits: [
          fill({
            id: "exit-1",
            orderId: "unrelated-order",
            side: "sell",
            quantity: "0.08",
          }),
        ],
      }),
    ),
  );
  const result = unwrap(await h.run());
  assert.equal(result.lifecycleOutcome, "UNKNOWN");
  assert.ok(result.reasons.includes("TP_EXIT_FILL_ATTRIBUTION_INVALID"));
});

test("manual parent remainder cancellation is provenance and fresh proof can still pass", async () => {
  const entry = parent({ filled: "0.04", status: "cancelled" });
  const tp = child({ requested: "0.04", filled: "0.04", status: "filled" });
  const h = harness(
    ok(
      observation({
        parent: entry,
        entry: [
          fill({
            id: "entry-1",
            orderId: entry.exchangeOrderId,
            clientOrderId: plan.clientOrderId,
            side: "buy",
            quantity: "0.04",
          }),
        ],
        children: [tp],
        exits: [
          fill({
            id: "exit-1",
            orderId: tp.exchangeOrderId,
            clientOrderId: tp.clientOrderId,
            side: "sell",
            quantity: "0.04",
          }),
        ],
      }),
    ),
  );
  const result = unwrap(await h.run("entry-remainder-cancelled"));
  assert.equal(result.lifecycleOutcome, "TP_LIFECYCLE_PASS");
  assert.equal(
    result.latestSnapshot.manualActions[0]?.action,
    "entry-remainder-cancelled",
  );
});

test("manual position closure remains MANUAL_CLEANUP and preserves TP exit quantity", async () => {
  const entry = parent({ filled: "0.08", status: "filled" });
  const tp = child({ requested: "0.08", filled: "0.04", status: "cancelled" });
  const h = harness(
    ok(
      observation({
        parent: entry,
        entry: [
          fill({
            id: "entry-1",
            orderId: entry.exchangeOrderId,
            clientOrderId: plan.clientOrderId,
            side: "buy",
            quantity: "0.08",
          }),
        ],
        children: [tp],
        exits: [
          fill({
            id: "exit-1",
            orderId: tp.exchangeOrderId,
            clientOrderId: tp.clientOrderId,
            side: "sell",
            quantity: "0.04",
          }),
        ],
      }),
    ),
  );
  const result = unwrap(await h.run("position-closed"));
  assert.equal(result.lifecycleOutcome, "MANUAL_CLEANUP");
  assert.equal(result.cleanupStatus, "verified-clean");
  assert.match(
    result.latestSnapshot.reconciliations.at(-1)!.canonicalJson,
    /"tpExitQuantity":"0.04"/u,
  );
});

test("unattributed reduction and missing exit fill remain UNKNOWN", async () => {
  const entry = parent({ filled: "0.08", status: "filled" });
  const tp = child({ requested: "0.08", filled: "0.08", status: "filled" });
  const h = harness(
    ok(
      observation({
        parent: entry,
        entry: [
          fill({
            id: "entry-1",
            orderId: entry.exchangeOrderId,
            clientOrderId: plan.clientOrderId,
            side: "buy",
            quantity: "0.08",
          }),
        ],
        children: [tp],
        position: { side: "flat", quantity: "0" },
        omitChildFillGroups: true,
      }),
    ),
  );
  const result = unwrap(await h.run());
  assert.equal(result.lifecycleOutcome, "UNKNOWN");
  assert.ok(result.reasons.includes("TP_EXIT_FILL_ATTRIBUTION_INVALID"));
});

test("racing entry fill mismatch and wrong TP trigger never pass", async () => {
  const entry = parent({ filled: "0.08", status: "filled" });
  const tp = child({
    requested: "0.08",
    filled: "0.08",
    status: "filled",
    trigger: "101",
  });
  const h = harness(
    ok(
      observation({
        parent: entry,
        entry: [
          fill({
            id: "entry-1",
            orderId: entry.exchangeOrderId,
            clientOrderId: plan.clientOrderId,
            side: "buy",
            quantity: "0.04",
          }),
        ],
        children: [tp],
        exits: [
          fill({
            id: "exit-1",
            orderId: tp.exchangeOrderId,
            clientOrderId: tp.clientOrderId,
            side: "sell",
            quantity: "0.08",
          }),
        ],
      }),
    ),
  );
  const result = unwrap(await h.run());
  assert.equal(result.lifecycleOutcome, "UNKNOWN");
  assert.ok(result.reasons.length > 0);
});

test("position side must match the remaining Buy entry quantity", async () => {
  const entry = parent({ filled: "0.08", status: "filled" });
  const tp = child({ requested: "0.08", filled: "0.04", status: "cancelled" });
  const h = harness(
    ok(
      observation({
        parent: entry,
        entry: [
          fill({
            id: "entry-1",
            orderId: entry.exchangeOrderId,
            clientOrderId: plan.clientOrderId,
            side: "buy",
            quantity: "0.08",
          }),
        ],
        children: [tp],
        exits: [
          fill({
            id: "exit-1",
            orderId: tp.exchangeOrderId,
            clientOrderId: tp.clientOrderId,
            side: "sell",
            quantity: "0.04",
          }),
        ],
        position: { side: "short", quantity: "0.04" },
      }),
    ),
  );
  const result = unwrap(await h.run());
  assert.equal(result.lifecycleOutcome, "UNKNOWN");
  assert.ok(result.reasons.includes("POSITION_EXIT_MISMATCH"));
});

test("failed or incomplete status reads append UNKNOWN and preserve active HALT", async () => {
  const h = harness(
    fail(
      domainError("UNRESOLVED_RECONCILIATION", "read failed", {
        reasonCode: "PAGE_BUDGET_EXHAUSTED",
        exchangeReads: 7,
      }),
    ),
  );
  const result = unwrap(await h.run());
  assert.equal(result.lifecycleOutcome, "UNKNOWN");
  assert.equal(result.cleanupStatus, "unknown");
  assert.equal(result.exchangeReads, 7);
  assert.equal(result.halt.active, true);
  assert.deepEqual(result.reasons, ["PAGE_BUDGET_EXHAUSTED"]);
  const evidence = JSON.parse(
    result.latestSnapshot.reconciliations[0]!.canonicalJson,
  ) as {
    readonly evidence: {
      readonly exchangeReads: number;
      readonly failedStage: string;
    };
  };
  assert.equal(evidence.evidence.exchangeReads, 7);
  assert.equal(evidence.evidence.failedStage, "PAGE_BUDGET_EXHAUSTED");
});

test("status appends after lease expiry without takeover and preserves incident HALT", async () => {
  const entry = parent({ filled: "0", status: "open" });
  const h = harness(ok(observation({ parent: entry, activeOrders: [entry] })), {
    expiredLease: true,
  });
  const existingHalt = h.snapshot.halt;
  const result = unwrap(await h.run());
  assert.equal(result.lifecycleOutcome, "NOT_EXERCISED");
  assert.equal(result.cleanupStatus, "pending");
  assert.deepEqual(result.halt, existingHalt);
  assert.equal(h.lease.ownerRunId, "operator-run-1");
  assert.equal(h.lease.reconciliationRequired, false);
  assert.equal(result.halt.active, true);
  assert.equal(result.halt.reconciliationRequired, true);
  assert.equal(result.latestSnapshot.reconciliations.length, 1);
});

test("status after an expired lease neither creates a lease incident nor stores lease authority", async () => {
  const entry = parent({ filled: "0", status: "open" });
  const h = harness(ok(observation({ parent: entry, activeOrders: [entry] })), {
    expiredLease: true,
    incidentHalt: false,
  });
  const result = unwrap(await h.run("other"));
  assert.equal(result.lifecycleOutcome, "NOT_EXERCISED");
  assert.equal(result.halt.active, false);
  assert.equal(h.snapshot.manualActions.length, 1);
  assert.equal(h.snapshot.reconciliations.length, 1);
  assert.doesNotMatch(
    h.snapshot.reconciliations[0]!.canonicalJson,
    /lease|statusAuthority/iu,
  );
  assert.equal(h.lease.epoch, 1);
});

test("read failure after lease expiry records truthful UNKNOWN without acquiring authority", async () => {
  const h = harness(fail(domainError("INVALID_VALUE", "read failed")), {
    expiredLease: true,
    incidentHalt: false,
  });
  const result = unwrap(await h.run());
  assert.equal(result.lifecycleOutcome, "UNKNOWN");
  assert.deepEqual(result.reasons, ["INVALID_VALUE"]);
  assert.equal(result.halt.active, true);
  assert.equal(result.halt.reason, "operator Mainnet status is unknown");
  assert.equal(result.exchangeReads, 0);
  assert.equal(h.lease.epoch, 1);
  assert.equal(h.snapshot.reconciliations.length, 1);
});
