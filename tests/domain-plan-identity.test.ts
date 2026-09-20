import assert from "node:assert/strict";
import test from "node:test";

import { createEvidenceRef } from "../src/domain/evidence/evidence-ref.js";
import {
  createExecutionPlan,
  hashPlanCandidate,
} from "../src/domain/planning/execution-plan.js";
import { createStrategyConfig } from "../src/domain/market/strategy-config.js";
import { createInstrumentConstraints } from "../src/domain/market/instrument-constraints.js";
import {
  createMarketSnapshot,
  createAccountSnapshot,
} from "../src/domain/market/snapshots.js";
import { normalizeOrderIntent } from "../src/domain/planning/normalize-order-intent.js";
import { createCapabilityObservation } from "../src/domain/capabilities/capability.js";
import {
  createBlockedRiskDecision,
  evaluateRisk,
} from "../src/domain/risk/risk-decision.js";
import { fixedClock } from "../src/domain/shared/time.js";

const rawEvidence = {
  kind: "capability-probe",
  schemaVersion: "market-snapshot/v1",
  producer: "fixture",
  sourceId: "run-1",
  asOf: "2026-09-19T10:00:00Z",
  validForMs: 60_000,
  contentHash: `sha256:${"e".repeat(64)}`,
};
const rawConstraints = {
  instrument: "DOGEUSDT",
  priceTickSize: "0.0001",
  quantityStep: "1",
  minQuantity: "1",
  minNotional: "5",
};
const demoScope = {
  exchange: "bybit",
  environment: "demo",
  category: "linear",
  positionMode: "one-way" as const,
};

function planFixture(
  comment: string,
  desired = "open",
  decisionId = "risk-1",
  now = "2026-09-19T10:00:01Z",
) {
  const evidence = createEvidenceRef(rawEvidence);
  const constraints = createInstrumentConstraints(rawConstraints);
  const strategy = createStrategyConfig({
    strategyId: "daily-baseline",
    version: "v1",
    cadence: "daily",
    maxOrderNotional: "100",
    requiresProtection: true,
  });
  assert.equal(evidence.ok, true);
  assert.equal(constraints.ok, true);
  assert.equal(strategy.ok, true);
  if (!evidence.ok || !constraints.ok || !strategy.ok)
    throw new Error("fixture");
  const market = createMarketSnapshot({
    snapshotId: "market-1",
    instrument: "DOGEUSDT",
    scope: demoScope,
    asOf: "2026-09-19T10:00:00Z",
    bid: "0.0887",
    ask: "0.0888",
    last: "0.08875",
    constraints: rawConstraints,
    evidence: [rawEvidence],
  });
  const account = createAccountSnapshot({
    snapshotId: "account-1",
    accountScope: "demo:1c58c10f6d80",
    scope: demoScope,
    asOf: "2026-09-19T10:00:00Z",
    availableBalance: "1000",
    positions: [],
    ownedOrders: [],
    evidence: [rawEvidence],
  });
  assert.equal(market.ok, true);
  assert.equal(account.ok, true);
  if (!market.ok || !account.ok) throw new Error("fixture");
  const intent = normalizeOrderIntent(
    {
      intentId: "intent-1",
      instrument: "DOGEUSDT",
      orderType: "limit",
      side: "buy",
      positionEffect: "open",
      price: "0.08876",
      quantity: "57",
      rounding: { price: "floor", quantity: "floor" },
      protection: { stopLoss: "0.08", takeProfit: "0.1" },
    },
    constraints.value,
  );
  const capability = createCapabilityObservation({
    capability: "attached-protection",
    status: "supported",
    observedAt: "2026-09-19T10:00:00Z",
    source: "fixture",
    evidence: rawEvidence,
    scope: demoScope,
  });
  const orderCreateCapability = createCapabilityObservation({
    capability: "order-create",
    status: "supported",
    observedAt: "2026-09-19T10:00:00Z",
    source: "fixture",
    evidence: rawEvidence,
    scope: demoScope,
  });
  const clock = fixedClock(now);
  assert.equal(intent.ok, true);
  assert.equal(capability.ok, true);
  assert.equal(orderCreateCapability.ok, true);
  assert.equal(clock.ok, true);
  if (!intent.ok || !capability.ok || !orderCreateCapability.ok || !clock.ok)
    throw new Error("fixture");
  const candidate = {
    strategy: strategy.value,
    marketSnapshot: market.value,
    accountSnapshot: account.value,
    evidence: [evidence.value],
    desiredCurrentDiff: { desired, current: null },
    orderIntents: [intent.value],
    requiredCapabilities: [
      { capability: "attached-protection", scope: demoScope },
      { capability: "order-create", scope: demoScope },
    ],
    executionScope: demoScope,
  };
  const candidateHash = hashPlanCandidate(candidate);
  assert.equal(candidateHash.ok, true);
  if (!candidateHash.ok) throw new Error("fixture");
  const risk = evaluateRisk({
    decisionId,
    candidate,
    capabilities: [capability.value, orderCreateCapability.value],
    clock: clock.value,
  });
  assert.equal(risk.ok, true);
  if (!risk.ok) throw new Error("fixture");
  assert.equal(risk.value.inputHash, candidateHash.value);
  const plan = createExecutionPlan({
    identityVersion: "execution-plan/v1",
    material: {
      ...candidate,
      riskDecision: risk.value,
    },
    presentation: {
      generatedAt: "2026-09-19T10:00:01Z",
      comment,
    },
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) throw new Error("fixture");
  return plan.value;
}

test("presentation metadata does not change material plan identity", () => {
  const first = planFixture("first report");
  const second = planFixture("operator note changed");
  assert.equal(first.materialHash, second.materialHash);
  assert.equal(first.planId, second.planId);
});

test("risk audit identity does not perturb equivalent material plan identity", () => {
  const first = planFixture("same", "open", "risk-1", "2026-09-19T10:00:01Z");
  const second = planFixture("same", "open", "risk-2", "2026-09-19T10:00:02Z");
  assert.equal(second.materialHash, first.materialHash);
  assert.equal(second.planId, first.planId);
});

test("material input changes produce a different immutable plan identity", () => {
  const first = planFixture("same");
  const changed = planFixture("same", "close");
  assert.notEqual(changed.materialHash, first.materialHash);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.material), true);
  assert.equal(Object.isFrozen(first.material.riskDecision), true);
  assert.equal(
    Object.isFrozen(first.material.riskDecision.requiredCapabilities),
    true,
  );
});

