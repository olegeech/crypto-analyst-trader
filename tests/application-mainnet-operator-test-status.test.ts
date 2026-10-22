import assert from "node:assert/strict";
import test from "node:test";

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
    observedAt: OBSERVED,
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
  options: { readonly expiredLease?: boolean } = {},
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
      leaseOwnerRunId: "operator-run-1",
      leaseEpoch: 1,
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
      active: true,
      revision: 1,
      reason: "awaiting operator status",
      raisedAt: NOW,
      reconciliationRequired: true,
    },
  };
  let lease = {
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
  } as unknown as OperatorMainnetTestPersistencePort;
  const persistence = {
    scope,
    readScopeSnapshot: () =>
      ok({ scope, lease, halt: snapshot.halt, accountingFacts: [] }),
    renewLease: (request: {
      readonly scope: PersistenceScope;
      readonly ownerRunId: string;
      readonly now: UtcTimestamp;
      readonly ttlMs: number;
      readonly authority: {
        readonly ownerRunId: string;
        readonly epoch: number;
      };
    }) => {
      lease = {
        ...lease,
        expiresAt: new Date(
          Date.parse(request.now) + request.ttlMs,
        ).toISOString() as UtcTimestamp,
      };
      return ok(lease);
    },
    acquireLease: () => {
      lease = {
        ...lease,
        ownerRunId: "operator-status-test",
        epoch: lease.epoch + 1,
        reconciliationRequired: true,
      };
      return ok(lease);
    },
    raiseHalt: () => {
      snapshot = { ...snapshot, halt: { ...snapshot.halt, active: true } };
      return ok(snapshot.halt);
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
          clock: { now: () => OBSERVED },
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

test("zero entry fill with an open GTC parent is NOT_EXERCISED and cleanup pending", async () => {
  const entry = parent({ filled: "0", status: "open" });
  const h = harness(ok(observation({ parent: entry, activeOrders: [entry] })));
  const result = unwrap(await h.run());
  assert.equal(result.lifecycleOutcome, "NOT_EXERCISED");
  assert.equal(result.cleanupStatus, "pending");
  assert.equal(result.latestSnapshot.reconciliations.length, 1);
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
      }),
    ),
  );
  const result = unwrap(await h.run());
  assert.equal(result.lifecycleOutcome, "UNKNOWN");
  assert.equal(result.cleanupStatus, "unknown");
  assert.equal(result.halt.active, true);
});

test("status appends after lease takeover while reconciliation-required HALT stays active", async () => {
  const entry = parent({ filled: "0", status: "open" });
  const h = harness(ok(observation({ parent: entry, activeOrders: [entry] })), {
    expiredLease: true,
  });
  const result = unwrap(await h.run());
  assert.equal(result.lifecycleOutcome, "NOT_EXERCISED");
  assert.equal(result.cleanupStatus, "pending");
  assert.equal(h.lease.ownerRunId, "operator-status-test");
  assert.equal(h.lease.reconciliationRequired, true);
  assert.equal(result.halt.active, true);
  assert.equal(result.halt.reconciliationRequired, true);
  assert.equal(result.latestSnapshot.reconciliations.length, 1);
});
