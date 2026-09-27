import { encodeCanonicalArtifact } from "../domain/identity/canonical-artifact.js";
import {
  createLiquidationEvidenceBundle,
  createLiquidationEvidenceDiagnostic,
  createLiquidationEvidenceRef,
  LIQUIDATION_EVIDENCE_ASSETS,
  LIQUIDATION_EVIDENCE_POLICY_VERSION,
  LIQUIDATION_EVIDENCE_PRODUCER,
  LIQUIDATION_EVIDENCE_SCHEMA_VERSION,
  LIQUIDATION_HOUR_MS,
  liquidationHistoryWindow,
  type LiquidationEvidenceBundleInput,
  type LiquidationEvidenceDiagnosticInput,
  type LiquidationTargetAsset,
} from "../domain/liquidation/liquidation-evidence-bundle.js";
import {
  createMarketEvidenceBundle,
  MARKET_EVIDENCE_PRODUCER,
  MARKET_EVIDENCE_SYMBOLS,
  MARKET_EVIDENCE_VALID_FOR_MS,
  MARKET_EVIDENCE_UNIVERSE_VERSION,
  marketEvidenceContentHash,
  type MarketEvidenceBundle,
} from "../domain/market/market-evidence-bundle.js";
import { DecimalValue } from "../domain/shared/decimal.js";
import { domainError } from "../domain/shared/errors.js";
import { fail, ok, type Result } from "../domain/shared/result.js";
import {
  parseUtcTimestamp,
  systemClock,
  type Clock,
  type UtcTimestamp,
} from "../domain/shared/time.js";
import { isRecord } from "../domain/shared/validation.js";
import type {
  CoinalyzeCatalogueResult,
  CoinalyzeHistoryResult,
  CoinalyzeLiquidationDataPort,
  CoinalyzeMarket,
  CoinalyzeMarketHistory,
} from "../ports/coinalyze-liquidation-data.js";
import type {
  LiquidationEvidenceCollectionRequest,
  LiquidationEvidenceCollectionResult,
} from "../ports/liquidation-evidence.js";
import type { SecretProvider } from "../ports/secret-provider.js";
import { selectEligibleLiquidationMarkets } from "./liquidation-market-selection.js";

const COINALYZE_SECRET_IDENTITY = Object.freeze({
  provider: "coinalyze",
  credential: "api-key",
});

interface CompatibleRunContext {
  readonly marketEvidence: MarketEvidenceBundle;
  readonly marketEvidenceHash: string;
  readonly referenceValidityMs: number;
}

export interface LiquidationEvidenceCollectionOptions {
  readonly marketData: CoinalyzeLiquidationDataPort;
  readonly secrets: SecretProvider;
  readonly clock?: Clock;
}

interface SelectedMarket extends CoinalyzeMarket {
  readonly asset: LiquidationTargetAsset;
}

interface NormalizedCatalogue {
  readonly markets: readonly CoinalyzeMarket[];
  readonly coverageComplete: boolean;
  readonly diagnostics: readonly LiquidationEvidenceDiagnosticInput[];
}

interface NormalizedHistory {
  readonly histories: readonly CoinalyzeMarketHistory[];
  readonly responseValid: boolean;
  readonly diagnostics: readonly LiquidationEvidenceDiagnosticInput[];
}

function makeDiagnostic(
  code: LiquidationEvidenceDiagnosticInput["code"],
  operation: LiquidationEvidenceDiagnosticInput["operation"],
  options: {
    asset?: string;
    providerSymbol?: string;
    bucketTimestamp?: string;
  } = {},
): LiquidationEvidenceDiagnosticInput {
  const parsed = createLiquidationEvidenceDiagnostic({
    code,
    operation,
    ...options,
  });
  return parsed.ok ? parsed.value : Object.freeze({ code, operation });
}

