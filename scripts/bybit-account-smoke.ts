import { pathToFileURL } from "node:url";
import {
  collectAccountEvidence,
  type AccountEvidenceCollectionOptions,
} from "../src/application/account-evidence-collection.js";
import { createMacOSKeychainProvider } from "../src/adapters/macos-keychain.js";
import {
  accountEvidenceContentHash,
  type AccountEvidenceCollectionResult,
} from "../src/domain/account/account-evidence-bundle.js";
import { validateAccountCollateralTiers } from "../src/domain/account/account-evidence-consistency.js";
import { requireIdentifier } from "../src/domain/shared/validation.js";

const usage =
  "Usage: npm run smoke:bybit:account -- --environment demo|testnet|mainnet --run-id <identity> [--symbols BTCUSDT,ETHUSDT,SOLUSDT,DOGEUSDT]";

export function parseAccountSmokeArgs(
  args: readonly string[],
): Pick<
  AccountEvidenceCollectionOptions,
  "environment" | "runId" | "configuredM1Symbols"
> {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!,
      value = args[i + 1];
    if (
      !["--environment", "--run-id", "--symbols"].includes(flag) ||
      flags.has(flag) ||
      !value ||
      value.startsWith("--")
    )
      throw new Error(usage);
    flags.set(flag, value);
  }
  const environment = flags.get("--environment"),
    runId = flags.get("--run-id");
  if (
    (environment !== "demo" &&
      environment !== "testnet" &&
      environment !== "mainnet") ||
    !requireIdentifier(runId, "runId").ok ||
    !runId ||
    runId.trim() !== runId
  )
    throw new Error(usage);
  const configuredM1Symbols = (
    flags.get("--symbols") ?? "BTCUSDT,ETHUSDT,SOLUSDT,DOGEUSDT"
  ).split(",");
  if (
    configuredM1Symbols.some((symbol) => !/^[A-Z0-9]+USDT$/.test(symbol)) ||
    new Set(configuredM1Symbols).size !== configuredM1Symbols.length
  )
    throw new Error(usage);
  return { environment, runId, configuredM1Symbols };
}

export function summarizeAccountEvidence(
  result: AccountEvidenceCollectionResult,
) {
  if (result.kind === "pre-auth-failure")
    return {
      kind: result.kind,
      environment: result.environment,
      policyVersion: result.policyVersion,
      startedAt: result.startedAt,
      endedAt: result.endedAt,
      reasonCodes: result.reasonCodes,
    };
  const bundle = result.bundle,
    hash = accountEvidenceContentHash(bundle);
  if (!hash.ok) throw new Error("Account evidence summary unavailable.");
  const counts = (pass: typeof bundle.criticalPasses.A) => ({
    assets: pass?.assets.length ?? 0,
    collateral: pass?.collateral.length ?? 0,
    positions: pass?.positions.length ?? 0,
    orders: pass?.orders.length ?? 0,
    modeProbes: pass?.modeProbes.length ?? 0,
  });
  const tierCoverage = bundle.coverage.filter(
    (entry) => entry.partition.endpoint === "tiers",
  );
  const safeMarginMode = (pass: typeof bundle.criticalPasses.A) => {
    const mode = pass?.account.marginMode;
    return mode?.state === "known"
      ? ["REGULAR_MARGIN", "ISOLATED_MARGIN", "PORTFOLIO_MARGIN"].includes(
          mode.value,
        )
        ? mode.value
        : "unsupported"
      : "unknown";
  };
  return {
    kind: result.kind,
    environment: bundle.accountBinding.environment,
    schemaVersion: bundle.schemaVersion,
    policyVersion: bundle.policyVersion,
    status: bundle.collectionStatus,
    reasonCodes: [
      ...new Set([
        ...bundle.consistency.reasonCodes,
        ...bundle.diagnostics.map((d) => d.code),
      ]),
    ].sort(),
    timing: {
      startedAt: bundle.startedAt,
      endedAt: bundle.endedAt,
      collectionStartedAt: bundle.collectionStartedAt,
      collectionEndedAt: bundle.collectionEndedAt,
      bundleCutoff: bundle.bundleCutoff,
      historyWindow: bundle.historyWindow,
    },
    durationMs: bundle.budget.monotonicDurationMs,
    partitionCounts: {
      expected: bundle.expectedPartitions.length,
      observed: bundle.coverage.length,
      traversed: bundle.coverage.filter((entry) => entry.status === "traversed")
        .length,
      failed: bundle.coverage.filter((entry) => entry.status === "failed")
        .length,
    },
    failedPartitions: bundle.coverage
      .filter((entry) => entry.status !== "traversed")
      .map((entry) => ({
        endpoint: entry.partition.endpoint,
        pass: entry.partition.pass,
        category: entry.partition.category,
        status: entry.status,
        reasonCodes: entry.reasonCodes,
      })),
    accountInfo: (["A", "B"] as const).map((pass) => {
      const info = bundle.coverage.find(
        (entry) =>
          entry.partition.endpoint === "account-info" &&
          entry.partition.pass === pass,
      );
      const facts = bundle.criticalPasses[pass];
      return {
        pass,
        status: info?.status ?? "not-observed",
        reasonCodes: info?.reasonCodes ?? [],
        marginMode: safeMarginMode(facts),
        marginModeState: facts?.account.marginMode.state ?? "unavailable",
        timeProvenance:
          facts?.observations.find(
            (observation) => observation.partition.endpoint === "account-info",
          )?.timeProvenance ?? "unavailable",
        utaStatusState: facts?.account.utaStatus.state ?? "unavailable",
        spotHedgingState: facts?.account.spotHedging.state ?? "unavailable",
      };
    }),
    recordCounts: {
      A: counts(bundle.criticalPasses.A),
      B: counts(bundle.criticalPasses.B),
      tiers: bundle.auxiliary.tiers.length,
      orders: bundle.auxiliary.orders.length,
      executions: bundle.auxiliary.executions.length,
    },
    modeProof: {
      margin: bundle.consistency.marginCompatibility,
      positions: bundle.consistency.positionModes,
    },
    tierProof:
      tierCoverage.length > 0 &&
      tierCoverage.every((entry) => entry.status === "traversed") &&
      bundle.auxiliary.tiers.length > 0 &&
      validateAccountCollateralTiers(bundle.auxiliary.tiers)
        ? "verified"
        : "unverified",
    canonicalHash: hash.value,
  };
}

export async function runAccountSmoke(
  args: readonly string[],
  dependencies: {
    collect?: typeof collectAccountEvidence;
    credentialLoader?: AccountEvidenceCollectionOptions["credentialLoader"];
    write?: (line: string) => void;
  } = {},
): Promise<number> {
  const write = dependencies.write ?? ((line: string) => console.log(line));
  let options: ReturnType<typeof parseAccountSmokeArgs>;
  try {
    options = parseAccountSmokeArgs(args);
  } catch {
    write(usage);
    return 1;
  }
  try {
    const provider =
      dependencies.credentialLoader ?? createMacOSKeychainProvider();
    const result = await (dependencies.collect ?? collectAccountEvidence)({
      ...options,
      credentialLoader: { load: (environment) => provider.load(environment) },
    });
    write(JSON.stringify(summarizeAccountEvidence(result)));
    return result.kind === "account-evidence" &&
      result.bundle.collectionStatus === "complete"
      ? 0
      : 1;
  } catch {
    write("Account evidence smoke failed; no summary available.");
    return 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await runAccountSmoke(process.argv.slice(2));
}
