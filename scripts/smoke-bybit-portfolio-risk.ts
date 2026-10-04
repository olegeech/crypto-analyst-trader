import { createReadStream } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { Buffer } from "node:buffer";
import { collectAccountEvidence } from "../src/application/account-evidence-collection.js";
import {
  createPortfolioRiskPreflightBoundary,
  type PortfolioRiskApplicationResult,
} from "../src/application/portfolio-risk-preflight.js";
import { createMacOSKeychainProvider } from "../src/adapters/macos-keychain.js";
import { createBybitRiskEvidenceReader } from "../src/adapters/bybit-v5/risk-evidence-reader.js";
import {
  accountEvidenceContentHash,
  type AccountEvidenceCollectionResult,
  type AccountEvidenceEnvironment,
} from "../src/domain/account/account-evidence-bundle.js";
import { rehydrateDailyDecisionPlan } from "../src/domain/planning/daily-decision-plan.js";
import { rehydratePortfolioRiskPreflight } from "../src/domain/risk/portfolio-risk-preflight.js";
import { MARKET_EVIDENCE_SYMBOLS } from "../src/domain/market/market-evidence-bundle.js";
import type { CredentialProvider } from "../src/ports/credential-provider.js";
import type { PortfolioRiskEvidenceReaderFactory } from "../src/ports/portfolio-risk-evidence.js";
import type { DataQualityBoundary } from "../src/application/data-quality-assessment.js";

const USAGE =
  "Usage: npm run smoke:bybit:portfolio-risk -- --live --environment demo|testnet|mainnet --run-id <identity> --daily-plan <json-path> --composition <trusted-module-path>";
const MAX_PLAN_BYTES = 4 * 1024 * 1024;
const ENVIRONMENTS = ["demo", "testnet", "mainnet"] as const;

export interface PortfolioRiskSmokeArguments {
  readonly environment: AccountEvidenceEnvironment;
  readonly runId: string;
  readonly dailyPlanPath: string;
  readonly compositionPath: string;
}

export interface PortfolioRiskSmokeComposition {
  readonly policy: unknown;
  readonly qualityProfile: unknown;
  readonly qualityBoundary: Pick<DataQualityBoundary, "assess">;
}

export interface PortfolioRiskSmokeSummary {
  readonly kind: "admission-failure" | "provider-failure" | "evaluated";
  readonly environment: AccountEvidenceEnvironment;
  readonly reasonCodes: readonly string[];
  readonly exchangeWrites: 0;
  readonly providerRequestCount?: number;
  readonly durationMs?: number;
  readonly verdict?: "PASS" | "BLOCK";
  readonly preflightHash?: string;
  readonly policyVersion?: string;
  readonly qualityProfileVersion?: string;
  readonly evaluationTime?: string;
  readonly accountCollectionStatus?: string;
  readonly supplementalEvidenceStatus?: string;
  readonly supplementalFailureCode?: string | null;
}

function plainDataRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every((property) =>
      Object.hasOwn(property, "value"),
    )
  );
}

export function parsePortfolioRiskSmokeArgs(
  args: readonly string[],
): PortfolioRiskSmokeArguments {
  const flags = new Map<string, string>();
  let live = false;
  for (let index = 0; index < args.length;) {
    const flag = args[index];
    if (flag === "--live") {
      if (live) throw new Error(USAGE);
      live = true;
      index++;
      continue;
    }
    if (
      flag !== "--environment" &&
      flag !== "--run-id" &&
      flag !== "--daily-plan" &&
      flag !== "--composition"
    )
      throw new Error(USAGE);
    const value = args[index + 1];
    if (!value || value.startsWith("--") || flags.has(flag))
      throw new Error(USAGE);
    flags.set(flag, value);
    index += 2;
  }
  const environment = flags.get("--environment");
  const runId = flags.get("--run-id");
  const dailyPlanPath = flags.get("--daily-plan");
  const compositionPath = flags.get("--composition");
  if (
    !live ||
    !ENVIRONMENTS.includes(environment as AccountEvidenceEnvironment) ||
    !runId ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(runId) ||
    !dailyPlanPath ||
    !compositionPath
  )
    throw new Error(USAGE);
  return {
    environment: environment as AccountEvidenceEnvironment,
    runId,
    dailyPlanPath,
    compositionPath,
  };
}