function compatibleRunContext(value: unknown): Result<CompatibleRunContext> {
  const parsed = createMarketEvidenceBundle(value);
  if (!parsed.ok) {
    return fail(
      domainError(
        "INCOMPATIBLE_EVIDENCE",
        "Liquidation collection requires a valid #11 market-evidence bundle.",
      ),
    );
  }
  const marketEvidence = parsed.value;
  const computedHash = marketEvidenceContentHash(marketEvidence);
  if (!computedHash.ok) {
    return fail(
      domainError(
        "INCOMPATIBLE_EVIDENCE",
        "Liquidation collection requires a valid #11 market-evidence bundle.",
      ),
    );
  }
  const identityReferences = marketEvidence.evidence.filter(
    (reference) =>
      reference.kind === "market-evidence-bundle" &&
      reference.schemaVersion === "market-evidence/v1" &&
      reference.producer === MARKET_EVIDENCE_PRODUCER &&
      reference.sourceId === `bybit-public:${marketEvidence.runId}` &&
      reference.asOf === marketEvidence.bundleCutoff,
  );
  const identityReference = identityReferences[0];
  if (
    marketEvidence.producer !== MARKET_EVIDENCE_PRODUCER ||
    marketEvidence.universeVersion !== MARKET_EVIDENCE_UNIVERSE_VERSION ||
    marketEvidence.universe.length !== MARKET_EVIDENCE_SYMBOLS.length ||
    marketEvidence.universe.some(
      (symbol, index) => symbol !== MARKET_EVIDENCE_SYMBOLS[index],
    ) ||
    marketEvidence.source.exchange !== "bybit" ||
    marketEvidence.source.environment !== "mainnet" ||
    marketEvidence.source.origin !== "https://api.bybit.com" ||
    marketEvidence.source.category !== "linear" ||
    identityReferences.length !== 1 ||
    identityReference === undefined ||
    identityReference.validForMs !== MARKET_EVIDENCE_VALID_FOR_MS ||
    identityReference.contentHash !== computedHash.value
  ) {
    return fail(
      domainError(
        "INCOMPATIBLE_EVIDENCE",
        "Liquidation collection requires compatible #11 run, cutoff, and M1 universe identity.",
      ),
    );
  }
  return ok(
    Object.freeze({
      marketEvidence,
      marketEvidenceHash: computedHash.value,
      referenceValidityMs: MARKET_EVIDENCE_VALID_FOR_MS,
    }),
  );
}

function safeProviderText(value: unknown, maxLength = 128): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return undefined;
  }
  return value.normalize("NFC");
}

function parseMarket(value: unknown): CoinalyzeMarket | undefined {
  if (!isRecord(value)) return undefined;
  const symbol = safeProviderText(value.symbol);
  const exchange = safeProviderText(value.exchange, 64);
  const symbolOnExchange = safeProviderText(value.symbolOnExchange);
  const baseAsset = safeProviderText(value.baseAsset, 64);
  const quoteAsset = safeProviderText(value.quoteAsset, 64);
  const marginType = safeProviderText(value.marginType, 64);
  const notionalDenominatedIn = safeProviderText(
    value.notionalDenominatedIn,
    64,
  );
  if (
    symbol === undefined ||
    exchange === undefined ||
    symbolOnExchange === undefined ||
    baseAsset === undefined ||
    quoteAsset === undefined ||
    marginType === undefined ||
    notionalDenominatedIn === undefined ||
    typeof value.isPerpetual !== "boolean" ||
    typeof value.expireAt !== "number" ||
    !Number.isSafeInteger(value.expireAt) ||
    value.expireAt < 0
  ) {
    return undefined;
  }
  return Object.freeze({
    symbol,
    exchange,
    symbolOnExchange,
    baseAsset,
    quoteAsset,
    isPerpetual: value.isPerpetual,
    marginType,
    expireAt: value.expireAt,
    notionalDenominatedIn,
  });
}

function marketContractKey(market: CoinalyzeMarket): string {
  return JSON.stringify([market.exchange, market.symbolOnExchange]);
}

function sameMarket(left: CoinalyzeMarket, right: CoinalyzeMarket): boolean {
  return (
    left.symbol === right.symbol &&
    left.exchange === right.exchange &&
    left.symbolOnExchange === right.symbolOnExchange &&
    left.baseAsset === right.baseAsset &&
    left.quoteAsset === right.quoteAsset &&
    left.isPerpetual === right.isPerpetual &&
    left.marginType === right.marginType &&
    left.expireAt === right.expireAt &&
    left.notionalDenominatedIn === right.notionalDenominatedIn
  );
}

