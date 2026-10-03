import {
  accountEvidencePolicyHash,
  deriveExpectedAccountEvidencePartitions,
} from "../src/domain/account/account-evidence-policy.js";

export const known = <T>(value: T) => ({ state: "known" as const, value });
export const decimal = (
  value: string,
  unit: "coin" | "USD" | "rate" | "contracts" | "price" = "USD",
) => ({ ...known(value), unit });
export const na = { state: "not-applicable" as const };
export function order() {
  return {
    category: "linear",
    symbol: "BTCUSDT",
    orderId: "manual-1",
    orderLinkId: null,
    status: "New",
    side: "Buy",
    orderType: "Limit",
    marketUnit: na,
    price: decimal("100", "price"),
    qty: decimal("1", "contracts"),
    cumExecQty: decimal("0", "contracts"),
    leavesQty: decimal("1", "contracts"),
    positionIdx: known(0),
    reduceOnly: known(false),
    closeOnTrigger: known(false),
    triggerPrice: { ...na, unit: "price" },
    triggerDirection: na,
    triggerBy: na,
    stopOrderType: na,
    takeProfit: { ...na, unit: "price" },
    stopLoss: { ...na, unit: "price" },
    tpslMode: na,
    timeInForce: known("GTC"),
    orderFilter: known("Order"),
    createdAt: known("2026-10-02T10:00:00.000Z"),
    updatedAt: known("2026-10-02T12:00:00.000Z"),
  };
}
export function position() {
  return {
    category: "linear",
    symbol: "BTCUSDT",
    positionIdx: 0,
    side: "None",
    size: decimal("0", "contracts"),
    avgPrice: decimal("0", "price"),
    markPrice: decimal("100", "price"),
    positionValue: decimal("0"),
    unrealisedPnl: decimal("0"),
    positionIM: decimal("0"),
    positionMM: decimal("0"),
    leverage: decimal("1", "rate"),
    riskId: known(1),
    tradeMode: known(0),
    isReduceOnly: known(false),
    seq: known("0"),
    createdAt: known("2026-10-02T10:00:00.000Z"),
    updatedAt: known("2026-10-02T12:00:00.000Z"),
    takeProfit: { ...na, unit: "price" },
    stopLoss: { ...na, unit: "price" },
    trailingStop: { ...na, unit: "price" },
  };
}
export function execution(
  execId = "exec-1",
  execTime = "2026-10-02T12:00:00.000Z",
) {
  return {
    category: "linear",
    symbol: "BTCUSDT",
    execId,
    orderId: "manual-1",
    orderLinkId: null,
    execType: "Trade",
    side: "Buy",
    execTime,
    price: decimal("100", "price"),
    qty: decimal("1", "contracts"),
    fee: decimal("-0.01", "coin"),
    feeCurrency: known("USDT"),
    feeRate: decimal("-0.0001", "rate"),
    execFeeV2: { state: "unavailable", reason: "not-returned", unit: "coin" },
    extraFees: { state: "unavailable", reason: "not-returned" },
  };
}
export function fixture() {
  const start = "2026-10-02T12:00:00.000Z",
    cutoff = "2026-10-02T12:00:01.000Z",
    end = "2026-10-02T12:00:02.000Z";
  const discovery = {
    settlementCoins: ["USDT", "USDC"],
    optionBaseCoins: ["ETH"],
    exposureOptionBaseCoins: [],
    passBSettlementCoins: ["USDT", "USDC"],
    passBOptionBaseCoins: ["ETH"],
    uncoveredScopes: false,
    upgradeOverlap: false,
    separateInverseWallet: false,
  };
  const expectedPartitions = [
    ...deriveExpectedAccountEvidencePartitions(["BTCUSDT"], discovery),
  ];
  const observations = expectedPartitions.map((partition) => ({
    partition,
    startedAt: partition.pass === "A" ? start : cutoff,
    endedAt: partition.pass === "A" ? start : end,
    exchangeResponseTime: partition.pass === "A" ? start : end,
    nativeRowTimes: [],
  }));
  const asset = (coin: string) => ({
    coin,
    walletBalance: decimal("50", "coin"),
    equity: decimal("50", "coin"),
    usdValue: decimal("50"),
    usdEquity: decimal("50"),
    locked: decimal("0", "coin"),
    bonus: decimal("0", "coin"),
    borrowAmount: decimal("0", "coin"),
    spotBorrow: decimal("0", "coin"),
    accruedInterest: decimal("0", "coin"),
    totalOrderIM: decimal("0"),
    totalPositionIM: decimal("0"),
    totalPositionMM: decimal("0"),
    unrealisedPnl: decimal("0", "coin"),
    collateralEligible: known(true),
    collateralSwitch: known(true),
    restricted: known(false),
  });
  const pass = (label: "A" | "B") => ({
    account: {
      utaStatus: known(5),
      marginMode: known("REGULAR_MARGIN"),
      spotHedging: known(false),
    },
    totals: {
      totalEquity: decimal("100"),
      totalWalletBalance: decimal("100"),
      totalMarginBalance: decimal("100"),
      totalPerpUPL: decimal("0"),
      totalAvailableBalance: decimal("100"),
      totalInitialMargin: decimal("0"),
      totalMaintenanceMargin: decimal("0"),
      accountIMRate: decimal("0", "rate"),
      accountMMRate: decimal("0", "rate"),
      equityBasis: "unestablished",
    },
    assets: [asset("USDT"), asset("USDC")],
    collateral: ["USDT", "USDC"].map((coin) => ({
      coin,
      collateralEligible: known(true),
      collateralSwitch: known(true),
      restricted: known(false),
      borrowable: known(true),
      borrowAmount: decimal("0", "coin"),
      otherBorrowAmount: decimal("0", "coin"),
      maxBorrowingAmount: decimal("100", "coin"),
      hourlyBorrowRate: decimal("0", "rate"),
    })),
    positions: [],
    orders: [],
    modeProbes: [{ symbol: "BTCUSDT", positionIndices: [0] }],
    observations: observations.filter((obs) => obs.partition.pass === label),
  });
  const rowCount = (endpoint: string) =>
    endpoint === "wallet" ||
    endpoint === "collateral" ||
    endpoint === "tiers" ||
    endpoint === "settlement-discovery"
      ? 2
      : endpoint === "account-info" ||
          endpoint === "mode-probe" ||
          endpoint === "option-base-discovery"
        ? 1
        : 0;
  const hash = accountEvidencePolicyHash();
  if (!hash.ok) throw new Error("fixture policy hash failed");
  return {
    schemaVersion: "account-evidence-bundle/v1",
    runId: "run-16",
    producer: "fixture",
    accountBinding: {
      exchange: "bybit",
      environment: "demo",
      origin: "https://api-demo.bybit.com",
      accountIdentityHash: `sha256:${"a".repeat(64)}`,
      authenticatedAt: start,
      identityVerified: true,
    },
    credentialPosture: {
      readOnly: true,
      permissions: {
        contractOrder: false,
        contractPosition: false,
        spotTrade: false,
        walletTransfer: false,
        withdraw: false,
      },
      ipBound: true,
      expiresAt: null,
      warnings: [],
    },
    policyVersion: "account-evidence-collection-policy/v1",
    policyHash: hash.value,
    startedAt: start,
    endedAt: end,
    collectionStartedAt: start,
    collectionEndedAt: end,
    bundleCutoff: cutoff,
    historyWindow: {
      startedAt: "2026-10-02T11:00:01.000Z",
      endedAt: cutoff,
      selectionClock: "provider-native",
    },
    collectionStatus: "complete",
    configuredM1Symbols: ["BTCUSDT"],
    discovery,
    criticalPasses: { A: pass("A"), B: pass("B") },
    auxiliary: {
      tiers: ["USDT", "USDC"].map((coin) => ({
        coin,
        minQty: decimal("0", "coin"),
        maxQty: null,
        collateralRatio: decimal("1", "rate"),
        boundSemantics: "provider-unspecified",
      })),
      orders: [],
      executions: [] as ReturnType<typeof execution>[],
      observations: observations.filter(
        (obs) => obs.partition.pass === "auxiliary",
      ),
    },
    expectedPartitions,
    coverage: observations.map((obs) => ({
      partition: obs.partition,
      status: "traversed",
      pages: 1,
      rows: rowCount(obs.partition.endpoint),
      startedAt: obs.startedAt,
      endedAt: obs.endedAt,
      reasonCodes: [],
    })),
    budget: {
      monotonicDurationMs: 2000,
      httpAttempts: expectedPartitions.length,
      retainedRows: 16,
      maxObservedResponseBytes: 1000,
    },
    diagnostics: [],
    evidence: [],
  };
}

