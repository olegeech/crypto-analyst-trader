import assert from "node:assert/strict";
import test from "node:test";

import { collectLiquidationEvidence } from "../src/application/liquidation-evidence-collection.js";
import {
  LIQUIDATION_EVIDENCE_ASSETS,
  LIQUIDATION_HISTORY_BUCKETS,
  LIQUIDATION_HOUR_MS,
} from "../src/domain/liquidation/liquidation-evidence-bundle.js";
import {
  createMarketEvidenceBundle,
  MARKET_EVIDENCE_PRODUCER,
  MARKET_EVIDENCE_SCHEMA_VERSION,
  MARKET_EVIDENCE_SYMBOLS,
  MARKET_EVIDENCE_UNIVERSE_VERSION,
  marketEvidenceContentHash,
  type MarketEvidenceBundle,
} from "../src/domain/market/market-evidence-bundle.js";
import { fixedClock } from "../src/domain/shared/time.js";
import type {
  CoinalyzeCatalogueResult,
  CoinalyzeHistoryRequest,
  CoinalyzeHistoryResult,
  CoinalyzeLiquidationDataPort,
  CoinalyzeMarket,
  CoinalyzeMarketHistory,
} from "../src/ports/coinalyze-liquidation-data.js";
import type { SecretProvider } from "../src/ports/secret-provider.js";

const API_KEY = "coinalyze-application-secret-sentinel";
const RUN_ID = "run-45-application";
const BUNDLE_CUTOFF = "2026-09-24T12:30:00.000Z";
const LAST_CLOSED_BUCKET = Date.parse("2026-09-24T11:00:00.000Z");

function timestamp(epoch: number): string {
  return new Date(epoch).toISOString();
}

function marketEvidence(
  overrides: Record<string, unknown> = {},
): MarketEvidenceBundle {
  const input = {
    runId: RUN_ID,
    schemaVersion: MARKET_EVIDENCE_SCHEMA_VERSION,
    producer: MARKET_EVIDENCE_PRODUCER,
    universeVersion: MARKET_EVIDENCE_UNIVERSE_VERSION,
    universe: [...MARKET_EVIDENCE_SYMBOLS],
    collectionStartedAt: "2026-09-24T11:55:00.000Z",
    collectionEndedAt: "2026-09-24T12:00:00.000Z",
    bundleCutoff: BUNDLE_CUTOFF,
    source: {
      exchange: "bybit",
      environment: "mainnet",
      origin: "https://api.bybit.com",
      category: "linear",
    },
    status: "incomplete",
    symbols: MARKET_EVIDENCE_SYMBOLS.map((symbol) => ({
      symbol,
      ohlcv: [],
      funding: [],
      openInterest: [],
      diagnostics: [],
    })),
    diagnostics: [],
    evidence: [
      {
        kind: "market-evidence-bundle",
        schemaVersion: "market-evidence/v1",
        producer: MARKET_EVIDENCE_PRODUCER,
        sourceId: `bybit-public:${RUN_ID}`,
        asOf: BUNDLE_CUTOFF,
        validForMs: 86_400_000,
        contentHash: `sha256:${"a".repeat(64)}`,
      },
    ],
    ...overrides,
  };
  const provisional = createMarketEvidenceBundle(input);
  assert.equal(provisional.ok, true);
  if (!provisional.ok) throw new Error("invalid market-evidence fixture");
  const identity = marketEvidenceContentHash(provisional.value);
  assert.equal(identity.ok, true);
  if (!identity.ok) throw new Error("invalid market-evidence hash fixture");
  const evidence =
    overrides.evidence ??
    provisional.value.evidence.map((reference) => ({
      ...reference,
      contentHash: identity.value,
    }));
  const created = createMarketEvidenceBundle({
    ...provisional.value,
    evidence,
  });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("invalid market-evidence fixture");
  return created.value;
}

function market(
  asset: string,
  venue: string,
  overrides: Partial<CoinalyzeMarket> = {},
): CoinalyzeMarket {
  return {
    symbol: `${asset}USDT_PERP.${venue}`,
    exchange: venue,
    symbolOnExchange: `${asset}USDT`,
    baseAsset: asset,
    quoteAsset: "USDT",
    isPerpetual: true,
    marginType: "STABLE",
    expireAt: 0,
    notionalDenominatedIn: "USD",
    ...overrides,
  };
}