function appendProviderDiagnostics(
  diagnostics: LiquidationEvidenceDiagnosticInput[],
  input: unknown,
  operation: LiquidationEvidenceDiagnosticInput["operation"],
): boolean {
  if (!Array.isArray(input)) return false;
  let valid = true;
  for (const item of input) {
    const parsed = createLiquidationEvidenceDiagnostic(item);
    if (!parsed.ok) {
      valid = false;
      continue;
    }
    diagnostics.push(parsed.value);
  }
  if (!valid)
    diagnostics.push(makeDiagnostic("provider-unavailable", operation));
  return valid;
}

function normalizeCatalogue(value: unknown): NormalizedCatalogue {
  const diagnostics: LiquidationEvidenceDiagnosticInput[] = [];
  if (
    !isRecord(value) ||
    !Array.isArray(value.markets) ||
    typeof value.complete !== "boolean" ||
    !Array.isArray(value.diagnostics)
  ) {
    return Object.freeze({
      markets: Object.freeze([]),
      coverageComplete: false,
      diagnostics: Object.freeze([
        makeDiagnostic("invalid-catalogue", "discover-markets"),
      ]),
    });
  }

  let coverageComplete = value.complete;
  const diagnosticsValid = appendProviderDiagnostics(
    diagnostics,
    value.diagnostics,
    "discover-markets",
  );
  if (!diagnosticsValid || diagnostics.length > 0) coverageComplete = false;

  const bySymbol = new Map<string, CoinalyzeMarket>();
  const byContract = new Map<string, CoinalyzeMarket>();
  const blockedSymbols = new Set<string>();
  const blockedContracts = new Set<string>();
  for (const rawMarket of value.markets) {
    const market = parseMarket(rawMarket);
    if (market === undefined) {
      coverageComplete = false;
      diagnostics.push(makeDiagnostic("invalid-catalogue", "discover-markets"));
      continue;
    }
    const key = marketContractKey(market);
    if (blockedSymbols.has(market.symbol) || blockedContracts.has(key)) {
      coverageComplete = false;
      continue;
    }
    const previousBySymbol = bySymbol.get(market.symbol);
    const previousByContract = byContract.get(key);
    if (previousBySymbol !== undefined || previousByContract !== undefined) {
      coverageComplete = false;
      diagnostics.push(
        makeDiagnostic("duplicate-market", "discover-markets", {
          providerSymbol: market.symbol,
        }),
      );
      const previous = previousBySymbol ?? previousByContract;
      if (previous !== undefined && sameMarket(previous, market)) continue;
      for (const previousMarket of [previousBySymbol, previousByContract]) {
        if (previousMarket === undefined) continue;
        bySymbol.delete(previousMarket.symbol);
        byContract.delete(marketContractKey(previousMarket));
        blockedSymbols.add(previousMarket.symbol);
        blockedContracts.add(marketContractKey(previousMarket));
      }
      blockedSymbols.add(market.symbol);
      blockedContracts.add(key);
      continue;
    }
    bySymbol.set(market.symbol, market);
    byContract.set(key, market);
  }

  if (!coverageComplete && diagnostics.length === 0) {
    diagnostics.push(
      makeDiagnostic("catalogue-incomplete", "discover-markets"),
    );
  }
  const markets = [...bySymbol.values()].sort((left, right) =>
    left.symbol.localeCompare(right.symbol),
  );
  return Object.freeze({
    markets: Object.freeze(markets),
    coverageComplete,
    diagnostics: Object.freeze(diagnostics),
  });
}

function canonicalDecimal(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = DecimalValue.fromString(value);
  if (!parsed.ok || parsed.value.isNegative()) return undefined;
  return parsed.value.toString();
}