function summarizeAccountCollection(
  result: AccountEvidenceCollectionResult,
): Record<string, unknown> {
  if (result.kind === "pre-auth-failure")
    return {
      kind: result.kind,
      environment: result.environment,
      reasonCodes: result.reasonCodes,
      startedAt: result.startedAt,
      endedAt: result.endedAt,
    };
  const bundle = result.bundle;
  const hash = accountEvidenceContentHash(bundle);
  if (!hash.ok) throw new Error("ACCOUNT_EVIDENCE_INVALID");
  return {
    kind: result.kind,
    environment: bundle.accountBinding.environment,
    status: bundle.collectionStatus,
    reasonCodes: [
      ...new Set([
        ...bundle.consistency.reasonCodes,
        ...bundle.diagnostics.map((item) => item.code),
      ]),
    ].sort(),
    timing: {
      startedAt: bundle.startedAt,
      endedAt: bundle.endedAt,
      collectionStartedAt: bundle.collectionStartedAt,
      collectionEndedAt: bundle.collectionEndedAt,
      bundleCutoff: bundle.bundleCutoff,
      durationMs: bundle.budget.monotonicDurationMs,
    },
    partitions: {
      expected: bundle.expectedPartitions.length,
      traversed: bundle.coverage.filter((item) => item.status === "traversed")
        .length,
      failed: bundle.coverage.filter((item) => item.status === "failed").length,
      unavailable: bundle.coverage.filter(
        (item) => item.status === "unavailable",
      ).length,
    },
    canonicalHash: hash.value,
  };
}

export function summarizePortfolioRiskResult(
  result: PortfolioRiskApplicationResult,
  environment: AccountEvidenceEnvironment,
): PortfolioRiskSmokeSummary {
  if (result.kind === "admission-failure")
    return {
      kind: result.kind,
      environment,
      reasonCodes: [result.code],
      exchangeWrites: 0,
    };
  if (result.kind === "provider-failure")
    return {
      kind: result.kind,
      environment,
      reasonCodes: [result.code],
      providerRequestCount: result.providerRequestCount,
      durationMs: result.durationMs,
      exchangeWrites: 0,
    };
  const preflight = rehydratePortfolioRiskPreflight(result.preflight);
  if (!preflight.ok) throw new Error("PREFLIGHT_ARTIFACT_INVALID");
  const bundleEnvironment =
    preflight.value.replayInputs.account.accountBinding.environment;
  return {
    kind: result.kind,
    environment: bundleEnvironment,
    verdict: preflight.value.verdict,
    reasonCodes: preflight.value.reasonCodes,
    preflightHash: preflight.value.contentHash,
    policyVersion: preflight.value.replayInputs.policy.policyVersion,
    qualityProfileVersion:
      preflight.value.replayInputs.qualityProfile.profileVersion,
    evaluationTime: preflight.value.evaluationTime,
    accountCollectionStatus:
      preflight.value.replayInputs.account.collectionStatus,
    supplementalEvidenceStatus: result.supplementalEvidenceStatus,
    supplementalFailureCode: result.supplementalFailureCode,
    providerRequestCount: result.providerRequestCount,
    durationMs: result.durationMs,
    exchangeWrites: 0,
  };
}

function compositionValue(value: unknown): PortfolioRiskSmokeComposition {
  if (
    !plainDataRecord(value) ||
    Reflect.ownKeys(value).length !== 3 ||
    !Object.hasOwn(value, "policy") ||
    !Object.hasOwn(value, "qualityProfile") ||
    !plainDataRecord(value.qualityBoundary) ||
    typeof value.qualityBoundary.assess !== "function"
  )
    throw new Error("COMPOSITION_INVALID");
  return {
    policy: value.policy,
    qualityProfile: value.qualityProfile,
    qualityBoundary: value.qualityBoundary as Pick<
      DataQualityBoundary,
      "assess"
    >,
  };
}

async function readDailyPlan(path: string): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of createReadStream(resolve(path))) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_PLAN_BYTES) throw new Error("DAILY_PLAN_INVALID");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as unknown;
}

function sharedCredentialLoader(
  provider: Pick<CredentialProvider, "load">,
): Pick<CredentialProvider, "load"> {
  let cachedEnvironment: AccountEvidenceEnvironment | null = null;
  let cachedCredentials: Awaited<ReturnType<typeof provider.load>> | null =
    null;
  return Object.freeze({
    async load(environment) {
      if (cachedCredentials !== null) {
        if (cachedEnvironment !== environment)
          throw new Error("CREDENTIAL_ENVIRONMENT_MISMATCH");
        return { ...cachedCredentials };
      }
      const loaded = await provider.load(environment);
      cachedEnvironment = environment;
      cachedCredentials = Object.freeze({ ...loaded });
      return { ...cachedCredentials };
    },
  });
}