function targetMarkets(perAssetCount = 1): CoinalyzeMarket[] {
  return LIQUIDATION_EVIDENCE_ASSETS.flatMap((asset) =>
    Array.from({ length: perAssetCount }, (_, index) =>
      market(asset, `VENUE${index + 1}`),
    ),
  );
}

function completeHistories(
  symbols: readonly string[],
  options: { missing?: ReadonlyMap<string, number> } = {},
): readonly CoinalyzeMarketHistory[] {
  return symbols.map((symbol) => ({
    symbol,
    observations: Array.from(
      { length: LIQUIDATION_HISTORY_BUCKETS },
      (_, index) => {
        const bucket =
          LAST_CLOSED_BUCKET -
          (LIQUIDATION_HISTORY_BUCKETS - 1 - index) * LIQUIDATION_HOUR_MS;
        if (options.missing?.get(symbol) === bucket) return undefined;
        return {
          timestamp: timestamp(bucket),
          longUsd: index === 0 ? "0" : String(index + 1),
          shortUsd: index === 0 ? "0" : String((index + 1) * 2),
        };
      },
    ).filter((observation) => observation !== undefined),
  }));
}

function diagnostics(
  code: CoinalyzeCatalogueResult["diagnostics"][number]["code"],
  operation: CoinalyzeCatalogueResult["diagnostics"][number]["operation"],
) {
  return [{ code, operation }];
}

function harness(
  options: {
    readonly markets?: readonly CoinalyzeMarket[];
    readonly catalogueComplete?: boolean;
    readonly catalogueDiagnostics?: CoinalyzeCatalogueResult["diagnostics"];
    readonly histories?: (
      request: CoinalyzeHistoryRequest,
    ) => CoinalyzeHistoryResult;
    readonly secret?: SecretProvider;
    readonly evidence?: MarketEvidenceBundle;
  } = {},
) {
  const calls: Array<{
    kind: string;
    apiKey?: string;
    request?: CoinalyzeHistoryRequest;
  }> = [];
  const selectedMarkets = options.markets ?? targetMarkets();
  const data: CoinalyzeLiquidationDataPort = {
    async fetchFutureMarkets(apiKey) {
      calls.push({ kind: "catalogue", apiKey });
      return {
        markets: selectedMarkets,
        complete: options.catalogueComplete ?? true,
        diagnostics: options.catalogueDiagnostics ?? [],
      };
    },
    async fetchLiquidationHistory(apiKey, symbols, from, to) {
      const request = { symbols, from, to };
      calls.push({ kind: "history", apiKey, request });
      return (
        options.histories?.(request) ?? {
          histories: completeHistories(symbols),
          responseValid: true,
          diagnostics: [],
        }
      );
    },
  };
  const secret: SecretProvider = options.secret ?? {
    async read(identity) {
      assert.equal(identity.provider, "coinalyze");
      assert.equal(identity.credential, "api-key");
      return { kind: "available", secret: API_KEY };
    },
  };
  const clock = fixedClock("2026-09-24T12:31:00.000Z");
  assert.equal(clock.ok, true);
  if (!clock.ok) throw new Error("invalid application test clock");
  return {
    calls,
    async collect() {
      return collectLiquidationEvidence(
        { marketEvidence: options.evidence ?? marketEvidence() },
        { marketData: data, secrets: secret, clock: clock.value },
      );
    },
  };
}

