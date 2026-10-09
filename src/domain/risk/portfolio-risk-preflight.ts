import {
  accountEvidenceContentHash,
  createAccountEvidenceBundle,
  type AccountEvidenceBundle,
} from "../account/account-evidence-bundle.js";
import {
  hashCanonical,
  canonicalSerialize,
} from "../identity/canonical-serialization.js";
import { prepareDailyPlanningInputs } from "../planning/daily-planning-inputs.js";
import {
  rehydrateDailyDecisionPlan,
  type DailyDecisionPlan,
} from "../planning/daily-decision-plan.js";
import type { OrderIntent } from "../planning/order-intent.js";
import {
  rehydrateLiquidationEvidenceBundle,
  createLiquidationEvidenceRef,
} from "../liquidation/liquidation-evidence-bundle.js";
import { admitQualitySource } from "../quality/quality-inputs.js";
import {
  createQualityProfile,
  hashQualityProfile,
  type QualityProfile,
} from "../quality/quality-profile.js";
import { classifyQualityEvidence } from "../quality/quality-validation.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";
import { parseUtcTimestamp, type UtcTimestamp } from "../shared/time.js";
import { isRecord } from "../shared/validation.js";
import {
  evaluatePortfolioRiskCapacity,
  type PortfolioRiskCapacity,
} from "./portfolio-risk-capacity.js";
import {
  createPortfolioRiskBlockReasonCodes,
  type PortfolioRiskBlockReasonCode,
  type PortfolioRiskNoOpReasonCode,
} from "./portfolio-risk-diagnostics.js";
import {
  evaluatePortfolioRiskEconomics,
  type PortfolioRiskEconomics,
} from "./portfolio-risk-economics.js";
import {
  createPortfolioRiskEvidenceSet,
  type PortfolioRiskEvidence,
} from "./portfolio-risk-evidence.js";
import {
  materializePortfolioRiskAction,
  type PortfolioRiskCloseProposal,
  type PortfolioRiskMaterialization,
} from "./portfolio-risk-materialization.js";
import {
  createPortfolioRiskPolicy,
  portfolioRiskPolicyHash,
  type PortfolioRiskPolicy,
} from "./portfolio-risk-policy.js";
import {
  createPortfolioRiskProjection,
  type PortfolioRiskProjection,
} from "./portfolio-risk-projection.js";

export const PORTFOLIO_RISK_PREFLIGHT_SCHEMA_VERSION =
  "portfolio-risk-preflight/v1" as const;

export interface PortfolioRiskPreflightInput {
  readonly dailyPlan: unknown;
  readonly account: unknown;
  readonly policy: unknown;
  readonly qualityProfile: unknown;
  readonly supplementalEvidence?: unknown;
  readonly evaluationTime: unknown;
}

export interface PortfolioRiskPreflightReplayInputs {
  readonly dailyPlan: DailyDecisionPlan;
  readonly account: AccountEvidenceBundle;
  readonly policy: PortfolioRiskPolicy;
  readonly qualityProfile: QualityProfile;
  readonly supplementalEvidence: readonly PortfolioRiskEvidence[];
  readonly evaluationTime: UtcTimestamp;
}

export interface PortfolioRiskPreflightIdentity {
  readonly dailyPlanHash: string;
  readonly marketContentHash: string;
  readonly marketBundleHash: string;
  readonly accountEvidenceHash: string;
  readonly policyHash: string;
  readonly qualityProfileHash: string;
  readonly qualityProfileVersion: string;
  readonly supplementalEvidenceHash: string;
  readonly evaluationTime: UtcTimestamp;
}

export type PortfolioRiskActionProposal =
  | {
      readonly kind: "add-long";
      readonly orderIntents: readonly OrderIntent[];
    }
  | {
      readonly kind: "close-long-quantity";
      readonly proposal: PortfolioRiskCloseProposal;
    }
  | {
      readonly kind: "reduction-no-op";
      readonly reasonCode: PortfolioRiskNoOpReasonCode;
    }
  | { readonly kind: "hold-no-action" }
  | null;

export interface PortfolioRiskPreflight {
  readonly schemaVersion: typeof PORTFOLIO_RISK_PREFLIGHT_SCHEMA_VERSION;
  readonly preflightId: string;
  readonly contentHash: string;
  readonly verdict: "PASS" | "BLOCK";
  readonly reasonCodes: readonly PortfolioRiskBlockReasonCode[];
  readonly evaluationTime: UtcTimestamp;
  readonly inputIdentity: PortfolioRiskPreflightIdentity;
  readonly replayInputs: PortfolioRiskPreflightReplayInputs;
  readonly projection: PortfolioRiskProjection;
  readonly capacity: PortfolioRiskCapacity;
  readonly economics: PortfolioRiskEconomics;
  readonly materialization: PortfolioRiskMaterialization;
  /** A planning proposal only; #17 does not confer approval or write authority. */
  readonly actionProposal: PortfolioRiskActionProposal;
}

