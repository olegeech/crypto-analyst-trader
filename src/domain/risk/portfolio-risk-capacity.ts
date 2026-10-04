import {
  accountEvidenceContentHash,
  createAccountEvidenceBundle,
  type AccountEvidenceBundle,
  type AccountPositionEvidence,
} from "../account/account-evidence-bundle.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { DecimalValue, isDecimalValue } from "../shared/decimal.js";
import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";
import { parseUtcTimestamp, type UtcTimestamp } from "../shared/time.js";
import { isRecord } from "../shared/validation.js";
import {
  rehydrateDailyDecisionPlan,
  type DailyDecisionPlan,
} from "../planning/daily-decision-plan.js";
import {
  createPortfolioRiskEvidenceSet,
  validatePortfolioRiskLeverageEvidence,
} from "./portfolio-risk-evidence.js";
import {
  createPortfolioRiskProjection,
  type PortfolioRiskProjection,
  type PortfolioRiskProjectionFact,
} from "./portfolio-risk-projection.js";
import {
  createPortfolioRiskPolicy,
  type PortfolioRiskPolicy,
  portfolioRiskPolicyHash,
} from "./portfolio-risk-policy.js";
import {
  createPortfolioRiskBlockReasonCodes,
  type PortfolioRiskBlockReasonCode,
} from "./portfolio-risk-diagnostics.js";

export const PORTFOLIO_RISK_CAPACITY_SCHEMA_VERSION =
  "portfolio-risk-capacity/v1" as const;

export type PortfolioRiskGateStatus = "pass" | "block" | "not-evaluated";

export interface PortfolioRiskLeverageCheck {
  readonly symbol: string;
  readonly positionIdx: number | null;
  readonly status: "pass" | "block";
  readonly source: "pass-b" | "supplemental" | "unavailable";
  readonly leverage: PortfolioRiskProjectionFact;
}

export interface PortfolioRiskCapacity {
  readonly schemaVersion: typeof PORTFOLIO_RISK_CAPACITY_SCHEMA_VERSION;
  readonly dailyPlanHash: string;
  readonly accountEvidenceHash: string;
  readonly policyHash: string;
  readonly evaluationTime: UtcTimestamp;
  readonly recommendation: "ADD_LONG" | "REDUCE_LONG" | "HOLD_LONG";
  readonly outcome: PortfolioRiskGateStatus;
  readonly reasonCodes: readonly PortfolioRiskBlockReasonCode[];
  readonly projection: PortfolioRiskProjection;
  readonly capacity: {
    readonly status: PortfolioRiskGateStatus;
    readonly availableBalance: PortfolioRiskProjectionFact;
    readonly reserve: PortfolioRiskProjectionFact;
    readonly incrementalCapacity: PortfolioRiskProjectionFact;
    readonly requestedIncrementalNotional: PortfolioRiskProjectionFact;
    readonly withinCapacity: boolean | null;
  };
  readonly leverage: {
    readonly status: PortfolioRiskGateStatus;
    readonly checks: readonly PortfolioRiskLeverageCheck[];
  };
}

export interface PortfolioRiskCapacityInput {
  readonly dailyPlan: unknown;
  readonly account: unknown;
  readonly policy: unknown;
  readonly evaluationTime: unknown;
  readonly supplementalEvidence?: unknown;
}

function invalid(
  message = "portfolio risk capacity input is invalid",
): Result<never> {
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

function closedInput(value: unknown): value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    !hasPlainDataProperties(value) ||
    ![4, 5].includes(Reflect.ownKeys(value).length)
  )
    return false;
  const allowed = [
    "dailyPlan",
    "account",
    "policy",
    "evaluationTime",
    "supplementalEvidence",
  ];
  return (
    Reflect.ownKeys(value).every(
      (key) => typeof key === "string" && allowed.includes(key),
    ) &&
    ["dailyPlan", "account", "policy", "evaluationTime"].every((key) =>
      Object.hasOwn(value, key),
    )
  );
}

function known<T>(fact: {
  readonly state: string;
  readonly value?: T;
}): fact is { readonly state: "known"; readonly value: T } {
  return fact.state === "known" && Object.hasOwn(fact, "value");
}

function fact(value: DecimalValue): PortfolioRiskProjectionFact {
  return { state: "known", value };
}

function unavailable(): PortfolioRiskProjectionFact {
  return { state: "unavailable" };
}

function notEvaluated(): PortfolioRiskProjectionFact {
  return { state: "not-evaluated" };
}