test("collects and hashes exact run-bound evidence from a coherent #11 identity", async () => {
  const target = targetMarkets();
  const h = harness({
    markets: [
      ...target,
      market("BTC", "SPOT", { isPerpetual: false, symbol: "BTCUSDT.SPOT" }),
      market("DOGE", "EXPIRED", {
        symbol: "DOGEUSDT_PERP.EXPIRED",
        expireAt: Math.floor(Date.parse(BUNDLE_CUTOFF) / 1_000) - 1,
      }),
      market("XRP", "NON_TARGET"),
    ],
  });

  const result = await h.collect();

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.bundle.status, "complete");
  assert.equal(result.value.bundle.runId, RUN_ID);
  assert.equal(result.value.bundle.bundleCutoff, BUNDLE_CUTOFF);
  assert.equal(result.value.bundle.coverageProof, "complete");
  assert.equal(result.value.bundle.historyProof, "complete");
  const sourceIdentity = marketEvidenceContentHash(marketEvidence());
  assert.equal(sourceIdentity.ok, true);
  if (!sourceIdentity.ok) return;
  assert.equal(
    result.value.bundle.marketEvidence.contentHash,
    sourceIdentity.value,
  );
  assert.deepEqual(
    result.value.bundle.targets.map(
      (targetEvidence) => targetEvidence.constituents.length,
    ),
    [1, 1, 1, 1],
  );
  assert.equal(result.value.bundle.targets[0]?.hourlyAggregates.length, 24);
  assert.equal(
    result.value.bundle.targets[0]?.hourlyAggregates[0]?.longUsd.toString(),
    "0",
  );
  assert.equal(
    result.value.bundle.targets[0]?.hourlyAggregates[0]?.shortUsd.toString(),
    "0",
  );
  assert.equal(
    result.value.artifact.artifactKind,
    "liquidation-evidence-bundle",
  );
  assert.equal(
    result.value.evidence.contentHash,
    result.value.artifact.canonicalHash,
  );
  assert.equal(result.value.evidence.asOf, BUNDLE_CUTOFF);
  assert.equal(result.value.artifact.canonicalJson.includes(API_KEY), false);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0]?.apiKey, API_KEY);
  assert.deepEqual(
    h.calls[1]?.request?.symbols,
    target.map(({ symbol }) => symbol).sort(),
  );
  assert.equal(
    h.calls[1]?.request?.from,
    Math.floor((LAST_CLOSED_BUCKET - 23 * LIQUIDATION_HOUR_MS) / 1_000),
  );
  assert.equal(h.calls[1]?.request?.to, Math.floor(LAST_CLOSED_BUCKET / 1_000));
});

test("partial catalogue preserves every trustworthy constituent and keeps history proof separate", async () => {
  const target = targetMarkets(5).filter(
    (item) => !item.symbol.startsWith("BTCUSDT_PERP.VENUE3"),
  );
  const h = harness({
    markets: target,
    catalogueComplete: false,
    catalogueDiagnostics: diagnostics(
      "catalogue-incomplete",
      "discover-markets",
    ),
  });

  const result = await h.collect();

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.bundle.status, "incomplete");
  assert.equal(result.value.bundle.coverageProof, "incomplete");
  assert.equal(result.value.bundle.historyProof, "complete");
  assert.equal(
    result.value.bundle.targets.reduce(
      (count, targetEvidence) => count + targetEvidence.constituents.length,
      0,
    ),
    19,
  );
  assert.equal(h.calls[1]?.request?.symbols.length, 19);
});

test("complete catalogue with one missing history bucket retains the market and never zero-fills", async () => {
  const target = targetMarkets();
  const btcSymbol = target.find(({ baseAsset }) => baseAsset === "BTC")?.symbol;
  assert.ok(btcSymbol);
  const missing = LAST_CLOSED_BUCKET - 8 * LIQUIDATION_HOUR_MS;
  const h = harness({
    markets: target,
    histories: (request) => ({
      histories: completeHistories(request.symbols, {
        missing: new Map([[btcSymbol, missing]]),
      }),
      responseValid: true,
      diagnostics: [],
    }),
  });

  const result = await h.collect();

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.bundle.coverageProof, "complete");
  assert.equal(result.value.bundle.historyProof, "incomplete");
  assert.equal(result.value.bundle.status, "incomplete");
  const bitcoin = result.value.bundle.targets[0];
  assert.equal(bitcoin?.constituents.length, 1);
  assert.equal(bitcoin?.constituents[0]?.observations.length, 23);
  assert.equal(
    bitcoin?.hourlyAggregates.some(
      (aggregate) => aggregate.timestamp === timestamp(missing),
    ),
    false,
  );
  assert.ok(
    result.value.bundle.diagnostics.some(
      ({ code, providerSymbol, bucketTimestamp }) =>
        code === "missing-bucket" &&
        providerSymbol === btcSymbol &&
        bucketTimestamp === timestamp(missing),
    ),
  );
});

