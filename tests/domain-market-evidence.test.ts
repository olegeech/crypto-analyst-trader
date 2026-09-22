import assert from "node:assert/strict";
import test from "node:test";

import {
  createMarketEvidenceBundle,
  MARKET_EVIDENCE_SCHEMA_VERSION,
  MARKET_EVIDENCE_SYMBOLS,
  MARKET_EVIDENCE_UNIVERSE_VERSION,
} from "../src/domain/market/market-evidence-bundle.js";
import {
  encodeCanonicalArtifact,
  rehydrateArtifact,
} from "../src/domain/identity/canonical-artifact.js";

const evidence = {
  kind: "market-snapshot",
  schemaVersion: "market-snapshot/v1",
  producer: "fixture",
  sourceId: "run-1",
  asOf: "2026-09-22T10:00:00Z",
  validForMs: 60_000,
  contentHash: `sha256:${"a".repeat(64)}`,
};

function symbolEvidence(symbol: string, status = "trading") {
  return {
    symbol,
    instrument: {
      symbol,
      status,
      contractType: "LinearPerpetual",
      baseCoin: symbol.replace("USDT", ""),
      quoteCoin: "USDT",
      settleCoin: "USDT",
      constraints: {
        instrument: symbol,
        version: "instrument-constraints/v1",
        priceTickSize: "0.01",
        quantityStep: "1",
        minQuantity: "1",
        minNotional: "5",
      },
      fundingInterval: 480,
      sourceTimestamp: "2026-09-22T09:59:00Z",
    },
    ticker: {
      observedAt: "2026-09-22T09:59:00Z",
      bid: "100",
      ask: "101",
      last: "100.5",
      markPrice: "100.4",
      indexPrice: "100.3",
      fundingRate: "-0.0001",
      openInterest: "1000",
      volume24h: "2000",
      turnover24h: "200000",
    },
    ohlcv: [
      {
        interval: "1h",
        observations: [
          {
            timestamp: "2026-09-22T08:00:00Z",
            open: "99",
            high: "102",
            low: "98",
            close: "100",
            volume: "10",
            turnover: "1000",
            closed: true,
          },
        ],
      },
    ],
    funding: [{ timestamp: "2026-09-22T08:00:00Z", rate: "0.0001" }],
    openInterest: [
      {
        interval: "1h",
        observations: [
          { timestamp: "2026-09-22T08:00:00Z", openInterest: "1000" },
        ],
      },
    ],
    diagnostics: [],
  };
}

function bundle(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    schemaVersion: MARKET_EVIDENCE_SCHEMA_VERSION,
    producer: "fixture/1",
    universeVersion: MARKET_EVIDENCE_UNIVERSE_VERSION,
    universe: [...MARKET_EVIDENCE_SYMBOLS],
    collectionStartedAt: "2026-09-22T09:00:00Z",
    collectionEndedAt: "2026-09-22T10:00:00Z",
    bundleCutoff: "2026-09-22T09:59:30Z",
    source: {
      exchange: "bybit",
      environment: "mainnet",
      origin: "https://api.bybit.com",
      category: "linear",
    },
    status: "complete",
    symbols: MARKET_EVIDENCE_SYMBOLS.map((symbol) => symbolEvidence(symbol)),
    diagnostics: [],
    evidence: [evidence],
    ...overrides,
  };
}

test("market evidence validates the four-symbol immutable exact-decimal bundle", () => {
  const result = createMarketEvidenceBundle(bundle());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.symbols.length, 4);
  assert.equal(result.value.symbols[0]?.ticker?.bid.toString(), "100");
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.symbols), true);
  assert.equal(Object.isFrozen(result.value.symbols[0]), true);
  assert.equal(result.value.symbols[0]?.instrument?.fundingInterval, 480);
});

