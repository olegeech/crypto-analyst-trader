import {
  type ExternalEvidenceFamily,
  isExternalEvidenceFamily,
} from "../analytics/analytics-profile.js";
import { accountEvidencePartitionKey } from "../account/account-evidence-policy.js";
import {
  canonicalSerialize,
  hashCanonical,
  type PlanHash,
} from "../identity/canonical-serialization.js";
import {
  prepareDailyPlanningInputs,
  type DailyPlanningInputs,
} from "../planning/daily-planning-inputs.js";
import { closedRecord } from "../planning/planning-validation.js";
import {
  rehydratePortfolioRiskPreflight,
  type PortfolioRiskPreflight,
} from "../risk/portfolio-risk-preflight.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";
import { requireIdentifier } from "../shared/validation.js";

export const PREPARED_DAILY_PLAN_SCHEMA_VERSION =
  "prepared-daily-plan/v1" as const;

export interface DailyReviewPolicy {
  readonly schemaVersion: "daily-review-policy/v1";
  readonly policyVersion: string;
  readonly provisionalRequiresReview: false;
  readonly unconfiguredExternalRequiresReview: false;
  readonly informationalCodes: readonly "PROVISIONAL_POLICY"[];
  /** Explicit unconditional exceptional warning codes under this policy version. */
  readonly exceptionalWarnings: readonly string[];
}

export interface DailyApprovalPolicy {
  readonly schemaVersion: "daily-approval-policy/v1";
  readonly policyVersion: string;
  readonly ttlMs: 900000;
}

export interface PreparedExternalAvailability {
  readonly family: ExternalEvidenceFamily;
  readonly status: "not-configured" | "unavailable" | "available";
}

export interface PreparedDailyPlanReplayInputs {
  /** The single self-contained source of plan, account, risk and original quality inputs. */
  readonly preflight: PortfolioRiskPreflight;
  readonly reviewPolicy: DailyReviewPolicy;
  readonly approvalPolicy: DailyApprovalPolicy;
  readonly externalAvailability: readonly PreparedExternalAvailability[];
}

export interface PreparedTargetGate {
  readonly status: "clean" | "conflict" | "unknown" | "not-applicable";
  readonly positionState: "flat" | "existing" | "unknown" | "not-evaluated";
  readonly activeOrderCount: number | null;
  readonly relevantCoverageComplete: boolean;
}

export type PreparedDailyPlanState =
  "READY_FOR_APPROVAL" | "REVIEW" | "BLOCKED";
export type PreparedDailyPlanSummary = ReturnType<typeof materialSummary>;

export interface PreparedDailyPlan {
  readonly schemaVersion: typeof PREPARED_DAILY_PLAN_SCHEMA_VERSION;
  readonly preparedPlanId: string;
  readonly contentHash: PlanHash;
  readonly inputIdentity: {
    readonly preflightContentHash: string;
    readonly preflightArtifactHash: string;
    readonly reviewPolicyHash: string;
    readonly approvalPolicyHash: string;
    readonly externalAvailabilityHash: string;
    readonly runId: string;
    readonly environment: PortfolioRiskPreflight["replayInputs"]["account"]["accountBinding"]["environment"];
    readonly accountIdentityHash: string;
    readonly evaluationTime: PortfolioRiskPreflight["evaluationTime"];
  };
  readonly replayInputs: PreparedDailyPlanReplayInputs;
  readonly state: PreparedDailyPlanState;
  readonly reasonCodes: readonly string[];
  readonly noteRequired: boolean;
  readonly executionAuthority: "none";
  /** Safe review surface; the embedded replay artifact is private persistence data. */
  readonly summary: PreparedDailyPlanSummary;
}

function invalid(
  message = "prepared daily plan input is invalid",
): Result<never> {
  return fail(domainError("INVALID_EVIDENCE", message));
}

function exactRecord(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  return (
    closedRecord(value, fields) &&
    fields.every((key) => Object.hasOwn(value, key))
  );
}

function dataList(value: unknown, max: number): value is unknown[] {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    Reflect.ownKeys(value).length === value.length + 1 &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every((d) =>
      Object.hasOwn(d, "value"),
    )
  );
}

