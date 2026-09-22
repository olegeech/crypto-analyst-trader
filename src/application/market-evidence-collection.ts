import { hashCanonical } from "../domain/identity/canonical-serialization.js";
import {
  createEvidenceRef,
  type EvidenceRef,
} from "../domain/evidence/evidence-ref.js";
import {
  createMarketEvidenceBundle,
  MARKET_EVIDENCE_PRODUCER,
  MARKET_EVIDENCE_SYMBOLS,
  type FundingObservation,
  type MarketEvidenceBundle,
  type MarketEvidenceSymbol,
  type MarketInstrumentEvidence,
  type MarketSeriesInterval,
  type MarketSymbolEvidence,
  type MarketTickerEvidence,
  type OhlcvObservation,
  type OpenInterestInterval,
  type OpenInterestObservation,
} from "../domain/market/market-evidence-bundle.js";
import type {
  MarketEvidenceCollectionRequest,
  MarketEvidencePort,
} from "../ports/market-evidence.js";
import {
  fundingBoundaryCrossed,
  intervalBoundaryCrossed,
  MARKET_FUNDING_WINDOW,
  MARKET_OHLCV_WINDOWS,
  MARKET_OPEN_INTEREST_WINDOWS,
  normalizeFundingObservations,
  normalizeOhlcvSeries,
  normalizeOpenInterestSeries,
} from "../domain/market/market-series-normalization.js";
import {
  createMarketEvidenceDiagnostic,
  type MarketEvidenceDiagnostic,
  type MarketEvidenceDiagnosticCode,
} from "../domain/market/market-evidence-diagnostics.js";
import { domainError } from "../domain/shared/errors.js";
import { fail, ok, type Result } from "../domain/shared/result.js";
import {
  systemClock,
  type Clock,
  type UtcTimestamp,
} from "../domain/shared/time.js";

export interface MarketEvidenceCollectionReader {
  readExchangeTime(): Promise<UtcTimestamp>;
  readInstrument(
    symbol: MarketEvidenceSymbol,
  ): Promise<MarketInstrumentEvidence>;
  readTicker(symbol: MarketEvidenceSymbol): Promise<MarketTickerEvidence>;
  readOhlcv(
    symbol: MarketEvidenceSymbol,
    interval: MarketSeriesInterval,
    requestedCount: number,
    exchangeTime: UtcTimestamp,
  ): Promise<readonly OhlcvObservation[]>;
  readFunding(
    symbol: MarketEvidenceSymbol,
    requestedCount: number,
  ): Promise<readonly FundingObservation[]>;
  readOpenInterest(
    symbol: MarketEvidenceSymbol,
    interval: OpenInterestInterval,
    requestedCount: number,
  ): Promise<readonly OpenInterestObservation[]>;
}

export interface MarketEvidenceCollectionOptions {
  readonly reader: MarketEvidenceCollectionReader;
  readonly clock?: Clock;
  readonly producer?: string;
}

interface SymbolFacts {
  readonly symbol: MarketEvidenceSymbol;
  instrument?: MarketInstrumentEvidence;
  ticker?: MarketTickerEvidence;
  readonly ohlcv: Partial<
    Record<MarketSeriesInterval, readonly OhlcvObservation[]>
  >;
  funding?: readonly FundingObservation[];
  readonly openInterest: Partial<
    Record<OpenInterestInterval, readonly OpenInterestObservation[]>
  >;
  readonly diagnostics: MarketEvidenceDiagnostic[];
}

interface ReadContext {
  readonly facts: SymbolFacts;
  readonly operation: string;
  readonly endpoint: string;
  readonly series?: string;
}

const OHLCV_INTERVALS = Object.freeze(
  Object.keys(MARKET_OHLCV_WINDOWS) as MarketSeriesInterval[],
);
const OI_INTERVALS = Object.freeze(
  Object.keys(MARKET_OPEN_INTEREST_WINDOWS) as OpenInterestInterval[],
);

