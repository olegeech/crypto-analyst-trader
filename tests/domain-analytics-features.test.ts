import assert from "node:assert/strict";
import test from "node:test";

import { computePriceFeatures } from "../src/domain/analytics/price-features.js";
import { createAnalyticsProfile } from "../src/domain/analytics/analytics-profile.js";
import {
  MARKET_EVIDENCE_SCHEMA_VERSION,
  MARKET_EVIDENCE_SYMBOLS,
  MARKET_EVIDENCE_UNIVERSE_VERSION,
  createMarketEvidenceBundle,
  type OhlcvObservation,
} from "../src/domain/market/market-evidence-bundle.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";

const HOUR_MS = 60 * 60 * 1_000;
const START = Date.parse("2026-09-24T08:00:00.000Z");
const CUTOFF = "2026-09-24T14:00:00.000Z";

function candle(
  index: number,
  open: string,
  high: string,
  low: string,
  close: string,
  hourOffset = index,
): OhlcvObservation {
  return {
    timestamp: new Date(
      START + hourOffset * HOUR_MS,
    ).toISOString() as OhlcvObservation["timestamp"],
    open: decimal(open),
    high: decimal(high),
    low: decimal(low),
    close: decimal(close),
    volume: decimal("1"),
    turnover: decimal("1"),
    closed: true,
  };
}

function decimal(value: string): OhlcvObservation["close"] {
  const result = DecimalValue.fromString(value);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("decimal fixture is invalid");
  return result.value;
}

