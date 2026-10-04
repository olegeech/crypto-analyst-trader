import assert from "node:assert/strict";
import test from "node:test";

import { assessDataQuality } from "../src/domain/quality/assess-data-quality.js";
import { createQualityProfile } from "../src/domain/quality/quality-profile.js";
import { createAccountEvidenceBundle } from "../src/domain/account/account-evidence-bundle.js";
import { createDailyDecisionPlan } from "../src/domain/planning/daily-decision-plan.js";
import { createPortfolioRiskProjection } from "../src/domain/risk/portfolio-risk-projection.js";
import { createPortfolioRiskPolicy } from "../src/domain/risk/portfolio-risk-policy.js";
import { analyticsFixture } from "./fixtures/data-quality-fixtures.js";
import {
  dailyQualityProfileFixture,
  requireDailyFixture,
} from "./fixtures/daily-planning-evidence-fixtures.js";
import { dailyDecisionInputFixture } from "./fixtures/daily-planning-policy-fixtures.js";
import { fixture as accountFixture } from "./account-evidence-fixture.js";
import {
  portfolioRiskAccountInput,
  portfolioRiskCollateral,
  portfolioRiskMarketFixture,
  portfolioRiskOrder,
  portfolioRiskPolicyInput,
  portfolioRiskPosition,
  portfolioRiskWalletAsset,
} from "./fixtures/portfolio-risk-fixtures.js";
import {
  decimal as accountDecimal,
  known,
} from "./account-evidence-fixture.js";

const evaluationTime = "2026-10-02T12:00:02.000Z";

function planningInput(
  recommendation: "ADD_LONG" | "REDUCE_LONG" | "HOLD_LONG" = "ADD_LONG",
) {
  const raw = dailyDecisionInputFixture();
  const market = portfolioRiskMarketFixture();
  const analytics = analyticsFixture(market, {
    profile: {
      schemaVersion: "analytics-profile/v1",
      features: [
        {
          id: "atr",
          kind: "atr",
          symbol: "BTCUSDT",
          interval: "1h",
          period: 1,
          required: true,
        },
        {
          id: "return",
          kind: "close-return",
          symbol: "BTCUSDT",
          interval: "1h",
          periods: 1,
          required: true,
        },
      ],
      externalEvidence: [],
    },
  });
  const profile = requireDailyFixture(
    createQualityProfile(dailyQualityProfileFixture()),
  );
  const assessment = requireDailyFixture(
    assessDataQuality({
      profile,
      sources: [
        { role: "market", value: market },
        { role: "analytics", value: analytics },
      ],
      bundleCutoff: market.bundleCutoff,
      evaluationTime: market.bundleCutoff,
    }),
  );
  const decisionPolicy = {
    ...raw.decisionPolicy,
    groups:
      recommendation === "HOLD_LONG"
        ? raw.decisionPolicy.groups.map((group) => ({
            ...group,
            rules: group.rules.map((rule) => ({
              ...rule,
              conditions: rule.conditions.map((condition) => ({
                ...condition,
                threshold: "1000",
              })),
            })),
          }))
        : raw.decisionPolicy.groups.map((group) => ({
            ...group,
            rules: group.rules.map((rule) => ({
              ...rule,
              target:
                recommendation === "REDUCE_LONG" ? "REDUCE_LONG" : "ADD_LONG",
            })),
          })),
  };
  return { ...raw, market, analytics, assessment, decisionPolicy };
}

function projection(
  accountInput: unknown = accountFixture(),
  options: {
    readonly recommendation?: "ADD_LONG" | "REDUCE_LONG" | "HOLD_LONG";
    readonly evaluationTime?: string;
  } = {},
) {
  const dailyPlan = requireDailyFixture(
    createDailyDecisionPlan(planningInput(options.recommendation)),
  );
  const account = createAccountEvidenceBundle(accountInput);
  assert.equal(account.ok, true);
  if (!account.ok) throw new Error("account fixture must be valid");
  const policy = requireDailyFixture(
    createPortfolioRiskPolicy(portfolioRiskPolicyInput()),
  );
  return requireDailyFixture(
    createPortfolioRiskProjection({
      dailyPlan,
      account: account.value,
      policy,
      evaluationTime: options.evaluationTime ?? evaluationTime,
    }),
  );
}

test("shared account admission uses the inclusive 60-second age boundary", () => {
  const fresh = accountFixture();
  for (const ageMs of [59_999, 60_000]) {
    const at = new Date(
      Date.parse(fresh.collectionEndedAt!) + ageMs,
    ).toISOString();
    const result = projection(fresh, { evaluationTime: at });
    assert.equal(result.sharedAdmission.status, "admitted");
    assert.equal(result.addProjection.status, "complete");
  }
  const stale = projection(fresh, {
    evaluationTime: "2026-10-02T12:01:02.001Z",
  });
  assert.equal(stale.sharedAdmission.status, "blocked");
  assert.ok(
    stale.sharedAdmission.reasonCodes.includes("ACCOUNT_EVIDENCE_STALE"),
  );
});

