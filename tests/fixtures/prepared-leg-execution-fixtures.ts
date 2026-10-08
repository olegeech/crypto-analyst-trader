import { createProvisionalM1Composition } from "../../src/application/policies/provisional-m1.js";
import { evaluatePortfolioRiskPreflight } from "../../src/domain/risk/portfolio-risk-preflight.js";
import { createPreparedDailyPlan } from "../../src/domain/review/prepared-daily-plan.js";
import { createPreparedPlanApproval } from "../../src/domain/review/prepared-plan-approval.js";
import {
  decimal as accountDecimal,
  withCounts,
} from "../account-evidence-fixture.js";
import {
  portfolioRiskAccountInput,
  portfolioRiskPolicyInput,
  portfolioRiskPosition,
} from "./portfolio-risk-fixtures.js";
import { portfolioRiskPlanningFixture } from "./portfolio-risk-planning-fixtures.js";
import { requireDailyFixture as value } from "./daily-planning-evidence-fixtures.js";

const EVALUATION_TIME = "2026-09-24T14:00:02.000Z";

export function preparedLegExecutionFixture() {
  const planning = portfolioRiskPlanningFixture({
    recommendation: "ADD_LONG",
    fundingRate: "0",
  });
  const composition = value(
    createProvisionalM1Composition({ symbol: "BTCUSDT", allocation: "10" }),
  );
  const source = portfolioRiskAccountInput({
    positions: [portfolioRiskPosition()],
  });
  const available = accountDecimal("1000", "USD");
  const account = withCounts({
    ...source,
    runId: planning.dailyPlan.inputIdentity.runId,
    accountBinding: {
      ...source.accountBinding,
      environment: "mainnet" as const,
      origin: "https://api.bybit.com",
    },
    credentialPosture: {
      ...source.credentialPosture,
      readOnly: false,
      permissions: {
        ...source.credentialPosture.permissions,
        contractOrder: true,
        contractPosition: true,
      },
    },
    criticalPasses: {
      A: {
        ...source.criticalPasses.A!,
        totals: {
          ...source.criticalPasses.A!.totals,
          totalAvailableBalance: available,
        },
      },
      B: {
        ...source.criticalPasses.B!,
        totals: {
          ...source.criticalPasses.B!.totals,
          totalAvailableBalance: available,
        },
      },
    },
  });
  const shiftedAccount = valueAccountTimes(account);
  const preflight = value(
    evaluatePortfolioRiskPreflight({
      dailyPlan: planning.dailyPlan,
      account: shiftedAccount,
      policy: portfolioRiskPolicyInput(),
      qualityProfile: planning.qualityProfile,
      evaluationTime: EVALUATION_TIME,
    }),
  );
  const prepared = value(
    createPreparedDailyPlan({
      preflight,
      reviewPolicy: composition.reviewPolicy,
      approvalPolicy: composition.approvalPolicy,
      externalAvailability: composition.externalAvailability,
    }),
  );
  const approvedAt = "2026-09-24T14:00:03.000Z";
  const approval = value(
    createPreparedPlanApproval({
      prepared,
      preparedHash: prepared.contentHash,
      actor: "local-operator:fixture",
      consent: true,
      approvedAt,
      note: prepared.noteRequired ? "Approved fixture review" : null,
    }),
  );
  const legId = planning.dailyPlan.candidateLegs?.[0]?.legId;
  if (legId === undefined) throw new Error("ADD fixture is missing a grid leg");
  return {
    prepared,
    approval,
    legId,
    now: "2026-09-24T14:00:04.000Z",
  };
}

function valueAccountTimes<T>(input: T): T {
  const shift =
    Date.parse("2026-09-24T14:00:00.000Z") -
    Date.parse("2026-10-02T12:00:00.000Z");
  const visit = (value: unknown): unknown => {
    if (typeof value === "string" && /^\d{4}-\d\d-\d\dT.*Z$/u.test(value))
      return new Date(Date.parse(value) + shift).toISOString();
    if (Array.isArray(value)) return value.map(visit);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, visit(child)]),
      );
    return value;
  };
  return visit(input) as T;
}
