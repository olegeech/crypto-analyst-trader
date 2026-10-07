import type { AccountEvidenceEnvironment } from "../domain/account/account-evidence-bundle.js";
import { createAnalyticsEvidenceBundle } from "../domain/analytics/analytics-evidence-bundle.js";
import { closedRecord } from "../domain/planning/planning-validation.js";
import {
  createPreparedDailyPlan,
  type PreparedDailyPlan,
} from "../domain/review/prepared-daily-plan.js";
import {
  MARKET_EVIDENCE_SYMBOLS,
  type MarketEvidenceBundle,
} from "../domain/market/market-evidence-bundle.js";
import { type Clock } from "../domain/shared/time.js";
import type { Result } from "../domain/shared/result.js";
import { requireIdentifier } from "../domain/shared/validation.js";
import type {
  CredentialProvider,
  ExchangeCredentials,
} from "../ports/credential-provider.js";
import type { LiquidationEvidenceCollectionResult } from "../ports/liquidation-evidence.js";
import type { PortfolioRiskEvidenceReaderFactory } from "../ports/portfolio-risk-evidence.js";
import type { PreparedArtifactStore } from "../ports/prepared-artifact-store.js";
import type {
  collectAccountEvidence,
  AccountEvidenceCollectionOptions,
} from "./account-evidence-collection.js";
import { createDataQualityBoundary } from "./data-quality-assessment.js";
import { createDailyPlanningBoundary } from "./daily-decision-planning.js";
import { createPortfolioRiskPreflightBoundary } from "./portfolio-risk-preflight.js";
import {
  createProvisionalM1Composition,
  PROVISIONAL_M1_EXTERNAL_AVAILABILITY,
  type ProvisionalM1Composition,
} from "./policies/provisional-m1.js";
import {
  summarizeRequiredLiquidationWindows,
  type RequiredLiquidationWindowDiagnostic,
} from "./daily-prepare-diagnostics.js";

export interface DailyPrepareDependencies {
  readonly collectMarket: (
    runId: string,
  ) => Promise<Result<MarketEvidenceBundle>>;
  readonly collectLiquidation: (
    market: MarketEvidenceBundle,
  ) => Promise<Result<LiquidationEvidenceCollectionResult>>;
  readonly collectAccount: typeof collectAccountEvidence;
  readonly credentialLoader: Pick<CredentialProvider, "load">;
  readonly createRiskReader: PortfolioRiskEvidenceReaderFactory;
  readonly storeForEnvironment: (
    environment: AccountEvidenceEnvironment,
  ) => Result<PreparedArtifactStore>;
  readonly clock: Clock;
  readonly newRunId: () => string;
  readonly createAccountReadPort?: AccountEvidenceCollectionOptions["createReadPort"];
}
export type DailyPrepareStage =
  | "input"
  | "market"
  | "liquidation"
  | "analytics"
  | "planning"
  | "account"
  | "risk"
  | "persistence";
export interface DailyPrepareDiagnostics {
  readonly marketStatus: string;
  readonly marketObservations: number;
  readonly liquidationStatus: string;
  readonly coverageProof: string;
  readonly historyProof: string;
  readonly eligibleConstituents: number;
  readonly observedHourlyBuckets: number;
  readonly requiredLiquidationWindows: readonly RequiredLiquidationWindowDiagnostic[];
  readonly accountPartitionsTraversed: number;
  readonly accountPartitionsExpected: number;
  readonly exchangeWrites: 0;
  readonly executionAuthority: "none";
}
export type DailyPrepareResult =
  | {
      readonly kind: "prepared";
      readonly prepared: PreparedDailyPlan;
      readonly diagnostics: DailyPrepareDiagnostics;
    }
  | {
      readonly kind: "blocked" | "unavailable";
      readonly stage: DailyPrepareStage;
      readonly reasonCodes: readonly string[];
      readonly externalAvailability: ProvisionalM1Composition["externalAvailability"];
      readonly informationalCodes: readonly string[];
      readonly diagnostics: DailyPrepareDiagnostics;
    };

function snapshot(input: unknown): ExchangeCredentials {
  if (
    !closedRecord(input, ["apiKey", "apiSecret", "accountId"]) ||
    ![input.apiKey, input.apiSecret, input.accountId].every(
      (s) =>
        typeof s === "string" &&
        s.length > 0 &&
        s.length <= 1024 &&
        !/[\u0000-\u001f\u007f]/u.test(s),
    )
  )
    throw new Error("CREDENTIALS_UNAVAILABLE");
  return Object.freeze({
    apiKey: input.apiKey as string,
    apiSecret: input.apiSecret as string,
    accountId: input.accountId as string,
  });
}

