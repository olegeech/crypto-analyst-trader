import assert from "node:assert/strict";
import test from "node:test";

import {
  accountEvidenceContentHash,
  createAccountEvidenceBundle,
} from "../src/domain/account/account-evidence-bundle.js";
import { evaluatePortfolioRiskCapacity } from "../src/domain/risk/portfolio-risk-capacity.js";
import { createPortfolioRiskEvidence } from "../src/domain/risk/portfolio-risk-evidence.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";
import { requireDailyFixture } from "./fixtures/daily-planning-evidence-fixtures.js";
import {
  decimal as accountDecimal,
  fixture as accountFixture,
  known,
  withCounts,
} from "./account-evidence-fixture.js";
import {
  portfolioRiskPolicyInput,
  portfolioRiskAccountInput,
  portfolioRiskCollateral,
  portfolioRiskOrder,
  portfolioRiskPosition,
  portfolioRiskWalletAsset,
} from "./fixtures/portfolio-risk-fixtures.js";
import { portfolioRiskPlanningFixture } from "./fixtures/portfolio-risk-planning-fixtures.js";

const evaluationTime = "2026-10-02T12:00:02.000Z";

function riskPlan(
  recommendation: "ADD_LONG" | "REDUCE_LONG" | "HOLD_LONG" = "ADD_LONG",
) {
  return portfolioRiskPlanningFixture({ recommendation }).dailyPlan;
}

function accountWithAvailableBalance(value: string) {
  const source = accountFixture();
  return withCounts({
    ...source,
    criticalPasses: {
      A: {
        ...source.criticalPasses.A!,
        totals: {
          ...source.criticalPasses.A!.totals,
          totalAvailableBalance: accountDecimal(value, "USD"),
        },
      },
      B: {
        ...source.criticalPasses.B!,
        totals: {
          ...source.criticalPasses.B!.totals,
          totalAvailableBalance: accountDecimal(value, "USD"),
        },
      },
    },
  });
}

function accountWithPositions(
  positions: readonly ReturnType<typeof portfolioRiskPosition>[],
  availableBalance = "100",
) {
  const source = portfolioRiskAccountInput({ positions });
  const balance = accountDecimal(availableBalance, "USD");
  return withCounts({
    ...source,
    criticalPasses: {
      A: {
        ...source.criticalPasses.A!,
        totals: {
          ...source.criticalPasses.A!.totals,
          totalAvailableBalance: balance,
        },
      },
      B: {
        ...source.criticalPasses.B!,
        totals: {
          ...source.criticalPasses.B!.totals,
          totalAvailableBalance: balance,
        },
      },
    },
  });
}

function evaluate(
  account: unknown = accountFixture(),
  options: {
    readonly recommendation?: "ADD_LONG" | "REDUCE_LONG" | "HOLD_LONG";
    readonly policy?: Record<string, unknown>;
    readonly supplementalEvidence?: readonly unknown[];
  } = {},
) {
  return requireDailyFixture(
    evaluatePortfolioRiskCapacity({
      dailyPlan: riskPlan(options.recommendation),
      account,
      policy: portfolioRiskPolicyInput(options.policy),
      evaluationTime,
      supplementalEvidence: options.supplementalEvidence ?? [],
    }),
  );
}

test("available balance 100 produces an exact 90 capacity after the 10% reserve", () => {
  const result = evaluate(accountWithAvailableBalance("100"));
  assert.equal(result.capacity.availableBalance.state, "known");
  assert.equal(result.capacity.reserve.state, "known");
  assert.equal(result.capacity.incrementalCapacity.state, "known");
  if (
    result.capacity.availableBalance.state !== "known" ||
    result.capacity.reserve.state !== "known" ||
    result.capacity.incrementalCapacity.state !== "known"
  )
    return;
  assert.equal(result.capacity.availableBalance.value.toString(), "100");
  assert.equal(result.capacity.reserve.value.toString(), "10");
  assert.equal(result.capacity.incrementalCapacity.value.toString(), "90");
});