function normalizeHistoryObservation(
  value: unknown,
  oldestBucket: number,
  latestClosedBucket: number,
): CoinalyzeMarketHistory["observations"][number] | undefined {
  if (!isRecord(value)) return undefined;
  const timestamp = parseUtcTimestamp(value.timestamp);
  const longUsd = canonicalDecimal(value.longUsd);
  const shortUsd = canonicalDecimal(value.shortUsd);
  if (!timestamp.ok || longUsd === undefined || shortUsd === undefined) {
    return undefined;
  }
  const epoch = Date.parse(timestamp.value);
  if (
    epoch % LIQUIDATION_HOUR_MS !== 0 ||
    epoch < oldestBucket ||
    epoch > latestClosedBucket
  ) {
    return undefined;
  }
  return Object.freeze({
    timestamp: timestamp.value,
    longUsd,
    shortUsd,
  });
}

function sameHistoryObservation(
  left: CoinalyzeMarketHistory["observations"][number],
  right: CoinalyzeMarketHistory["observations"][number],
): boolean {
  return (
    left.timestamp === right.timestamp &&
    left.longUsd === right.longUsd &&
    left.shortUsd === right.shortUsd
  );
}

function normalizeHistory(
  value: unknown,
  selectedMarkets: readonly SelectedMarket[],
  oldestBucket: number,
  latestClosedBucket: number,
): NormalizedHistory {
  const diagnostics: LiquidationEvidenceDiagnosticInput[] = [];
  if (
    !isRecord(value) ||
    !Array.isArray(value.histories) ||
    typeof value.responseValid !== "boolean" ||
    !Array.isArray(value.diagnostics)
  ) {
    return Object.freeze({
      histories: Object.freeze(
        selectedMarkets.map(({ symbol }) =>
          Object.freeze({ symbol, observations: Object.freeze([]) }),
        ),
      ),
      responseValid: false,
      diagnostics: Object.freeze([
        makeDiagnostic("invalid-observation", "fetch-liquidation-history"),
      ]),
    });
  }

  let responseValid = value.responseValid;
  const providerDiagnosticsValid = appendProviderDiagnostics(
    diagnostics,
    value.diagnostics,
    "fetch-liquidation-history",
  );
  if (!providerDiagnosticsValid || diagnostics.length > 0)
    responseValid = false;

  const requestedSymbols = new Set(selectedMarkets.map(({ symbol }) => symbol));
  const bySymbol = new Map<string, CoinalyzeMarketHistory>();
  const conflictedSymbols = new Set<string>();
  for (const rawHistory of value.histories) {
    if (!isRecord(rawHistory)) {
      responseValid = false;
      diagnostics.push(
        makeDiagnostic("invalid-observation", "fetch-liquidation-history"),
      );
      continue;
    }
    const symbol = safeProviderText(rawHistory.symbol);
    if (symbol === undefined || !requestedSymbols.has(symbol)) {
      responseValid = false;
      diagnostics.push(
        makeDiagnostic("invalid-observation", "fetch-liquidation-history"),
      );
      continue;
    }
    if (conflictedSymbols.has(symbol)) continue;
    if (bySymbol.has(symbol)) {
      responseValid = false;
      diagnostics.push(
        makeDiagnostic("invalid-observation", "fetch-liquidation-history", {
          providerSymbol: symbol,
        }),
      );
      bySymbol.delete(symbol);
      conflictedSymbols.add(symbol);
      continue;
    }
    if (!Array.isArray(rawHistory.observations)) {
      responseValid = false;
      diagnostics.push(
        makeDiagnostic("invalid-observation", "fetch-liquidation-history", {
          providerSymbol: symbol,
        }),
      );
      bySymbol.set(
        symbol,
        Object.freeze({ symbol, observations: Object.freeze([]) }),
      );
      continue;
    }

    const byTimestamp = new Map<
      string,
      CoinalyzeMarketHistory["observations"][number]
    >();
    const conflictedBuckets = new Set<string>();
    let previousTimestamp = -1;
    for (const rawObservation of rawHistory.observations) {
      const observation = normalizeHistoryObservation(
        rawObservation,
        oldestBucket,
        latestClosedBucket,
      );
      if (observation === undefined) {
        responseValid = false;
        diagnostics.push(
          makeDiagnostic("invalid-observation", "fetch-liquidation-history", {
            providerSymbol: symbol,
          }),
        );
        continue;
      }
      const epoch = Date.parse(observation.timestamp);
      if (epoch <= previousTimestamp) {
        responseValid = false;
        diagnostics.push(
          makeDiagnostic("invalid-observation", "fetch-liquidation-history", {
            providerSymbol: symbol,
            bucketTimestamp: observation.timestamp,
          }),
        );
      }
      previousTimestamp = epoch;
      if (conflictedBuckets.has(observation.timestamp)) continue;
      const previous = byTimestamp.get(observation.timestamp);
      if (previous !== undefined) {
        responseValid = false;
        diagnostics.push(
          makeDiagnostic("invalid-observation", "fetch-liquidation-history", {
            providerSymbol: symbol,
            bucketTimestamp: observation.timestamp,
          }),
        );
        if (!sameHistoryObservation(previous, observation)) {
          byTimestamp.delete(observation.timestamp);
          conflictedBuckets.add(observation.timestamp);
        }
        continue;
      }
      byTimestamp.set(observation.timestamp, observation);
    }
    const observations = [...byTimestamp.values()].sort(
      (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp),
    );
    bySymbol.set(
      symbol,
      Object.freeze({ symbol, observations: Object.freeze(observations) }),
    );
  }

  for (const market of selectedMarkets) {
    if (bySymbol.has(market.symbol)) continue;
    responseValid = false;
    diagnostics.push(
      makeDiagnostic("history-unavailable", "fetch-liquidation-history", {
        providerSymbol: market.symbol,
      }),
    );
    bySymbol.set(
      market.symbol,
      Object.freeze({ symbol: market.symbol, observations: Object.freeze([]) }),
    );
  }

  if (!responseValid && diagnostics.length === 0) {
    diagnostics.push(
      makeDiagnostic("history-incomplete", "fetch-liquidation-history"),
    );
  }

  const histories = selectedMarkets.map(
    (market) =>
      bySymbol.get(market.symbol) ?? {
        symbol: market.symbol,
        observations: Object.freeze([]),
      },
  );
  return Object.freeze({
    histories: Object.freeze(histories),
    responseValid,
    diagnostics: Object.freeze(diagnostics),
  });
}

