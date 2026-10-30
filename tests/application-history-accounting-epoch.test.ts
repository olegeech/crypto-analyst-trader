import assert from "node:assert/strict";
import test from "node:test";

import {
  projectHistoryAccountingEpoch,
  projectScopedHistoryAccountingEpoch,
} from "../src/application/history-accounting-epoch.js";
import { resolveHistoryAccountingScope } from "../src/application/history-accounting-scope.js";
import {
  mapBybitExecutionResponse,
  mapBybitTransactionLogResponse,
} from "../src/adapters/bybit-v5/history-read-mappers.js";
import type { HistorySourceFact } from "../src/domain/accounting/history-source-fact.js";
import { createHistorySourceFact } from "../src/domain/accounting/history-source-fact.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";
import type { Result } from "../src/domain/shared/result.js";
import type { UtcTimestamp } from "../src/domain/shared/time.js";
import { hashCanonical } from "../src/domain/identity/canonical-serialization.js";
import { createHistoryAccountingAnchorMac } from "../src/application/history-accounting-anchor-authentication.js";
import type { HistoryAccountingWalletAnchor } from "../src/ports/history-accounting-anchor-store.js";
import { authenticateWalletAnchorCapture } from "../src/ports/history-accounting-anchor-capture-provenance.js";
import type {
  HistoryCheckpoint,
  HistoryConflictSummary,
  HistoryStoredObservation,
  HistoryStoreScope,
} from "../src/ports/history-store.js";

const scope: HistoryStoreScope = {
  exchange: "bybit",
  environment: "mainnet",
  accountId: `sha256:${"a".repeat(64)}`,
};
const accountingScope = unwrap(
  resolveHistoryAccountingScope("provisional-m1-v1"),
);
const openingAt = "2026-10-27T10:00:00.000Z" as UtcTimestamp;
const closingAt = "2026-10-27T10:10:00.000Z" as UtcTimestamp;
const startMs = Date.parse(openingAt);
const endMs = Date.parse(closingAt);
const testAuthenticationKey = new Uint8Array(32).fill(0x42);
const sources = [
  "order-history",
  "executions",
  "closed-pnl",
  "transaction-log",
] as const;

