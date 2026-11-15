import process from "node:process";
import { pathToFileURL } from "node:url";

import { readMarketDiscoverySnapshot } from "../src/adapters/bybit-v5/public-market-discovery.js";
import { createBybitPublicTransport } from "../src/adapters/bybit-v5/public-transport.js";
import {
  DEFAULT_MARKET_DISCOVERY_SCAN_LIMIT,
  rankMarketDiscovery,
  type MarketDiscoveryCandidate,
} from "../src/domain/market/market-discovery.js";
import { DecimalValue, RoundingMode } from "../src/domain/shared/decimal.js";

interface Options {
  readonly scanLimit: number;
  readonly symbol?: string;
}

const oneHundredResult = DecimalValue.fromString("100");
if (!oneHundredResult.ok)
  throw new Error("Market discovery display constant is invalid.");
const ONE_HUNDRED = oneHundredResult.value;

function parseOptions(args: readonly string[]): Options {
  let scanLimit = DEFAULT_MARKET_DISCOVERY_SCAN_LIMIT;
  let symbol: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--scan-limit") {
      const value = args[index + 1];
      const parsed =
        value !== undefined && /^[1-9]\d*$/u.test(value)
          ? Number(value)
          : Number.NaN;
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error("--scan-limit must be a positive integer");
      }
      scanLimit = parsed;
      index += 1;
    } else if (argument === "--symbol") {
      const value = args[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith("--")) {
        throw new Error("--symbol requires a symbol such as INJUSDT");
      }
      symbol = value;
      index += 1;
    } else {
      throw new Error(
        `Unknown option ${argument ?? ""}. Usage: npm run market:discover -- [--scan-limit N] [--symbol SYMBOL]`,
      );
    }
  }
  return { scanLimit, ...(symbol === undefined ? {} : { symbol }) };
}

function percentage(value: MarketDiscoveryCandidate["priceChange24h"]): string {
  if (value === undefined) return "unknown";
  return `${value.multiply(ONE_HUNDRED).roundToScale(2, RoundingMode.HALF_UP).toString()}%`;
}

function printCandidate(
  candidate: MarketDiscoveryCandidate,
  index?: number,
): void {
  const prefix =
    index === undefined ? candidate.symbol : `${index}. ${candidate.symbol}`;
  console.log(prefix);
  console.log(`  Reasons: ${candidate.reasons.join("; ")}`);
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
  let snapshot;
  try {
    snapshot = await readMarketDiscoverySnapshot({
      transport: createBybitPublicTransport(),
      ...(options.symbol === undefined ? {} : { symbol: options.symbol }),
    });
  } catch (error) {
    console.error(
      `DATA_UNAVAILABLE: ${error instanceof Error ? error.message : "Bybit public data could not be read."}`,
    );
    process.exitCode = 1;
    return;
  }
  const analysis = rankMarketDiscovery(snapshot, {
    scanLimit: options.scanLimit,
    ...(options.symbol === undefined ? {} : { symbol: options.symbol }),
  });
  const durationMs = Math.round(performance.now() - startedAt);

  console.log("Bybit USDT linear perpetual discovery (consideration only)");
  console.log(`As of: ${snapshot.asOf}`);
  console.log(
    `Coverage: instruments=${snapshot.instruments.length}, tickers=${snapshot.tickers.length}, matched=${analysis.matchedCount}, eligible=${analysis.eligibleCount}`,
  );
  console.log(`Requests: ${snapshot.requestCount}; duration: ${durationMs} ms`);

  if (analysis.target !== undefined) {
    if (analysis.target.candidate !== undefined) {
      console.log(`${analysis.target.symbol}: eligible for consideration`);
      printCandidate(analysis.target.candidate);
    } else {
      console.log(
        `${analysis.target.symbol}: NO_CANDIDATES (${analysis.target.reasons?.join(", ") ?? "not eligible"})`,
      );
    }
  } else if (analysis.candidates.length === 0) {
    console.log("NO_CANDIDATES");
  } else {
    console.log(
      `Candidates (top ${analysis.candidates.length}; shortlist ${options.scanLimit}):`,
    );
    analysis.candidates.forEach((candidate, index) =>
      printCandidate(candidate, index + 1),
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