function isRelevantPosition(position: AccountPositionEvidence): boolean {
  return (
    position.category === "linear" &&
    (position.size.state !== "known" || position.size.value.isPositive())
  );
}

function leverageValue(position: AccountPositionEvidence): DecimalValue | null {
  return known(position.leverage) &&
    position.leverage.unit === "rate" &&
    position.leverage.value.isPositive()
    ? position.leverage.value
    : null;
}

function isFlatTarget(position: AccountPositionEvidence): boolean {
  return (
    position.category === "linear" &&
    position.positionIdx === 0 &&
    position.side === "None" &&
    known(position.size) &&
    position.size.unit === "contracts" &&
    position.size.value.isZero()
  );
}

function supplementalFailureCode(code: string): PortfolioRiskBlockReasonCode {
  if (code === "STALE_EVIDENCE") return "SUPPLEMENTAL_EVIDENCE_STALE";
  if (code === "INCOMPATIBLE_EVIDENCE") return "SUPPLEMENTAL_EVIDENCE_CONFLICT";
  return "SUPPLEMENTAL_EVIDENCE_INVALID";
}

function deriveRequestedNotional(
  plan: DailyDecisionPlan,
): Result<DecimalValue> {
  const zero = DecimalValue.fromString("0");
  if (!zero.ok) return zero;
  if (plan.decision.recommendation !== "ADD_LONG") return ok(zero.value);
  if (!Array.isArray(plan.orderIntents))
    return invalid("daily ADD plan is missing candidate intents");
  let total = zero.value;
  for (const intent of plan.orderIntents) {
    if (!isDecimalValue(intent.notional) || !intent.notional.isPositive())
      return invalid("daily ADD plan has an invalid candidate notional");
    total = total.add(intent.notional);
  }
  if (total.isZero()) return invalid("daily ADD plan has no positive notional");
  return ok(total);
}

function relevantSymbols(
  account: AccountEvidenceBundle,
  projection: PortfolioRiskProjection,
): readonly string[] {
  const symbols = new Set<string>([projection.targetSymbol]);
  const passB = account.criticalPasses.B;
  for (const position of passB?.positions ?? [])
    if (isRelevantPosition(position)) symbols.add(position.symbol);
  for (const exposure of projection.addProjection.exposures)
    if (
      exposure.source === "open-order" &&
      exposure.category === "linear" &&
      exposure.treatment === "gross-exposure"
    )
      symbols.add(exposure.symbol);
  return [...symbols].sort();
}