test("execution plans reject a risk decision bound to another candidate", () => {
  const first = planFixture("same");
  const clock = fixedClock("2026-09-19T10:00:01Z");
  assert.equal(clock.ok, true);
  if (!clock.ok) return;
  const blocked = createBlockedRiskDecision(
    "risk-blocked",
    first.material.orderIntents[0]?.intentId ?? "intent-1",
    `sha256:${"0".repeat(64)}`,
    "CAPABILITY_UNKNOWN",
    clock.value,
  );
  assert.equal(blocked.ok, true);
  if (!blocked.ok) return;
  const result = createExecutionPlan({
    identityVersion: first.identityVersion,
    material: { ...first.material, riskDecision: blocked.value },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "PLAN_HASH_MISMATCH");
});

test("execution plans reject a hand-built passing risk decision", () => {
  const first = planFixture("forged-risk");
  const candidate = {
    strategy: first.material.strategy,
    marketSnapshot: first.material.marketSnapshot,
    accountSnapshot: first.material.accountSnapshot,
    evidence: first.material.evidence,
    desiredCurrentDiff: first.material.desiredCurrentDiff,
    orderIntents: first.material.orderIntents,
    requiredCapabilities: first.material.requiredCapabilities,
    executionScope: first.material.executionScope,
  };
  const forged = {
    ...first.material.riskDecision,
    status: "pass" as const,
    reasonCodes: [],
  };
  const result = createExecutionPlan({
    identityVersion: first.identityVersion,
    material: { ...candidate, riskDecision: forged },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "INVALID_PLAN");
});

test("execution plans reject accessor material before evaluating identity", () => {
  const first = planFixture("accessor");
  const material = { ...first.material };
  Object.defineProperty(material, "orderIntents", {
    enumerable: true,
    get: () => first.material.orderIntents,
  });
  const result = createExecutionPlan({
    identityVersion: first.identityVersion,
    material: material as never,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "INVALID_PLAN");
});