/** No hidden defaults, and informational metadata can never impose review ceremony. */
export function createDailyReviewPolicy(
  input: unknown,
): Result<DailyReviewPolicy> {
  if (
    !exactRecord(input, [
      "schemaVersion",
      "policyVersion",
      "provisionalRequiresReview",
      "unconfiguredExternalRequiresReview",
      "informationalCodes",
      "exceptionalWarnings",
    ]) ||
    input.schemaVersion !== "daily-review-policy/v1" ||
    input.provisionalRequiresReview !== false ||
    input.unconfiguredExternalRequiresReview !== false ||
    !dataList(input.informationalCodes, 1) ||
    input.informationalCodes.some((code) => code !== "PROVISIONAL_POLICY") ||
    !dataList(input.exceptionalWarnings, 32)
  )
    return invalid("review policy is invalid");
  const version = requireIdentifier(input.policyVersion, "policyVersion");
  if (!version.ok) return invalid("review policy version is invalid");
  const warnings: string[] = [];
  for (const code of input.exceptionalWarnings) {
    // Codes only, never caller prose, account data or informational absence.
    if (
      typeof code !== "string" ||
      !/^[A-Z][A-Z0-9_]{0,63}$/.test(code) ||
      code === "PROVISIONAL_POLICY" ||
      code === "EXTERNAL_NOT_CONFIGURED" ||
      warnings.includes(code)
    )
      return invalid("exceptional warning code is invalid");
    warnings.push(code);
  }
  return ok(
    deepFreeze({
      schemaVersion: "daily-review-policy/v1",
      policyVersion: version.value,
      provisionalRequiresReview: false,
      unconfiguredExternalRequiresReview: false,
      informationalCodes: input.informationalCodes.length
        ? ["PROVISIONAL_POLICY"]
        : [],
      exceptionalWarnings: warnings.sort(),
    }),
  );
}

export function createDailyApprovalPolicy(
  input: unknown,
): Result<DailyApprovalPolicy> {
  if (
    !exactRecord(input, ["schemaVersion", "policyVersion", "ttlMs"]) ||
    input.schemaVersion !== "daily-approval-policy/v1" ||
    input.ttlMs !== 900000
  )
    return invalid("approval policy is invalid");
  const version = requireIdentifier(input.policyVersion, "policyVersion");
  return version.ok
    ? ok(
        deepFreeze({
          schemaVersion: "daily-approval-policy/v1",
          policyVersion: version.value,
          ttlMs: 900000,
        }),
      )
    : invalid("approval policy version is invalid");
}

const FAMILIES: readonly ExternalEvidenceFamily[] = [
  "market-regime-score",
  "early-warning-risk",
  "liquidity-stress",
  "trap",
];

function externalAvailability(
  input: unknown,
  planning: DailyPlanningInputs,
): Result<readonly PreparedExternalAvailability[]> {
  if (!dataList(input, FAMILIES.length) || input.length !== FAMILIES.length)
    return invalid("all external families must have explicit availability");
  const rows = new Map<ExternalEvidenceFamily, PreparedExternalAvailability>();
  for (const row of input) {
    if (
      !exactRecord(row, ["family", "status"]) ||
      !isExternalEvidenceFamily(row.family) ||
      rows.has(row.family)
    )
      return invalid("external availability is invalid");
    const configured = planning.analytics.profile.externalEvidence.some(
      (request) => request.family === row.family,
    );
    const accepted =
      planning.analytics.externalEvidence.some(
        (evidence) => evidence.family === row.family,
      ) &&
      planning.assessment.dispositions.some(
        (d) =>
          d.role === `external:${row.family}` && d.disposition === "accepted",
      );
    const expected = !configured
      ? "not-configured"
      : accepted
        ? "available"
        : "unavailable";
    if (row.status !== expected)
      return invalid("external availability differs from retained evidence");
    rows.set(row.family, { family: row.family, status: expected });
  }
  return ok(deepFreeze(FAMILIES.map((family) => rows.get(family)!)));
}