function maxTimestamp(left: UtcTimestamp, right: UtcTimestamp): UtcTimestamp {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function diagnosticCode(
  error: unknown,
  fallback: MarketEvidenceDiagnosticCode,
): MarketEvidenceDiagnosticCode {
  if (typeof error !== "object" || error === null) return fallback;
  const kind = "kind" in error ? error.kind : undefined;
  switch (kind) {
    case "rate-limited":
      return "rate-limited";
    case "transport-failed":
      return "transport-failed";
    case "invalid-response":
      return "invalid-response";
    case "invalid-cursor":
      return "invalid-response";
    case "precondition":
      return "wrong-identity";
    case "missing-data":
      return "missing-required-data";
    case "wrong-identity":
      return "wrong-identity";
    case "duplicate-observation":
      return "duplicate-observation";
    case "page-budget-exhausted":
      return "page-budget-exhausted";
    case "row-budget-exhausted":
      return "row-budget-exhausted";
    case "repeated-cursor":
      return "repeated-cursor";
    default:
      return fallback;
  }
}

function makeDiagnostic(
  context: ReadContext,
  code: MarketEvidenceDiagnosticCode,
): MarketEvidenceDiagnostic {
  const parsed = createMarketEvidenceDiagnostic({
    code,
    operation: context.operation,
    endpoint: context.endpoint,
    symbol: context.facts.symbol,
    ...(context.series === undefined ? {} : { series: context.series }),
  });
  if (!parsed.ok) {
    throw new Error("internal market evidence diagnostic construction failed");
  }
  return parsed.value;
}

function addReadDiagnostic(
  context: ReadContext,
  error: unknown,
  fallback: MarketEvidenceDiagnosticCode = "invalid-response",
): void {
  context.facts.diagnostics.push(
    makeDiagnostic(context, diagnosticCode(error, fallback)),
  );
}

function addProofDiagnostic(
  facts: SymbolFacts,
  operation: string,
  endpoint: string,
  series: string,
): void {
  const context: ReadContext = { facts, operation, endpoint, series };
  facts.diagnostics.push(makeDiagnostic(context, "incomplete-proof"));
}

function createFacts(symbol: MarketEvidenceSymbol): SymbolFacts {
  return {
    symbol,
    ohlcv: {},
    openInterest: {},
    diagnostics: [],
  };
}

function hasDiagnosticForSeries(facts: SymbolFacts, series: string): boolean {
  return facts.diagnostics.some((diagnostic) => diagnostic.series === series);
}

function hasUsableEvidence(facts: readonly SymbolFacts[]): boolean {
  return facts.some(
    (factsForSymbol) =>
      factsForSymbol.instrument !== undefined ||
      factsForSymbol.ticker !== undefined ||
      (factsForSymbol.funding?.length ?? 0) > 0 ||
      Object.values(factsForSymbol.ohlcv).some(
        (observations) => (observations?.length ?? 0) > 0,
      ) ||
      Object.values(factsForSymbol.openInterest).some(
        (observations) => (observations?.length ?? 0) > 0,
      ),
  );
}

function evidenceForBundle(
  bundle: MarketEvidenceBundle,
): Result<readonly EvidenceRef[]> {
  const identity = hashCanonical({
    runId: bundle.runId,
    schemaVersion: bundle.schemaVersion,
    producer: bundle.producer,
    universeVersion: bundle.universeVersion,
    universe: bundle.universe,
    collectionStartedAt: bundle.collectionStartedAt,
    collectionEndedAt: bundle.collectionEndedAt,
    bundleCutoff: bundle.bundleCutoff,
    source: bundle.source,
    status: bundle.status,
    symbols: bundle.symbols,
    diagnostics: bundle.diagnostics,
  });
  if (!identity.ok) return identity;
  const evidence = createEvidenceRef({
    kind: "market-evidence-bundle",
    schemaVersion: "market-evidence/v1",
    producer: MARKET_EVIDENCE_PRODUCER,
    sourceId: `bybit-public:${bundle.runId}`,
    asOf: bundle.bundleCutoff,
    validForMs: 86_400_000,
    contentHash: identity.value,
  });
  if (!evidence.ok) return evidence;
  return ok(Object.freeze([evidence.value]));
}

function buildBundle(
  runId: string,
  producer: string,
  startedAt: UtcTimestamp,
  endedAt: UtcTimestamp,
  cutoff: UtcTimestamp,
  facts: readonly SymbolFacts[],
): Result<MarketEvidenceBundle> {
  if (!hasUsableEvidence(facts)) {
    return fail(
      domainError(
        "UNRESOLVED_STATE",
        "Bybit public market collection produced no usable evidence.",
      ),
    );
  }
  let complete = true;
  const symbols: MarketSymbolEvidence[] = [];
  for (const factsForSymbol of facts) {
    const diagnostics = [...factsForSymbol.diagnostics];
    const tickerIsAtOrBeforeCutoff =
      factsForSymbol.ticker === undefined ||
      Date.parse(factsForSymbol.ticker.observedAt) <= Date.parse(cutoff);
    if (!tickerIsAtOrBeforeCutoff) {
      diagnostics.push(
        makeDiagnostic(
          {
            facts: factsForSymbol,
            operation: "normalize-ticker",
            endpoint: "/v5/market/tickers",
          },
          "future-observation",
        ),
      );
    }
    const ohlcv = [] as ReturnType<typeof normalizeOhlcvSeries>["value"][];
    const openInterest = [] as ReturnType<
      typeof normalizeOpenInterestSeries
    >["value"][];
    if (factsForSymbol.instrument === undefined) complete = false;
    if (factsForSymbol.ticker === undefined) complete = false;
    for (const interval of OHLCV_INTERVALS) {
      const normalized = normalizeOhlcvSeries(
        interval,
        factsForSymbol.ohlcv[interval] ?? [],
        cutoff,
      );
      ohlcv.push(normalized.value);
      if (!normalized.complete) {
        complete = false;
        if (!hasDiagnosticForSeries(factsForSymbol, `ohlcv-${interval}`)) {
          addProofDiagnostic(
            { ...factsForSymbol, diagnostics },
            "normalize-ohlcv",
            `/v5/market/kline`,
            `ohlcv-${interval}`,
          );
        }
      }
    }
    const funding = normalizeFundingObservations(
      factsForSymbol.funding ?? [],
      cutoff,
      undefined,
      factsForSymbol.instrument?.fundingInterval,
    );
    if (!funding.complete) {
      complete = false;
      if (!hasDiagnosticForSeries(factsForSymbol, "funding")) {
        addProofDiagnostic(
          { ...factsForSymbol, diagnostics },
          "normalize-funding",
          "/v5/market/funding/history",
          "funding",
        );
      }
    }
    for (const interval of OI_INTERVALS) {
      const normalized = normalizeOpenInterestSeries(
        interval,
        factsForSymbol.openInterest[interval] ?? [],
        cutoff,
      );
      openInterest.push(normalized.value);
      if (!normalized.complete) {
        complete = false;
        if (
          !hasDiagnosticForSeries(factsForSymbol, `open-interest-${interval}`)
        ) {
          addProofDiagnostic(
            { ...factsForSymbol, diagnostics },
            "normalize-open-interest",
            "/v5/market/open-interest",
            `open-interest-${interval}`,
          );
        }
      }
    }
    if (diagnostics.length > 0 || !tickerIsAtOrBeforeCutoff) complete = false;
    symbols.push({
      symbol: factsForSymbol.symbol,
      ...(factsForSymbol.instrument === undefined
        ? {}
        : { instrument: factsForSymbol.instrument }),
      ...(factsForSymbol.ticker === undefined || !tickerIsAtOrBeforeCutoff
        ? {}
        : { ticker: factsForSymbol.ticker }),
      ohlcv,
      funding: funding.value,
      openInterest,
      diagnostics,
    });
  }
  const status = complete ? "complete" : "incomplete";
  const bundleInput = {
    runId,
    schemaVersion: "market-evidence/v1",
    producer,
    universeVersion: "m1-universe/v1",
    universe: [...MARKET_EVIDENCE_SYMBOLS],
    collectionStartedAt: startedAt,
    collectionEndedAt: endedAt,
    bundleCutoff: cutoff,
    source: {
      exchange: "bybit",
      environment: "mainnet",
      origin: "https://api.bybit.com",
      category: "linear",
    },
    status,
    symbols,
    diagnostics: [],
  };
  const provisional = createMarketEvidenceBundle({
    ...bundleInput,
    evidence: [
      {
        kind: "market-evidence-bundle",
        schemaVersion: "market-evidence/v1",
        producer: MARKET_EVIDENCE_PRODUCER,
        sourceId: `bybit-public:${runId}`,
        asOf: cutoff,
        validForMs: 86_400_000,
        contentHash: `sha256:${"0".repeat(64)}`,
      },
    ],
  });
  if (!provisional.ok) return provisional;
  const evidence = evidenceForBundle(provisional.value);
  if (!evidence.ok) return evidence;
  return createMarketEvidenceBundle({
    ...bundleInput,
    evidence: evidence.value,
  });
}

export async function collectMarketEvidence(
  request: MarketEvidenceCollectionRequest,
  options: MarketEvidenceCollectionOptions,
): Promise<Result<MarketEvidenceBundle>> {
  const clock = options.clock ?? systemClock;
  const producer = options.producer ?? MARKET_EVIDENCE_PRODUCER;
  const startedAt = clock.now();
  const facts = MARKET_EVIDENCE_SYMBOLS.map(createFacts);
  let initialTime: UtcTimestamp;
  try {
    initialTime = await options.reader.readExchangeTime();
  } catch {
    return fail(
      domainError(
        "UNRESOLVED_STATE",
        "Bybit public exchange time could not be established for the collection.",
      ),
    );
  }

  for (const factsForSymbol of facts) {
    try {
      factsForSymbol.instrument = await options.reader.readInstrument(
        factsForSymbol.symbol,
      );
    } catch (error) {
      addReadDiagnostic(
        {
          facts: factsForSymbol,
          operation: "read-instrument",
          endpoint: "/v5/market/instruments-info",
        },
        error,
      );
    }
    try {
      factsForSymbol.ticker = await options.reader.readTicker(
        factsForSymbol.symbol,
      );
    } catch (error) {
      addReadDiagnostic(
        {
          facts: factsForSymbol,
          operation: "read-ticker",
          endpoint: "/v5/market/tickers",
        },
        error,
      );
    }
    for (const interval of OHLCV_INTERVALS) {
      try {
        factsForSymbol.ohlcv[interval] = await options.reader.readOhlcv(
          factsForSymbol.symbol,
          interval,
          MARKET_OHLCV_WINDOWS[interval],
          initialTime,
        );
      } catch (error) {
        addReadDiagnostic(
          {
            facts: factsForSymbol,
            operation: "read-ohlcv",
            endpoint: "/v5/market/kline",
            series: `ohlcv-${interval}`,
          },
          error,
        );
      }
    }
    try {
      factsForSymbol.funding = await options.reader.readFunding(
        factsForSymbol.symbol,
        MARKET_FUNDING_WINDOW,
      );
    } catch (error) {
      addReadDiagnostic(
        {
          facts: factsForSymbol,
          operation: "read-funding",
          endpoint: "/v5/market/funding/history",
          series: "funding",
        },
        error,
      );
    }
    for (const interval of OI_INTERVALS) {
      try {
        factsForSymbol.openInterest[interval] =
          await options.reader.readOpenInterest(
            factsForSymbol.symbol,
            interval,
            MARKET_OPEN_INTEREST_WINDOWS[interval],
          );
      } catch (error) {
        addReadDiagnostic(
          {
            facts: factsForSymbol,
            operation: "read-open-interest",
            endpoint: "/v5/market/open-interest",
            series: `open-interest-${interval}`,
          },
          error,
        );
      }
    }
  }

  let candidateTime: UtcTimestamp;
  try {
    candidateTime = await options.reader.readExchangeTime();
  } catch {
    const first = facts[0];
    if (first !== undefined) {
      first.diagnostics.push(
        makeDiagnostic(
          {
            facts: first,
            operation: "read-candidate-exchange-time",
            endpoint: "/v5/market/time",
          },
          "exchange-time-failed",
        ),
      );
    }
    return buildBundle(
      request.runId,
      producer,
      startedAt,
      maxTimestamp(startedAt, clock.now()),
      initialTime,
      facts,
    );
  }
  if (Date.parse(candidateTime) < Date.parse(initialTime)) {
    const first = facts[0];
    if (first !== undefined) {
      first.diagnostics.push(
        makeDiagnostic(
          {
            facts: first,
            operation: "validate-exchange-time",
            endpoint: "/v5/market/time",
          },
          "non-monotonic-time",
        ),
      );
    }
    return buildBundle(
      request.runId,
      producer,
      startedAt,
      maxTimestamp(startedAt, clock.now()),
      initialTime,
      facts,
    );
  }

  const reread: Array<{
    readonly facts: SymbolFacts;
    readonly kind: "ohlcv" | "funding";
    readonly interval?: MarketSeriesInterval;
  }> = [];
  for (const factsForSymbol of facts) {
    for (const interval of OHLCV_INTERVALS) {
      const normalized = normalizeOhlcvSeries(
        interval,
        factsForSymbol.ohlcv[interval] ?? [],
        candidateTime,
      );
      if (
        !hasDiagnosticForSeries(factsForSymbol, `ohlcv-${interval}`) &&
        (intervalBoundaryCrossed(initialTime, candidateTime, interval) ||
          !normalized.complete)
      ) {
        reread.push({ facts: factsForSymbol, kind: "ohlcv", interval });
      }
    }
    const fundingInterval = factsForSymbol.instrument?.fundingInterval;
    const normalizedFunding = normalizeFundingObservations(
      factsForSymbol.funding ?? [],
      candidateTime,
      MARKET_FUNDING_WINDOW,
      fundingInterval,
    );
    if (
      fundingInterval !== undefined &&
      !hasDiagnosticForSeries(factsForSymbol, "funding") &&
      (fundingBoundaryCrossed(initialTime, candidateTime, fundingInterval) ||
        !normalizedFunding.complete)
    ) {
      reread.push({ facts: factsForSymbol, kind: "funding" });
    }
  }

  let cutoff = candidateTime;
  if (reread.length > 0) {
    for (const target of reread) {
      try {
        if (target.kind === "ohlcv" && target.interval !== undefined) {
          target.facts.ohlcv[target.interval] = await options.reader.readOhlcv(
            target.facts.symbol,
            target.interval,
            MARKET_OHLCV_WINDOWS[target.interval],
            candidateTime,
          );
        } else {
          target.facts.funding = await options.reader.readFunding(
            target.facts.symbol,
            MARKET_FUNDING_WINDOW,
          );
        }
      } catch (error) {
        addReadDiagnostic(
          {
            facts: target.facts,
            operation: `reread-${target.kind}`,
            endpoint:
              target.kind === "ohlcv"
                ? "/v5/market/kline"
                : "/v5/market/funding/history",
            ...(target.interval === undefined
              ? { series: "funding" }
              : { series: `ohlcv-${target.interval}` }),
          },
          error,
        );
      }
    }
    try {
      cutoff = await options.reader.readExchangeTime();
    } catch {
      const first = facts[0];
      if (first !== undefined) {
        first.diagnostics.push(
          makeDiagnostic(
            {
              facts: first,
              operation: "read-final-exchange-time",
              endpoint: "/v5/market/time",
            },
            "exchange-time-failed",
          ),
        );
      }
      cutoff = candidateTime;
    }
    if (Date.parse(cutoff) < Date.parse(candidateTime)) {
      const first = facts[0];
      if (first !== undefined) {
        first.diagnostics.push(
          makeDiagnostic(
            {
              facts: first,
              operation: "validate-final-exchange-time",
              endpoint: "/v5/market/time",
            },
            "non-monotonic-time",
          ),
        );
      }
      cutoff = candidateTime;
    }
    for (const factsForSymbol of facts) {
      for (const interval of OHLCV_INTERVALS) {
        if (intervalBoundaryCrossed(candidateTime, cutoff, interval)) {
          addProofDiagnostic(
            factsForSymbol,
            "validate-final-cutoff",
            "/v5/market/kline",
            `ohlcv-${interval}`,
          );
        }
      }
      const fundingInterval = factsForSymbol.instrument?.fundingInterval;
      if (
        fundingInterval !== undefined &&
        fundingBoundaryCrossed(candidateTime, cutoff, fundingInterval)
      ) {
        addProofDiagnostic(
          factsForSymbol,
          "validate-final-cutoff",
          "/v5/market/funding/history",
          "funding",
        );
      }
    }
  }

  const endedAt = maxTimestamp(startedAt, clock.now());
  return buildBundle(
    request.runId,
    producer,
    startedAt,
    endedAt,
    cutoff,
    facts,
  );
}

export class MarketEvidenceCollector implements MarketEvidencePort {
  private readonly options: MarketEvidenceCollectionOptions;

  constructor(options: MarketEvidenceCollectionOptions) {
    this.options = options;
  }

  collect(
    request: MarketEvidenceCollectionRequest,
  ): Promise<Result<MarketEvidenceBundle>> {
    return collectMarketEvidence(request, this.options);
  }
}

export function createMarketEvidenceCollector(
  options: MarketEvidenceCollectionOptions,
): MarketEvidenceCollector {
  return new MarketEvidenceCollector(options);
}
