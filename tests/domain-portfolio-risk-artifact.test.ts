import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeCanonicalArtifact,
  rehydrateArtifact,
} from "../src/domain/identity/canonical-artifact.js";
import { hashCanonical } from "../src/domain/identity/canonical-serialization.js";
import { evaluatePortfolioRiskPreflight } from "../src/domain/risk/portfolio-risk-preflight.js";
import { requireDailyFixture } from "./fixtures/daily-planning-evidence-fixtures.js";
import { fixture as accountFixture } from "./account-evidence-fixture.js";
import { portfolioRiskPolicyInput } from "./fixtures/portfolio-risk-fixtures.js";
import { portfolioRiskPlanningFixture } from "./fixtures/portfolio-risk-planning-fixtures.js";

const ACCOUNT_TIME_SHIFT_MS =
  Date.parse("2026-09-24T14:00:00.000Z") -
  Date.parse("2026-10-02T12:00:00.000Z");

function shiftAccountTimes<T>(value: T): T {
  if (typeof value === "string" && /^\d{4}-\d\d-\d\dT.*Z$/.test(value))
    return new Date(
      Date.parse(value) + ACCOUNT_TIME_SHIFT_MS,
    ).toISOString() as T;
  if (Array.isArray(value))
    return value.map((entry) => shiftAccountTimes(entry)) as T;
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        shiftAccountTimes(child),
      ]),
    ) as T;
  return value;
}

test("portfolio risk preflight round-trips through the canonical artifact registry", () => {
  const fixtures = portfolioRiskPlanningFixture({
    recommendation: "HOLD_LONG",
  });
  const preflight = requireDailyFixture(
    evaluatePortfolioRiskPreflight({
      dailyPlan: fixtures.dailyPlan,
      account: shiftAccountTimes(accountFixture()),
      policy: portfolioRiskPolicyInput(),
      qualityProfile: fixtures.qualityProfile,
      evaluationTime: "2026-09-24T14:00:02.000Z",
    }),
  );
  const envelope = requireDailyFixture(
    encodeCanonicalArtifact("portfolio-risk-preflight", preflight),
  );
  const restored = requireDailyFixture(
    rehydrateArtifact("portfolio-risk-preflight", envelope),
  );
  assert.equal(restored.contentHash, preflight.contentHash);
  assert.equal(restored.preflightId, preflight.preflightId);
  assert.deepEqual(restored.actionProposal, { kind: "hold-no-action" });
});

test("registry refuses a rehashed but semantically altered preflight", () => {
  const fixtures = portfolioRiskPlanningFixture({
    recommendation: "HOLD_LONG",
  });
  const preflight = requireDailyFixture(
    evaluatePortfolioRiskPreflight({
      dailyPlan: fixtures.dailyPlan,
      account: shiftAccountTimes(accountFixture()),
      policy: portfolioRiskPolicyInput(),
      qualityProfile: fixtures.qualityProfile,
      evaluationTime: "2026-09-24T14:00:02.000Z",
    }),
  );
  const { contentHash: _contentHash, ...payload } = preflight;
  void _contentHash;
  const modified = { ...payload, verdict: "BLOCK" };
  const contentHash = requireDailyFixture(hashCanonical(modified));
  assert.equal(
    encodeCanonicalArtifact("portfolio-risk-preflight", {
      ...modified,
      contentHash,
    }).ok,
    false,
  );
});