function targetGate(preflight: PortfolioRiskPreflight): PreparedTargetGate {
  const { account, dailyPlan } = preflight.replayInputs;
  if (dailyPlan.decision.recommendation !== "ADD_LONG")
    return {
      status: "not-applicable",
      positionState: "not-evaluated",
      activeOrderCount: null,
      relevantCoverageComplete: false,
    };
  const symbol = preflight.projection.targetSymbol;
  const pass = account.criticalPasses.B;
  const relevant = account.expectedPartitions.filter(
    (p) =>
      p.pass === "B" &&
      (p.endpoint === "positions" || p.endpoint === "open-orders"),
  );
  const traversed = new Set(
    account.coverage
      .filter(
        (entry) =>
          entry.status === "traversed" && entry.reasonCodes.length === 0,
      )
      .map((entry) => accountEvidencePartitionKey(entry.partition)),
  );
  const relevantCoverageComplete =
    account.collectionStatus === "complete" &&
    account.consistency.complete &&
    pass !== null &&
    relevant.length > 0 &&
    relevant.every((p) => traversed.has(accountEvidencePartitionKey(p))) &&
    ["linear", "inverse", "spot", "option"].every((category) =>
      relevant.some(
        (p) => p.endpoint === "open-orders" && p.category === category,
      ),
    );
  if (!pass)
    return {
      status: "unknown",
      positionState: "unknown",
      activeOrderCount: null,
      relevantCoverageComplete,
    };
  const positions = pass.positions.filter((p) => p.symbol === symbol);
  const terminal = [
    "Filled",
    "Cancelled",
    "Rejected",
    "Deactivated",
    "PartiallyFilledCanceled",
  ];
  const active = ["New", "PartiallyFilled", "Untriggered", "Triggered"];
  const orders = pass.orders.filter((o) => o.symbol === symbol);
  const activeOrderCount = orders.filter((o) =>
    active.includes(o.status),
  ).length;
  const unknownOrders = orders.some(
    (o) => !active.includes(o.status) && !terminal.includes(o.status),
  );
  const existing = positions.some(
    (p) => p.size.state === "known" && p.size.value.isPositive(),
  );
  const unknownPosition =
    preflight.projection.targetPosition.state === "ambiguous" ||
    positions.some(
      (p) =>
        p.category !== "linear" ||
        p.positionIdx !== 0 ||
        !["None", "Buy", "Sell"].includes(p.side) ||
        p.size.state !== "known" ||
        (p.size.value.isPositive() && p.side === "None"),
    );
  const positionState = unknownPosition
    ? "unknown"
    : existing
      ? "existing"
      : "flat";
  const status =
    existing || activeOrderCount > 0
      ? "conflict"
      : !relevantCoverageComplete || unknownPosition || unknownOrders
        ? "unknown"
        : "clean";
  return {
    status,
    positionState,
    activeOrderCount: unknownOrders ? null : activeOrderCount,
    relevantCoverageComplete,
  };
}

function reviewAction(
  preflight: PortfolioRiskPreflight,
  state: PreparedDailyPlanState,
) {
  if (state === "BLOCKED" || preflight.actionProposal === null)
    return { kind: "blocked-no-action" as const };
  const action = preflight.actionProposal;
  switch (action.kind) {
    case "add-long":
      return { kind: "add-long-proposal" as const };
    case "hold-no-action":
      return { kind: action.kind };
    case "reduction-no-op":
      return { kind: action.kind, reasonCode: action.reasonCode };
    case "close-long-quantity":
      return { kind: action.kind, proposal: action.proposal };
  }
}