function bundle(observations: readonly OhlcvObservation[]) {
  const parsed = createMarketEvidenceBundle({
    runId: "analytics-price-run",
    schemaVersion: MARKET_EVIDENCE_SCHEMA_VERSION,
    producer: "fixture/market-evidence",
    universeVersion: MARKET_EVIDENCE_UNIVERSE_VERSION,
    universe: [...MARKET_EVIDENCE_SYMBOLS],
    collectionStartedAt: "2026-09-24T08:00:00.000Z",
    collectionEndedAt: "2026-09-24T13:00:00.000Z",
    bundleCutoff: CUTOFF,
    source: {
      exchange: "bybit",
      environment: "mainnet",
      origin: "https://api.bybit.com",
      category: "linear",
    },
    status: "incomplete",
    symbols: MARKET_EVIDENCE_SYMBOLS.map((symbol) => ({
      symbol,
      ohlcv: symbol === "BTCUSDT" ? [{ interval: "1h", observations }] : [],
      funding: [],
      openInterest: [],
      diagnostics: [],
    })),
    diagnostics: [],
    evidence: [
      {
        kind: "market-snapshot",
        schemaVersion: "market-snapshot/v1",
        producer: "fixture/market-evidence",
        sourceId: "analytics-price-run",
        asOf: "2026-09-24T13:00:00.000Z",
        validForMs: 60_000,
        contentHash: `sha256:${"d".repeat(64)}`,
      },
    ],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("market feature fixture is invalid");
  return parsed.value;
}

function profile(features: readonly Record<string, unknown>[]) {
  const parsed = createAnalyticsProfile({
    schemaVersion: "analytics-profile/v1",
    features,
    externalEvidence: [],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("analytics profile fixture is invalid");
  return parsed.value;
}

function flatCandles(closes: readonly string[]): OhlcvObservation[] {
  return closes.map((close, index) =>
    candle(index, close, close, close, close),
  );
}

test("price features derive simple return and maximum drawdown from closed candles", () => {
  const features = profile([
    {
      id: "btc-return",
      kind: "close-return",
      symbol: "BTCUSDT",
      interval: "1h",
      periods: 1,
      required: true,
    },
    {
      id: "btc-drawdown",
      kind: "maximum-drawdown",
      symbol: "BTCUSDT",
      interval: "1h",
      observationCount: 5,
      required: true,
    },
  ]);
  const result = computePriceFeatures(
    bundle(flatCandles(["10", "12", "9", "10", "11"])),
    features,
  );
  const returnFeature = result.find((item) => item.requestId === "btc-return");
  const drawdownFeature = result.find(
    (item) => item.requestId === "btc-drawdown",
  );

  assert.equal(returnFeature?.status, "complete");
  assert.equal(returnFeature?.value?.type, "close-return");
  if (returnFeature?.value?.type === "close-return") {
    assert.equal(returnFeature.value.percent.toString(), "10");
  }
  assert.equal(drawdownFeature?.status, "complete");
  assert.equal(drawdownFeature?.value?.type, "maximum-drawdown");
  if (drawdownFeature?.value?.type === "maximum-drawdown") {
    assert.equal(drawdownFeature.value.percent.toString(), "25");
  }
});

test("ATR seeds with the period mean then applies Wilder smoothing", () => {
  const features = profile([
    {
      id: "btc-atr",
      kind: "atr",
      symbol: "BTCUSDT",
      interval: "1h",
      period: 2,
      required: true,
    },
  ]);
  const result = computePriceFeatures(
    bundle([
      candle(0, "10", "12", "8", "10"),
      candle(1, "10", "14", "9", "13"),
      candle(2, "13", "15", "11", "12"),
      candle(3, "12", "13", "10", "11"),
    ]),
    features,
  );

  assert.equal(result[0]?.status, "complete");
  assert.equal(result[0]?.value?.type, "atr");
  if (result[0]?.value?.type === "atr") {
    assert.equal(result[0].value.atr.toString(), "3.75");
    assert.equal(
      result[0].value.normalizedPercent.toString(),
      "34.0909090909090909",
    );
  }
});

test("realized-volatility comparison reports expansion, compression, and equality", () => {
  const request = {
    id: "btc-volatility-relation",
    kind: "volatility-comparison",
    symbol: "BTCUSDT",
    interval: "1h",
    recentObservationCount: 2,
    referenceObservationCount: 2,
    required: true,
  };
  const cases = [
    {
      closes: ["100", "110", "121", "145.2", "174.24"],
      relation: "expansion",
      ratio: "2",
    },
    {
      closes: ["100", "120", "144", "158.4", "174.24"],
      relation: "compression",
      ratio: "0.5",
    },
    {
      closes: ["100", "110", "121", "133.1", "146.41"],
      relation: "unchanged",
      ratio: "1",
    },
  ] as const;

  for (const scenario of cases) {
    const result = computePriceFeatures(
      bundle(flatCandles(scenario.closes)),
      profile([request]),
    );
    assert.equal(result[0]?.status, "complete");
    assert.equal(result[0]?.value?.type, "volatility-comparison");
    if (result[0]?.value?.type === "volatility-comparison") {
      assert.equal(result[0].value.relation, scenario.relation);
      assert.equal(result[0].value.ratio.toString(), scenario.ratio);
    }
  }
});

test("price features fail closed on short, gapped, zero-reference, and invalid-price windows", () => {
  const returnProfile = profile([
    {
      id: "btc-return",
      kind: "close-return",
      symbol: "BTCUSDT",
      interval: "1h",
      periods: 3,
      required: true,
    },
  ]);
  const short = computePriceFeatures(
    bundle(flatCandles(["10", "11", "12"])),
    returnProfile,
  );
  assert.equal(short[0]?.status, "unavailable");
  assert.deepEqual(short[0]?.reasonCodes, ["INSUFFICIENT_WINDOW"]);

  const gappedCandles = [
    candle(0, "100", "100", "100", "100", 0),
    candle(1, "101", "101", "101", "101", 1),
    candle(2, "102", "102", "102", "102", 2),
    candle(3, "103", "103", "103", "103", 4),
    candle(4, "104", "104", "104", "104", 5),
  ];
  const gapped = computePriceFeatures(
    bundle(gappedCandles),
    profile([
      {
        id: "btc-return",
        kind: "close-return",
        symbol: "BTCUSDT",
        interval: "1h",
        periods: 2,
        required: true,
      },
    ]),
  );
  assert.equal(gapped[0]?.status, "unavailable");
  assert.deepEqual(gapped[0]?.reasonCodes, ["INSUFFICIENT_WINDOW"]);

  const zeroReference = computePriceFeatures(
    bundle(flatCandles(["100", "100", "100", "100", "100"])),
    profile([
      {
        id: "btc-volatility-relation",
        kind: "volatility-comparison",
        symbol: "BTCUSDT",
        interval: "1h",
        recentObservationCount: 2,
        referenceObservationCount: 2,
        required: true,
      },
    ]),
  );
  assert.equal(zeroReference[0]?.status, "unavailable");
  assert.deepEqual(zeroReference[0]?.reasonCodes, [
    "ZERO_VOLATILITY_REFERENCE",
  ]);

  const invalidPrice = createMarketEvidenceBundle({
    runId: "invalid-price-run",
    schemaVersion: MARKET_EVIDENCE_SCHEMA_VERSION,
    producer: "fixture/market-evidence",
    universeVersion: MARKET_EVIDENCE_UNIVERSE_VERSION,
    universe: [...MARKET_EVIDENCE_SYMBOLS],
    collectionStartedAt: "2026-09-24T08:00:00.000Z",
    collectionEndedAt: "2026-09-24T13:00:00.000Z",
    bundleCutoff: CUTOFF,
    source: {
      exchange: "bybit",
      environment: "mainnet",
      origin: "https://api.bybit.com",
      category: "linear",
    },
    status: "incomplete",
    symbols: MARKET_EVIDENCE_SYMBOLS.map((symbol) => ({
      symbol,
      ohlcv:
        symbol === "BTCUSDT"
          ? [{ interval: "1h", observations: [candle(0, "0", "0", "0", "0")] }]
          : [],
      funding: [],
      openInterest: [],
      diagnostics: [],
    })),
    diagnostics: [],
    evidence: [
      {
        kind: "market-snapshot",
        schemaVersion: "market-snapshot/v1",
        producer: "fixture/market-evidence",
        sourceId: "invalid-price-run",
        asOf: "2026-09-24T13:00:00.000Z",
        validForMs: 60_000,
        contentHash: `sha256:${"e".repeat(64)}`,
      },
    ],
  });
  assert.equal(invalidPrice.ok, false);
});

test("same canonical candles and profile produce identical feature values", () => {
  const candles = flatCandles(["100", "102", "98", "101", "104"]);
  const selectedProfile = profile([
    {
      id: "btc-return",
      kind: "close-return",
      symbol: "BTCUSDT",
      interval: "1h",
      periods: 2,
      required: true,
    },
    {
      id: "btc-volatility",
      kind: "realized-volatility",
      symbol: "BTCUSDT",
      interval: "1h",
      observationCount: 3,
      required: true,
    },
  ]);
  const first = computePriceFeatures(bundle(candles), selectedProfile);
  const second = computePriceFeatures(bundle(candles), selectedProfile);

  assert.deepEqual(
    first.map((item) => ({
      id: item.requestId,
      status: item.status,
      reasonCodes: item.reasonCodes,
      value: item.value,
    })),
    second.map((item) => ({
      id: item.requestId,
      status: item.status,
      reasonCodes: item.reasonCodes,
      value: item.value,
    })),
  );
});