test("missing secret fails without provider access or empty successful evidence", async () => {
  let secretReads = 0;
  const secret: SecretProvider = {
    async read() {
      secretReads += 1;
      return { kind: "unavailable", reason: "missing" };
    },
  };
  const h = harness({ secret });

  const result = await h.collect();

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.bundle.status, "failed");
  assert.equal(result.value.bundle.coverageProof, "incomplete");
  assert.equal(result.value.bundle.historyProof, "incomplete");
  assert.equal(
    result.value.bundle.targets.every(
      ({ constituents }) => constituents.length === 0,
    ),
    true,
  );
  assert.equal(secretReads, 1);
  assert.equal(h.calls.length, 0);
  assert.ok(
    result.value.bundle.diagnostics.some(
      ({ code }) => code === "secret-unavailable",
    ),
  );
});

test("complete catalogue with no eligible target markets proves coverage but fails collection", async () => {
  const h = harness({
    markets: [market("XRP", "OTHER")],
    catalogueComplete: true,
  });

  const result = await h.collect();

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.bundle.status, "failed");
  assert.equal(result.value.bundle.coverageProof, "complete");
  assert.equal(result.value.bundle.historyProof, "incomplete");
  assert.ok(
    result.value.bundle.diagnostics.some(
      ({ code }) => code === "no-eligible-markets",
    ),
  );
  assert.equal(h.calls.length, 1);
});

test("malformed and contradictory adapter catalogue results downgrade proof without first-match-wins", async () => {
  const markets = targetMarkets();
  const btc = markets[0];
  assert.ok(btc);
  const h = harness({
    markets: [
      btc,
      { ...btc, exchange: "OTHER", symbolOnExchange: "BTCUSDT-OTHER" },
      ...markets.slice(1),
      { symbol: "malformed" } as unknown as CoinalyzeMarket,
    ],
  });

  const result = await h.collect();

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.bundle.status, "incomplete");
  assert.equal(result.value.bundle.coverageProof, "incomplete");
  assert.equal(result.value.bundle.targets[0]?.constituents.length, 0);
  assert.equal(result.value.bundle.targets[1]?.constituents.length, 1);
  assert.ok(
    result.value.bundle.diagnostics.some(
      ({ code }) => code === "duplicate-market",
    ),
  );
  assert.ok(
    result.value.bundle.diagnostics.some(
      ({ code }) => code === "invalid-catalogue",
    ),
  );
});

test("same venue contract with conflicting metadata is excluded from aggregate", async () => {
  const markets = targetMarkets();
  const btc = markets[0];
  assert.ok(btc);
  const conflicting = {
    ...btc,
    symbol: "BTCUSDT_PERP.BINANCE_ALT",
    marginType: "COIN",
    expireAt: 1_800_000_000,
  };
  const h = harness({ markets: [btc, conflicting, ...markets.slice(1)] });

  const result = await h.collect();

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.bundle.status, "incomplete");
  assert.equal(result.value.bundle.coverageProof, "incomplete");
  assert.equal(result.value.bundle.targets[0]?.constituents.length, 0);
  assert.ok(
    result.value.bundle.diagnostics.some(
      ({ code }) => code === "duplicate-market",
    ),
  );
  const historyCall = h.calls.find(({ kind }) => kind === "history");
  assert.ok(historyCall?.request);
  assert.equal(historyCall.request.symbols.includes(btc.symbol), false);
  assert.equal(historyCall.request.symbols.includes(conflicting.symbol), false);
});

test("incompatible #11 run identity stops before secret/provider access", async () => {
  const mismatched = marketEvidence({
    runId: "different-run",
    evidence: [
      {
        kind: "market-evidence-bundle",
        schemaVersion: "market-evidence/v1",
        producer: MARKET_EVIDENCE_PRODUCER,
        sourceId: `bybit-public:${RUN_ID}`,
        asOf: BUNDLE_CUTOFF,
        validForMs: 86_400_000,
        contentHash: `sha256:${"a".repeat(64)}`,
      },
    ],
  });
  let secretReads = 0;
  const h = harness({
    evidence: mismatched,
    secret: {
      async read() {
        secretReads += 1;
        return { kind: "available", secret: API_KEY };
      },
    },
  });

  const result = await h.collect();

  assert.equal(result.ok, false);
  assert.equal(secretReads, 0);
  assert.equal(h.calls.length, 0);
});

