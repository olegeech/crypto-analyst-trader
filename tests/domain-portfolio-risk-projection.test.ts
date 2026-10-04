import assert from "node:assert/strict";
import test from "node:test";

import { assessDataQuality } from "../src/domain/quality/assess-data-quality.js";
import { createQualityProfile } from "../src/domain/quality/quality-profile.js";
import { createAccountEvidenceBundle } from "../src/domain/account/account-evidence-bundle.js";
import { createDailyDecisionPlan } from "../src/domain/planning/daily-decision-plan.js";
import { createPortfolioRiskProjection } from "../src/domain/risk/portfolio-risk-projection.js";
import { createPortfolioRiskPolicy } from "../src/domain/risk/portfolio-risk-policy.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";
import { analyticsFixture } from "./fixtures/data-quality-fixtures.js";
import { marketFixture } from "./fixtures/data-quality-fixtures.js";
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
  targetInstrumentStatus?: "trading" | "non-trading" | "unavailable",
) {
  const raw = dailyDecisionInputFixture();
  const originalMarket = portfolioRiskMarketFixture();
  const { evidence: _evidence, ...marketPayload } = originalMarket;
  void _evidence;
  const market =
    targetInstrumentStatus === undefined
      ? originalMarket
      : marketFixture({
          ...marketPayload,
          symbols: marketPayload.symbols.map((row) =>
            row.symbol !== "BTCUSDT" || row.instrument === undefined
              ? row
              : {
                  ...row,
                  instrument: {
                    ...row.instrument,
                    status: targetInstrumentStatus,
                  },
                },
          ),
        });
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
    readonly targetInstrumentStatus?: "trading" | "non-trading" | "unavailable";
  } = {},
) {
  const dailyPlan = requireDailyFixture(
    createDailyDecisionPlan(
      planningInput(options.recommendation, options.targetInstrumentStatus),
    ),
  );
  const account = createAccountEvidenceBundle(accountInput);
  assert.equal(account.ok, true, account.ok ? "" : account.error.message);
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

test("projected gross exposure includes current positions, open orders and planned ADD legs once", () => {
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
  const plan = requireDailyFixture(
    createDailyDecisionPlan(planningInput("ADD_LONG")),
  );
  if (plan.decision.recommendation !== "ADD_LONG")
    throw new Error("ADD fixture must retain its candidate legs");
  if (!Array.isArray(plan.candidateLegs))
    throw new Error("ADD fixture is missing its candidate legs");
  const candidateLegs = plan.candidateLegs;
  const zero = requireDailyFixture(DecimalValue.fromString("0"));
  const plannedNotional = candidateLegs.reduce(
    (total, leg) => total.add(leg.intent.notional),
    zero,
  );
  assert.equal(result.addProjection.plannedDerivativesGrossUsd.state, "known");
  if (
    result.addProjection.plannedDerivativesGrossUsd.state !== "known" ||
    result.addProjection.currentDerivativesGrossUsd.state !== "known" ||
    result.addProjection.pendingDerivativesGrossUsd.state !== "known" ||
    result.addProjection.spotInventoryGrossUsd.state !== "known" ||
    result.addProjection.totalGrossExposureUsd.state !== "known"
  )
    return;
  assert.equal(
    result.addProjection.plannedDerivativesGrossUsd.value.toString(),
    plannedNotional.toString(),
  );
  assert.equal(
    result.addProjection.exposures.filter(
      (line) => line.source === "planned-order",
    ).length,
    candidateLegs.length,
  );
  const expectedTotal = result.addProjection.currentDerivativesGrossUsd.value
    .add(result.addProjection.pendingDerivativesGrossUsd.value)
    .add(result.addProjection.plannedDerivativesGrossUsd.value)
    .add(result.addProjection.spotInventoryGrossUsd.value);
  const existingExposure = requireDailyFixture(DecimalValue.fromString("400"));
  assert.equal(
    expectedTotal.toString(),
    plannedNotional.add(existingExposure).toString(),
  );
  assert.equal(
    result.addProjection.totalGrossExposureUsd.value.toString(),
    expectedTotal.toString(),
  );
});

test("zero-size positions with nonzero provider notional block ADD as contradictory", () => {
  const input = portfolioRiskAccountInput({
    positions: [
      portfolioRiskPosition({
        symbol: "BTCUSDT",
        side: "None",
        size: accountDecimal("0", "contracts"),
        positionValue: accountDecimal("100", "USD"),
      }),
    ],
  });
  const result = projection(input);
  assert.equal(result.addProjection.status, "blocked");
  assert.ok(
    result.addProjection.reasonCodes.includes("CURRENT_STATE_UNVALUABLE"),
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

test("non-cash spot inventory is counted once; cash is not a second budget", () => {
  const input = portfolioRiskAccountInput({
    assets: [
      portfolioRiskWalletAsset("BTC", {
        balance: "1",
        usdValue: "100",
        collateralEligible: false,
        collateralSwitch: "not-applicable",
        restricted: "unrestricted",
      }),
    ],
    collateral: [
      portfolioRiskCollateral("BTC", {
        collateralEligible: false,
        collateralSwitch: "not-applicable",
        restricted: "unrestricted",
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

test("zero coin balance with positive provider USD value is contradictory", () => {
  const input = portfolioRiskAccountInput({
    assets: [
      portfolioRiskWalletAsset("BTC", {
        balance: "0",
        usdValue: "100",
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
  assert.ok(
    result.addProjection.exposures.some(
      (line) =>
        line.symbol === "BTC" &&
        line.treatment === "unvalued" &&
        line.notionalUsd === null,
    ),
  );
});

test("active, unknown, or unavailable collateral restrictions block ADD", () => {
  for (const restricted of ["restricted", "near-limit", "unknown"] as const) {
    const input = portfolioRiskAccountInput({
      assets: [
        portfolioRiskWalletAsset("BTC", {
          balance: "0",
          usdValue: "0",
          collateralEligible: false,
          collateralSwitch: "not-applicable",
          restricted,
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
    assert.equal(result.addProjection.status, "blocked", restricted);
    assert.ok(
      result.addProjection.reasonCodes.includes(
        restricted === "unknown"
          ? "REQUIRED_ACCOUNT_FACT_UNKNOWN"
          : "ACCOUNT_RESTRICTION_ACTIVE",
      ),
    );
  }
  const unavailable = portfolioRiskAccountInput({
    assets: [
      portfolioRiskWalletAsset("BTC", {
        restricted: null,
        collateralEligible: false,
        collateralSwitch: "not-applicable",
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
  const result = projection(unavailable);
  assert.equal(result.addProjection.status, "blocked");
  assert.ok(
    result.addProjection.reasonCodes.includes("REQUIRED_ACCOUNT_FACT_UNKNOWN"),
  );
});

test("unmodeled borrow and accrued-interest liabilities block ADD", () => {
  const borrowed = portfolioRiskAccountInput({
    assets: [
      {
        ...portfolioRiskWalletAsset("BTC", {
          balance: "1",
          usdValue: "50",
          collateralEligible: false,
          collateralSwitch: "not-applicable",
        }),
        spotBorrow: accountDecimal("1", "coin"),
      },
    ],
    collateral: [
      portfolioRiskCollateral("BTC", {
        collateralEligible: false,
        collateralSwitch: "not-applicable",
      }),
    ],
  });
  const result = projection(borrowed);
  assert.equal(result.addProjection.status, "blocked");
  assert.ok(
    result.addProjection.reasonCodes.includes("ACCOUNT_LIABILITY_UNMODELED"),
  );
  const collateralDebt = portfolioRiskAccountInput({
    assets: [
      portfolioRiskWalletAsset("BTC", {
        collateralEligible: false,
        collateralSwitch: "not-applicable",
      }),
    ],
    collateral: [
      {
        ...portfolioRiskCollateral("BTC", {
          collateralEligible: false,
          collateralSwitch: "not-applicable",
        }),
        otherBorrowAmount: accountDecimal("0.1", "coin"),
      },
    ],
  });
  const collateralResult = projection(collateralDebt);
  assert.equal(collateralResult.addProjection.status, "blocked");
  assert.ok(
    collateralResult.addProjection.reasonCodes.includes(
      "ACCOUNT_LIABILITY_UNMODELED",
    ),
  );
});

test("ADD blocks target instruments that are non-trading or unavailable", () => {
  for (const status of ["non-trading", "unavailable"] as const) {
    const result = projection(accountFixture(), {
      targetInstrumentStatus: status,
    });
    assert.equal(result.addProjection.status, "blocked", status);
    assert.ok(
      result.addProjection.reasonCodes.includes(
        "TARGET_INSTRUMENT_NOT_TRADING",
      ),
    );
  }
});

test("linear position notional falls back to exact size times mark price", () => {
  const unavailableUsd = {
    state: "unavailable" as const,
    reason: "not-returned" as const,
    unit: "USD" as const,
  } as unknown as ReturnType<typeof portfolioRiskPosition>["positionValue"];
  const unavailablePrice = {
    state: "unavailable" as const,
    reason: "not-returned" as const,
    unit: "price" as const,
  } as unknown as ReturnType<typeof portfolioRiskPosition>["markPrice"];
  const input = portfolioRiskAccountInput({
    positions: [
      portfolioRiskPosition({
        side: "Buy",
        size: accountDecimal("2", "contracts"),
        positionValue: unavailableUsd,
        markPrice: accountDecimal("100", "price"),
      }),
    ],
  });
  const result = projection(input);
  assert.equal(result.addProjection.status, "complete");
  assert.equal(result.addProjection.currentDerivativesGrossUsd.state, "known");
  if (result.addProjection.currentDerivativesGrossUsd.state === "known")
    assert.equal(
      result.addProjection.currentDerivativesGrossUsd.value.toString(),
      "200",
    );

  const unpriced = portfolioRiskAccountInput({
    positions: [
      portfolioRiskPosition({
        side: "Buy",
        size: accountDecimal("2", "contracts"),
        positionValue: unavailableUsd,
        markPrice: unavailablePrice,
      }),
    ],
  });
  assert.equal(projection(unpriced).addProjection.status, "blocked");
});
