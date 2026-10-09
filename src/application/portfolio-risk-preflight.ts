import {
  accountEvidenceContentHash,
  createAccountEvidenceBundle,
  type AccountEvidenceBundle,
  type AccountEvidenceEnvironment,
} from "../domain/account/account-evidence-bundle.js";
import { mapAccountReadIdentity } from "../adapters/bybit-v5/account-key-mapper.js";
import { BybitAccountReadError } from "../adapters/bybit-v5/account-read-transport.js";
import {
  createPortfolioRiskEvidence,
  type PortfolioRiskEvidence,
} from "../domain/risk/portfolio-risk-evidence.js";
import {
  evaluatePortfolioRiskPreflight,
  type PortfolioRiskPreflight,
} from "../domain/risk/portfolio-risk-preflight.js";
import {
  createPortfolioRiskPolicy,
  type PortfolioRiskPolicy,
} from "../domain/risk/portfolio-risk-policy.js";
import {
  createQualityProfile,
  hashQualityProfile,
  type QualityProfile,
} from "../domain/quality/quality-profile.js";
import { rehydrateDataQualityAssessment } from "../domain/quality/data-quality-assessment.js";
import { prepareDailyPlanningInputs } from "../domain/planning/daily-planning-inputs.js";
import {
  rehydrateDailyDecisionPlan,
  type DailyDecisionPlan,
} from "../domain/planning/daily-decision-plan.js";
import type { AccountPositionEvidence } from "../domain/account/account-evidence-bundle.js";
import {
  timestampFromEpochMs,
  parseUtcTimestamp,
} from "../domain/shared/time.js";
import { fail, ok, type Result } from "../domain/shared/result.js";
import { domainError } from "../domain/shared/errors.js";
import { isRecord } from "../domain/shared/validation.js";
import type {
  CredentialProvider,
  ExchangeCredentials,
} from "../ports/credential-provider.js";
import type {
  PortfolioRiskEvidenceReadPort,
  PortfolioRiskEvidenceReaderFactory,
} from "../ports/portfolio-risk-evidence.js";
import type { AccountEvidenceFailureCode } from "../domain/account/account-evidence-diagnostics.js";
import { hashCanonical } from "../domain/identity/canonical-serialization.js";
import {
  rehydrateLiquidationEvidenceBundle,
  createLiquidationEvidenceRef,
} from "../domain/liquidation/liquidation-evidence-bundle.js";
import type { QualitySourceInput } from "../domain/quality/quality-inputs.js";
import type { DataQualityBoundary } from "./data-quality-assessment.js";

const APP_INPUT_KEYS = ["dailyPlan", "account"] as const;

export type PortfolioRiskAdmissionFailureCode =
  | "INVALID_INPUT"
  | "INVALID_DAILY_PLAN"
  | "INVALID_ACCOUNT_EVIDENCE"
  | "QUALITY_PROFILE_MISMATCH"
  | "QUALITY_ASSESSMENT_MISMATCH";

export type PortfolioRiskApplicationResult =
  | {
      readonly kind: "admission-failure";
      readonly code: PortfolioRiskAdmissionFailureCode;
    }
  | {
      readonly kind: "provider-failure";
      readonly code: AccountEvidenceFailureCode;
      readonly providerRequestCount: number;
      readonly durationMs: number;
    }
  | {
      readonly kind: "evaluated";
      readonly preflight: PortfolioRiskPreflight;
      readonly supplementalEvidenceStatus:
        "not-needed" | "collected" | "unavailable" | "failed";
      readonly supplementalFailureCode: AccountEvidenceFailureCode | null;
      readonly providerRequestCount: number;
      readonly durationMs: number;
    };

export interface PortfolioRiskPreflightBoundary {
  /** Input has no caller-selected profile, policy, supplemental proof or clock. */
  prepare(input: unknown): Promise<PortfolioRiskApplicationResult>;
}

export interface PortfolioRiskPreflightBoundaryConfiguration {
  readonly policy: unknown;
  readonly qualityProfile: unknown;
  /** Application-controlled #13 boundary; serialized admission claims are historical only. */
  readonly qualityBoundary: Pick<DataQualityBoundary, "assess">;
  readonly credentialLoader: Pick<CredentialProvider, "load">;
  readonly createReader: PortfolioRiskEvidenceReaderFactory;
  readonly monotonicClock?: () => number;
}