const INPUT_KEYS = [
  "dailyPlan",
  "account",
  "policy",
  "qualityProfile",
  "supplementalEvidence",
  "evaluationTime",
] as const;
const RESULT_KEYS = [
  "schemaVersion",
  "preflightId",
  "contentHash",
  "verdict",
  "reasonCodes",
  "evaluationTime",
  "inputIdentity",
  "replayInputs",
  "projection",
  "capacity",
  "economics",
  "materialization",
  "actionProposal",
] as const;
const INPUT_IDENTITY_KEYS = [
  "dailyPlanHash",
  "marketContentHash",
  "marketBundleHash",
  "accountEvidenceHash",
  "policyHash",
  "qualityProfileHash",
  "qualityProfileVersion",
  "supplementalEvidenceHash",
  "evaluationTime",
] as const;
const REPLAY_INPUT_KEYS = [
  "dailyPlan",
  "account",
  "policy",
  "qualityProfile",
  "supplementalEvidence",
  "evaluationTime",
] as const;

function invalid(message = "portfolio risk preflight input is invalid") {
  return fail(domainError("INVALID_EVIDENCE", message));
}

function hasPlainDataProperties(value: object): boolean {
  return (
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) =>
      Object.hasOwn(descriptor, "value"),
    )
  );
}

function closedRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): value is Record<string, unknown> {
  if (!isRecord(value) || !hasPlainDataProperties(value)) return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.every((key) => typeof key === "string" && allowed.includes(key)) &&
    required.every((key) => Object.hasOwn(value, key))
  );
}

function parseInput(
  input: unknown,
): Result<PortfolioRiskPreflightReplayInputs> {
  if (
    !closedRecord(input, INPUT_KEYS, [
      "dailyPlan",
      "account",
      "policy",
      "qualityProfile",
      "evaluationTime",
    ])
  )
    return invalid();

  const dailyPlan = rehydrateDailyDecisionPlan(input.dailyPlan);
  const account = createAccountEvidenceBundle(input.account);
  const policy = createPortfolioRiskPolicy(input.policy);
  const qualityProfile = createQualityProfile(input.qualityProfile);
  const supplementalEvidence = createPortfolioRiskEvidenceSet(
    Object.hasOwn(input, "supplementalEvidence")
      ? input.supplementalEvidence
      : [],
  );
  const evaluationTime = parseUtcTimestamp(input.evaluationTime);
  if (
    !dailyPlan.ok ||
    !account.ok ||
    !policy.ok ||
    !qualityProfile.ok ||
    !supplementalEvidence.ok ||
    !evaluationTime.ok
  )
    return invalid(
      "preflight requires valid nested evidence and policy inputs",
    );

  if (
    dailyPlan.value.decision.recommendation !== "ADD_LONG" &&
    supplementalEvidence.value.length > 0
  )
    return invalid("supplemental evidence is only supported for ADD_LONG");

  const planning = prepareDailyPlanningInputs(dailyPlan.value.inputs);
  const profileHash = hashQualityProfile(qualityProfile.value);
  if (
    !planning.ok ||
    !profileHash.ok ||
    qualityProfile.value.profileVersion !==
      planning.value.assessment.profileVersion ||
    profileHash.value !== planning.value.assessment.profileHash
  )
    return invalid(
      "original quality profile does not match the daily assessment",
    );

  return ok(
    deepFreeze({
      dailyPlan: dailyPlan.value,
      account: account.value,
      policy: policy.value,
      qualityProfile: qualityProfile.value,
      supplementalEvidence: supplementalEvidence.value,
      evaluationTime: evaluationTime.value,
    }),
  );
}

