import {
  createAccountEvidenceBundle,
  type AccountEvidenceEnvironment,
} from "../../src/domain/account/account-evidence-bundle.js";
import {
  accountEvidencePartitionKey,
  deriveExpectedAccountEvidencePartitions,
} from "../../src/domain/account/account-evidence-policy.js";
import { encodeCanonicalArtifact } from "../../src/domain/identity/canonical-artifact.js";
import { hashCanonical } from "../../src/domain/identity/canonical-serialization.js";
import { LIQUIDATION_EVIDENCE_ASSETS } from "../../src/domain/liquidation/liquidation-evidence-bundle.js";
import type { MarketEvidenceBundle } from "../../src/domain/market/market-evidence-bundle.js";
import { parseUtcTimestamp } from "../../src/domain/shared/time.js";
import { decimal, withCounts } from "../account-evidence-fixture.js";
import {
  fixtureDecimal,
  liquidationFixture,
  liquidationFixtureRef,
  marketFixture,
} from "./data-quality-fixtures.js";
import { requireDailyFixture as value } from "./daily-planning-evidence-fixtures.js";
import {
  portfolioRiskAccountInput,
  portfolioRiskMarketFixture,
  portfolioRiskOrder,
  portfolioRiskPosition,
} from "./portfolio-risk-fixtures.js";
import {
  completeMarketFixture,
  shiftAccountTimes,
} from "./prepared-plan-fixtures.js";

export const DAILY_PREPARE_RUN_ID = "daily-prepare-test-run";
export const DAILY_PREPARE_TIME = value(
  parseUtcTimestamp("2026-09-24T14:00:03.000Z"),
);
export const DAILY_PREPARE_CREDENTIALS = Object.freeze({
  apiKey: "synthetic-key",
  apiSecret: "synthetic-secret",
  accountId: "123",
});
export const DAILY_PREPARE_ORIGINS = {
  demo: "https://api-demo.bybit.com",
  testnet: "https://api-testnet.bybit.com",
  mainnet: "https://api.bybit.com",
} as const;
export const DAILY_PREPARE_SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "DOGEUSDT",
] as const;

/** Genuine full #11 cadence and instrument bounds; analytics is never stubbed. */
export function dailyPrepareMarket(runId = DAILY_PREPARE_RUN_ID) {
  const base = completeMarketFixture(portfolioRiskMarketFixture());
  return marketFixture({
    ...base,
    runId,
    symbols: base.symbols.map((row) => ({
      ...row,
      ticker: { ...row.ticker!, fundingRate: fixtureDecimal("0") },
    })),
  });
}

/** Complete/zero modes include every closed hour; missing removes one bucket.
 * An observed zero is still distinct from an omitted bucket.
 */
export function dailyPrepareLiquidation(
  market: MarketEvidenceBundle,
  mode: "complete" | "zero" | "missing" | "invalid-response" = "complete",
) {
  const last =
    Math.floor(Date.parse(market.bundleCutoff) / 3_600_000) * 3_600_000 -
    3_600_000;
  const bundle = liquidationFixture(market, {
    coverageProof: "complete",
    historyProof:
      mode === "missing" || mode === "invalid-response"
        ? "incomplete"
        : "complete",
    status:
      mode === "missing" || mode === "invalid-response"
        ? "incomplete"
        : "complete",
    targets: LIQUIDATION_EVIDENCE_ASSETS.map((asset) => ({
      asset,
      constituents: [
        {
          providerSymbol: `${asset}USDT_PERP.BYBIT`,
          exchange: "Bybit",
          symbolOnExchange: `${asset}USDT`,
          baseAsset: asset,
          quoteAsset: "USDT",
          isPerpetual: true,
          marginType: "STABLE",
          expireAt: 0,
          notionalDenominatedIn: "USD",
          observations: Array.from({ length: 24 }, (_, i) => ({
            timestamp: new Date(last - (23 - i) * 3_600_000).toISOString(),
            longUsd: mode === "zero" ? "0" : "10",
            shortUsd: mode === "zero" ? "0" : "20",
          })).filter((_, i) => mode !== "missing" || i !== 20),
        },
      ],
    })),
    diagnostics:
      mode === "missing"
        ? LIQUIDATION_EVIDENCE_ASSETS.map((asset) => ({
            code: "missing-bucket",
            operation: "fetch-liquidation-history",
            asset,
            providerSymbol: `${asset}USDT_PERP.BYBIT`,
            bucketTimestamp: new Date(last - 3 * 3_600_000).toISOString(),
          }))
        : mode === "invalid-response"
          ? [
              {
                code: "history-incomplete",
                operation: "fetch-liquidation-history",
              },
            ]
          : [],
  });
  return {
    bundle,
    artifact: value(
      encodeCanonicalArtifact("liquidation-evidence-bundle", bundle),
    ),
    evidence: liquidationFixtureRef(bundle),
  };
}