function unwrap<T>(result: Result<T>): T {
  if (!result.ok)
    throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function decimal(value: string) {
  return unwrap(DecimalValue.fromString(value));
}

function usdFact(value: string) {
  return {
    state: "known" as const,
    value: decimal(value),
    unit: "USD" as const,
  };
}

function coinFact(value: string) {
  return {
    state: "known" as const,
    value: decimal(value),
    unit: "coin" as const,
  };
}

function authenticateFixtureAnchor<T extends object>(value: T): T {
  const mac = createHistoryAccountingAnchorMac(
    value as never,
    testAuthenticationKey,
  );
  if (!mac.ok) throw new Error("fixture anchor authentication failed");
  authenticateWalletAnchorCapture(value, mac.value, testAuthenticationKey);
  return value;
}

function asset(coin: string, balance: string) {
  return {
    coin,
    walletBalance: coinFact(balance),
    equity: coinFact(balance),
    usdValue: usdFact(balance),
    usdEquity: {
      state: "unavailable" as const,
      reason: "not-returned" as const,
      unit: "USD" as const,
    },
    locked: coinFact("0"),
    bonus: coinFact("0"),
    borrowAmount: coinFact("0"),
    spotBorrow: coinFact("0"),
    accruedInterest: coinFact("0"),
    totalOrderIM: usdFact("0"),
    totalPositionIM: usdFact("0"),
    totalPositionMM: usdFact("0"),
    unrealisedPnl: coinFact("0"),
    collateralEligible: { state: "known" as const, value: false },
    collateralSwitch: { state: "not-applicable" as const },
    restricted: {
      state: "unavailable" as const,
      reason: "not-returned" as const,
    },
  };
}

function anchor(
  kind: "opening" | "closing",
  at: UtcTimestamp,
  balances: Readonly<Record<string, string>> = { USDT: "100" },
  overrides: Partial<HistoryAccountingWalletAnchor> = {},
): HistoryAccountingWalletAnchor {
  const epoch = Date.parse(at);
  const before = new Date(epoch - 100).toISOString() as UtcTimestamp;
  const after = new Date(epoch + 100).toISOString() as UtcTimestamp;
  const assets = Object.entries(balances).map(([coin, value]) =>
    asset(coin, value),
  );
  return authenticateFixtureAnchor({
    schemaVersion: "history-accounting-wallet-anchor/v1",
    anchorId: `${kind}-anchor-1`,
    kind,
    scope,
    accountBinding: {
      exchange: "bybit",
      environment: "mainnet",
      origin: "https://api.bybit.com",
      accountIdentityHash: scope.accountId,
      authenticatedAt: new Date(epoch - 1_000).toISOString() as UtcTimestamp,
      identityVerified: true,
    },
    credentialPosture: {
      readOnly: false,
      permissions: {
        contractOrder: true,
        contractPosition: true,
        spotTrade: false,
        walletTransfer: false,
        withdraw: false,
      },
      ipBound: true,
      expiresAt: null,
      warnings: [],
    },
    capture: {
      identityEndpoint: "/v5/user/query-api",
      walletEndpoint: "/v5/account/wallet-balance",
      accountType: "UNIFIED",
      identityObservedAt: new Date(epoch - 50).toISOString() as UtcTimestamp,
      collectionStartedAt: before,
      collectionEndedAt: after,
      providerTimeBefore: before,
      providerResponseTime: at,
      providerTimeAfter: after,
    },
    totals: {
      totalEquity: usdFact("100"),
      totalWalletBalance: usdFact("100"),
      totalMarginBalance: usdFact("100"),
      totalPerpUPL: usdFact("0"),
      totalAvailableBalance: usdFact("100"),
      totalInitialMargin: usdFact("0"),
      totalMaintenanceMargin: usdFact("0"),
      accountIMRate: {
        state: "unavailable",
        reason: "not-returned",
        unit: "rate",
      },
      accountMMRate: {
        state: "unavailable",
        reason: "not-returned",
        unit: "rate",
      },
      equityBasis: "unestablished",
    },
    assets,
    contentHash: `sha256:${"b".repeat(64)}`,
    recordedAt: new Date(epoch + 1_000).toISOString() as UtcTimestamp,
    ...overrides,
  });
}

function stored(
  factInput: Parameters<typeof createHistorySourceFact>[0],
  observationId: string,
): HistoryStoredObservation {
  const fact = unwrap(createHistorySourceFact(factInput));
  const eventIdentity =
    fact.factKind === "transaction"
      ? `transaction:${fact.transactionId}`
      : fact.factKind === "closed-pnl"
        ? `closed-pnl-group:${fact.groupingKey.orderId}:${fact.groupingKey.createdTime}`
        : fact.factKind === "execution"
          ? `execution:${fact.execId}`
          : `order:${fact.orderId}`;
  return {
    observationId,
    scope,
    source: fact.source,
    eventIdentity,
    contentHash: fact.contentHash,
    canonicalHash: fact.contentHash,
    providerEventTime: fact.providerEventTime,
    providerRevisionTime: fact.providerRevisionTime,
    collectedAt: fact.collectedAt,
    fact,
  };
}

function storedMappedFact(
  fact: HistorySourceFact,
  observationId: string,
): HistoryStoredObservation {
  return {
    observationId,
    scope,
    source: fact.source,
    eventIdentity:
      fact.factKind === "transaction"
        ? `transaction:${fact.transactionId}`
        : fact.factKind === "closed-pnl"
          ? `closed-pnl-group:${fact.groupingKey.orderId}:${fact.groupingKey.createdTime}`
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

function transaction(
  transactionId: string,
  change: string,
  overrides: Partial<{
    type: string | null;
    transSubType: string | null;
    category: string | null;
    symbol: string | null;
    side: string | null;
    currency: string | null;
    qty: string | null;
    size: string | null;
    tradePrice: string | null;
    cashFlow: string | null;
    funding: string | null;
    fee: string | null;
    change: string | null;
    bonusChange: string | null;
    tradeId: string | null;
    orderId: string | null;
    providerEventTime: string;
  }> = {},
  observationId = `obs-${transactionId}`,
) {
  const input = {
    factKind: "transaction" as const,
    source: "transaction-log" as const,
    transactionId,
    category: "linear",
    symbol: "DOGEUSDT",
    side: "Buy",
    currency: "USDT",
    type: "SETTLEMENT",
    transSubType: null,
    qty: null,
    size: null,
    tradePrice: null,
    cashFlow: change,
    funding: "0",
    fee: "0",
    feeRate: null,
    change,
    bonusChange: null,
    cashBalance: "100",
    tradeId: null,
    orderId: null,
    orderLinkId: null,
    displayType: null,
    extraFees: null,
    providerEventTime: "2026-10-27T10:05:00.000Z",
    providerRevisionTime: null,
    collectedAt: "2026-10-27T10:06:00.000Z",
    ...overrides,
  };
  return stored(input, observationId);
}

function supportingObservation(
  source: Exclude<(typeof sources)[number], "transaction-log">,
  id: string,
  time = "2026-10-27T10:05:00.000Z",
  closedPnl = "0",
  closeFee = "0",
): HistoryStoredObservation {
  const common = {
    providerEventTime: time,
    providerRevisionTime: null,
    collectedAt: "2026-10-27T10:06:00.000Z",
  };
  if (source === "order-history")
    return stored(
      {
        factKind: "order",
        source,
        category: "linear",
        symbol: "DOGEUSDT",
        orderId: id,
        orderLinkId: null,
        parentOrderLinkId: null,
        side: "Buy",
        orderType: "Limit",
        orderStatus: "Filled",
        timeInForce: "GTC",
        qty: "1",
        price: "1",
        avgPrice: "1",
        cumExecQty: "1",
        cumExecValue: "1",
        cumExecFee: "0",
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
        ...common,
      },
      `obs-${source}-${id}`,
    );
  if (source === "executions")
    return stored(
      {
        factKind: "execution",
        source,
        category: "linear",
        symbol: "DOGEUSDT",
        orderId: id,
        orderLinkId: null,
        execId: id,
        orderPrice: "1",
        orderQty: "1",
        side: "Buy",
        execType: "Trade",
        execPrice: "1",
        execQty: "1",
        execValue: "1",
        execFee: "0",
        execFeeV2: null,
        feeCurrency: "USDT",
        feeRate: "0",
        execPnl: "0",
        closedSize: "0",
        isMaker: true,
        seq: "1",
        leavesQty: "0",
        markPrice: "1",
        indexPrice: "1",
        underlyingPrice: null,
        createType: null,
        blockTradeId: null,
        extraFees: null,
        ...common,
      },
      `obs-${source}-${id}`,
    );
  return stored(
    {
      factKind: "closed-pnl",
      source,
      category: "linear",
      symbol: "DOGEUSDT",
      orderId: id,
      side: "Sell",
      orderType: "Market",
      execType: "Trade",
      qty: "1",
      orderPrice: "1",
      closedSize: "1",
      cumEntryValue: "1",
      avgEntryPrice: "1",
      cumExitValue: "1",
      avgExitPrice: "1",
      closedPnl,
      openFee: "0",
      closeFee,
      fundingFee: null,
      fillCount: "1",
      leverage: "1",
      ...common,
    },
    `obs-${source}-${id}`,
  );
}

function executionObservation(
  overrides: Partial<{
    category: string;
    symbol: string;
    orderId: string;
    execId: string;
    side: string;
    execType: string;
    execPrice: string;
    execQty: string;
    execFee: string | null;
    feeCurrency: string | null;
    providerEventTime: string;
  }> = {},
): HistoryStoredObservation {
  const input = {
    factKind: "execution" as const,
    source: "executions" as const,
    category: "linear",
    symbol: "DOGEUSDT",
    orderId: "order-1",
    orderLinkId: null,
    execId: "exec-1",
    orderPrice: "1",
    orderQty: "1",
    side: "Buy",
    execType: "Trade",
    execPrice: "1",
    execQty: "1",
    execValue: "1",
    execFee: "0",
    execFeeV2: null,
    feeCurrency: "USDT",
    feeRate: "0",
    execPnl: "0",
    closedSize: "0",
    isMaker: true,
    seq: "1",
    leavesQty: "0",
    markPrice: "1",
    indexPrice: "1",
    underlyingPrice: null,
    createType: null,
    blockTradeId: null,
    extraFees: null,
    providerEventTime: "2026-10-27T10:05:00.000Z",
    providerRevisionTime: null,
    collectedAt: "2026-10-27T10:06:00.000Z",
    ...overrides,
  };
  return stored(input, `obs-execution-${input.execId}`);
}

function checkpoint(
  source: (typeof sources)[number],
  fromMs = startMs - 100,
  toMs = endMs + 100,
  overrides: Partial<HistoryCheckpoint> = {},
): HistoryCheckpoint {
  const filters =
    source === "transaction-log"
      ? {
          accountType: "UNIFIED",
          purpose: "backfill",
          rangeStartMs: fromMs,
          rangeEndMs: toMs,
        }
      : {
          category: "linear",
          purpose: "backfill",
          rangeStartMs: fromMs,
          rangeEndMs: toMs,
        };
  const filterHash = unwrap(hashCanonical(filters));
  return {
    scope,
    source,
    filters,
    window: { fromMs, toMs },
    filterHash,
    cursor: null,
    status: "traversed",
    rowCount: 0,
    insertedCount: 0,
    duplicateCount: 0,
    conflictCount: 0,
    reasonCode: null,
    updatedAt: "2026-10-27T10:11:00.000Z" as UtcTimestamp,
    revision: 1,
    ...overrides,
  };
}

function completeCoverage(): HistoryCheckpoint[] {
  return sources.map((source) => checkpoint(source));
}

function project(options: {
  opening?: HistoryAccountingWalletAnchor;
  closing?: HistoryAccountingWalletAnchor;
  observations?: readonly HistoryStoredObservation[];
  conflicts?: readonly HistoryConflictSummary[];
  coverage?: readonly HistoryCheckpoint[];
}) {
  return projectHistoryAccountingEpoch({
    scope,
    opening: options.opening ?? anchor("opening", openingAt),
    closing: options.closing ?? anchor("closing", closingAt),
    observations: options.observations ?? [],
    conflicts: options.conflicts ?? [],
    coverage: options.coverage ?? completeCoverage(),
  });
}

function projectScoped(options: {
  opening?: HistoryAccountingWalletAnchor;
  closing?: HistoryAccountingWalletAnchor;
  observations?: readonly HistoryStoredObservation[];
  conflicts?: readonly HistoryConflictSummary[];
  coverage?: readonly HistoryCheckpoint[];
}) {
  return projectScopedHistoryAccountingEpoch({
    scope,
    accountingScope,
    opening: options.opening ?? anchor("opening", openingAt),
    closing: options.closing ?? anchor("closing", closingAt),
    observations: options.observations ?? [],
    conflicts: options.conflicts ?? [],
    coverage: options.coverage ?? completeCoverage(),
  });
}

function reasons(result: ReturnType<typeof projectHistoryAccountingEpoch>) {
  if (!result.ok) throw new Error(result.error.message);
  return result.value.reasonCodes;
}

test("a caller-built wallet anchor cannot establish an accounting epoch", () => {
  const trustedOpening = anchor("opening", openingAt);
  const untrustedOpening = { ...trustedOpening, anchorId: "forged-opening" };
  const result = project({ opening: untrustedOpening });

  assert.equal(unwrap(result).readiness, "NOT_READY");
  assert.ok(reasons(result).includes("ANCHOR_CAPTURE_INVALID"));
});

test("reconciles an exact USDT opening + unique transaction change to closing balance", () => {
  const result = project({
    closing: anchor("closing", closingAt, { USDT: "101" }),
    observations: [transaction("tx-1", "1")],
  });

  assert.equal(
    unwrap(result).status,
    "RECONCILED",
    unwrap(result).reasonCodes.join(","),
  );
  assert.deepEqual(unwrap(result).currencies, [
    {
      currency: "USDT",
      openingBalance: "100",
      transactionChange: "1",
      transferChange: "0",
      expectedClosingBalance: "101",
      closingBalance: "101",
      unexplainedDrift: "0",
    },
  ]);
});

test("does not report ready when an execution fee has no matching transaction evidence", () => {
  const result = unwrap(
    project({
      observations: [executionObservation({ execFee: "0.01" })],
    }),
  );

  assert.equal(result.status, "NOT_READY");
  assert.ok(result.reasonCodes.includes("TRANSACTION_EXECUTION_MISMATCH"));
});

test("detects offsetting trade movements omitted from execution evidence even when wallet drift is zero", () => {
  const result = unwrap(
    project({
      observations: [
        transaction("tx-in", "1", {
          type: "TRADE",
          category: "linear",
          symbol: "DOGEUSDT",
          side: "Buy",
          qty: "1",
          size: "1",
          tradePrice: "1",
          cashFlow: "1",
          fee: "0",
          tradeId: "exec-in",
          orderId: "order-in",
        }),
        transaction("tx-out", "-1", {
          type: "TRADE",
          category: "linear",
          symbol: "DOGEUSDT",
          side: "Sell",
          qty: "1",
          size: "1",
          tradePrice: "1",
          cashFlow: "-1",
          fee: "0",
          tradeId: "exec-out",
          orderId: "order-out",
        }),
      ],
    }),
  );

  assert.equal(result.status, "NOT_READY");
  assert.equal(result.currencies[0]?.unexplainedDrift, "0");
  assert.ok(result.reasonCodes.includes("TRANSACTION_EXECUTION_MISMATCH"));
});

test("accepts an exact linked transaction and execution with matching fee evidence", () => {
  const result = unwrap(
    project({
      closing: anchor("closing", closingAt, { USDT: "100.99" }),
      observations: [
        transaction("tx-execution-1", "0.99", {
          type: "TRADE",
          category: "linear",
          symbol: "DOGEUSDT",
          side: "Buy",
          qty: "1",
          size: "1",
          tradePrice: "1",
          cashFlow: "1",
          fee: "0.01",
          change: "0.99",
          tradeId: "trade-1",
          orderId: "order-1",
        }),
        executionObservation({ execFee: "0.01" }),
      ],
    }),
  );

  assert.equal(result.status, "RECONCILED", result.reasonCodes.join(","));
  assert.equal(result.currencies[0]?.transactionChange, "0.99");
});

test("provider-shaped Bybit execution and transaction responses reconcile through production mappers", () => {
  const eventTimeMs = Date.parse("2026-10-27T10:05:00.000Z");
  const collectedAtMs = Date.parse("2026-10-27T10:06:00.000Z");
  const executions = mapBybitExecutionResponse(
    {
      result: {
        category: "linear",
        list: [
          {
            symbol: "DOGEUSDT",
            orderId: "order-1",
            orderLinkId: "",
            execId: "exec-provider-1",
            orderPrice: "1",
            orderQty: "1",
            side: "Buy",
            execType: "Trade",
            execPrice: "1",
            execQty: "1",
            execValue: "1",
            execFee: "0.01",
            feeCurrency: "USDT",
            execTime: String(eventTimeMs),
          },
        ],
      },
    },
    collectedAtMs,
  );
  const transactions = mapBybitTransactionLogResponse(
    {
      result: {
        accountType: "UNIFIED",
        list: [
          {
            id: "transaction-provider-1",
            type: "TRADE",
            transSubType: "",
            side: "Buy",
            category: "linear",
            symbol: "DOGEUSDT",
            currency: "USDT",
            qty: "1",
            size: "1",
            tradePrice: "1",
            cashFlow: "1",
            funding: "0",
            fee: "0.01",
            change: "0.99",
            bonusChange: "0",
            cashBalance: "100",
            tradeId: "trade-provider-1",
            orderId: "order-1",
            transactionTime: String(eventTimeMs),
          },
        ],
      },
    },
    collectedAtMs,
  );
  const result = unwrap(
    project({
      closing: anchor("closing", closingAt, { USDT: "100.99" }),
      observations: [
        storedMappedFact(executions[0]!, "mapped-exec-1"),
        storedMappedFact(transactions[0]!, "mapped-tx-1"),
      ],
    }),
  );

  assert.equal(result.status, "RECONCILED", result.reasonCodes.join(","));
  assert.equal(result.currencies[0]?.transactionChange, "0.99");
});

test("closed-PnL close fee must equal the linked execution fees", () => {
  const result = unwrap(
    project({
      observations: [
        transaction("tx-close", "0", {
          type: "TRADE",
          category: "linear",
          symbol: "DOGEUSDT",
          side: "Sell",
          qty: "1",
          size: "1",
          tradePrice: "1",
          cashFlow: "0.01",
          fee: "0.01",
          change: "0",
          tradeId: "trade-close",
          orderId: "order-close",
        }),
        executionObservation({
          orderId: "order-close",
          execId: "order-close",
          side: "Sell",
          execFee: "0.01",
        }),
        supportingObservation(
          "closed-pnl",
          "order-close",
          "2026-10-27T10:05:00.000Z",
          "0",
          "0.02",
        ),
      ],
    }),
  );

  assert.equal(result.status, "NOT_READY");
  assert.ok(result.reasonCodes.includes("CLOSED_PNL_EXECUTION_MISMATCH"));
});

test("includes known transfers in the account bridge without classifying them as strategy profit", () => {
  const result = unwrap(
    project({
      closing: anchor("closing", closingAt, { USDT: "120" }),
      observations: [
        transaction("transfer-1", "20", {
          type: "TRANSFER_IN",
          category: null,
          symbol: null,
        }),
      ],
    }),
  );

  assert.equal(result.status, "RECONCILED", result.reasonCodes.join(","));
  assert.equal(result.currencies[0]?.transactionChange, "20");
  assert.equal(result.currencies[0]?.transferChange, "20");
  assert.equal("strategyProfit" in (result.currencies[0] ?? {}), false);
});

test("does not waive a one-unit exact-decimal bridge drift", () => {
  const result = unwrap(
    project({
      closing: anchor("closing", closingAt, { USDT: "102" }),
      observations: [transaction("tx-1", "1")],
    }),
  );

  assert.equal(result.status, "NOT_READY");
  assert.ok(result.reasonCodes.includes("UNEXPLAINED_DRIFT"));
  assert.equal(result.currencies[0]?.unexplainedDrift, "1");
});

test("does not zero-fill a missing coin balance and marks non-USDT supported-scope assets", () => {
  const missingCoin = unwrap(
    project({
      observations: [transaction("tx-usdc", "1", { currency: "USDC" })],
    }),
  );
  assert.equal(missingCoin.status, "NOT_READY");
  assert.ok(missingCoin.reasonCodes.includes("MISSING_COIN_BALANCE"));
  assert.equal(
    missingCoin.currencies.find((row) => row.currency === "USDC")
      ?.openingBalance,
    null,
  );

  const missingUsdt = unwrap(
    project({
      opening: anchor("opening", openingAt, { USDC: "0" }),
      closing: anchor("closing", closingAt, { USDC: "0" }),
    }),
  );
  assert.equal(missingUsdt.status, "NOT_READY");
  assert.ok(missingUsdt.reasonCodes.includes("MISSING_COIN_BALANCE"));

  const mixed = unwrap(
    project({
      opening: anchor("opening", openingAt, { USDT: "100", USDC: "0" }),
      closing: anchor("closing", closingAt, { USDT: "100", USDC: "0" }),
    }),
  );
  assert.equal(mixed.status, "NOT_READY");
  assert.ok(mixed.reasonCodes.includes("UNSUPPORTED_CURRENCY"));
});

test("accepts a fully covered USDT-only bridge while rejecting unsupported mixed currency", () => {
  const usdtOnly = unwrap(project({}));
  assert.equal(usdtOnly.status, "RECONCILED", usdtOnly.reasonCodes.join(","));
  assert.deepEqual(
    usdtOnly.currencies.map((row) => row.currency),
    ["USDT"],
  );

  const mixed = unwrap(
    project({
      opening: anchor("opening", openingAt, { USDT: "100", BTC: "0" }),
      closing: anchor("closing", closingAt, { USDT: "100", BTC: "0" }),
    }),
  );
  assert.equal(mixed.status, "NOT_READY");
  assert.ok(mixed.reasonCodes.includes("UNSUPPORTED_CURRENCY"));

  const closing = anchor("closing", closingAt);
  const differentUsdValuation = unwrap(
    project({
      closing: authenticateFixtureAnchor({
        ...closing,
        totals: {
          ...closing.totals,
          totalEquity: usdFact("999999"),
          totalPerpUPL: usdFact("-999899"),
        },
      }),
    }),
  );
  assert.equal(
    differentUsdValuation.status,
    "RECONCILED",
    differentUsdValuation.reasonCodes.join(","),
  );
});

test("scoped epoch reconciles USDT while excluding an independent MNT transfer", () => {
  const anchors = {
    opening: anchor("opening", openingAt, { USDT: "100", MNT: "20" }),
    closing: anchor("closing", closingAt, { USDT: "100", MNT: "21" }),
  };
  const observations = [
    transaction("tx-mnt-transfer", "1", {
      currency: "MNT",
      type: "TRANSFER_IN",
      cashFlow: "1",
      funding: "0",
      fee: "0",
      change: "1",
    }),
  ];
  const result = unwrap(projectScoped({ ...anchors, observations }));

  assert.equal(result.schemaVersion, "history-accounting-epoch-projection/v2");
  assert.equal(result.status, "RECONCILED", result.reasonCodes.join(","));
  assert.equal(result.accountingScope?.scopeHash, accountingScope.scopeHash);
  assert.deepEqual(
    result.currencies.map((row) => row.currency),
    ["USDT"],
  );
  assert.ok(
    result.exclusions.some(
      (row) => row.kind === "anchor-balance" && row.currency === "MNT",
    ),
  );
  assert.ok(
    result.exclusions.some(
      (row) => row.kind === "transaction" && row.currency === "MNT",
    ),
  );

  const legacy = unwrap(project({ ...anchors, observations }));
  assert.equal(legacy.status, "NOT_READY");
  assert.ok(legacy.reasonCodes.includes("UNSUPPORTED_CURRENCY"));
});

test("scoped epoch rejects structurally duplicated excluded anchor balances", () => {
  const opening = anchor("opening", openingAt, { USDT: "100", MNT: "20" });
  const mnt = opening.assets.find((row) => row.coin === "MNT");
  assert.ok(mnt);
  const duplicateOpening = authenticateFixtureAnchor({
    ...opening,
    assets: [...opening.assets, mnt],
  });

  const result = unwrap(projectScoped({ opening: duplicateOpening }));
  assert.equal(result.status, "NOT_READY");
  assert.ok(result.reasonCodes.includes("ANCHOR_CAPTURE_INVALID"));
  assert.ok(!result.reasonCodes.includes("DUPLICATE_COIN_BALANCE"));
});

test("scoped epoch retains a linked MNT fee and blocks unknown MNT movements", () => {
  const linkedFee = transaction("tx-mnt-fee", "-0.1", {
    currency: "MNT",
    type: "TRADE",
    category: "linear",
    symbol: "DOGEUSDT",
    side: "Buy",
    qty: "1",
    tradePrice: "1",
    cashFlow: "0",
    funding: "0",
    fee: "0.1",
    orderId: "order-linked-fee",
  });
  const usdtTrade = transaction("tx-usdt-trade", "0", {
    currency: "USDT",
    type: "SETTLEMENT",
    orderId: "order-linked-fee",
  });
  const feeResult = unwrap(
    projectScoped({ observations: [usdtTrade, linkedFee] }),
  );
  assert.equal(feeResult.status, "NOT_READY");
  assert.ok(feeResult.reasonCodes.includes("UNSUPPORTED_CURRENCY"));
  assert.ok(
    feeResult.selectedEvidenceIdentities.some(
      (identity) => identity.eventIdentity === linkedFee.eventIdentity,
    ),
  );

  const unknown = transaction("tx-mnt-unknown", "1", {
    currency: "MNT",
    type: "NEW_PROVIDER_TYPE",
  });
  const unknownResult = unwrap(projectScoped({ observations: [unknown] }));
  assert.equal(unknownResult.status, "NOT_READY");
  assert.ok(unknownResult.reasonCodes.includes("UNKNOWN_TRANSACTION_TYPE"));
  assert.ok(unknownResult.reasonCodes.includes("UNSUPPORTED_CURRENCY"));
});

test("scoped epoch blocks an ambiguous MNT transaction revision", () => {
  const mnt = transaction("tx-mnt-ambiguous", "1", {
    currency: "MNT",
    type: "TRANSFER_IN",
  });
  const conflict: HistoryConflictSummary = {
    conflictId: "conflict-mnt-ambiguous",
    source: "transaction-log",
    eventIdentity: mnt.eventIdentity,
    existingHash: mnt.contentHash,
    incomingHash: `sha256:${"f".repeat(64)}`,
    reason: "IMMUTABLE_ID_CONTENT_CHANGED",
    recordedAt: "2026-10-27T10:07:00.000Z" as UtcTimestamp,
    windows: [],
  };
  const result = unwrap(
    projectScoped({ observations: [mnt], conflicts: [conflict] }),
  );

  assert.equal(result.status, "NOT_READY");
  assert.ok(result.reasonCodes.includes("TRANSACTION_IDENTITY_CONFLICT"));
  assert.equal(result.exclusions.length, 0);
});

test("unknown transaction type and incomplete funding components keep readiness blocked", () => {
  const unknownType = unwrap(
    project({
      observations: [transaction("tx-unknown", "0", { type: "FUTURE_TYPE" })],
    }),
  );
  assert.equal(unknownType.status, "NOT_READY");
  assert.ok(unknownType.reasonCodes.includes("UNKNOWN_TRANSACTION_TYPE"));

  const missingFunding = unwrap(
    project({
      observations: [
        transaction("tx-funding", "0.1", {
          type: "SETTLEMENT",
          cashFlow: "0",
          funding: null,
          fee: "0",
        }),
      ],
    }),
  );
  assert.equal(missingFunding.status, "NOT_READY");
  assert.ok(
    missingFunding.reasonCodes.includes("TRANSACTION_COMPONENTS_INCOMPLETE"),
  );

  const optionalTradeFunding = unwrap(
    project({
      closing: anchor("closing", closingAt, { USDT: "100.1" }),
      observations: [
        transaction("tx-trade-funding", "0.1", {
          type: "TRADE",
          category: "linear",
          symbol: "DOGEUSDT",
          side: "Buy",
          qty: "1",
          size: "1",
          tradePrice: "1",
          orderId: "order-1",
          cashFlow: "0.1",
          funding: null,
        }),
        supportingObservation("executions", "order-1"),
      ],
    }),
  );
  assert.equal(optionalTradeFunding.status, "RECONCILED");
  assert.equal(optionalTradeFunding.currencies[0]?.transactionChange, "0.1");

  const unknownCurrency = unwrap(
    project({
      observations: [transaction("tx-no-currency", "0", { currency: null })],
    }),
  );
  assert.ok(
    unknownCurrency.reasonCodes.includes("UNKNOWN_TRANSACTION_CURRENCY"),
  );

  const unknownChange = unwrap(
    project({
      observations: [transaction("tx-no-change", "0", { change: null })],
    }),
  );
  assert.ok(unknownChange.reasonCodes.includes("UNKNOWN_TRANSACTION_CHANGE"));
});

test("a balanced spot transaction remains visible but blocks full-account equality", () => {
  const result = unwrap(
    project({
      closing: anchor("closing", closingAt, { USDT: "101" }),
      observations: [
        transaction("tx-spot", "1", {
          category: "spot",
          symbol: "BTCUSDT",
          cashFlow: "1",
        }),
      ],
    }),
  );
  assert.equal(result.status, "NOT_READY");
  assert.ok(result.reasonCodes.includes("UNSUPPORTED_TRANSACTION_CATEGORY"));
});

test("mismatched transaction components and nonzero bonus semantics keep readiness blocked", () => {
  const mismatch = unwrap(
    project({
      observations: [transaction("tx-mismatch", "1", { cashFlow: "2" })],
    }),
  );
  assert.ok(mismatch.reasonCodes.includes("TRANSACTION_COMPONENT_MISMATCH"));

  const bonus = unwrap(
    project({
      observations: [transaction("tx-bonus", "1", { bonusChange: "1" })],
    }),
  );
  assert.ok(bonus.reasonCodes.includes("UNSUPPORTED_BONUS_MOVEMENT"));

  const borrowed = anchor(
    "opening",
    openingAt,
    { USDT: "100" },
    {
      assets: [
        {
          ...asset("USDT", "100"),
          borrowAmount: coinFact("0.01"),
        },
      ],
    },
  );
  assert.ok(
    reasons(project({ opening: borrowed })).includes(
      "UNSUPPORTED_BALANCE_SEMANTICS",
    ),
  );
});

test("counts an exact native transaction identity once and blocks changed identity conflicts", () => {
  const duplicate = transaction("tx-duplicate", "1", {}, "obs-duplicate-copy");
  const result = unwrap(
    project({
      closing: anchor("closing", closingAt, { USDT: "101" }),
      observations: [transaction("tx-duplicate", "1"), duplicate],
    }),
  );
  assert.equal(result.status, "RECONCILED", result.reasonCodes.join(","));
  assert.equal(result.currencies[0]?.transactionChange, "1");

  const changed = transaction("tx-conflict", "1", {}, "obs-conflict-a");
  const changedVersion = transaction("tx-conflict", "2", {}, "obs-conflict-b");
  const conflictedTransactionWindow = checkpoint(
    "transaction-log",
    startMs + 1,
    endMs,
    {
      conflictCount: 1,
    },
  );
  const conflict = unwrap(
    project({
      observations: [changed, changedVersion],
      conflicts: [
        {
          conflictId: "conflict-1",
          source: "transaction-log",
          eventIdentity: "transaction:tx-conflict",
          existingHash: changed.contentHash,
          incomingHash: changedVersion.contentHash,
          reason: "IMMUTABLE_ID_CONTENT_CHANGED",
          recordedAt: "2026-10-27T10:07:00.000Z" as UtcTimestamp,
          windows: [
            {
              filterHash: conflictedTransactionWindow.filterHash,
              window: conflictedTransactionWindow.window,
            },
          ],
        },
      ],
      coverage: [
        ...completeCoverage().filter((row) => row.source !== "transaction-log"),
        conflictedTransactionWindow,
      ],
    }),
  );
  assert.equal(conflict.status, "NOT_READY");
  assert.ok(conflict.reasonCodes.includes("TRANSACTION_IDENTITY_CONFLICT"));
});

test("requires contiguous leading, interior, and trailing coverage for every source", () => {
  for (const source of sources) {
    const leading = completeCoverage().filter((row) => row.source !== source);
    leading.push(checkpoint(source, startMs - 99, endMs + 100));
    assert.ok(
      reasons(project({ coverage: leading })).includes("HISTORY_COVERAGE_GAP"),
    );

    const interior = completeCoverage().filter((row) => row.source !== source);
    interior.push(checkpoint(source, startMs - 100, startMs + 10_000));
    interior.push(checkpoint(source, startMs + 10_002, endMs + 100));
    assert.ok(
      reasons(project({ coverage: interior })).includes("HISTORY_COVERAGE_GAP"),
    );

    const trailing = completeCoverage().filter((row) => row.source !== source);
    trailing.push(checkpoint(source, startMs - 100, endMs + 99));
    assert.ok(
      reasons(project({ coverage: trailing })).includes("HISTORY_COVERAGE_GAP"),
    );
  }
});

test("requires every source to cover both wallet-capture uncertainty brackets", () => {
  for (const source of sources) {
    for (const [fromMs, toMs] of [
      [startMs + 1, endMs + 100],
      [startMs - 100, endMs],
    ]) {
      const coverage = completeCoverage().filter(
        (row) => row.source !== source,
      );
      coverage.push(checkpoint(source, fromMs, toMs));
      assert.ok(
        reasons(project({ coverage })).includes("HISTORY_COVERAGE_GAP"),
        `${source} must cover ${fromMs}..${toMs}`,
      );
    }
  }
});

test("a conflict outside a narrow report epoch does not block a broad covered window", () => {
  const outsideMs = startMs - 60_000;
  const broad = checkpoint("executions", outsideMs, endMs + 100, {
    conflictCount: 1,
  });
  const outsideObservation = executionObservation({
    execId: "outside-conflict",
    orderId: "outside-conflict",
    providerEventTime: new Date(outsideMs + 30_000).toISOString(),
  });
  const result = unwrap(
    project({
      observations: [outsideObservation],
      conflicts: [
        {
          conflictId: "outside-epoch-conflict",
          source: "executions",
          eventIdentity: outsideObservation.eventIdentity,
          existingHash: `sha256:${"a".repeat(64)}`,
          incomingHash: `sha256:${"b".repeat(64)}`,
          reason: "IMMUTABLE_ID_CONTENT_CHANGED",
          recordedAt: "2026-10-27T10:08:00.000Z" as UtcTimestamp,
          windows: [{ filterHash: broad.filterHash, window: broad.window }],
        },
      ],
      coverage: [
        ...completeCoverage().filter((row) => row.source !== "executions"),
        broad,
      ],
    }),
  );

  assert.equal(result.status, "RECONCILED", result.reasonCodes.join(","));
  assert.equal(result.reasonCodes.includes("HISTORY_COVERAGE_CONFLICT"), false);
});

test("a matched conflict in an anchor-capture query window blocks readiness", () => {
  for (const [window, storedTime] of [
    [
      { fromMs: startMs - 100, toMs: startMs },
      new Date(startMs - 1_000).toISOString(),
    ],
    [
      { fromMs: endMs, toMs: endMs + 100 },
      new Date(endMs + 1_000).toISOString(),
    ],
  ] as const) {
    const stored = supportingObservation(
      "order-history",
      "boundary-conflict",
      storedTime,
    );
    const boundaryCheckpoint = checkpoint(
      "order-history",
      window.fromMs,
      window.toMs,
      { conflictCount: 1 },
    );
    const result = unwrap(
      project({
        observations: [stored],
        conflicts: [
          {
            conflictId: "boundary-order-revision",
            source: "order-history",
            eventIdentity: stored.eventIdentity,
            existingHash: stored.contentHash,
            incomingHash: `sha256:${"c".repeat(64)}`,
            reason: "ORDER_REVISION_CONTENT_CHANGED",
            recordedAt: "2026-10-27T10:08:00.000Z" as UtcTimestamp,
            windows: [
              {
                filterHash: boundaryCheckpoint.filterHash,
                window: boundaryCheckpoint.window,
              },
            ],
          },
        ],
        coverage: [...completeCoverage(), boundaryCheckpoint],
      }),
    );

    assert.equal(result.status, "NOT_READY", result.reasonCodes.join(","));
    assert.ok(result.reasonCodes.includes("HISTORY_SOURCE_CONFLICT"));
  }
});

test("an unlocated checkpoint conflict remains fail-closed", () => {
  const conflicted = checkpoint("executions", startMs + 1, endMs, {
    conflictCount: 1,
  });
  const result = unwrap(
    project({
      coverage: [
        ...completeCoverage().filter((row) => row.source !== "executions"),
        conflicted,
      ],
    }),
  );

  assert.equal(result.status, "NOT_READY");
  assert.ok(result.reasonCodes.includes("HISTORY_COVERAGE_CONFLICT"));
});

test("requires compatible filters and traversed status for all four coverage sources", () => {
  for (const source of sources) {
    const wrongFilter = completeCoverage();
    const filters =
      source === "transaction-log"
        ? {
            accountType: "CONTRACT",
            purpose: "backfill",
            rangeStartMs: startMs + 1,
            rangeEndMs: endMs,
          }
        : {
            category: "inverse",
            purpose: "backfill",
            rangeStartMs: startMs + 1,
            rangeEndMs: endMs,
          };
    wrongFilter[sources.indexOf(source)] = checkpoint(
      source,
      startMs + 1,
      endMs,
      {
        filters,
        filterHash: unwrap(hashCanonical(filters)),
      },
    );
    assert.ok(
      reasons(project({ coverage: wrongFilter })).includes(
        "HISTORY_COVERAGE_FILTER_INCOMPATIBLE",
      ),
      `${source} wrong filter should be rejected`,
    );
  }

  const partial = completeCoverage();
  partial[1] = checkpoint("executions", startMs + 1, endMs, {
    status: "partial",
  });
  assert.ok(
    reasons(project({ coverage: partial })).includes("HISTORY_COVERAGE_GAP"),
  );

  const obsoleteFilters = {
    category: "spot",
    purpose: "backfill",
    rangeStartMs: startMs - 10_000,
    rangeEndMs: startMs - 101,
  };
  const withOldOutOfEpochWindow = [
    ...completeCoverage(),
    checkpoint("executions", startMs - 10_000, startMs - 101, {
      filters: obsoleteFilters,
      filterHash: unwrap(hashCanonical(obsoleteFilters)),
    }),
  ];
  assert.equal(
    unwrap(project({ coverage: withOldOutOfEpochWindow })).status,
    "RECONCILED",
  );
});

test("accepts a genuine historical opening anchor without expiring it by capture age", () => {
  const oldOpeningTime = "2026-09-01T00:00:00.000Z" as UtcTimestamp;
  const currentClosingTime = "2026-10-27T00:00:00.000Z" as UtcTimestamp;
  const historic = anchor("opening", oldOpeningTime);
  const current = anchor("closing", currentClosingTime);
  const coverage: HistoryCheckpoint[] = [];
  const firstWindowStart = Date.parse(oldOpeningTime) - 100;
  const finalWindowEnd = Date.parse(currentClosingTime) + 100;
  const maxWindowMs = 7 * 24 * 60 * 60 * 1_000;
  for (const source of sources) {
    let fromMs = firstWindowStart;
    while (fromMs < finalWindowEnd) {
      const toMs = Math.min(finalWindowEnd, fromMs + maxWindowMs);
      coverage.push(checkpoint(source, fromMs, toMs));
      fromMs = toMs + 1;
    }
  }
  const result = unwrap(
    project({
      opening: historic,
      closing: current,
      coverage,
    }),
  );

  assert.equal(result.status, "RECONCILED", result.reasonCodes.join(","));
});

test("does not fabricate an opening anchor or a zero coin balance", () => {
  const result = unwrap(
    projectHistoryAccountingEpoch({
      scope,
      opening: undefined as unknown as HistoryAccountingWalletAnchor,
      closing: anchor("closing", closingAt),
      observations: [],
      conflicts: [],
      coverage: completeCoverage(),
    }),
  );

  assert.equal(result.status, "NOT_READY");
  assert.ok(result.reasonCodes.includes("ANCHOR_CAPTURE_INVALID"));
  assert.ok(result.reasonCodes.includes("MISSING_COIN_BALANCE"));
  assert.equal(result.epoch.openingBoundary, "unknown");
});

test("marks a transaction in an anchor collection bracket or equal to a cutoff not ready", () => {
  const openingBracket = unwrap(
    project({
      observations: [
        transaction("tx-race", "0", {
          cashFlow: "0",
          providerEventTime: new Date(startMs + 50).toISOString(),
        }),
      ],
    }),
  );
  assert.ok(
    openingBracket.reasonCodes.includes("ANCHOR_BOUNDARY_EVENT_AMBIGUOUS"),
  );

  const closingBracket = unwrap(
    project({
      observations: [
        transaction("tx-closing-race", "0", {
          cashFlow: "0",
          providerEventTime: new Date(endMs + 50).toISOString(),
        }),
      ],
    }),
  );
  assert.ok(
    closingBracket.reasonCodes.includes("ANCHOR_BOUNDARY_EVENT_AMBIGUOUS"),
  );

  const atClosing = unwrap(
    project({
      observations: [
        transaction("tx-cutoff", "0", {
          cashFlow: "0",
          providerEventTime: closingAt,
        }),
      ],
    }),
  );
  assert.ok(atClosing.reasonCodes.includes("ANCHOR_BOUNDARY_EVENT_AMBIGUOUS"));
});

test("rejects forged anchor binding, cross-scope observations, and unordered provider brackets", () => {
  const forged = anchor(
    "opening",
    openingAt,
    { USDT: "100" },
    {
      accountBinding: {
        exchange: "bybit",
        environment: "mainnet",
        origin: "https://api.bybit.com",
        accountIdentityHash: `sha256:${"d".repeat(64)}`,
        authenticatedAt: openingAt,
        identityVerified: true,
      },
    },
  );
  assert.ok(
    reasons(project({ opening: forged })).includes("ANCHOR_SCOPE_MISMATCH"),
  );

  const forgedExchangeScope: HistoryStoreScope = {
    ...scope,
    exchange: "other",
  };
  const invalidScopeProjection = projectHistoryAccountingEpoch({
    scope: forgedExchangeScope,
    opening: anchor(
      "opening",
      openingAt,
      { USDT: "100" },
      {
        scope: forgedExchangeScope,
      },
    ),
    closing: anchor(
      "closing",
      closingAt,
      { USDT: "100" },
      {
        scope: forgedExchangeScope,
      },
    ),
    observations: [],
    conflicts: [],
    coverage: completeCoverage(),
  });
  assert.ok(reasons(invalidScopeProjection).includes("ANCHOR_SCOPE_MISMATCH"));

  const wrongEnvironment = anchor(
    "opening",
    openingAt,
    { USDT: "100" },
    {
      accountBinding: {
        exchange: "bybit",
        environment: "testnet",
        origin: "https://api-testnet.bybit.com",
        accountIdentityHash: scope.accountId,
        authenticatedAt: openingAt,
        identityVerified: true,
      },
    },
  );
  assert.ok(
    reasons(project({ opening: wrongEnvironment })).includes(
      "ANCHOR_SCOPE_MISMATCH",
    ),
  );

  const crossScope = transaction("tx-scope", "0");
  (crossScope as { scope: HistoryStoreScope }).scope = {
    ...scope,
    accountId: `sha256:${"e".repeat(64)}`,
  };
  assert.ok(
    reasons(project({ observations: [crossScope] })).includes(
      "HISTORY_SCOPE_MISMATCH",
    ),
  );

  const unordered = anchor(
    "closing",
    closingAt,
    { USDT: "100" },
    {
      capture: {
        ...anchor("closing", closingAt).capture,
        providerTimeBefore: "2026-10-27T10:10:00.100Z" as UtcTimestamp,
        providerResponseTime: closingAt,
      },
    },
  );
  assert.ok(
    reasons(project({ closing: unordered })).includes("ANCHOR_TIME_INVALID"),
  );
});

test("ignores out-of-epoch closed-PnL revisions while blocking an in-epoch conflict", () => {
  const outsideTime = "2026-10-26T10:05:00.000Z";
  const outside = unwrap(
    project({
      observations: [
        supportingObservation("closed-pnl", "old-close", outsideTime, "1"),
        supportingObservation("closed-pnl", "old-close", outsideTime, "2"),
      ],
    }),
  );
  assert.equal(outside.status, "RECONCILED", outside.reasonCodes.join(","));

  const inside = unwrap(
    project({
      observations: [
        supportingObservation("closed-pnl", "current-close", undefined, "1"),
        supportingObservation("closed-pnl", "current-close", undefined, "2"),
      ],
    }),
  );
  assert.equal(inside.status, "NOT_READY");
  assert.ok(inside.reasonCodes.includes("CLOSED_PNL_REVISION_CONFLICT"));
});

test("zero drift is not ready when a required history source lacks execution or fee corroboration coverage", () => {
  for (const missing of ["executions", "transaction-log"] as const) {
    const result = unwrap(
      project({
        coverage: completeCoverage().filter((row) => row.source !== missing),
      }),
    );
    assert.equal(result.status, "NOT_READY");
    assert.ok(result.reasonCodes.includes("HISTORY_COVERAGE_GAP"));
  }
});