function identityFor(
  inputs: PortfolioRiskPreflightReplayInputs,
): Result<PortfolioRiskPreflightIdentity> {
  const planning = prepareDailyPlanningInputs(inputs.dailyPlan.inputs);
  const accountEvidenceHash = accountEvidenceContentHash(inputs.account);
  const policyHash = portfolioRiskPolicyHash(inputs.policy);
  const qualityProfileHash = hashQualityProfile(inputs.qualityProfile);
  const marketBundleHash = planning.ok
    ? hashCanonical(planning.value.market)
    : planning;
  const supplementalEvidenceHash = hashCanonical(inputs.supplementalEvidence);
  if (
    !planning.ok ||
    !accountEvidenceHash.ok ||
    !policyHash.ok ||
    !qualityProfileHash.ok ||
    !marketBundleHash.ok ||
    !supplementalEvidenceHash.ok
  )
    return invalid("preflight source identity could not be verified");
  return ok({
    dailyPlanHash: inputs.dailyPlan.contentHash,
    marketContentHash: inputs.dailyPlan.inputIdentity.marketContentHash,
    marketBundleHash: marketBundleHash.value,
    accountEvidenceHash: accountEvidenceHash.value,
    policyHash: policyHash.value,
    qualityProfileHash: qualityProfileHash.value,
    qualityProfileVersion: inputs.qualityProfile.profileVersion,
    supplementalEvidenceHash: supplementalEvidenceHash.value,
    evaluationTime: inputs.evaluationTime,
  });
}

function deriveActionProposal(input: {
  readonly verdict: "PASS" | "BLOCK";
  readonly dailyPlan: DailyDecisionPlan;
  readonly materialization: PortfolioRiskMaterialization;
}): Result<PortfolioRiskActionProposal> {
  if (input.verdict === "BLOCK") return ok(null);
  switch (input.dailyPlan.decision.recommendation) {
    case "ADD_LONG":
      return "orderIntents" in input.dailyPlan
        ? ok({
            kind: "add-long",
            orderIntents: input.dailyPlan.orderIntents,
          })
        : invalid("PASS ADD preflight is missing original order intents");
    case "REDUCE_LONG": {
      const reduction = input.materialization.reduction;
      if (reduction.status === "proposed" && reduction.proposal)
        return ok({
          kind: "close-long-quantity",
          proposal: reduction.proposal,
        });
      if (reduction.status === "no-op" && reduction.noOpReason)
        return ok({
          kind: "reduction-no-op",
          reasonCode: reduction.noOpReason,
        });
      return invalid("PASS REDUCE preflight lacks a proposal or typed no-op");
    }
    case "HOLD_LONG":
      return ok({ kind: "hold-no-action" });
  }
}

function hasBlockingStaleQualityEvidence(
  dailyPlan: DailyDecisionPlan,
  qualityProfile: QualityProfile,
  evaluationTime: UtcTimestamp,
): Result<boolean> {
  const planning = prepareDailyPlanningInputs(dailyPlan.inputs);
  if (!planning.ok) return invalid("quality freshness inputs are invalid");

  const records = [
    admitQualitySource({ role: "market", value: planning.value.market }),
    admitQualitySource({ role: "analytics", value: planning.value.analytics }),
  ];
  if (dailyPlan.inputs.liquidation !== undefined) {
    const liquidation = rehydrateLiquidationEvidenceBundle(
      dailyPlan.inputs.liquidation,
    );
    if (!liquidation.ok)
      return invalid("liquidation freshness input is invalid");
    const liquidationHash = hashCanonical(liquidation.value);
    if (!liquidationHash.ok) return liquidationHash;
    const liquidationPolicy = qualityProfile.roles.find(
      (role) => role.id === "liquidation",
    );
    if (!liquidationPolicy)
      return invalid("liquidation freshness policy is unavailable");
    const evidenceRef = createLiquidationEvidenceRef(
      liquidation.value,
      liquidationHash.value,
      liquidationPolicy.maxAgeMs,
    );
    if (!evidenceRef.ok) return evidenceRef;
    records.push(
      admitQualitySource({
        role: "liquidation",
        value: liquidation.value,
        evidenceRef: evidenceRef.value,
      }),
    );
  }

  const findings = classifyQualityEvidence(
    records,
    qualityProfile,
    planning.value.market.bundleCutoff,
    evaluationTime,
  );
  return ok(
    findings.some(
      (finding) => finding.blocking && finding.reasonCode === "STALE_EVIDENCE",
    ),
  );
}