test("capacity comparison is inclusive at exact planned notional", () => {
  const baseline = evaluate(accountWithAvailableBalance("100"));
  assert.equal(baseline.capacity.requestedIncrementalNotional.state, "known");
  if (baseline.capacity.requestedIncrementalNotional.state !== "known") return;
  const requested = baseline.capacity.requestedIncrementalNotional.value;
  const cent = requireDailyFixture(DecimalValue.fromString("0.01"));
  const lower = requested.subtract(cent);
  const higher = requested.add(cent);

  const atLimit = evaluate(accountWithAvailableBalance(requested.toString()), {
    policy: { marginReserveRatio: "0" },
  });
  assert.equal(atLimit.capacity.status, "pass");
  assert.equal(atLimit.capacity.withinCapacity, true);

  const below = evaluate(accountWithAvailableBalance(lower.toString()), {
    policy: { marginReserveRatio: "0" },
  });
  assert.equal(below.capacity.status, "block");
  assert.ok(below.reasonCodes.includes("CAPACITY_EXCEEDED"));

  const above = evaluate(accountWithAvailableBalance(higher.toString()), {
    policy: { marginReserveRatio: "0" },
  });
  assert.equal(above.capacity.status, "pass");
});

test("zero and negative available balance yield zero capacity without hidden capital", () => {
  for (const available of ["0", "-10"]) {
    const result = evaluate(accountWithAvailableBalance(available));
    assert.equal(result.capacity.reserve.state, "known");
    assert.equal(result.capacity.incrementalCapacity.state, "known");
    if (
      result.capacity.reserve.state !== "known" ||
      result.capacity.incrementalCapacity.state !== "known"
    )
      return;
    assert.equal(result.capacity.reserve.value.toString(), "0");
    assert.equal(result.capacity.incrementalCapacity.value.toString(), "0");
    assert.ok(result.reasonCodes.includes("CAPACITY_EXCEEDED"));
  }
});

test("missing pass-B available balance blocks ADD instead of borrowing equity", () => {
  const source = accountFixture();
  const account = withCounts({
    ...source,
    criticalPasses: {
      A: {
        ...source.criticalPasses.A!,
        totals: {
          ...source.criticalPasses.A!.totals,
          totalAvailableBalance: {
            state: "unavailable" as const,
            reason: "not-returned" as const,
            unit: "USD" as const,
          },
        },
      },
      B: {
        ...source.criticalPasses.B!,
        totals: {
          ...source.criticalPasses.B!.totals,
          totalAvailableBalance: {
            state: "unavailable" as const,
            reason: "not-returned" as const,
            unit: "USD" as const,
          },
        },
      },
    },
  });
  const result = evaluate(account);
  assert.equal(result.capacity.status, "block");
  assert.ok(result.reasonCodes.includes("AVAILABLE_BALANCE_UNKNOWN"));
  assert.equal(result.capacity.incrementalCapacity.state, "unavailable");
});

test("existing position IM and spot equity do not get subtracted or added twice", () => {
  const position = portfolioRiskPosition({
    side: "Buy",
    size: accountDecimal("1", "contracts"),
    markPrice: accountDecimal("100", "price"),
    positionValue: accountDecimal("100", "USD"),
    positionIM: accountDecimal("75", "USD"),
  });
  const result = evaluate(
    portfolioRiskAccountInput({
      positions: [position],
      orders: [
        portfolioRiskOrder({
          side: "Sell",
          reduceOnly: known(true),
        }),
      ],
      assets: [
        portfolioRiskWalletAsset("BTC", {
          balance: "1",
          usdValue: "100",
          collateralEligible: false,
        }),
      ],
      collateral: [
        portfolioRiskCollateral("BTC", { collateralEligible: false }),
      ],
    }),
  );
  assert.equal(result.capacity.incrementalCapacity.state, "known");
  if (result.capacity.incrementalCapacity.state === "known")
    assert.equal(result.capacity.incrementalCapacity.value.toString(), "90");
  assert.equal(result.leverage.status, "pass");
  assert.equal(
    result.projection.addProjection.currentDerivativesGrossUsd.state,
    "known",
  );
  if (
    result.projection.addProjection.currentDerivativesGrossUsd.state === "known"
  )
    assert.equal(
      result.projection.addProjection.currentDerivativesGrossUsd.value.toString(),
      "100",
    );
  assert.equal(
    result.projection.addProjection.spotInventoryGrossUsd.state,
    "known",
  );
  if (result.projection.addProjection.spotInventoryGrossUsd.state === "known")
    assert.equal(
      result.projection.addProjection.spotInventoryGrossUsd.value.toString(),
      "100",
    );
});