function deriveLeverageChecks(input: {
  readonly account: AccountEvidenceBundle;
  readonly projection: PortfolioRiskProjection;
  readonly policy: PortfolioRiskPolicy;
  readonly evaluationTime: UtcTimestamp;
  readonly targetSymbol: string;
  readonly symbols: readonly string[];
  readonly supplementalEvidence: unknown;
}): {
  readonly checks: readonly PortfolioRiskLeverageCheck[];
  readonly reasonCodes: readonly PortfolioRiskBlockReasonCode[];
  readonly status: PortfolioRiskGateStatus;
} {
  const reasons = new Set<PortfolioRiskBlockReasonCode>();
  const passB = input.account.criticalPasses.B;
  if (!passB) {
    reasons.add("ACCOUNT_EVIDENCE_INCOMPLETE");
    return { checks: [], reasonCodes: [...reasons], status: "block" };
  }

  const rawEvidence = input.supplementalEvidence;
  const evidenceSet = createPortfolioRiskEvidenceSet(rawEvidence);
  let supplementalLeverage: DecimalValue | null = null;
  if (!evidenceSet.ok) {
    reasons.add("SUPPLEMENTAL_EVIDENCE_INVALID");
  } else if (evidenceSet.value.length > 0) {
    if (
      evidenceSet.value.length !== 1 ||
      evidenceSet.value[0]?.symbol !== input.targetSymbol
    ) {
      reasons.add("SUPPLEMENTAL_EVIDENCE_INVALID");
    } else {
      const validated = validatePortfolioRiskLeverageEvidence(
        evidenceSet.value[0],
        input.account,
        {
          expectedSymbol: input.targetSymbol,
          evaluationTime: input.evaluationTime,
          policy: input.policy,
        },
      );
      if (validated.ok) supplementalLeverage = validated.value.leverage;
      else reasons.add(supplementalFailureCode(validated.error.code));
    }
  }

  const checks: PortfolioRiskLeverageCheck[] = [];
  const limit = input.policy.maxDerivativesLeverage;
  for (const symbol of input.symbols) {
    const rows = passB.positions.filter(
      (position) =>
        position.category === "linear" && position.symbol === symbol,
    );
    const ordersNeedSymbol = projectionHasIncreasingOrder(
      input.projection,
      symbol,
    );
    const relevantRows = rows.filter(isRelevantPosition);
    const target = symbol === input.targetSymbol;
    const rowsToCheck =
      relevantRows.length > 0 || target || ordersNeedSymbol ? rows : [];

    if (rowsToCheck.length === 0) {
      const leverage = target ? supplementalLeverage : null;
      if (leverage !== null) {
        const exceeds = leverage.compare(limit) > 0;
        checks.push({
          symbol,
          positionIdx: null,
          status: exceeds ? "block" : "pass",
          source: "supplemental",
          leverage: fact(leverage),
        });
        if (exceeds) reasons.add("LEVERAGE_EXCEEDS_POLICY");
      } else {
        checks.push({
          symbol,
          positionIdx: null,
          status: "block",
          source: "unavailable",
          leverage: unavailable(),
        });
        reasons.add("LEVERAGE_UNKNOWN");
      }
      continue;
    }

    for (const position of rowsToCheck) {
      const value = leverageValue(position);
      const targetFlat = target && isFlatTarget(position);
      const useSupplement =
        targetFlat &&
        value === null &&
        supplementalLeverage !== null &&
        rowsToCheck.length === 1;
      const effective = useSupplement ? supplementalLeverage : value;
      if (effective === null) {
        checks.push({
          symbol,
          positionIdx: position.positionIdx,
          status: "block",
          source: "unavailable",
          leverage: unavailable(),
        });
        reasons.add("LEVERAGE_UNKNOWN");
        continue;
      }
      const exceeds = effective.compare(limit) > 0;
      checks.push({
        symbol,
        positionIdx: position.positionIdx,
        status: exceeds ? "block" : "pass",
        source: useSupplement ? "supplemental" : "pass-b",
        leverage: fact(effective),
      });
      if (exceeds) reasons.add("LEVERAGE_EXCEEDS_POLICY");
    }
  }

  const normalized = createPortfolioRiskBlockReasonCodes([...reasons]);
  if (!normalized.ok)
    return {
      checks,
      reasonCodes: ["SUPPLEMENTAL_EVIDENCE_INVALID"],
      status: "block",
    };
  return {
    checks: deepFreeze(checks),
    reasonCodes: normalized.value,
    status: normalized.value.length > 0 ? "block" : "pass",
  };
}

function projectionHasIncreasingOrder(
  projection: PortfolioRiskProjection,
  symbol: string,
): boolean {
  return (
    projection.addProjection.exposures.some(
      (exposure) =>
        exposure.source === "open-order" &&
        exposure.category === "linear" &&
        exposure.symbol === symbol &&
        exposure.treatment === "gross-exposure",
    ) ?? false
  );
}