test("HOLD and REDUCE pass shared admission without evaluating ADD capacity", () => {
  for (const recommendation of ["HOLD_LONG", "REDUCE_LONG"] as const) {
    const result = projection(accountFixture(), { recommendation });
    assert.equal(result.sharedAdmission.status, "admitted");
    assert.equal(result.addProjection.status, "not-evaluated");
    assert.equal(result.addProjection.availableBalance.state, "not-evaluated");
    assert.equal(result.targetPosition.state, "absent");
  }
});

test("stale, future and incomplete account evidence block ADD, HOLD and REDUCE alike", () => {
  for (const recommendation of [
    "ADD_LONG",
    "HOLD_LONG",
    "REDUCE_LONG",
  ] as const) {
    const stale = projection(accountFixture(), {
      recommendation,
      evaluationTime: "2026-10-02T12:01:02.001Z",
    });
    assert.equal(stale.sharedAdmission.status, "blocked");
    assert.equal(stale.addProjection.status, "not-evaluated");

    const future = projection(accountFixture(), {
      recommendation,
      evaluationTime: "2026-10-02T12:00:01.000Z",
    });
    assert.ok(
      future.sharedAdmission.reasonCodes.includes("ACCOUNT_EVIDENCE_FUTURE"),
    );

    const incomplete = projection(
      {
        ...accountFixture(),
        collectionStatus: "incomplete",
        diagnostics: [
          {
            code: "COVERAGE_INCOMPLETE",
            severity: "error",
            scope: "collection",
          },
        ],
      },
      { recommendation },
    );
    assert.ok(
      incomplete.sharedAdmission.reasonCodes.includes(
        "ACCOUNT_EVIDENCE_INCOMPLETE",
      ),
    );
  }
});

test("unsupported margin or non-one-way target mode blocks shared admission", () => {
  const source = accountFixture();
  const unsupportedMargin = {
    ...source,
    collectionStatus: "incomplete",
    criticalPasses: {
      A: {
        ...source.criticalPasses.A!,
        account: {
          ...source.criticalPasses.A!.account,
          marginMode: known("ISOLATED_MARGIN"),
        },
      },
      B: {
        ...source.criticalPasses.B!,
        account: {
          ...source.criticalPasses.B!.account,
          marginMode: known("ISOLATED_MARGIN"),
        },
      },
    },
  };
  const margin = projection(unsupportedMargin);
  assert.ok(
    margin.sharedAdmission.reasonCodes.includes("ACCOUNT_MODE_UNSUPPORTED"),
  );

  const hedge = {
    ...source,
    collectionStatus: "incomplete",
    criticalPasses: {
      A: {
        ...source.criticalPasses.A!,
        modeProbes: [{ symbol: "BTCUSDT", positionIndices: [1] }],
      },
      B: {
        ...source.criticalPasses.B!,
        modeProbes: [{ symbol: "BTCUSDT", positionIndices: [1] }],
      },
    },
  };
  const mode = projection(hedge);
  assert.ok(
    mode.sharedAdmission.reasonCodes.includes("POSITION_MODE_UNSUPPORTED"),
  );
});

test("existing supported positions and open limit orders each contribute once", () => {
  const input = portfolioRiskAccountInput({
    positions: [
      portfolioRiskPosition({
        symbol: "BTCUSDT",
        side: "Buy",
        size: accountDecimal("1", "contracts"),
        positionValue: accountDecimal("100", "USD"),
      }),
      portfolioRiskPosition({
        symbol: "ETHUSDT",
        side: "Buy",
        size: accountDecimal("1", "contracts"),
        positionValue: accountDecimal("200", "USD"),
      }),
    ],
    orders: [
      portfolioRiskOrder({
        orderId: "eth-open-1",
        symbol: "ETHUSDT",
        side: "Buy",
        qty: accountDecimal("1", "contracts"),
        leavesQty: accountDecimal("0.5", "contracts"),
        price: accountDecimal("200", "price"),
      }),
    ],
  });
  const result = projection(input);
  assert.equal(result.addProjection.status, "complete");
  if (result.addProjection.currentDerivativesGrossUsd.state !== "known") return;
  assert.equal(
    result.addProjection.currentDerivativesGrossUsd.value.toString(),
    "300",
  );
  assert.equal(result.addProjection.pendingDerivativesGrossUsd.state, "known");
  if (result.addProjection.pendingDerivativesGrossUsd.state === "known")
    assert.equal(
      result.addProjection.pendingDerivativesGrossUsd.value.toString(),
      "100",
    );
});