function hasExpectedHistory(
  market: SelectedMarket,
  history: CoinalyzeMarketHistory | undefined,
  buckets: readonly number[],
): boolean {
  if (history === undefined || history.observations.length !== buckets.length) {
    return false;
  }
  return buckets.every(
    (bucket, index) =>
      Date.parse(history.observations[index]?.timestamp ?? "") === bucket,
  );
}

function buildBundleInput({
  context,
  startedAt,
  endedAt,
  coverageProof,
  historyProof,
  status,
  selectedMarkets,
  histories,
  diagnostics,
}: {
  readonly context: CompatibleRunContext;
  readonly startedAt: UtcTimestamp;
  readonly endedAt: UtcTimestamp;
  readonly coverageProof: "complete" | "incomplete";
  readonly historyProof: "complete" | "incomplete";
  readonly status: "complete" | "incomplete" | "failed";
  readonly selectedMarkets: readonly SelectedMarket[];
  readonly histories: readonly CoinalyzeMarketHistory[];
  readonly diagnostics: readonly LiquidationEvidenceDiagnosticInput[];
}): LiquidationEvidenceBundleInput {
  const historyBySymbol = new Map(
    histories.map((history) => [history.symbol, history] as const),
  );
  const targetMarkets = new Map<LiquidationTargetAsset, SelectedMarket[]>(
    LIQUIDATION_EVIDENCE_ASSETS.map((asset) => [asset, []]),
  );
  for (const market of selectedMarkets) {
    targetMarkets.get(market.asset)?.push(market);
  }
  const cutoff = context.marketEvidence.bundleCutoff;
  return {
    runId: context.marketEvidence.runId,
    schemaVersion: LIQUIDATION_EVIDENCE_SCHEMA_VERSION,
    producer: LIQUIDATION_EVIDENCE_PRODUCER,
    policyVersion: LIQUIDATION_EVIDENCE_POLICY_VERSION,
    provider: "coinalyze",
    collectionStartedAt: startedAt,
    collectionEndedAt: endedAt,
    bundleCutoff: cutoff,
    marketEvidence: {
      runId: context.marketEvidence.runId,
      universeVersion: context.marketEvidence.universeVersion,
      bundleCutoff: cutoff,
      contentHash: context.marketEvidenceHash,
    },
    coverageProof,
    historyProof,
    status,
    targets: LIQUIDATION_EVIDENCE_ASSETS.map((asset) => ({
      asset,
      constituents: (targetMarkets.get(asset) ?? []).map((market) => ({
        providerSymbol: market.symbol,
        exchange: market.exchange,
        symbolOnExchange: market.symbolOnExchange,
        baseAsset: market.baseAsset as LiquidationTargetAsset,
        quoteAsset: market.quoteAsset,
        isPerpetual: true,
        marginType: market.marginType,
        expireAt: market.expireAt,
        notionalDenominatedIn: market.notionalDenominatedIn,
        observations: (
          historyBySymbol.get(market.symbol)?.observations ?? []
        ).map((observation) => ({
          timestamp: observation.timestamp,
          longUsd: observation.longUsd,
          shortUsd: observation.shortUsd,
        })),
      })),
    })),
    diagnostics,
  };
}