test("#11 content hash must match its canonical market evidence", async () => {
  const valid = marketEvidence();
  const tampered = createMarketEvidenceBundle({
    ...valid,
    evidence: valid.evidence.map((reference) => ({
      ...reference,
      contentHash: `sha256:${"b".repeat(64)}`,
    })),
  });
  assert.equal(tampered.ok, true);
  if (!tampered.ok) return;
  let secretReads = 0;
  const h = harness({
    evidence: tampered.value,
    secret: {
      async read() {
        secretReads += 1;
        return { kind: "available", secret: API_KEY };
      },
    },
  });

  const result = await h.collect();

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "INCOMPATIBLE_EVIDENCE");
  assert.equal(secretReads, 0);
  assert.equal(h.calls.length, 0);
});

test("#11 reference validity must match its canonical freshness policy", async () => {
  const valid = marketEvidence();
  const changedLifetime = createMarketEvidenceBundle({
    ...valid,
    evidence: valid.evidence.map((reference) => ({
      ...reference,
      validForMs: 10 * 86_400_000,
    })),
  });
  assert.equal(changedLifetime.ok, true);
  if (!changedLifetime.ok) return;
  let secretReads = 0;
  const h = harness({
    evidence: changedLifetime.value,
    secret: {
      async read() {
        secretReads += 1;
        return { kind: "available", secret: API_KEY };
      },
    },
  });

  const result = await h.collect();

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "INCOMPATIBLE_EVIDENCE");
  assert.equal(secretReads, 0);
  assert.equal(h.calls.length, 0);
});

test("#11 run identity rejects duplicate matching EvidenceRefs", async () => {
  const valid = marketEvidence();
  const duplicated = createMarketEvidenceBundle({
    ...valid,
    evidence: [...valid.evidence, ...valid.evidence],
  });
  assert.equal(duplicated.ok, true);
  if (!duplicated.ok) return;
  let secretReads = 0;
  const h = harness({
    evidence: duplicated.value,
    secret: {
      async read() {
        secretReads += 1;
        return { kind: "available", secret: API_KEY };
      },
    },
  });

  const result = await h.collect();

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "INCOMPATIBLE_EVIDENCE");
  assert.equal(secretReads, 0);
  assert.equal(h.calls.length, 0);
});

test("a false history validity flag without adapter diagnostics stays incomplete", async () => {
  const h = harness({
    histories: (request) => ({
      histories: completeHistories(request.symbols),
      responseValid: false,
      diagnostics: [],
    }),
  });

  const result = await h.collect();

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.bundle.status, "incomplete");
  assert.equal(result.value.bundle.historyProof, "incomplete");
  assert.ok(
    result.value.bundle.diagnostics.some(
      ({ code, operation }) =>
        code === "history-incomplete" &&
        operation === "fetch-liquidation-history",
    ),
  );
});

test("a rejected history request preserves selected markets as incomplete evidence", async () => {
  const h = harness({
    histories: () => {
      throw new Error("provider request failed");
    },
  });

  const result = await h.collect();

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.bundle.coverageProof, "complete");
  assert.equal(result.value.bundle.historyProof, "incomplete");
  assert.equal(result.value.bundle.status, "incomplete");
  assert.ok(
    result.value.bundle.targets.every(
      ({ constituents }) => constituents.length === 1,
    ),
  );
  assert.ok(
    result.value.bundle.targets.every(({ constituents }) =>
      constituents.every(({ observations }) => observations.length === 0),
    ),
  );
  assert.ok(
    result.value.bundle.diagnostics.some(
      ({ code, operation }) =>
        code === "history-unavailable" &&
        operation === "fetch-liquidation-history",
    ),
  );
});

test("equivalent provider ordering yields the same canonical liquidation identity", async () => {
  const markets = targetMarkets(2);
  const first = await harness({ markets }).collect();
  const reversed = await harness({ markets: [...markets].reverse() }).collect();
  assert.equal(first.ok, true);
  assert.equal(reversed.ok, true);
  if (!first.ok || !reversed.ok) return;
  assert.equal(
    first.value.artifact.canonicalHash,
    reversed.value.artifact.canonicalHash,
  );
});
