import assert from "node:assert/strict";
import test from "node:test";

import {
  createPortfolioRiskPolicy,
  portfolioRiskPolicyHash,
} from "../src/domain/risk/portfolio-risk-policy.js";
import {
  createPortfolioRiskBlockReasonCodes,
  createPortfolioRiskNoOpReasonCodes,
  PORTFOLIO_RISK_BLOCK_REASON_CODES,
  PORTFOLIO_RISK_NO_OP_REASON_CODES,
} from "../src/domain/risk/portfolio-risk-diagnostics.js";
import { portfolioRiskPolicyInput } from "./fixtures/portfolio-risk-fixtures.js";

test("risk policy is explicit, immutable, and canonically round-trips", () => {
  const policy = createPortfolioRiskPolicy(portfolioRiskPolicyInput());
  assert.equal(policy.ok, true);
  if (!policy.ok) return;

  assert.equal(policy.value.maxAccountEvidenceAgeMs, 60_000);
  assert.equal(policy.value.marginReserveRatio.toString(), "0.1");
  assert.equal(policy.value.maxDerivativesLeverage.toString(), "1");
  assert.equal(policy.value.entryFeeRate.toString(), "0.0002");
  assert.equal(policy.value.exitFeeRate.toString(), "0.00055");
  assert.equal(policy.value.slippageBufferRate.toString(), "0.0005");
  assert.equal(policy.value.minimumNetEdgeRate.toString(), "0.001");
  assert.ok(Object.isFrozen(policy.value));

  const hash = portfolioRiskPolicyHash(policy.value);
  assert.equal(hash.ok, true);
  assert.deepEqual(
    createPortfolioRiskPolicy(JSON.parse(JSON.stringify(policy.value))),
    policy,
  );
});

test("every valid policy field change changes the canonical identity", () => {
  const original = createPortfolioRiskPolicy(portfolioRiskPolicyInput());
  assert.equal(original.ok, true);
  if (!original.ok) return;

  const originalHash = portfolioRiskPolicyHash(original.value);
  assert.equal(originalHash.ok, true);
  if (!originalHash.ok) return;

  const changes = [
    { policyVersion: "m1-v2" },
    { maxAccountEvidenceAgeMs: 59_999 },
    { marginReserveRatio: "0.09" },
    { maxDerivativesLeverage: "0.9" },
    { entryFeeRate: "0.00021" },
    { exitFeeRate: "0.00056" },
    { slippageBufferRate: "0.00051" },
    { minimumNetEdgeRate: "0.0011" },
  ];
  for (const change of changes) {
    const changed = createPortfolioRiskPolicy(portfolioRiskPolicyInput(change));
    assert.equal(changed.ok, true);
    if (!changed.ok) continue;
    const changedHash = portfolioRiskPolicyHash(changed.value);
    assert.equal(changedHash.ok, true);
    if (changedHash.ok) assert.notEqual(changedHash.value, originalHash.value);
  }
});

test("policy rejects unknown fields, malformed decimals, and invalid bounds", () => {
  for (const input of [
    portfolioRiskPolicyInput({ unexpected: true }),
    portfolioRiskPolicyInput({ entryFeeRate: "1e-4" }),
    portfolioRiskPolicyInput({ marginReserveRatio: "1" }),
    portfolioRiskPolicyInput({ marginReserveRatio: "-0.1" }),
    portfolioRiskPolicyInput({ maxDerivativesLeverage: "0" }),
    portfolioRiskPolicyInput({ maxAccountEvidenceAgeMs: 0 }),
    portfolioRiskPolicyInput({ maxAccountEvidenceAgeMs: 60_000.5 }),
  ])
    assert.equal(createPortfolioRiskPolicy(input).ok, false);

  const accessorInput = portfolioRiskPolicyInput();
  Object.defineProperty(accessorInput, "policyVersion", {
    get: () => {
      throw new Error("untrusted policy getter was invoked");
    },
  });
  assert.equal(createPortfolioRiskPolicy(accessorInput).ok, false);
});

test("risk block reasons are recognized, sorted, and unique", () => {
  const parsed = createPortfolioRiskBlockReasonCodes([
    "CAPACITY_EXCEEDED",
    "ACCOUNT_EVIDENCE_STALE",
    "CAPACITY_EXCEEDED",
  ]);
  assert.deepEqual(parsed, {
    ok: true,
    value: ["ACCOUNT_EVIDENCE_STALE", "CAPACITY_EXCEEDED"],
  });
  assert.equal(
    createPortfolioRiskBlockReasonCodes(["UNKNOWN_REASON"]).ok,
    false,
  );
});

test("no-op reasons are a separate vocabulary from block reasons", () => {
  assert.deepEqual(PORTFOLIO_RISK_NO_OP_REASON_CODES, [
    "NO_REDUCIBLE_LONG",
    "REDUCTION_QUANTITY_TOO_SMALL",
  ]);
  assert.ok(
    PORTFOLIO_RISK_NO_OP_REASON_CODES.every(
      (code) =>
        !(PORTFOLIO_RISK_BLOCK_REASON_CODES as readonly string[]).includes(
          code,
        ),
    ),
  );
  assert.deepEqual(
    createPortfolioRiskNoOpReasonCodes(["REDUCTION_QUANTITY_TOO_SMALL"]),
    { ok: true, value: ["REDUCTION_QUANTITY_TOO_SMALL"] },
  );
  assert.equal(
    createPortfolioRiskBlockReasonCodes(["REDUCTION_QUANTITY_TOO_SMALL"]).ok,
    false,
  );
});