function buildCapacity(
  input: PortfolioRiskCapacityInput,
): Result<PortfolioRiskCapacity> {
  if (!closedInput(input)) return invalid();
  const plan = rehydrateDailyDecisionPlan(input.dailyPlan);
  const account = createAccountEvidenceBundle(input.account);
  const policy = createPortfolioRiskPolicy(input.policy);
  const evaluationTime = parseUtcTimestamp(input.evaluationTime);
  const supplementalEvidence = Object.hasOwn(input, "supplementalEvidence")
    ? input.supplementalEvidence
    : [];
  if (
    !plan.ok ||
    !account.ok ||
    !policy.ok ||
    !evaluationTime.ok ||
    !Array.isArray(supplementalEvidence)
  )
    return invalid(
      "capacity requires a validated plan, account, policy and evidence list",
    );

  const projection = createPortfolioRiskProjection({
    dailyPlan: plan.value,
    account: account.value,
    policy: policy.value,
    evaluationTime: evaluationTime.value,
  });
  const accountHash = accountEvidenceContentHash(account.value);
  const policyHash = portfolioRiskPolicyHash(policy.value);
  if (!projection.ok || !accountHash.ok || !policyHash.ok)
    return invalid("capacity source identity or shared projection is invalid");

  const reasons = new Set<PortfolioRiskBlockReasonCode>([
    ...projection.value.sharedAdmission.reasonCodes,
  ]);
  const unavailableFacts = {
    status: "not-evaluated" as const,
    availableBalance: notEvaluated(),
    reserve: notEvaluated(),
    incrementalCapacity: notEvaluated(),
    requestedIncrementalNotional: notEvaluated(),
    withinCapacity: null,
  };
  const unavailableLeverage = {
    status: "not-evaluated" as const,
    checks: [] as readonly PortfolioRiskLeverageCheck[],
  };

  if (projection.value.sharedAdmission.status === "blocked") {
    const normalized = createPortfolioRiskBlockReasonCodes([...reasons]);
    if (!normalized.ok) return invalid();
    return ok(
      deepFreeze({
        schemaVersion: PORTFOLIO_RISK_CAPACITY_SCHEMA_VERSION,
        dailyPlanHash: plan.value.contentHash,
        accountEvidenceHash: accountHash.value,
        policyHash: policyHash.value,
        evaluationTime: evaluationTime.value,
        recommendation: plan.value.decision.recommendation,
        outcome: "block",
        reasonCodes: normalized.value,
        projection: projection.value,
        capacity: unavailableFacts,
        leverage: unavailableLeverage,
      }),
    );
  }

  if (plan.value.decision.recommendation !== "ADD_LONG")
    return ok(
      deepFreeze({
        schemaVersion: PORTFOLIO_RISK_CAPACITY_SCHEMA_VERSION,
        dailyPlanHash: plan.value.contentHash,
        accountEvidenceHash: accountHash.value,
        policyHash: policyHash.value,
        evaluationTime: evaluationTime.value,
        recommendation: plan.value.decision.recommendation,
        outcome: "not-evaluated",
        reasonCodes: [],
        projection: projection.value,
        capacity: unavailableFacts,
        leverage: unavailableLeverage,
      }),
    );

  for (const code of projection.value.addProjection.reasonCodes)
    reasons.add(code);
  const requested = deriveRequestedNotional(plan.value);
  if (!requested.ok) return requested;

  const available = projection.value.addProjection.availableBalance;
  let capacity: PortfolioRiskCapacity["capacity"];
  if (available.state !== "known") {
    reasons.add("AVAILABLE_BALANCE_UNKNOWN");
    capacity = {
      status: "block",
      availableBalance: unavailable(),
      reserve: unavailable(),
      incrementalCapacity: unavailable(),
      requestedIncrementalNotional: fact(requested.value),
      withinCapacity: null,
    };
  } else {
    const zero = DecimalValue.fromString("0");
    if (!zero.ok) return invalid();
    const nonNegativeAvailable =
      available.value.compare(zero.value) > 0 ? available.value : zero.value;
    const reserve = nonNegativeAvailable.multiply(
      policy.value.marginReserveRatio,
    );
    const rawCapacity = available.value.subtract(reserve);
    const incrementalCapacity =
      rawCapacity.compare(zero.value) > 0 ? rawCapacity : zero.value;
    const withinCapacity = requested.value.compare(incrementalCapacity) <= 0;
    if (!withinCapacity) reasons.add("CAPACITY_EXCEEDED");
    capacity = {
      status: withinCapacity ? "pass" : "block",
      availableBalance: fact(available.value),
      reserve: fact(reserve),
      incrementalCapacity: fact(incrementalCapacity),
      requestedIncrementalNotional: fact(requested.value),
      withinCapacity,
    };
  }

  const leverage = deriveLeverageChecks({
    account: account.value,
    projection: projection.value,
    policy: policy.value,
    evaluationTime: evaluationTime.value,
    targetSymbol: projection.value.targetSymbol,
    symbols: relevantSymbols(account.value, projection.value),
    supplementalEvidence,
  });
  for (const code of leverage.reasonCodes) reasons.add(code);
  const normalized = createPortfolioRiskBlockReasonCodes([...reasons]);
  if (!normalized.ok) return invalid();
  const outcome: PortfolioRiskGateStatus =
    normalized.value.length > 0 ? "block" : "pass";

  return ok(
    deepFreeze({
      schemaVersion: PORTFOLIO_RISK_CAPACITY_SCHEMA_VERSION,
      dailyPlanHash: plan.value.contentHash,
      accountEvidenceHash: accountHash.value,
      policyHash: policyHash.value,
      evaluationTime: evaluationTime.value,
      recommendation: plan.value.decision.recommendation,
      outcome,
      reasonCodes: normalized.value,
      projection: projection.value,
      capacity,
      leverage,
    }),
  );
}

export function evaluatePortfolioRiskCapacity(
  input: PortfolioRiskCapacityInput,
): Result<PortfolioRiskCapacity> {
  return buildCapacity(input);
}