function materialSummary(
  inputs: PreparedDailyPlanReplayInputs,
  planning: DailyPlanningInputs,
  gate: PreparedTargetGate,
  state: PreparedDailyPlanState,
) {
  const p = inputs.preflight;
  const { dailyPlan, account } = p.replayInputs;
  const pass = account.criticalPasses.B;
  return {
    symbol: planning.symbol,
    allocationUsd: planning.allocation,
    evaluatedAt: p.evaluationTime,
    decision: dailyPlan.decision,
    quality: {
      gate: planning.assessment.qualityGate,
      evidenceConfidence: planning.evidenceConfidence,
      findings: planning.assessment.findings,
      appliedPenalties: planning.assessment.appliedPenalties,
    },
    nativeAvailability: [
      ...planning.analytics.priceFeatures,
      ...planning.analytics.derivativeFeatures,
    ].map((outcome) => ({
      requestId: outcome.requestId,
      kind: outcome.kind,
      status: outcome.status,
    })),
    selectorObservations: planning.selectors,
    atr: planning.atr,
    grid: (dailyPlan.candidateLegs ?? []).map((leg) => ({
      index: leg.index,
      allocationUsd: leg.allocation,
      price: leg.intent.price,
      quantity: leg.intent.quantity,
      notionalUsd: leg.intent.notional,
      timeInForce: leg.timeInForce,
      takeProfit: leg.intent.protection?.takeProfit ?? null,
      stopLoss: leg.intent.protection?.stopLoss ?? null,
    })),
    externalAvailability: inputs.externalAvailability,
    informationalCodes: inputs.reviewPolicy.informationalCodes,
    exceptionalWarnings: inputs.reviewPolicy.exceptionalWarnings,
    policies: {
      reviewVersion: inputs.reviewPolicy.policyVersion,
      approvalVersion: inputs.approvalPolicy.policyVersion,
      approvalTtlMs: inputs.approvalPolicy.ttlMs,
      qualityVersion: p.replayInputs.qualityProfile.profileVersion,
      decisionVersion: planning.decisionPolicy.policyVersion,
      planningVersion: planning.planningPolicy.policyVersion,
      riskVersion: p.replayInputs.policy.policyVersion,
    },
    account: {
      environment: account.accountBinding.environment,
      collectionStatus: account.collectionStatus,
      collectionEndedAt: account.collectionEndedAt,
      positionCount: pass?.positions.length ?? null,
      openOrderCount: pass?.orders.length ?? null,
      assetCount: pass?.assets.length ?? null,
      coveredPartitions: account.coverage.filter(
        (c) => c.status === "traversed",
      ).length,
      expectedPartitions: account.expectedPartitions.length,
      marginCompatibility: account.consistency.marginCompatibility,
    },
    publicMarket: {
      environment: planning.market.source.environment,
      runId: planning.market.runId,
      bundleCutoff: planning.market.bundleCutoff,
    },
    targetGate: gate,
    risk: {
      verdict: p.verdict,
      reasonCodes: p.reasonCodes,
      sharedAdmission: p.projection.sharedAdmission,
      capacity: {
        outcome: p.capacity.outcome,
        reasonCodes: p.capacity.reasonCodes,
        withinCapacity: p.capacity.capacity.withinCapacity,
        incrementalCapacityUsd: p.capacity.capacity.incrementalCapacity,
        requestedIncrementalNotionalUsd:
          p.capacity.capacity.requestedIncrementalNotional,
        leverage: p.capacity.leverage,
      },
      exposure: {
        status: p.projection.addProjection.status,
        currentDerivativesGrossUsd:
          p.projection.addProjection.currentDerivativesGrossUsd,
        pendingDerivativesGrossUsd:
          p.projection.addProjection.pendingDerivativesGrossUsd,
        plannedDerivativesGrossUsd:
          p.projection.addProjection.plannedDerivativesGrossUsd,
        spotInventoryGrossUsd: p.projection.addProjection.spotInventoryGrossUsd,
        totalGrossExposureUsd: p.projection.addProjection.totalGrossExposureUsd,
      },
      economics: {
        outcome: p.economics.outcome,
        reasonCodes: p.economics.reasonCodes,
        fundingEvidence: p.economics.fundingEvidence,
        legs: p.economics.legs,
      },
    },
    action: reviewAction(p, state),
    executionAuthority: "none" as const,
  };
}

const INPUT_KEYS = [
  "preflight",
  "reviewPolicy",
  "approvalPolicy",
  "externalAvailability",
] as const;
const ARTIFACT_KEYS = [
  "schemaVersion",
  "preparedPlanId",
  "contentHash",
  "inputIdentity",
  "replayInputs",
  "state",
  "reasonCodes",
  "noteRequired",
  "executionAuthority",
  "summary",
] as const;