test("protective close orders are reported separately and do not create short exposure", () => {
  const input = portfolioRiskAccountInput({
    positions: [
      portfolioRiskPosition({
        side: "Buy",
        size: accountDecimal("1", "contracts"),
        positionValue: accountDecimal("100", "USD"),
      }),
    ],
    orders: [
      portfolioRiskOrder({
        side: "Sell",
        reduceOnly: known(true),
        leavesQty: accountDecimal("0.5", "contracts"),
        price: accountDecimal("0", "price"),
      }),
    ],
  });
  const result = projection(input);
  assert.equal(result.addProjection.status, "complete");
  assert.equal(result.addProjection.pendingDerivativesGrossUsd.state, "known");
  if (result.addProjection.pendingDerivativesGrossUsd.state === "known")
    assert.equal(
      result.addProjection.pendingDerivativesGrossUsd.value.toString(),
      "0",
    );
  assert.ok(
    result.addProjection.exposures.some(
      (line) => line.treatment === "protective-close",
    ),
  );
});

test("out-of-universe contracts and unpriced increasing orders block ADD, not HOLD", () => {
  const unsupported = portfolioRiskAccountInput({
    positions: [
      portfolioRiskPosition({
        symbol: "XRPUSDT",
        side: "Buy",
        size: accountDecimal("1", "contracts"),
        positionValue: accountDecimal("10", "USD"),
      }),
    ],
  });
  const blocked = projection(unsupported);
  assert.equal(blocked.addProjection.status, "blocked");
  assert.ok(blocked.addProjection.reasonCodes.includes("UNSUPPORTED_EXPOSURE"));

  const inverse = portfolioRiskAccountInput({
    positions: [
      portfolioRiskPosition({
        category: "inverse",
        symbol: "BTCUSD",
        side: "Buy",
        size: accountDecimal("1", "contracts"),
        positionValue: accountDecimal("1", "coin"),
        unrealisedPnl: accountDecimal("0", "coin"),
        positionIM: accountDecimal("0", "coin"),
        positionMM: accountDecimal("0", "coin"),
      }),
    ],
  });
  assert.ok(
    projection(inverse).addProjection.reasonCodes.includes(
      "UNSUPPORTED_EXPOSURE",
    ),
  );
  const option = portfolioRiskAccountInput({
    positions: [
      portfolioRiskPosition({
        category: "option",
        symbol: "ETH-OPTION",
        side: "Buy",
        size: accountDecimal("1", "contracts"),
        positionValue: accountDecimal("10", "USD"),
      }),
    ],
  });
  assert.ok(
    projection(option).addProjection.reasonCodes.includes(
      "UNSUPPORTED_EXPOSURE",
    ),
  );

  const unpriced = portfolioRiskAccountInput({
    orders: [
      portfolioRiskOrder({
        orderType: "Market",
        price: accountDecimal("0", "price"),
      }),
    ],
  });
  assert.ok(
    projection(unpriced).addProjection.reasonCodes.includes(
      "CURRENT_STATE_UNVALUABLE",
    ),
  );
  const conflictingTargetMode = portfolioRiskAccountInput({
    orders: [portfolioRiskOrder({ positionIdx: known(1) })],
  });
  assert.ok(
    projection(conflictingTargetMode).addProjection.reasonCodes.includes(
      "POSITION_MODE_UNSUPPORTED",
    ),
  );
  assert.equal(
    projection(unsupported, { recommendation: "HOLD_LONG" }).addProjection
      .status,
    "not-evaluated",
  );
});

test("non-cash spot inventory is counted once; cash and optional restriction are not a second budget", () => {
  const input = portfolioRiskAccountInput({
    assets: [
      portfolioRiskWalletAsset("BTC", {
        balance: "1",
        usdValue: "100",
        collateralEligible: false,
        collateralSwitch: "not-applicable",
        restricted: null,
      }),
    ],
    collateral: [
      portfolioRiskCollateral("BTC", {
        collateralEligible: false,
        collateralSwitch: "not-applicable",
        restricted: null,
      }),
    ],
  });
  const result = projection(input);
  assert.equal(result.addProjection.status, "complete");
  assert.equal(result.addProjection.spotInventoryGrossUsd.state, "known");
  if (result.addProjection.spotInventoryGrossUsd.state === "known")
    assert.equal(
      result.addProjection.spotInventoryGrossUsd.value.toString(),
      "100",
    );
  assert.equal(result.addProjection.availableBalance.state, "known");
  if (result.addProjection.availableBalance.state === "known")
    assert.equal(result.addProjection.availableBalance.value.toString(), "100");
  assert.equal(
    result.addProjection.exposures.filter(
      (line) => line.treatment === "cash-visibility",
    ).length,
    2,
  );
});

test("positive non-cash inventory without provider USD valuation is not zero-filled", () => {
  const input = portfolioRiskAccountInput({
    assets: [
      portfolioRiskWalletAsset("BTC", {
        balance: "1",
        usdValue: null,
        collateralEligible: false,
        collateralSwitch: "not-applicable",
      }),
    ],
    collateral: [
      portfolioRiskCollateral("BTC", {
        collateralEligible: false,
        collateralSwitch: "not-applicable",
      }),
    ],
  });
  const result = projection(input);
  assert.equal(result.addProjection.status, "blocked");
  assert.ok(
    result.addProjection.reasonCodes.includes("CURRENT_STATE_UNVALUABLE"),
  );
  assert.equal(result.addProjection.spotInventoryGrossUsd.state, "unavailable");
});