function finalizeBundle(
  input: LiquidationEvidenceBundleInput,
  validForMs: number,
): Result<LiquidationEvidenceCollectionResult> {
  const bundle = createLiquidationEvidenceBundle(input);
  if (!bundle.ok) return bundle;
  const artifact = encodeCanonicalArtifact(
    "liquidation-evidence-bundle",
    bundle.value,
  );
  if (!artifact.ok) return artifact;
  const evidence = createLiquidationEvidenceRef(
    bundle.value,
    artifact.value.canonicalHash,
    validForMs,
  );
  if (!evidence.ok) return evidence;
  return ok(
    Object.freeze({
      bundle: bundle.value,
      artifact: artifact.value,
      evidence: evidence.value,
    }),
  );
}

function emptyCatalogueResult(): CoinalyzeCatalogueResult {
  return Object.freeze({
    markets: Object.freeze([]),
    complete: false,
    diagnostics: Object.freeze([
      makeDiagnostic("catalogue-unavailable", "discover-markets"),
    ]),
  });
}

function emptyHistoryResult(
  selectedMarkets: readonly SelectedMarket[],
): CoinalyzeHistoryResult {
  return Object.freeze({
    histories: Object.freeze(
      selectedMarkets.map(({ symbol }) =>
        Object.freeze({ symbol, observations: Object.freeze([]) }),
      ),
    ),
    responseValid: false,
    diagnostics: Object.freeze([
      makeDiagnostic("history-unavailable", "fetch-liquidation-history"),
    ]),
  });
}

