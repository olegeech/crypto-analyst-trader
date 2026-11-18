import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  readMarketDiscoveryBooks,
  readMarketDiscoverySnapshot,
} from "../src/adapters/bybit-v5/public-market-discovery.js";
import {
  BybitPublicTransportError,
  createBybitPublicTransport,
} from "../src/adapters/bybit-v5/public-transport.js";
import {
  DEFAULT_MARKET_DISCOVERY_RESULT_LIMIT,
  MAX_MARKET_DISCOVERY_RESULT_LIMIT,
  rankMarketDiscovery,
  type MarketDiscoveryCandidate,
  type MarketDiscoveryBookEstimate,
} from "../src/domain/market/market-discovery.js";
import { DecimalValue, RoundingMode } from "../src/domain/shared/decimal.js";

interface Options {
  readonly symbol?: string;
  readonly resultLimit?: number;
}

const oneHundredResult = DecimalValue.fromString("100");
if (!oneHundredResult.ok)
  throw new Error("Market discovery display constant is invalid.");
const ONE_HUNDRED = oneHundredResult.value;

function parseOptions(args: readonly string[]): Options {
  let symbol: string | undefined;
  let resultLimit: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--symbol") {
      const value = args[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith("--")) {
        throw new Error("--symbol requires a symbol such as INJUSDT");
      }
      symbol = value.toUpperCase();
      index += 1;
    } else if (argument === "--result-limit") {
      const value = args[index + 1];
      const parsed =
        value !== undefined && /^\d+$/u.test(value)
          ? Number(value)
          : Number.NaN;
      if (
        !Number.isSafeInteger(parsed) ||
        parsed < 1 ||
        parsed > MAX_MARKET_DISCOVERY_RESULT_LIMIT
      ) {
        throw new Error("--result-limit must be an integer from 1 to 100");
      }
      resultLimit = parsed;
      index += 1;
    } else {
      throw new Error(
        `Unknown option ${argument ?? ""}. Usage: npm run market:discover -- [--result-limit N] [--symbol SYMBOL]`,
      );
    }
  }
  if (symbol !== undefined && resultLimit !== undefined) {
    throw new Error("--symbol cannot be combined with --result-limit");
  }
  return {
    ...(symbol === undefined ? {} : { symbol }),
    ...(resultLimit === undefined ? {} : { resultLimit }),
  };
}

function percentage(value: MarketDiscoveryCandidate["priceChange24h"]): string {
  if (value === undefined) return "unknown";
  return `${value.multiply(ONE_HUNDRED).roundToScale(2, RoundingMode.HALF_UP).toString()}%`;
}

function printCandidate(
  candidate: MarketDiscoveryCandidate,
  book: MarketDiscoveryBookEstimate | undefined,
  index?: number,
): void {
  const prefix =
    index === undefined ? candidate.symbol : `${index}. ${candidate.symbol}`;
  console.log(prefix);
  console.log(`  Reasons: ${candidate.reasons.join("; ")}`);
  console.log(
    `  Exposure: ${candidate.exposureGroup}; reference market: ${candidate.referenceSession}`,
  );
  if (book !== undefined && book.status !== "unavailable") {
    console.log(
      `  Book time: ${book.asOf}; available ask notional: ${book.availableAskNotional.toString()} USDT (up to 50 levels)`,
    );
  }
  console.log(
    `  Estimated buy cost (bps), 100 USDT: ${book?.status === "available" ? book.estimatedBuyCostBps.roundToScale(4, RoundingMode.HALF_UP).toString() : (book?.status ?? "unavailable")}`,
  );
  console.log(`  24h change: ${percentage(candidate.priceChange24h)}`);
  if (
    candidate.lowPrice24h !== undefined ||
    candidate.highPrice24h !== undefined
  ) {
    console.log(
      `  24h range: ${candidate.lowPrice24h?.toString() ?? "unknown"}–${candidate.highPrice24h?.toString() ?? "unknown"}`,
    );
  }
}

async function run(): Promise<void> {
  let options: Options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Invalid CLI options.",
    );
    process.exitCode = 2;
    return;
  }

  const startedAt = performance.now();
  const transport = createBybitPublicTransport();
  let snapshot;
  try {
    snapshot = await readMarketDiscoverySnapshot({
      transport,
      ...(options.symbol === undefined ? {} : { symbol: options.symbol }),
    });
  } catch (error) {
    if (
      options.symbol !== undefined &&
      error instanceof BybitPublicTransportError &&
      error.retCode === 10001 &&
      /symbol invalid/iu.test(error.retMsg ?? "")
    ) {
      console.log(`${options.symbol}: NO_CANDIDATES (INSTRUMENT_NOT_FOUND)`);
      process.exitCode = 0;
      return;
    }
    const detail =
      error instanceof BybitPublicTransportError && error.retCode !== undefined
        ? `Bybit retCode=${error.retCode}: ${error.message}`
        : error instanceof Error
          ? error.message
          : "Bybit public data could not be read.";
    console.error(`DATA_UNAVAILABLE: ${detail}`);
    process.exitCode = 1;
    return;
  }
  const analysis = rankMarketDiscovery(snapshot, options);
  const books = await readMarketDiscoveryBooks({
    transport,
    symbols: analysis.candidates.map((candidate) => candidate.symbol),
  });
  const durationMs = Math.round(performance.now() - startedAt);

  console.log("Bybit USDT linear perpetual discovery (consideration only)");
  console.log(`As of: ${snapshot.asOf}`);
  console.log(
    `Coverage: instruments=${snapshot.instruments.length}, tickers=${snapshot.tickers.length}, matched=${analysis.matchedCount}, eligible=${analysis.eligibleCount}`,
  );
  console.log(
    `Requests: ${snapshot.requestCount + books.requestCount} (bulk ${snapshot.requestCount}, books ${books.requestCount}); duration: ${durationMs} ms`,
  );
  console.log(
    `Representatives: ${analysis.representativeRule}; duplicates omitted: ${analysis.duplicateCount}`,
  );
  console.log(
    "Book costs are point-in-time estimates, including half-spread and book sweep. Fills are not guaranteed; fees and RPI liquidity are excluded.",
  );

  if (analysis.target !== undefined) {
    if (analysis.target.candidate !== undefined) {
      console.log(`${analysis.target.symbol}: eligible for consideration`);
      printCandidate(
        analysis.target.candidate,
        books.estimates.get(analysis.target.candidate.symbol),
      );
    } else {
      console.log(
        `${analysis.target.symbol}: NO_CANDIDATES (${analysis.target.reasons?.join(", ") ?? "not eligible"})`,
      );
    }
  } else if (analysis.candidates.length === 0) {
    console.log("NO_CANDIDATES");
  } else {
    console.log(
      `Candidates (top ${analysis.candidates.length} of ${analysis.eligibleCount} eligible; limit ${options.resultLimit ?? DEFAULT_MARKET_DISCOVERY_RESULT_LIMIT}):`,
    );
    analysis.candidates.forEach((candidate, index) =>
      printCandidate(
        candidate,
        books.estimates.get(candidate.symbol),
        index + 1,
      ),
    );
  }

  if (analysis.target === undefined) {
    const exclusions = Object.entries(analysis.exclusionCounts).sort(
      ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
    );
    if (exclusions.length > 0) {
      console.log(
        `Excluded: ${exclusions.map(([reason, count]) => `${reason}=${count}`).join(", ")}`,
      );
    }
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  await run();
}