/** Pure decision-only preparation. Invalid/pre-auth inputs never fabricate a canonical artifact. */
export function createPreparedDailyPlan(
  input: unknown,
): Result<PreparedDailyPlan> {
  if (!exactRecord(input, INPUT_KEYS)) return invalid();
  const preflight = rehydratePortfolioRiskPreflight(input.preflight);
  const reviewPolicy = createDailyReviewPolicy(input.reviewPolicy);
  const approvalPolicy = createDailyApprovalPolicy(input.approvalPolicy);
  if (!preflight.ok || !reviewPolicy.ok || !approvalPolicy.ok)
    return invalid(
      "prepared plan requires exact validated preflight and explicit policies",
    );
  const p = preflight.value;
  const planning = prepareDailyPlanningInputs(p.replayInputs.dailyPlan.inputs);
  if (!planning.ok) return invalid("prepared plan planning inputs are invalid");
  const account = p.replayInputs.account;
  if (account.runId !== planning.value.identity.runId)
    return invalid("account and planning runs differ");
  const availability = externalAvailability(
    input.externalAvailability,
    planning.value,
  );
  if (!availability.ok) return availability;
  const replayInputs = {
    preflight: p,
    reviewPolicy: reviewPolicy.value,
    approvalPolicy: approvalPolicy.value,
    externalAvailability: availability.value,
  };
  const gate = targetGate(p);
  const reasonCodes: string[] = [...p.reasonCodes];
  if (gate.status === "conflict")
    reasonCodes.push("BLOCKED_BY_CREATE_ONLY_SCOPE");
  if (gate.status === "unknown") reasonCodes.push("TARGET_STATE_UNKNOWN");
  const needsReview =
    planning.value.assessment.findings.some((f) => !f.blocking) ||
    planning.value.assessment.appliedPenalties.some((penalty) =>
      penalty.penalty.isPositive(),
    ) ||
    reviewPolicy.value.exceptionalWarnings.length > 0;
  const state: PreparedDailyPlanState =
    p.verdict === "BLOCK" || reasonCodes.length > 0
      ? "BLOCKED"
      : needsReview
        ? "REVIEW"
        : "READY_FOR_APPROVAL";
  const summary = materialSummary(replayInputs, planning.value, gate, state);
  const preflightArtifactHash = hashCanonical(p);
  const reviewPolicyHash = hashCanonical(reviewPolicy.value);
  const approvalPolicyHash = hashCanonical(approvalPolicy.value);
  const externalAvailabilityHash = hashCanonical(availability.value);
  if (
    !preflightArtifactHash.ok ||
    !reviewPolicyHash.ok ||
    !approvalPolicyHash.ok ||
    !externalAvailabilityHash.ok
  )
    return invalid("prepared source identity is invalid");
  const inputIdentity = {
    preflightContentHash: p.contentHash,
    preflightArtifactHash: preflightArtifactHash.value,
    reviewPolicyHash: reviewPolicyHash.value,
    approvalPolicyHash: approvalPolicyHash.value,
    externalAvailabilityHash: externalAvailabilityHash.value,
    runId: account.runId,
    environment: account.accountBinding.environment,
    accountIdentityHash: account.accountBinding.accountIdentityHash,
    evaluationTime: p.evaluationTime,
  };
  const id = hashCanonical({
    schemaVersion: "prepared-daily-plan-id/v1",
    inputIdentity,
  });
  if (!id.ok) return id;
  const payload = {
    schemaVersion: PREPARED_DAILY_PLAN_SCHEMA_VERSION,
    preparedPlanId: `prepared-daily-plan:${id.value}`,
    inputIdentity,
    replayInputs,
    state,
    reasonCodes: [...new Set(reasonCodes)].sort(),
    noteRequired: state === "REVIEW",
    executionAuthority: "none" as const,
    summary,
  };
  const contentHash = hashCanonical(payload);
  return contentHash.ok
    ? ok(deepFreeze({ ...payload, contentHash: contentHash.value }))
    : contentHash;
}

/** Recompute all claims at the saved preflight time, even if an attacker rehashed them. */
export function rehydratePreparedDailyPlan(
  input: unknown,
): Result<PreparedDailyPlan> {
  if (!exactRecord(input, ARTIFACT_KEYS)) return invalid();
  const replayed = createPreparedDailyPlan(input.replayInputs);
  if (!replayed.ok) return replayed;
  const actual = canonicalSerialize(input);
  const expected = canonicalSerialize(replayed.value);
  return actual.ok && expected.ok && actual.value === expected.value
    ? replayed
    : fail(
        domainError(
          "PLAN_HASH_MISMATCH",
          "prepared daily plan differs from deterministic replay",
        ),
      );
}