test("unknown target or above-policy relevant leverage blocks ADD", () => {
  const above = portfolioRiskPosition({
    side: "Buy",
    size: accountDecimal("1", "contracts"),
    positionValue: accountDecimal("100", "USD"),
    leverage: accountDecimal("2", "rate"),
  });
  const excessive = evaluate(accountWithPositions([above]));
  assert.ok(excessive.reasonCodes.includes("LEVERAGE_EXCEEDS_POLICY"));

  const otherSymbol = portfolioRiskPosition({
    symbol: "ETHUSDT",
    side: "Buy",
    size: accountDecimal("1", "contracts"),
    positionValue: accountDecimal("100", "USD"),
    leverage: accountDecimal("2", "rate"),
  });
  const otherExcessive = evaluate(accountWithPositions([otherSymbol]));
  assert.ok(otherExcessive.reasonCodes.includes("LEVERAGE_EXCEEDS_POLICY"));

  const missing = evaluate(accountFixture());
  assert.ok(missing.reasonCodes.includes("LEVERAGE_UNKNOWN"));
});

test("an exchange reduce-only target position blocks ADD", () => {
  const restricted = portfolioRiskPosition({
    side: "Buy",
    size: accountDecimal("1", "contracts"),
    positionValue: accountDecimal("100", "USD"),
    isReduceOnly: known(true),
  });
  const result = evaluate(accountWithPositions([restricted], "1000"));
  assert.equal(result.outcome, "block");
  assert.ok(result.reasonCodes.includes("ACCOUNT_RESTRICTION_ACTIVE"));
});

test("compatible supplemental evidence supplies only a missing flat target leverage", () => {
  const rawAccount = accountFixture();
  const account = createAccountEvidenceBundle(rawAccount);
  assert.equal(account.ok, true);
  if (!account.ok) return;
  const accountHash = accountEvidenceContentHash(account.value);
  assert.equal(accountHash.ok, true);
  if (!accountHash.ok) return;
  const evidence = requireDailyFixture(
    createPortfolioRiskEvidence({
      schemaVersion: "portfolio-risk-evidence/v1",
      kind: "target-leverage",
      environment: account.value.accountBinding.environment,
      accountIdentityHash: account.value.accountBinding.accountIdentityHash,
      accountEvidenceHash: accountHash.value,
      symbol: "BTCUSDT",
      observedAt: evaluationTime,
      rows: [
        {
          positionIdx: 0,
          side: "None",
          size: "0",
          leverage: "1",
          isReduceOnly: false,
        },
      ],
    }),
  );
  const result = evaluate(rawAccount, { supplementalEvidence: [evidence] });
  assert.equal(result.leverage.status, "pass");
  assert.ok(
    result.leverage.checks.some((row) => row.source === "supplemental"),
  );
  assert.ok(!result.reasonCodes.includes("LEVERAGE_UNKNOWN"));

  const { contentHash: _contentHash, ...payload } = evidence;
  void _contentHash;
  const earlier = requireDailyFixture(
    createPortfolioRiskEvidence({
      ...payload,
      observedAt: "2026-10-02T12:00:01.000Z",
    }),
  );
  const temporalConflict = evaluate(rawAccount, {
    supplementalEvidence: [earlier],
  });
  assert.equal(temporalConflict.outcome, "block");
  assert.ok(
    temporalConflict.reasonCodes.includes("SUPPLEMENTAL_EVIDENCE_CONFLICT"),
  );
  assert.ok(
    !temporalConflict.reasonCodes.includes("SUPPLEMENTAL_EVIDENCE_STALE"),
  );

  const knownTarget = accountWithPositions([portfolioRiskPosition()]);
  const knownBundle = createAccountEvidenceBundle(knownTarget);
  assert.equal(knownBundle.ok, true);
  if (!knownBundle.ok) return;
  const knownHash = accountEvidenceContentHash(knownBundle.value);
  assert.equal(knownHash.ok, true);
  if (!knownHash.ok) return;
  const override = requireDailyFixture(
    createPortfolioRiskEvidence({
      schemaVersion: "portfolio-risk-evidence/v1",
      kind: "target-leverage",
      environment: knownBundle.value.accountBinding.environment,
      accountIdentityHash: knownBundle.value.accountBinding.accountIdentityHash,
      accountEvidenceHash: knownHash.value,
      symbol: "BTCUSDT",
      observedAt: evaluationTime,
      rows: [
        {
          positionIdx: 0,
          side: "None",
          size: "0",
          leverage: "2",
          isReduceOnly: false,
        },
      ],
    }),
  );
  const overridden = evaluate(knownTarget, {
    supplementalEvidence: [override],
  });
  assert.ok(overridden.reasonCodes.includes("SUPPLEMENTAL_EVIDENCE_CONFLICT"));
});