/** Refresh only counts after a test adds rows; never synthesizes traversal or observations. */
export function withCounts<
  T extends {
    coverage: ReturnType<typeof fixture>["coverage"];
    criticalPasses: {
      A: {
        positions: readonly { category: string }[];
        orders: readonly { category: string }[];
      };
      B: {
        positions: readonly { category: string }[];
        orders: readonly { category: string }[];
      };
    };
    auxiliary: {
      orders: readonly { category: string }[];
      executions: readonly { category: string }[];
      tiers: readonly unknown[];
    };
  },
>(input: T): T {
  for (const entry of input.coverage) {
    const p = entry.partition,
      pass =
        p.pass === "A"
          ? input.criticalPasses.A
          : p.pass === "B"
            ? input.criticalPasses.B
            : null;
    if (p.endpoint === "positions" && pass)
      entry.rows = pass.positions.filter(
        (row: { category: string }) => row.category === p.category,
      ).length;
    if (p.endpoint === "open-orders" && pass)
      entry.rows = pass.orders.filter(
        (row: { category: string }) => row.category === p.category,
      ).length;
    if (p.endpoint === "order-history")
      entry.rows = input.auxiliary.orders.filter(
        (row: { category: string }) => row.category === p.category,
      ).length;
    if (p.endpoint === "executions")
      entry.rows = input.auxiliary.executions.filter(
        (row) => row.category === p.category,
      ).length;
    if (p.endpoint === "tiers") entry.rows = input.auxiliary.tiers.length;
  }
  return input;
}
