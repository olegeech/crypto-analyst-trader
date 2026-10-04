import {
  decimal as accountDecimal,
  fixture as accountFixture,
  known as accountKnown,
  na as accountNotApplicable,
  order as accountOrder,
  position as accountPosition,
  withCounts,
} from "../account-evidence-fixture.js";
import {
  dailyMarketFixture,
  requireDailyFixture,
} from "./daily-planning-evidence-fixtures.js";
import { createInstrumentConstraints } from "../../src/domain/market/instrument-constraints.js";
import { marketFixture } from "./data-quality-fixtures.js";

export function portfolioRiskPolicyInput(
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaVersion: "portfolio-risk-policy/v1",
    policyVersion: "m1-v1",
    maxAccountEvidenceAgeMs: 60_000,
    marginReserveRatio: "0.1",
    maxDerivativesLeverage: "1",
    entryFeeRate: "0.0002",
    exitFeeRate: "0.00055",
    slippageBufferRate: "0.0005",
    minimumNetEdgeRate: "0.001",
    ...overrides,
  };
}

const zero = () => accountDecimal("0", "coin");

export function portfolioRiskPosition(
  overrides: Partial<ReturnType<typeof accountPosition>> = {},
) {
  return {
    ...accountPosition(),
    ...overrides,
  };
}

export function portfolioRiskOrder(
  overrides: Partial<ReturnType<typeof accountOrder>> = {},
) {
  return {
    ...accountOrder(),
    ...overrides,
  };
}

export function portfolioRiskWalletAsset(
  coin: string,
  options: {
    readonly balance?: string;
    readonly usdValue?: string | null;
    readonly collateralEligible?: boolean;
    readonly collateralSwitch?: boolean | "not-applicable";
    readonly restricted?:
      "unknown" | "unrestricted" | "near-limit" | "restricted" | null;
  } = {},
) {
  const balance = options.balance ?? "0";
  const eligible = options.collateralEligible ?? true;
  const switchValue =
    options.collateralSwitch ?? (eligible ? true : "not-applicable");
  const restricted = Object.hasOwn(options, "restricted")
    ? options.restricted
    : "unrestricted";
  const flag = (value: boolean) => accountKnown(value);
  const restriction =
    restricted === null
      ? { state: "unavailable" as const, reason: "not-returned" as const }
      : accountKnown(restricted);
  return {
    coin,
    walletBalance: accountDecimal(balance, "coin"),
    equity: accountDecimal(balance, "coin"),
    usdValue:
      options.usdValue === null
        ? {
            state: "unavailable" as const,
            reason: "not-returned" as const,
            unit: "USD" as const,
          }
        : accountDecimal(options.usdValue ?? balance, "USD"),
    usdEquity: {
      state: "unavailable" as const,
      reason: "not-returned" as const,
      unit: "USD" as const,
    },
    locked: zero(),
    bonus: zero(),
    borrowAmount: zero(),
    spotBorrow: zero(),
    accruedInterest: zero(),
    totalOrderIM: accountDecimal("0", "USD"),
    totalPositionIM: accountDecimal("0", "USD"),
    totalPositionMM: accountDecimal("0", "USD"),
    unrealisedPnl: zero(),
    collateralEligible: flag(eligible),
    collateralSwitch:
      switchValue === "not-applicable"
        ? accountNotApplicable
        : flag(switchValue),
    restricted: restriction,
  };
}

export function portfolioRiskCollateral(
  coin: string,
  options: {
    readonly collateralEligible?: boolean;
    readonly collateralSwitch?: boolean | "not-applicable";
    readonly restricted?:
      "unknown" | "unrestricted" | "near-limit" | "restricted" | null;
  } = {},
) {
  const eligible = options.collateralEligible ?? true;
  const switchValue =
    options.collateralSwitch ?? (eligible ? true : "not-applicable");
  const restricted = Object.hasOwn(options, "restricted")
    ? options.restricted
    : "unrestricted";
  return {
    coin,
    collateralEligible: accountKnown(eligible),
    collateralSwitch:
      switchValue === "not-applicable"
        ? accountNotApplicable
        : accountKnown(switchValue),
    restricted:
      restricted === null
        ? { state: "unavailable" as const, reason: "not-returned" as const }
        : accountKnown(restricted),
    borrowable: accountKnown(true),
    borrowAmount: zero(),
    otherBorrowAmount: zero(),
    maxBorrowingAmount: accountDecimal("100", "coin"),
    hourlyBorrowRate: accountDecimal("0", "rate"),
  };
}

export function portfolioRiskAccountInput(
  options: {
    readonly positions?: readonly ReturnType<typeof portfolioRiskPosition>[];
    readonly orders?: readonly ReturnType<typeof portfolioRiskOrder>[];
    readonly assets?: readonly ReturnType<typeof portfolioRiskWalletAsset>[];
    readonly collateral?: readonly ReturnType<typeof portfolioRiskCollateral>[];
  } = {},
) {
  const source = accountFixture();
  const positions = options.positions ?? [];
  const orders = options.orders ?? [];
  const assets = options.assets ?? [];
  const collateral = options.collateral ?? [];
  const passes = {
    A: {
      ...source.criticalPasses.A!,
      positions: [...positions],
      orders: [...orders],
      assets: [...source.criticalPasses.A!.assets, ...assets],
      collateral: [...source.criticalPasses.A!.collateral, ...collateral],
    },
    B: {
      ...source.criticalPasses.B!,
      positions: [...positions],
      orders: [...orders],
      assets: [...source.criticalPasses.B!.assets, ...assets],
      collateral: [...source.criticalPasses.B!.collateral, ...collateral],
    },
  };
  const addedRows =
    2 * (positions.length + orders.length + assets.length + collateral.length);
  const payload = {
    ...source,
    criticalPasses: passes,
    budget: {
      ...source.budget,
      retainedRows: source.budget.retainedRows + addedRows,
    },
    coverage: source.coverage.map((entry) => {
      const pass =
        entry.partition.pass === "A"
          ? passes.A
          : entry.partition.pass === "B"
            ? passes.B
            : null;
      if (!pass) return entry;
      if (entry.partition.endpoint === "wallet")
        return { ...entry, rows: pass.assets.length };
      if (entry.partition.endpoint === "collateral")
        return { ...entry, rows: pass.collateral.length };
      return entry;
    }),
  };
  return withCounts(payload);
}

export function portfolioRiskMarketFixture() {
  const base = dailyMarketFixture();
  const baseCoins = {
    BTCUSDT: "BTC",
    ETHUSDT: "ETH",
    SOLUSDT: "SOL",
    DOGEUSDT: "DOGE",
  } as const;
  const symbols = base.symbols.map((row) => {
    const constraints = requireDailyFixture(
      createInstrumentConstraints({
        instrument: row.symbol,
        version: "portfolio-risk-fixture/v1",
        priceTickSize: "0.1",
        quantityStep: "0.01",
        minQuantity: "0.01",
        minNotional: "1",
        minPrice: "0.1",
        maxPrice: "1000000",
        maxLimitQuantity: "1000000",
      }),
    );
    return {
      ...row,
      instrument: {
        symbol: row.symbol,
        status: "trading" as const,
        contractType: "LinearPerpetual" as const,
        baseCoin: baseCoins[row.symbol],
        quoteCoin: "USDT" as const,
        settleCoin: "USDT" as const,
        constraints,
        fundingInterval: 480,
        sourceTimestamp: base.bundleCutoff,
      },
    };
  });
  return marketFixture({ symbols });
}