function closedInput(input: unknown): input is Record<string, unknown> {
  if (
    !isRecord(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    return false;
  const descriptors = Object.getOwnPropertyDescriptors(input);
  return (
    Reflect.ownKeys(input).length === APP_INPUT_KEYS.length &&
    Reflect.ownKeys(input).every(
      (key) => typeof key === "string" && APP_INPUT_KEYS.includes(key as never),
    ) &&
    Object.values(descriptors).every((descriptor) =>
      Object.hasOwn(descriptor, "value"),
    ) &&
    APP_INPUT_KEYS.every((key) => Object.hasOwn(input, key))
  );
}

function credentialSnapshot(input: unknown): ExchangeCredentials | null {
  if (
    !isRecord(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== 3 ||
    Reflect.ownKeys(input).some(
      (key) =>
        typeof key !== "string" ||
        !["apiKey", "apiSecret", "accountId"].includes(key),
    ) ||
    Object.values(Object.getOwnPropertyDescriptors(input)).some(
      (descriptor) => !Object.hasOwn(descriptor, "value"),
    )
  )
    return null;
  const values = [input.apiKey, input.apiSecret, input.accountId];
  if (
    values.some(
      (value) =>
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > 1024 ||
        /[\u0000-\u001f\u007f]/u.test(value),
    )
  )
    return null;
  return Object.freeze({
    apiKey: input.apiKey as string,
    apiSecret: input.apiSecret as string,
    accountId: input.accountId as string,
  });
}

function accountFailure(error: unknown): AccountEvidenceFailureCode {
  return error instanceof BybitAccountReadError
    ? error.code
    : "TRANSPORT_FAILED";
}

function unsupportedReader(
  reader: PortfolioRiskEvidenceReadPort,
  environment: AccountEvidenceEnvironment,
  origin: string,
): boolean {
  return reader.environment !== environment || reader.origin !== origin;
}

function isRiskEvidenceReader(
  value: unknown,
): value is PortfolioRiskEvidenceReadPort {
  return (
    isRecord(value) &&
    typeof value.environment === "string" &&
    typeof value.origin === "string" &&
    typeof value.readIdentity === "function" &&
    typeof value.readTargetPositions === "function" &&
    typeof value.readExchangeTime === "function" &&
    typeof value.requestCount === "function"
  );
}

function needsTargetLeverageRead(
  plan: DailyDecisionPlan,
  account: AccountEvidenceBundle,
  targetInstrumentType: string | undefined,
): boolean {
  if (
    plan.decision.recommendation !== "ADD_LONG" ||
    targetInstrumentType !== "LinearPerpetual" ||
    account.collectionStatus !== "complete" ||
    !account.consistency.complete ||
    !account.criticalPasses.B ||
    account.consistency.marginCompatibility !== "regular-margin"
  )
    return false;
  const targetMode = account.consistency.positionModes.find(
    (row) => row.symbol === plan.inputs.symbol,
  );
  if (targetMode?.mode !== "one-way") return false;
  const positions = account.criticalPasses.B.positions.filter(
    (row) => row.symbol === plan.inputs.symbol,
  );
  if (positions.length === 0) return true;
  if (positions.length !== 1) return false;
  const position = positions[0];
  return (
    position?.category === "linear" &&
    position.positionIdx === 0 &&
    position.side === "None" &&
    position.size.state === "known" &&
    position.size.unit === "contracts" &&
    position.size.value.isZero() &&
    position.leverage.state !== "known"
  );
}

function toSupplementalEvidence(input: {
  readonly rows: readonly AccountPositionEvidence[];
  readonly environment: AccountEvidenceEnvironment;
  readonly accountIdentityHash: string;
  readonly accountEvidenceHash: string;
  readonly symbol: string;
  readonly observedAt: string;
}): Result<PortfolioRiskEvidence> {
  if (input.rows.length === 0)
    return fail(
      domainError("INVALID_EVIDENCE", "target position row unavailable"),
    );
  const rows = input.rows.map((position) => ({
    positionIdx: position.positionIdx,
    side: position.side,
    size: position.size.state === "known" ? position.size.value : null,
    leverage:
      position.leverage.state === "known" ? position.leverage.value : null,
    isReduceOnly:
      position.isReduceOnly.state === "known"
        ? position.isReduceOnly.value
        : null,
  }));
  if (rows.some((row) => row.size === null || row.isReduceOnly === null))
    return fail(
      domainError(
        "INVALID_EVIDENCE",
        "target position size or restriction unavailable",
      ),
    );
  return createPortfolioRiskEvidence({
    schemaVersion: "portfolio-risk-evidence/v1",
    kind: "target-leverage",
    environment: input.environment,
    accountIdentityHash: input.accountIdentityHash,
    accountEvidenceHash: input.accountEvidenceHash,
    symbol: input.symbol,
    observedAt: input.observedAt,
    rows: rows.map((row) => ({
      positionIdx: row.positionIdx,
      side: row.side,
      size: row.size,
      leverage: row.leverage,
      isReduceOnly: row.isReduceOnly,
    })),
  });
}

function safeDuration(start: number, end: number): number {
  const duration = end - start;
  return Number.isFinite(duration) && duration >= 0 ? Math.floor(duration) : 0;
}

/** Creates an application boundary from trusted composition, not request JSON. */
export function createPortfolioRiskPreflightBoundary(
  configuration: PortfolioRiskPreflightBoundaryConfiguration,
): Result<PortfolioRiskPreflightBoundary> {
  const policy = createPortfolioRiskPolicy(configuration.policy);
  const qualityProfile = createQualityProfile(configuration.qualityProfile);
  if (!policy.ok) return policy;
  if (!qualityProfile.ok) return qualityProfile;
  const profileHash = hashQualityProfile(qualityProfile.value);
  if (!profileHash.ok) return profileHash;
  if (
    !configuration.qualityBoundary ||
    typeof configuration.qualityBoundary.assess !== "function" ||
    !configuration.credentialLoader ||
    typeof configuration.credentialLoader.load !== "function" ||
    typeof configuration.createReader !== "function"
  )
    return fail(
      domainError("INVALID_VALUE", "risk application composition is invalid"),
    );

  const mono = configuration.monotonicClock ?? (() => performance.now());
  const configuredPolicy: PortfolioRiskPolicy = policy.value;
  const configuredProfile: QualityProfile = qualityProfile.value;
  const configuredProfileHash = profileHash.value;

  return ok(
    Object.freeze({
      async prepare(input: unknown): Promise<PortfolioRiskApplicationResult> {
        if (!closedInput(input))
          return { kind: "admission-failure", code: "INVALID_INPUT" };
        const started = mono();
        const plan = rehydrateDailyDecisionPlan(input.dailyPlan);
        if (!plan.ok)
          return { kind: "admission-failure", code: "INVALID_DAILY_PLAN" };
        const planning = prepareDailyPlanningInputs(plan.value.inputs);
        if (!planning.ok)
          return { kind: "admission-failure", code: "INVALID_DAILY_PLAN" };
        const account = createAccountEvidenceBundle(input.account);
        if (!account.ok)
          return {
            kind: "admission-failure",
            code: "INVALID_ACCOUNT_EVIDENCE",
          };
        const accountHash = accountEvidenceContentHash(account.value);
        const assessment = rehydrateDataQualityAssessment(
          plan.value.inputs.assessment,
        );
        if (
          !accountHash.ok ||
          !assessment.ok ||
          assessment.value.profileHash !== configuredProfileHash ||
          assessment.value.profileVersion !== configuredProfile.profileVersion
        )
          return {
            kind: "admission-failure",
            code: "QUALITY_PROFILE_MISMATCH",
          };

        const qualitySources: QualitySourceInput[] = [
          { role: "market", value: planning.value.market },
          { role: "analytics", value: planning.value.analytics },
        ];
        if (plan.value.inputs.liquidation !== undefined) {
          const liquidation = rehydrateLiquidationEvidenceBundle(
            plan.value.inputs.liquidation,
          );
          if (!liquidation.ok)
            return {
              kind: "admission-failure",
              code: "INVALID_DAILY_PLAN",
            };
          const liquidationHash = hashCanonical(liquidation.value);
          if (!liquidationHash.ok)
            return {
              kind: "admission-failure",
              code: "INVALID_DAILY_PLAN",
            };
          const evidenceRef = createLiquidationEvidenceRef(
            liquidation.value,
            liquidationHash.value,
            assessment.value.findings.some(
              (finding) =>
                finding.role === "liquidation" &&
                finding.reasonCode === "STALE_EVIDENCE",
            )
              ? 1
              : Number.MAX_SAFE_INTEGER,
          );
          if (!evidenceRef.ok)
            return {
              kind: "admission-failure",
              code: "INVALID_DAILY_PLAN",
            };
          qualitySources.push({
            role: "liquidation",
            value: liquidation.value,
            evidenceRef: evidenceRef.value,
          });
        }
        let replayedAssessment;
        try {
          replayedAssessment = configuration.qualityBoundary.assess({
            sources: qualitySources,
            bundleCutoff: planning.value.market.bundleCutoff,
            evaluationTime: assessment.value.evaluationTime,
          });
        } catch {
          return {
            kind: "admission-failure",
            code: "QUALITY_ASSESSMENT_MISMATCH",
          };
        }
        if (
          !replayedAssessment.ok ||
          replayedAssessment.value.contentHash !==
            assessment.value.contentHash ||
          replayedAssessment.value.profileHash !== configuredProfileHash ||
          replayedAssessment.value.profileVersion !==
            configuredProfile.profileVersion
        )
          return {
            kind: "admission-failure",
            code: "QUALITY_ASSESSMENT_MISMATCH",
          };

        const environment = account.value.accountBinding.environment;
        const shouldRead = needsTargetLeverageRead(
          plan.value,
          account.value,
          planning.value.market.symbols.find(
            (row) => row.symbol === planning.value.symbol,
          )?.instrument?.contractType,
        );
        let reader: PortfolioRiskEvidenceReadPort;
        let credentials: ExchangeCredentials;
        try {
          const loaded = await configuration.credentialLoader.load(environment);
          const snapshot = credentialSnapshot(loaded);
          if (!snapshot)
            return {
              kind: "provider-failure",
              code: "CREDENTIALS_UNAVAILABLE",
              providerRequestCount: 0,
              durationMs: safeDuration(started, mono()),
            };
          credentials = snapshot;
          const candidate = configuration.createReader({
            environment,
            credentials,
          });
          if (!isRiskEvidenceReader(candidate))
            throw new BybitAccountReadError("INVALID_RESPONSE");
          reader = candidate;
        } catch (error) {
          return {
            kind: "provider-failure",
            code:
              error instanceof BybitAccountReadError
                ? error.code
                : "CREDENTIALS_UNAVAILABLE",
            providerRequestCount: 0,
            durationMs: safeDuration(started, mono()),
          };
        }
        if (
          unsupportedReader(
            reader,
            environment,
            account.value.accountBinding.origin,
          )
        )
          return {
            kind: "provider-failure",
            code: "ORIGIN_MISMATCH",
            providerRequestCount: 0,
            durationMs: safeDuration(started, mono()),
          };

        let supplementalEvidence: readonly PortfolioRiskEvidence[] = [];
        let supplementalEvidenceStatus:
          "not-needed" | "collected" | "unavailable" | "failed" = "not-needed";
        let supplementalFailureCode: AccountEvidenceFailureCode | null = null;

        try {
          const identity = await reader.readIdentity();
          const identityTime =
            identity.time === undefined
              ? parseUtcTimestamp(await reader.readExchangeTime())
              : timestampFromEpochMs(identity.time);
          if (!identityTime.ok)
            throw new BybitAccountReadError("INVALID_RESPONSE");
          const verified = mapAccountReadIdentity(
            identity,
            credentials.accountId,
            environment,
            identityTime.value,
          );
          if (
            verified.accountBinding.accountIdentityHash !==
              account.value.accountBinding.accountIdentityHash ||
            verified.accountBinding.environment !== environment ||
            verified.accountBinding.origin !==
              account.value.accountBinding.origin
          )
            throw new BybitAccountReadError("ACCOUNT_IDENTITY_MISMATCH");
        } catch (error) {
          return {
            kind: "provider-failure",
            code: accountFailure(error),
            providerRequestCount: reader.requestCount(),
            durationMs: safeDuration(started, mono()),
          };
        }

        if (shouldRead) {
          try {
            const observation = await reader.readTargetPositions(
              planning.value.symbol,
            );
            if (observation.rows.length === 0) {
              supplementalEvidenceStatus = "unavailable";
            } else {
              const evidence = toSupplementalEvidence({
                rows: observation.rows,
                environment,
                accountIdentityHash:
                  account.value.accountBinding.accountIdentityHash,
                accountEvidenceHash: accountHash.value,
                symbol: planning.value.symbol,
                observedAt: observation.observedAt,
              });
              if (!evidence.ok)
                throw new BybitAccountReadError("INVALID_RESPONSE");
              supplementalEvidence = [evidence.value];
              supplementalEvidenceStatus = "collected";
            }
          } catch (error) {
            supplementalEvidenceStatus = "failed";
            supplementalFailureCode = accountFailure(error);
          }
        }

        let evaluationTime;
        try {
          evaluationTime = parseUtcTimestamp(await reader.readExchangeTime());
          if (!evaluationTime.ok)
            throw new BybitAccountReadError("INVALID_RESPONSE");
        } catch (error) {
          return {
            kind: "provider-failure",
            code: accountFailure(error),
            providerRequestCount: reader.requestCount(),
            durationMs: safeDuration(started, mono()),
          };
        }
        const preflight = evaluatePortfolioRiskPreflight({
          dailyPlan: plan.value,
          account: account.value,
          policy: configuredPolicy,
          qualityProfile: configuredProfile,
          supplementalEvidence,
          evaluationTime: evaluationTime.value,
        });
        if (!preflight.ok)
          return {
            kind: "admission-failure",
            code: "INVALID_DAILY_PLAN",
          };
        return Object.freeze({
          kind: "evaluated",
          preflight: preflight.value,
          supplementalEvidenceStatus,
          supplementalFailureCode,
          providerRequestCount: reader.requestCount(),
          durationMs: safeDuration(started, mono()),
        });
      },
    }),
  );
}