test("supplemental reduce-only target state blocks ADD", () => {
  const rawAccount = accountFixture();
  const account = createAccountEvidenceBundle(rawAccount);
  assert.equal(account.ok, true);
  if (!account.ok) return;
  const accountHash = accountEvidenceContentHash(account.value);
  assert.equal(accountHash.ok, true);
  if (!accountHash.ok) return;
  const evidence = requireDailyFixture(
    createPortfolioRiskEvidence({
      schemaVersion: "portfolio-risk-evidence/v1",
      kind: "target-leverage",
      environment: account.value.accountBinding.environment,
      accountIdentityHash: account.value.accountBinding.accountIdentityHash,
      accountEvidenceHash: accountHash.value,
      symbol: "BTCUSDT",
      observedAt: evaluationTime,
      rows: [
        {
          positionIdx: 0,
          side: "None",
          size: "0",
          leverage: "1",
          isReduceOnly: true,
        },
      ],
    }),
  );
  const result = evaluate(rawAccount, { supplementalEvidence: [evidence] });
  assert.equal(result.outcome, "block");
  assert.ok(result.reasonCodes.includes("ACCOUNT_RESTRICTION_ACTIVE"));
});

test("HOLD and REDUCE do not require capacity or leverage evidence", () => {
  const source = accountFixture();
  const unavailableBalance = withCounts({
    ...source,
    criticalPasses: {
      A: {
        ...source.criticalPasses.A!,
        totals: {
          ...source.criticalPasses.A!.totals,
          totalAvailableBalance: {
            state: "unavailable" as const,
            reason: "not-returned" as const,
            unit: "USD" as const,
          },
        },
      },
      B: {
        ...source.criticalPasses.B!,
        totals: {
          ...source.criticalPasses.B!.totals,
          totalAvailableBalance: {
            state: "unavailable" as const,
            reason: "not-returned" as const,
            unit: "USD" as const,
          },
        },
      },
    },
  });
  for (const recommendation of ["HOLD_LONG", "REDUCE_LONG"] as const) {
    const result = evaluate(unavailableBalance, { recommendation });
    assert.equal(result.outcome, "not-evaluated");
    assert.equal(result.capacity.status, "not-evaluated");
    assert.equal(result.leverage.status, "not-evaluated");
    assert.ok(!result.reasonCodes.includes("AVAILABLE_BALANCE_UNKNOWN"));
    assert.ok(!result.reasonCodes.includes("LEVERAGE_UNKNOWN"));
  }
});