export function dailyPrepareAccount(
  options: {
    environment?: AccountEvidenceEnvironment;
    runId?: string;
    target?: "flat" | "long" | "order" | "absent";
  } = {},
) {
  const environment = options.environment ?? "demo";
  const position = portfolioRiskPosition(
    options.target === "long"
      ? {
          side: "Buy",
          size: decimal("0.1", "contracts"),
          avgPrice: decimal("100", "price"),
          positionValue: decimal("10"),
        }
      : {},
  );
  const raw = portfolioRiskAccountInput({
    positions: options.target === "absent" ? [] : [position],
    orders: options.target === "order" ? [portfolioRiskOrder()] : [],
  });
  const expectedPartitions = [
    ...deriveExpectedAccountEvidencePartitions(
      DAILY_PREPARE_SYMBOLS,
      raw.discovery,
    ),
  ];
  const coverage = expectedPartitions.map((partition) => {
    const existing = raw.coverage.find(
      (entry) =>
        accountEvidencePartitionKey(entry.partition) ===
        accountEvidencePartitionKey(partition),
    );
    if (existing) return { ...existing };
    const template = raw.coverage.find(
      (entry) =>
        entry.partition.endpoint === "mode-probe" &&
        entry.partition.pass === partition.pass,
    )!;
    return { ...template, partition };
  });
  const expandedPass = (pass: "A" | "B") => {
    const original = raw.criticalPasses[pass]!;
    const modeObservation = original.observations.find(
      (entry) => entry.partition.endpoint === "mode-probe",
    )!;
    return {
      ...original,
      modeProbes: DAILY_PREPARE_SYMBOLS.map((symbol) => ({
        symbol,
        positionIndices: [0],
      })),
      observations: expectedPartitions
        .filter((partition) => partition.pass === pass)
        .map((partition) => {
          const existing = original.observations.find(
            (entry) =>
              accountEvidencePartitionKey(entry.partition) ===
              accountEvidencePartitionKey(partition),
          );
          return existing ?? { ...modeObservation, partition };
        }),
      totals: { ...original.totals, totalAvailableBalance: decimal("1000") },
    };
  };
  const funded = withCounts({
    ...raw,
    configuredM1Symbols: [...DAILY_PREPARE_SYMBOLS],
    expectedPartitions,
    coverage,
    budget: {
      ...raw.budget,
      httpAttempts: raw.budget.httpAttempts + 6,
      retainedRows: raw.budget.retainedRows + 6,
    },
    runId: options.runId ?? DAILY_PREPARE_RUN_ID,
    accountBinding: {
      ...raw.accountBinding,
      environment,
      origin: DAILY_PREPARE_ORIGINS[environment],
      accountIdentityHash: value(
        hashCanonical({ exchange: "bybit", environment, userID: "123" }),
      ),
    },
    criticalPasses: {
      A: expandedPass("A"),
      B: expandedPass("B"),
    },
  });
  return value(createAccountEvidenceBundle(shiftAccountTimes(funded)));
}

export function dailyPrepareIdentity() {
  return {
    time: Date.parse(DAILY_PREPARE_TIME),
    result: {
      userID: 123,
      readOnly: 1,
      permissions: { ContractTrade: [], Spot: [], Wallet: [] },
      ips: [],
      expiredAt: "",
    },
  };
}
