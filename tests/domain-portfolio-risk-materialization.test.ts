import assert from "node:assert/strict";
import test from "node:test";

import { materializePortfolioRiskAction } from "../src/domain/risk/portfolio-risk-materialization.js";
import { requireDailyFixture } from "./fixtures/daily-planning-evidence-fixtures.js";
import {
  decimal as accountDecimal,
  fixture as accountFixture,
} from "./account-evidence-fixture.js";
import {
  portfolioRiskAccountInput,
  portfolioRiskPolicyInput,
  portfolioRiskPosition,
} from "./fixtures/portfolio-risk-fixtures.js";
import { portfolioRiskPlanningFixture } from "./fixtures/portfolio-risk-planning-fixtures.js";

const evaluationTime = "2026-10-02T12:00:02.000Z";

function materialize(
  account: unknown = accountFixture(),
  recommendation: "REDUCE_LONG" | "HOLD_LONG" | "ADD_LONG" = "REDUCE_LONG",
  at = evaluationTime,
) {
  const dailyPlan = portfolioRiskPlanningFixture({ recommendation }).dailyPlan;
  return requireDailyFixture(
    materializePortfolioRiskAction({
      dailyPlan,
      account,
      policy: portfolioRiskPolicyInput(),
      evaluationTime: at,
    }),
  );
}

test("known fresh one-way long produces a quantity-only close proposal", () => {
  const long = portfolioRiskPosition({
    side: "Buy",
    size: accountDecimal("1", "contracts"),
    positionValue: accountDecimal("100", "USD"),
  });
  const result = materialize(portfolioRiskAccountInput({ positions: [long] }));
  assert.equal(result.outcome, "pass");
  assert.equal(result.reduction.status, "proposed");
  assert.equal(result.reduction.currentQuantity.state, "known");
  assert.equal(result.reduction.requestedQuantity.state, "known");
  assert.equal(result.reduction.normalizedQuantity.state, "known");
  if (
    result.reduction.currentQuantity.state !== "known" ||
    result.reduction.requestedQuantity.state !== "known" ||
    result.reduction.normalizedQuantity.state !== "known"
  )
    return;
  assert.equal(result.reduction.currentQuantity.value.toString(), "1");
  assert.equal(result.reduction.requestedQuantity.value.toString(), "0.25");
  assert.equal(result.reduction.normalizedQuantity.value.toString(), "0.25");
  assert.equal(result.reduction.proposal?.kind, "close-long-quantity");
  assert.equal(result.reduction.proposal?.symbol, "BTCUSDT");
  assert.equal(result.reduction.proposal?.side, "Sell");
  assert.equal(result.reduction.proposal?.positionIdx, 0);
  assert.equal(result.reduction.proposal?.quantityUnit, "contracts");
  assert.equal(result.reduction.proposal?.quantity.toString(), "0.25");
  assert.equal("price" in (result.reduction.proposal ?? {}), false);
  assert.equal("orderIntent" in result.reduction, false);
});

test("absent and zero long are passing typed no-ops, never zero-quantity orders", () => {
  const absent = materialize();
  assert.equal(absent.outcome, "pass");
  assert.equal(absent.reduction.status, "no-op");
  assert.equal(absent.reduction.noOpReason, "NO_REDUCIBLE_LONG");
  assert.equal(absent.reduction.proposal, null);

  const zero = portfolioRiskPosition();
  const zeroResult = materialize(
    portfolioRiskAccountInput({ positions: [zero] }),
  );
  assert.equal(zeroResult.outcome, "pass");
  assert.equal(zeroResult.reduction.status, "no-op");
  assert.equal(zeroResult.reduction.noOpReason, "NO_REDUCIBLE_LONG");
  assert.equal(zeroResult.reduction.proposal, null);
});

test("quantity is floored and below-minimum reduction is a typed no-op", () => {
  const belowMinimum = portfolioRiskPosition({
    side: "Buy",
    size: accountDecimal("0.039", "contracts"),
    positionValue: accountDecimal("3.9", "USD"),
  });
  const result = materialize(
    portfolioRiskAccountInput({ positions: [belowMinimum] }),
  );
  assert.equal(result.outcome, "pass");
  assert.equal(result.reduction.status, "no-op");
  assert.equal(result.reduction.noOpReason, "REDUCTION_QUANTITY_TOO_SMALL");
  assert.equal(result.reduction.requestedQuantity.state, "known");
  assert.equal(result.reduction.normalizedQuantity.state, "known");
  if (
    result.reduction.requestedQuantity.state !== "known" ||
    result.reduction.normalizedQuantity.state !== "known"
  )
    return;
  assert.equal(result.reduction.requestedQuantity.value.toString(), "0.00975");
  assert.equal(result.reduction.normalizedQuantity.value.toString(), "0");
  assert.equal(result.reduction.proposal, null);
});

test("exact minimum quantity produces a positive close proposal without rounding up", () => {
  const atMinimum = portfolioRiskPosition({
    side: "Buy",
    size: accountDecimal("0.04", "contracts"),
    positionValue: accountDecimal("4", "USD"),
  });
  const result = materialize(
    portfolioRiskAccountInput({ positions: [atMinimum] }),
  );
  assert.equal(result.reduction.status, "proposed");
  assert.equal(result.reduction.proposal?.quantity.toString(), "0.01");
});

test("short or ambiguous target state blocks without a sell proposal", () => {
  const short = portfolioRiskPosition({
    side: "Sell",
    size: accountDecimal("1", "contracts"),
    positionValue: accountDecimal("100", "USD"),
  });
  const shortResult = materialize(
    portfolioRiskAccountInput({ positions: [short] }),
  );
  assert.equal(shortResult.outcome, "block");
  assert.ok(shortResult.reasonCodes.includes("REDUCTION_STATE_INVALID"));
  assert.equal(shortResult.reduction.proposal, null);

  const otherCategory = portfolioRiskPosition({
    category: "inverse",
    positionIdx: 1,
    side: "None",
    size: accountDecimal("0", "contracts"),
    positionValue: accountDecimal("0", "coin"),
    unrealisedPnl: accountDecimal("0", "coin"),
    positionIM: accountDecimal("0", "coin"),
    positionMM: accountDecimal("0", "coin"),
  });
  const ambiguousResult = materialize(
    portfolioRiskAccountInput({
      positions: [portfolioRiskPosition(), otherCategory],
    }),
  );
  assert.equal(ambiguousResult.outcome, "block");
  assert.ok(ambiguousResult.reasonCodes.includes("REDUCTION_STATE_INVALID"));
  assert.equal(ambiguousResult.reduction.proposal, null);
});

test("shared freshness admission blocks REDUCE, while HOLD and ADD have no reduction action", () => {
  const stale = materialize(
    accountFixture(),
    "REDUCE_LONG",
    "2026-10-02T12:01:02.001Z",
  );
  assert.equal(stale.outcome, "block");
  assert.ok(stale.reasonCodes.includes("ACCOUNT_EVIDENCE_STALE"));
  assert.equal(stale.reduction.status, "not-evaluated");
  assert.equal(stale.reduction.proposal, null);

  for (const recommendation of ["HOLD_LONG", "ADD_LONG"] as const) {
    const result = materialize(accountFixture(), recommendation);
    assert.equal(result.outcome, "not-evaluated");
    assert.equal(result.reduction.status, "not-evaluated");
    assert.equal(result.reduction.proposal, null);
  }
});