/** Trusted code seams only; policy, issuer and time cannot come from input JSON. */
export function createDailyPrepareBoundary(deps: DailyPrepareDependencies) {
  return Object.freeze({
    async prepare(input: unknown): Promise<DailyPrepareResult> {
      let stage: DailyPrepareStage = "input";
      const diagnostics = {
        marketStatus: "not-collected",
        marketObservations: 0,
        liquidationStatus: "not-collected",
        coverageProof: "not-collected",
        historyProof: "not-collected",
        eligibleConstituents: 0,
        observedHourlyBuckets: 0,
        accountPartitionsTraversed: 0,
        accountPartitionsExpected: 0,
        exchangeWrites: 0 as const,
        executionAuthority: "none" as const,
      };
      let composition: ProvisionalM1Composition | undefined = undefined;
      let requiredLiquidationWindows: readonly RequiredLiquidationWindowDiagnostic[] =
        Object.freeze([]);
      const failure = (
        kind: "blocked" | "unavailable",
        reasonCodes: readonly string[],
      ): DailyPrepareResult =>
        Object.freeze({
          kind,
          stage,
          reasonCodes: Object.freeze([...new Set(reasonCodes)].sort()),
          externalAvailability:
            composition?.externalAvailability ??
            PROVISIONAL_M1_EXTERNAL_AVAILABILITY,
          informationalCodes: composition?.reviewPolicy.informationalCodes ?? [
            "PROVISIONAL_POLICY",
          ],
          diagnostics: Object.freeze({
            ...diagnostics,
            requiredLiquidationWindows,
          }),
        });
      if (
        !closedRecord(input, ["environment", "symbol", "allocation"]) ||
        !["demo", "testnet", "mainnet"].includes(input.environment as string)
      )
        return failure("unavailable", ["INVALID_INPUT"]);
      const configured = createProvisionalM1Composition({
        symbol: input.symbol,
        allocation: input.allocation,
      });
      if (!configured.ok) return failure("unavailable", ["INVALID_INPUT"]);
      composition = configured.value;
      requiredLiquidationWindows = summarizeRequiredLiquidationWindows(
        composition.analyticsProfile,
      );
      const environment = input.environment as AccountEvidenceEnvironment;
      try {
        const runId = deps.newRunId();
        if (!requireIdentifier(runId, "runId").ok)
          return failure("unavailable", ["INVALID_RUN_ID"]);
        stage = "market";
        const market = await deps.collectMarket(runId);
        if (!market.ok)
          return failure("unavailable", ["MARKET_COLLECTION_UNAVAILABLE"]);
        diagnostics.marketStatus = market.value.status;
        diagnostics.marketObservations = market.value.symbols.reduce(
          (n, s) =>
            n +
            s.ohlcv.reduce((m, series) => m + series.observations.length, 0) +
            s.funding.length +
            s.openInterest.reduce(
              (m, series) => m + series.observations.length,
              0,
            ),
          0,
        );
        if (market.value.runId !== runId)
          return failure("blocked", ["MIXED_RUN"]);
        if (market.value.status !== "complete")
          return failure("blocked", ["MARKET_EVIDENCE_INCOMPLETE"]);
        stage = "liquidation";
        const liquidation = await deps.collectLiquidation(market.value);
        if (!liquidation.ok)
          return failure("unavailable", ["LIQUIDATION_COLLECTION_UNAVAILABLE"]);
        const l = liquidation.value.bundle;
        requiredLiquidationWindows = summarizeRequiredLiquidationWindows(
          composition.analyticsProfile,
          market.value,
          l,
        );
        diagnostics.liquidationStatus = l.status;
        diagnostics.coverageProof = l.coverageProof;
        diagnostics.historyProof = l.historyProof;
        const constituents = l.targets.flatMap((t) => t.constituents);
        diagnostics.eligibleConstituents = constituents.length;
        diagnostics.observedHourlyBuckets = constituents.reduce(
          (n, c) => n + c.observations.length,
          0,
        );
        stage = "analytics";
        const analytics = createAnalyticsEvidenceBundle({
          market: market.value,
          liquidation: l,
          profile: composition.analyticsProfile,
          featuresVersion: composition.analyticsFeaturesVersion,
        });
        if (!analytics.ok)
          return failure("blocked", ["ANALYTICS_ADMISSION_FAILED"]);
        const quality = createDataQualityBoundary({
          qualityProfile: composition.qualityProfile,
          issuer: "daily-prepare:provisional-m1-v1",
        });
        if (!quality.ok)
          return failure("unavailable", ["QUALITY_COMPOSITION_INVALID"]);
        const planning = createDailyPlanningBoundary({
          qualityBoundary: quality.value,
          decisionPolicy: composition.decisionPolicy,
          planningPolicy: composition.planningPolicy,
        });
        if (!planning.ok)
          return failure("unavailable", ["PLANNING_COMPOSITION_INVALID"]);
        stage = "planning";
        const plan = planning.value.prepare({
          sources: [
            { role: "market", value: market.value },
            { role: "analytics", value: analytics.value },
            {
              role: "liquidation",
              value: l,
              evidenceRef: liquidation.value.evidence,
            },
          ],
          symbol: composition.symbol,
          allocation: composition.allocation,
          bundleCutoff: market.value.bundleCutoff,
          evaluationTime: deps.clock.now(),
        });
        if (plan.status === "blocked")
          return failure(
            "blocked",
            plan.reasons.map((r) => r.code),
          );
        // Lazy after all public evidence. Copy exactly once; both private boundaries
        // receive this immutable credential snapshot, not independently rotating keys.
        let captured: Promise<ExchangeCredentials> | undefined;
        const credentials = {
          load(selected: AccountEvidenceEnvironment) {
            if (selected !== environment)
              return Promise.reject(new Error("ENVIRONMENT_MISMATCH"));
            captured ??= Promise.resolve()
              .then(() => deps.credentialLoader.load(environment))
              .then(snapshot);
            return captured;
          },
        };
        stage = "account";
        const account = await deps.collectAccount({
          environment,
          runId,
          configuredM1Symbols: [...MARKET_EVIDENCE_SYMBOLS],
          credentialLoader: credentials,
          ...(deps.createAccountReadPort
            ? { createReadPort: deps.createAccountReadPort }
            : {}),
        });
        if (account.kind === "pre-auth-failure")
          return failure("unavailable", account.reasonCodes);
        diagnostics.accountPartitionsTraversed = account.bundle.coverage.filter(
          (e) => e.status === "traversed",
        ).length;
        diagnostics.accountPartitionsExpected =
          account.bundle.expectedPartitions.length;
        if (
          account.bundle.accountBinding.environment !== environment ||
          account.bundle.runId !== runId
        )
          return failure("blocked", ["ACCOUNT_BINDING_MISMATCH"]);
        stage = "risk";
        const risk = createPortfolioRiskPreflightBoundary({
          policy: composition.riskPolicy,
          qualityProfile: composition.qualityProfile,
          qualityBoundary: quality.value,
          credentialLoader: credentials,
          createReader: deps.createRiskReader,
        });
        if (!risk.ok)
          return failure("unavailable", ["RISK_COMPOSITION_INVALID"]);
        const evaluated = await risk.value.prepare({
          dailyPlan: plan.plan,
          account: account.bundle,
        });
        if (evaluated.kind !== "evaluated")
          return failure("unavailable", [evaluated.code]);
        const prepared = createPreparedDailyPlan({
          preflight: evaluated.preflight,
          reviewPolicy: composition.reviewPolicy,
          approvalPolicy: composition.approvalPolicy,
          externalAvailability: composition.externalAvailability,
        });
        if (!prepared.ok)
          return failure("blocked", ["PREPARED_ADMISSION_FAILED"]);
        stage = "persistence";
        const store = deps.storeForEnvironment(environment);
        if (!store.ok)
          return failure("unavailable", ["PERSISTENCE_UNAVAILABLE"]);
        try {
          const saved = store.value.savePrepared(prepared.value);
          if (!saved.ok)
            return failure("unavailable", ["PERSISTENCE_INTEGRITY"]);
        } finally {
          store.value.close();
        }
        return Object.freeze({
          kind: "prepared",
          prepared: prepared.value,
          diagnostics: Object.freeze({
            ...diagnostics,
            requiredLiquidationWindows,
          }),
        });
      } catch {
        return failure("unavailable", [
          stage === "account"
            ? "ACCOUNT_COLLECTION_UNAVAILABLE"
            : "PROVIDER_UNAVAILABLE",
        ]);
      }
    },
  });
}