test("incomplete bundles preserve an unavailable configured symbol and diagnostics", () => {
  const symbols = MARKET_EVIDENCE_SYMBOLS.map((symbol) =>
    symbolEvidence(symbol),
  );
  symbols[2] = {
    symbol: MARKET_EVIDENCE_SYMBOLS[2],
    ohlcv: [],
    funding: [],
    openInterest: [],
    diagnostics: [
      {
        code: "missing-required-data",
        operation: "read-instrument",
        endpoint: "/v5/market/instruments-info",
        symbol: MARKET_EVIDENCE_SYMBOLS[2],
      },
    ],
  } as unknown as ReturnType<typeof symbolEvidence>;
  const result = createMarketEvidenceBundle(
    bundle({ status: "incomplete", symbols }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.symbols[2]?.symbol, "SOLUSDT");
  assert.equal(result.value.symbols[2]?.instrument, undefined);
  assert.equal(
    result.value.symbols[2]?.diagnostics[0]?.code,
    "missing-required-data",
  );
});

test("market evidence rejects non-canonical decimals, duplicate observations and wrong identity", () => {
  const malformedDecimal = createMarketEvidenceBundle(
    bundle({
      symbols: MARKET_EVIDENCE_SYMBOLS.map((symbol, index) =>
        index === 0
          ? {
              ...symbolEvidence(symbol),
              ticker: { ...symbolEvidence(symbol).ticker, bid: 100 },
            }
          : symbolEvidence(symbol),
      ),
    }),
  );
  assert.equal(malformedDecimal.ok, false);

  const duplicate = symbolEvidence("BTCUSDT");
  const firstObservation = duplicate.ohlcv[0]?.observations[0];
  assert.ok(firstObservation);
  duplicate.ohlcv[0]?.observations.push({
    timestamp: firstObservation.timestamp,
    open: firstObservation.open,
    high: firstObservation.high,
    low: firstObservation.low,
    close: firstObservation.close,
    volume: firstObservation.volume,
    turnover: firstObservation.turnover,
    closed: firstObservation.closed,
  });
  const duplicateResult = createMarketEvidenceBundle(
    bundle({
      symbols: [
        duplicate,
        ...MARKET_EVIDENCE_SYMBOLS.slice(1).map((symbol) =>
          symbolEvidence(symbol),
        ),
      ],
    }),
  );
  assert.equal(duplicateResult.ok, false);

  const wrongIdentity = createMarketEvidenceBundle(
    bundle({
      symbols: MARKET_EVIDENCE_SYMBOLS.map((symbol, index) =>
        index === 0
          ? {
              ...symbolEvidence(symbol),
              instrument: {
                ...symbolEvidence(symbol).instrument,
                quoteCoin: "BTC",
              },
            }
          : symbolEvidence(symbol),
      ),
    }),
  );
  assert.equal(wrongIdentity.ok, false);
});

test("market evidence rejects a ticker or historical observation after the common cutoff", () => {
  const result = createMarketEvidenceBundle(
    bundle({
      symbols: MARKET_EVIDENCE_SYMBOLS.map((symbol, index) =>
        index === 0
          ? {
              ...symbolEvidence(symbol),
              ticker: {
                ...symbolEvidence(symbol).ticker,
                observedAt: "2026-09-22T10:00:00Z",
              },
            }
          : symbolEvidence(symbol),
      ),
    }),
  );
  assert.equal(result.ok, false);
});

test("market evidence participates in deterministic canonical identity and rehydration", () => {
  const first = createMarketEvidenceBundle(bundle());
  const reordered = createMarketEvidenceBundle(
    bundle({
      symbols: [...MARKET_EVIDENCE_SYMBOLS]
        .reverse()
        .map((symbol) => symbolEvidence(symbol)),
    }),
  );
  assert.equal(first.ok, true);
  assert.equal(reordered.ok, true);
  if (!first.ok || !reordered.ok) return;

  const firstEnvelope = encodeCanonicalArtifact(
    "market-evidence-bundle",
    first.value,
  );
  const reorderedEnvelope = encodeCanonicalArtifact(
    "market-evidence-bundle",
    reordered.value,
  );
  assert.equal(firstEnvelope.ok, true);
  assert.equal(reorderedEnvelope.ok, true);
  if (!firstEnvelope.ok || !reorderedEnvelope.ok) return;
  assert.equal(
    firstEnvelope.value.canonicalHash,
    reorderedEnvelope.value.canonicalHash,
  );

  const rehydrated = rehydrateArtifact(
    "market-evidence-bundle",
    firstEnvelope.value,
  );
  assert.equal(rehydrated.ok, true);
  if (rehydrated.ok) {
    assert.equal(rehydrated.value.bundleCutoff, first.value.bundleCutoff);
    assert.equal(rehydrated.value.symbols[0]?.ticker?.bid.toString(), "100");
  }
});
