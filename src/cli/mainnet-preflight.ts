import { pathToFileURL } from "node:url";
import { MARKET_EVIDENCE_SYMBOLS } from "../domain/market/market-evidence-bundle.js";
import { isPlanningSymbol } from "../domain/planning/decision-policy.js";
import { runMainnetPreflight } from "../application/mainnet-preflight-composition.js";
import type { MainnetPreflightResult } from "../application/mainnet-preflight-composition.js";

export const MAINNET_PREFLIGHT_USAGE = `Usage: npm run mainnet:preflight -- --symbol <${MARKET_EVIDENCE_SYMBOLS.join("|")}>`;

export interface MainnetPreflightCliOutput {
  write(text: string): void;
}

export function parseMainnetPreflightArgs(
  argv: readonly string[],
): { readonly ok: true; readonly symbol: string } | { readonly ok: false } {
  if (argv.length !== 2 || argv[0] !== "--symbol" || !isPlanningSymbol(argv[1]))
    return { ok: false };
  return { ok: true, symbol: argv[1] };
}

function writeResult(
  output: MainnetPreflightCliOutput,
  result: MainnetPreflightResult,
  symbol: string,
): number {
  output.write("ENVIRONMENT=MAINNET\n");
  output.write(`SYMBOL=${symbol}\n`);
  output.write(`EXCHANGE_READS=${result.requestCounts.exchangeReads}\n`);
  output.write(`EXCHANGE_WRITES=${result.requestCounts.exchangeWrites}\n`);
  if (result.kind === "failure") {
    output.write("VERDICT=BLOCKED\n");
    output.write("CAPABILITY_STATUS=NOT_ESTABLISHED\n");
    output.write("LIVE_PROOF=NOT_ESTABLISHED\n");
    output.write(`REASON_CODES=${result.reasonCode}\n`);
    output.write("PROVIDER_REASON_CODES=NONE\n");
    output.write("WARNING_CODES=NONE\n");
    return result.reasonCode === "INVALID_SYMBOL" ? 2 : 1;
  }

  const readiness = result.readiness;
  output.write(`VERDICT=${readiness.verdict}\n`);
  output.write(`CAPABILITY_STATUS=${readiness.capabilityProfile.status}\n`);
  output.write("LIVE_PROOF=NOT_ESTABLISHED\n");
  if (readiness.accountEvidenceAgeMs !== undefined)
    output.write(`ACCOUNT_EVIDENCE_AGE_MS=${readiness.accountEvidenceAgeMs}\n`);
  output.write(
    `UNRELATED_COVERAGE_GAPS=${readiness.unrelatedCoverageGapCount}\n`,
  );
  output.write(`REASON_CODES=${readiness.reasonCodes.join(",") || "NONE"}\n`);
  output.write(
    `PROVIDER_REASON_CODES=${
      [
        ...new Set([
          ...readiness.providerReasonCodes,
          ...(result.instrumentProviderReasonCode === undefined
            ? []
            : [result.instrumentProviderReasonCode]),
        ]),
      ]
        .sort()
        .join(",") || "NONE"
    }\n`,
  );
  output.write(`WARNING_CODES=${readiness.warningCodes.join(",") || "NONE"}\n`);
  return readiness.verdict === "READY" ? 0 : 4;
}

export async function runMainnetPreflightCli(
  argv: readonly string[],
  dependencies: {
    readonly output?: MainnetPreflightCliOutput;
    readonly run?: typeof runMainnetPreflight;
  } = {},
): Promise<number> {
  const output = dependencies.output ?? {
    write: (text: string) => process.stdout.write(text),
  };
  const parsed = parseMainnetPreflightArgs(argv);
  if (!parsed.ok) {
    output.write(`${MAINNET_PREFLIGHT_USAGE}\n`);
    output.write("VERDICT=BLOCKED\nREASON_CODES=INVALID_REQUEST\n");
    return 2;
  }
  try {
    return writeResult(
      output,
      await (dependencies.run ?? runMainnetPreflight)(parsed.symbol),
      parsed.symbol,
    );
  } catch {
    output.write("ENVIRONMENT=MAINNET\n");
    output.write(`SYMBOL=${parsed.symbol}\n`);
    output.write("VERDICT=BLOCKED\n");
    output.write("CAPABILITY_STATUS=NOT_ESTABLISHED\n");
    output.write("LIVE_PROOF=NOT_ESTABLISHED\n");
    output.write("EXCHANGE_READS=UNKNOWN\nEXCHANGE_WRITES=UNKNOWN\n");
    output.write("REASON_CODES=PREFLIGHT_FAILED\n");
    return 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await runMainnetPreflightCli(process.argv.slice(2));
}