export async function collectLiquidationEvidence(
  request: LiquidationEvidenceCollectionRequest,
  options: LiquidationEvidenceCollectionOptions,
): Promise<Result<LiquidationEvidenceCollectionResult>> {
  const context = compatibleRunContext(request.marketEvidence);
  if (!context.ok) return context;
  const clock = options.clock ?? systemClock;
  const startedAt = clock.now();
  const diagnostics: LiquidationEvidenceDiagnosticInput[] = [];
  let catalogue = emptyCatalogueResult();
  let selectedMarkets: readonly SelectedMarket[] = Object.freeze([]);
  let histories: readonly CoinalyzeMarketHistory[] = Object.freeze([]);
  let coverageComplete = false;
  let historyComplete = false;

  let secretResult: unknown;
  try {
    secretResult = await options.secrets.read(COINALYZE_SECRET_IDENTITY);
  } catch {
    secretResult = {
      kind: "unavailable" as const,
      reason: "inaccessible" as const,
    };
  }
  const apiKey =
    isRecord(secretResult) &&
    secretResult.kind === "available" &&
    typeof secretResult.secret === "string" &&
    secretResult.secret.length > 0 &&
    !/[\u0000-\u001f\u007f]/u.test(secretResult.secret)
      ? secretResult.secret
      : undefined;

  if (apiKey === undefined) {
    diagnostics.push(makeDiagnostic("secret-unavailable", "discover-markets"));
  } else {
    try {
      catalogue = await options.marketData.fetchFutureMarkets(apiKey);
    } catch {
      catalogue = emptyCatalogueResult();
    }
  }

  const normalizedCatalogue = normalizeCatalogue(catalogue);
  diagnostics.push(...normalizedCatalogue.diagnostics);
  coverageComplete = normalizedCatalogue.coverageComplete;
  selectedMarkets = selectEligibleLiquidationMarkets(
    normalizedCatalogue.markets,
    Date.parse(context.value.marketEvidence.bundleCutoff),
  );

  const marketsByAsset = new Map<LiquidationTargetAsset, SelectedMarket[]>(
    LIQUIDATION_EVIDENCE_ASSETS.map((asset) => [asset, []]),
  );
  for (const market of selectedMarkets)
    marketsByAsset.get(market.asset)?.push(market);
  for (const asset of LIQUIDATION_EVIDENCE_ASSETS) {
    if ((marketsByAsset.get(asset)?.length ?? 0) > 0) continue;
    if (coverageComplete) {
      diagnostics.push(
        makeDiagnostic("no-eligible-markets", "discover-markets", { asset }),
      );
    } else if (
      !diagnostics.some(
        ({ code, operation }) =>
          code === "catalogue-incomplete" && operation === "discover-markets",
      )
    ) {
      diagnostics.push(
        makeDiagnostic("catalogue-incomplete", "discover-markets", { asset }),
      );
    }
  }

  const expected = liquidationHistoryWindow(
    Date.parse(context.value.marketEvidence.bundleCutoff),
  ).epochs;
  const oldestBucket = expected[0] ?? 0;
  const latestClosedBucket = expected.at(-1) ?? 0;
  if (selectedMarkets.length > 0 && apiKey !== undefined) {
    const from = Math.floor(oldestBucket / 1_000);
    const to = Math.floor(latestClosedBucket / 1_000);
    let historyResult: CoinalyzeHistoryResult;
    try {
      historyResult = await options.marketData.fetchLiquidationHistory(
        apiKey,
        selectedMarkets.map(({ symbol }) => symbol),
        from,
        to,
      );
    } catch {
      historyResult = emptyHistoryResult(selectedMarkets);
    }
    const normalizedHistory = normalizeHistory(
      historyResult,
      selectedMarkets,
      oldestBucket,
      latestClosedBucket,
    );
    histories = normalizedHistory.histories;
    diagnostics.push(...normalizedHistory.diagnostics);
    historyComplete = normalizedHistory.responseValid;

    const historyBySymbol = new Map(
      histories.map((history) => [history.symbol, history] as const),
    );
    for (const market of selectedMarkets) {
      const history = historyBySymbol.get(market.symbol);
      if (hasExpectedHistory(market, history, expected)) continue;
      historyComplete = false;
      const observed = new Set(
        (history?.observations ?? []).map(({ timestamp }) =>
          Date.parse(timestamp),
        ),
      );
      const firstMissing = expected.find((bucket) => !observed.has(bucket));
      diagnostics.push(
        makeDiagnostic(
          firstMissing === undefined ? "history-incomplete" : "missing-bucket",
          "fetch-liquidation-history",
          {
            asset: market.asset,
            providerSymbol: market.symbol,
            ...(firstMissing === undefined
              ? {}
              : { bucketTimestamp: new Date(firstMissing).toISOString() }),
          },
        ),
      );
    }
  } else if (selectedMarkets.length > 0) {
    for (const market of selectedMarkets) {
      diagnostics.push(
        makeDiagnostic("history-unavailable", "fetch-liquidation-history", {
          asset: market.asset,
          providerSymbol: market.symbol,
        }),
      );
    }
  }

  const status =
    selectedMarkets.length === 0
      ? "failed"
      : coverageComplete && historyComplete && diagnostics.length === 0
        ? "complete"
        : "incomplete";
  const endedAt = clock.now();
  const bundleInput = buildBundleInput({
    context: context.value,
    startedAt,
    endedAt,
    coverageProof: coverageComplete ? "complete" : "incomplete",
    historyProof: historyComplete ? "complete" : "incomplete",
    status,
    selectedMarkets,
    histories,
    diagnostics,
  });
  return finalizeBundle(bundleInput, context.value.referenceValidityMs);
}