export async function runPortfolioRiskSmoke(
  args: readonly string[],
  dependencies: {
    readonly collect?: typeof collectAccountEvidence;
    readonly credentialProvider?: Pick<CredentialProvider, "load">;
    readonly createReader?: PortfolioRiskEvidenceReaderFactory;
    readonly readPlan?: (path: string) => Promise<unknown>;
    readonly loadComposition?: (path: string) => Promise<unknown>;
    readonly write?: (line: string) => void;
  } = {},
): Promise<number> {
  const write = dependencies.write ?? ((line) => console.log(line));
  let options: PortfolioRiskSmokeArguments;
  try {
    options = parsePortfolioRiskSmokeArgs(args);
  } catch {
    write(USAGE);
    return 1;
  }

  try {
    const loadedComposition = dependencies.loadComposition
      ? await dependencies.loadComposition(options.compositionPath)
      : await import(pathToFileURL(resolve(options.compositionPath)).href).then(
          (module) => module.default,
        );
    const composition = compositionValue(loadedComposition);
    const dailyPlanInput = await (dependencies.readPlan ?? readDailyPlan)(
      options.dailyPlanPath,
    );
    const dailyPlan = rehydrateDailyDecisionPlan(dailyPlanInput);
    if (!dailyPlan.ok) {
      write(
        JSON.stringify({
          kind: "admission-failure",
          environment: options.environment,
          reasonCodes: ["INVALID_DAILY_PLAN"],
          exchangeWrites: 0,
        }),
      );
      return 1;
    }

    const credentialProvider =
      dependencies.credentialProvider ?? createMacOSKeychainProvider();
    const credentialLoader = sharedCredentialLoader(credentialProvider);
    const readerFactory =
      dependencies.createReader ??
      ((input) => createBybitRiskEvidenceReader(input));
    const boundary = createPortfolioRiskPreflightBoundary({
      policy: composition.policy,
      qualityProfile: composition.qualityProfile,
      qualityBoundary: composition.qualityBoundary,
      credentialLoader,
      createReader: readerFactory,
    });
    if (!boundary.ok) {
      write(
        JSON.stringify({
          kind: "admission-failure",
          environment: options.environment,
          reasonCodes: ["TRUSTED_COMPOSITION_INVALID"],
          exchangeWrites: 0,
        }),
      );
      return 1;
    }

    const collect = dependencies.collect ?? collectAccountEvidence;
    const account = await collect({
      environment: options.environment,
      runId: options.runId,
      configuredM1Symbols: MARKET_EVIDENCE_SYMBOLS,
      credentialLoader,
    });
    if (account.kind === "pre-auth-failure") {
      if (account.environment !== options.environment) {
        write(
          JSON.stringify({
            kind: "admission-failure",
            environment: options.environment,
            reasonCodes: ["ACCOUNT_ENVIRONMENT_MISMATCH"],
            exchangeWrites: 0,
          }),
        );
        return 1;
      }
      write(
        JSON.stringify({
          ...summarizeAccountCollection(account),
          exchangeWrites: 0,
        }),
      );
      return 1;
    }
    if (account.bundle.accountBinding.environment !== options.environment) {
      write(
        JSON.stringify({
          kind: "admission-failure",
          environment: options.environment,
          reasonCodes: ["ACCOUNT_ENVIRONMENT_MISMATCH"],
          exchangeWrites: 0,
        }),
      );
      return 1;
    }

    const result = await boundary.value.prepare({
      dailyPlan: dailyPlan.value,
      account: account.bundle,
    });
    const summary = summarizePortfolioRiskResult(result, options.environment);
    write(
      JSON.stringify({
        ...summary,
        accountCollection: summarizeAccountCollection(account),
      }),
    );
    return result.kind === "evaluated" && result.preflight.verdict === "PASS"
      ? 0
      : 1;
  } catch {
    write(
      JSON.stringify({
        kind: "smoke-failure",
        environment: options.environment,
        reasonCodes: ["SMOKE_FAILED"],
        exchangeWrites: 0,
      }),
    );
    return 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href)
  process.exitCode = await runPortfolioRiskSmoke(process.argv.slice(2));