function buildPreflight(rawInputs: unknown): Result<PortfolioRiskPreflight> {
  const parsed = parseInput(rawInputs);
  if (!parsed.ok) return parsed;
  const inputs = parsed.value;
  const staleRequiredEvidence = hasBlockingStaleQualityEvidence(
    inputs.dailyPlan,
    inputs.qualityProfile,
    inputs.evaluationTime,
  );
  if (!staleRequiredEvidence.ok) return staleRequiredEvidence;
  const identity = identityFor(inputs);
  if (!identity.ok) return identity;

  const common = {
    dailyPlan: inputs.dailyPlan,
    account: inputs.account,
    policy: inputs.policy,
    evaluationTime: inputs.evaluationTime,
  };
  const projection = createPortfolioRiskProjection(common);
  const capacity = evaluatePortfolioRiskCapacity({
    ...common,
    supplementalEvidence: inputs.supplementalEvidence,
  });
  const economics = evaluatePortfolioRiskEconomics({
    dailyPlan: inputs.dailyPlan,
    qualityProfile: inputs.qualityProfile,
    policy: inputs.policy,
    evaluationTime: inputs.evaluationTime,
  });
  const materialization = materializePortfolioRiskAction(common);
  if (!projection.ok || !capacity.ok || !economics.ok || !materialization.ok)
    return invalid("validated inputs failed deterministic risk evaluation");

  const recommendation = inputs.dailyPlan.decision.recommendation;
  const reasons = new Set<PortfolioRiskBlockReasonCode>(
    projection.value.sharedAdmission.reasonCodes,
  );
  if (staleRequiredEvidence.value) reasons.add("REQUIRED_EVIDENCE_STALE");
  if (recommendation === "ADD_LONG") {
    for (const code of capacity.value.reasonCodes) reasons.add(code);
    for (const code of economics.value.reasonCodes) reasons.add(code);
  } else if (recommendation === "REDUCE_LONG") {
    for (const code of materialization.value.reasonCodes) reasons.add(code);
  }
  const normalizedReasons = createPortfolioRiskBlockReasonCodes([...reasons]);
  if (!normalizedReasons.ok) return invalid();

  const blocked =
    staleRequiredEvidence.value ||
    projection.value.sharedAdmission.status === "blocked" ||
    (recommendation === "ADD_LONG" &&
      (capacity.value.outcome !== "pass" ||
        economics.value.outcome !== "pass")) ||
    (recommendation === "REDUCE_LONG" &&
      materialization.value.outcome !== "pass");
  const verdict: PortfolioRiskPreflight["verdict"] = blocked ? "BLOCK" : "PASS";
  if ((verdict === "BLOCK") !== normalizedReasons.value.length > 0)
    return invalid("preflight verdict and explicit blocking reasons disagree");

  const action = deriveActionProposal({
    verdict,
    dailyPlan: inputs.dailyPlan,
    materialization: materialization.value,
  });
  if (!action.ok) return action;

  const preflightId = hashCanonical({
    schemaVersion: "portfolio-risk-preflight-id/v1",
    inputIdentity: identity.value,
  });
  if (!preflightId.ok)
    return invalid("preflight identity could not be derived");
  const payload = {
    schemaVersion: PORTFOLIO_RISK_PREFLIGHT_SCHEMA_VERSION,
    preflightId: preflightId.value,
    verdict,
    reasonCodes: normalizedReasons.value,
    evaluationTime: inputs.evaluationTime,
    inputIdentity: identity.value,
    replayInputs: inputs,
    projection: projection.value,
    capacity: capacity.value,
    economics: economics.value,
    materialization: materialization.value,
    actionProposal: action.value,
  };
  const contentHash = hashCanonical(payload);
  if (!contentHash.ok)
    return invalid("preflight content hash could not be derived");
  return ok(deepFreeze({ ...payload, contentHash: contentHash.value }));
}

/** Pure risk evaluation; PASS is not approval or exchange execution authority. */
export function evaluatePortfolioRiskPreflight(
  input: PortfolioRiskPreflightInput,
): Result<PortfolioRiskPreflight> {
  return buildPreflight(input);
}

/** Replays a serialized artifact from retained inputs and compares every field. */
export function rehydratePortfolioRiskPreflight(
  input: unknown,
): Result<PortfolioRiskPreflight> {
  if (!closedRecord(input, RESULT_KEYS)) return invalid();
  const replayInputs = input.replayInputs;
  if (!closedRecord(replayInputs, REPLAY_INPUT_KEYS)) return invalid();
  if (!closedRecord(input.inputIdentity, INPUT_IDENTITY_KEYS)) return invalid();
  const replayed = buildPreflight(replayInputs);
  if (!replayed.ok) return replayed;
  const expected = canonicalSerialize(replayed.value);
  const actual = canonicalSerialize(input);
  if (!expected.ok || !actual.ok || expected.value !== actual.value)
    return fail(
      domainError(
        "PLAN_HASH_MISMATCH",
        "portfolio risk preflight differs from deterministic replay",
      ),
    );
  return replayed;
}
