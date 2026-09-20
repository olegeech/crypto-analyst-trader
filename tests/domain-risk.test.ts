import assert from "node:assert/strict";
import test from "node:test";

import { createCapabilityObservation } from "../src/domain/capabilities/capability.js";
import { createEvidenceRef } from "../src/domain/evidence/evidence-ref.js";
import { createInstrumentConstraints } from "../src/domain/market/instrument-constraints.js";
import { createStrategyConfig } from "../src/domain/market/strategy-config.js";
import {
  createAccountSnapshot,
  createMarketSnapshot,
} from "../src/domain/market/snapshots.js";
import { normalizeOrderIntent } from "../src/domain/planning/normalize-order-intent.js";
import { createOrderIntent } from "../src/domain/planning/order-intent.js";
import { evaluateRisk } from "../src/domain/risk/risk-decision.js";
import { parseDecimal } from "../src/domain/shared/decimal.js";
import { fixedClock } from "../src/domain/shared/time.js";
import type { CapabilityRequirement } from "../src/domain/capabilities/capability.js";
import type { EvidenceRef } from "../src/domain/evidence/evidence-ref.js";
import type { StrategyConfig } from "../src/domain/market/strategy-config.js";
import type { PlanCandidate } from "../src/domain/planning/execution-plan.js";
import type { OrderIntent } from "../src/domain/planning/order-intent.js";

const rawEvidence = {
  kind: "capability-probe",
  schemaVersion: "risk-input/v1",
  producer: "fixture",
  sourceId: "run-1",
  asOf: "2026-09-19T10:00:00Z",
  validForMs: 60_000,
  contentHash: `sha256:${"d".repeat(64)}`,
};
const rawConstraints = {
  instrument: "DOGEUSDT",
  priceTickSize: "0.0001",
  quantityStep: "1",
  minQuantity: "1",
  minNotional: "5",
};
const constraints = createInstrumentConstraints(rawConstraints);
const evidence = createEvidenceRef(rawEvidence);
const strategy = createStrategyConfig({
  strategyId: "daily-risk",
  version: "v1",
  cadence: "daily",
  maxOrderNotional: "100",
  requiresProtection: false,
});
const demoScope = {
  exchange: "bybit",
  environment: "demo",
  category: "linear",
  positionMode: "one-way" as const,
};
const protectionRequirement = {
  capability: "attached-protection",
  scope: demoScope,
};
const orderCreateRequirement = {
  capability: "order-create",
  scope: demoScope,
};
const marketSnapshot = createMarketSnapshot({
  snapshotId: "market-risk-1",
  instrument: "DOGEUSDT",
  scope: demoScope,
  asOf: "2026-09-19T10:00:00Z",
  bid: "0.0887",
  ask: "0.0888",
  last: "0.08875",
  constraints: rawConstraints,
  evidence: [rawEvidence],
});
const accountSnapshot = createAccountSnapshot({
  snapshotId: "account-risk-1",
  accountScope: "demo:fixture",
  scope: demoScope,
  asOf: "2026-09-19T10:00:00Z",
  availableBalance: "1000",
  positions: [],
  ownedOrders: [],
  evidence: [rawEvidence],
});

function candidateFixture(
  intent: OrderIntent,
  candidateEvidence: readonly EvidenceRef[],
  candidateStrategy: StrategyConfig,
  requiredCapabilities: readonly CapabilityRequirement[] = [],
): PlanCandidate {
  assert.equal(marketSnapshot.ok, true);
  assert.equal(accountSnapshot.ok, true);
  if (!marketSnapshot.ok || !accountSnapshot.ok) {
    throw new Error("candidate fixture");
  }
  return {
    strategy: candidateStrategy,
    marketSnapshot: marketSnapshot.value,
    accountSnapshot: accountSnapshot.value,
    evidence: candidateEvidence,
    desiredCurrentDiff: {},
    orderIntents: [intent],
    requiredCapabilities,
    executionScope: demoScope,
  };
}

test("risk passes only with fresh evidence and supported required capabilities", () => {
  assert.equal(constraints.ok, true);
  assert.equal(evidence.ok, true);
  assert.equal(strategy.ok, true);
  assert.equal(accountSnapshot.ok, true);
  if (!constraints.ok || !evidence.ok || !strategy.ok || !accountSnapshot.ok)
    return;
  const intent = normalizeOrderIntent(
    {
      intentId: "intent-risk-1",
      instrument: "DOGEUSDT",
      orderType: "limit",
      side: "buy",
      positionEffect: "open",
      price: "0.0887",
      quantity: "57",
      rounding: { price: "floor", quantity: "floor" },
    },
    constraints.value,
  );
  const capability = createCapabilityObservation({
    capability: "attached-protection",
    status: "supported",
    observedAt: "2026-09-19T10:00:00Z",
    source: "fixture",
    evidence: evidence.value,
    scope: demoScope,
  });
  const orderCreateCapability = createCapabilityObservation({
    capability: "order-create",
    status: "supported",
    observedAt: "2026-09-19T10:00:00Z",
    source: "fixture",
    evidence: evidence.value,
    scope: demoScope,
  });
  const clock = fixedClock("2026-09-19T10:00:01Z");
  assert.equal(intent.ok, true);
  assert.equal(capability.ok, true);
  assert.equal(orderCreateCapability.ok, true);
  assert.equal(clock.ok, true);
  if (!intent.ok || !capability.ok || !orderCreateCapability.ok || !clock.ok)
    return;
  const decision = evaluateRisk({
    decisionId: "risk-1",
    candidate: candidateFixture(
      intent.value,
      [evidence.value],
      strategy.value,
      [protectionRequirement, orderCreateRequirement],
    ),
    capabilities: [capability.value, orderCreateCapability.value],
    clock: clock.value,
  });
  assert.equal(decision.ok, true);
  if (decision.ok) assert.equal(decision.value.status, "pass");
});

test("risk rejects a capability requirement outside the declared execution scope", () => {
  assert.equal(constraints.ok, true);
  assert.equal(evidence.ok, true);
  assert.equal(strategy.ok, true);
  if (!constraints.ok || !evidence.ok || !strategy.ok) return;
  const intent = normalizeOrderIntent(
    {
      intentId: "intent-scope-mismatch",
      instrument: "DOGEUSDT",
      orderType: "limit",
      side: "buy",
      positionEffect: "open",
      price: "0.0887",
      quantity: "57",
      rounding: { price: "floor", quantity: "floor" },
    },
    constraints.value,
  );
  const capability = createCapabilityObservation({
    capability: "attached-protection",
    status: "supported",
    observedAt: "2026-09-19T10:00:00Z",
    source: "fixture",
    evidence: evidence.value,
    scope: demoScope,
  });
  const clock = fixedClock("2026-09-19T10:00:01Z");
  assert.equal(intent.ok, true);
  assert.equal(capability.ok, true);
  assert.equal(clock.ok, true);
  if (!intent.ok || !capability.ok || !clock.ok) return;
  const candidate = candidateFixture(
    intent.value,
    [evidence.value],
    strategy.value,
    [protectionRequirement],
  );
  const decision = evaluateRisk({
    decisionId: "risk-scope-mismatch",
    candidate: {
      ...candidate,
      executionScope: { ...demoScope, environment: "testnet" },
    },
    capabilities: [capability.value],
    clock: clock.value,
  });
  assert.equal(decision.ok, true);
  if (decision.ok) {
    assert.equal(decision.value.status, "blocked");
    assert.deepEqual(decision.value.reasonCodes, [
      "CAPABILITY_UNKNOWN",
      "INCOMPATIBLE_EVIDENCE",
    ]);
  }
});

test("risk rejects a forged capability observation backed by snapshot evidence", () => {
  assert.equal(constraints.ok, true);
  assert.equal(evidence.ok, true);
  assert.equal(strategy.ok, true);
  if (!constraints.ok || !evidence.ok || !strategy.ok) return;
  const intent = normalizeOrderIntent(
    {
      intentId: "intent-forged-capability",
      instrument: "DOGEUSDT",
      orderType: "limit",
      side: "buy",
      positionEffect: "open",
      price: "0.0887",
      quantity: "57",
      rounding: { price: "floor", quantity: "floor" },
    },
    constraints.value,
  );
  const clock = fixedClock("2026-09-19T10:00:01Z");
  assert.equal(intent.ok, true);
  assert.equal(clock.ok, true);
  if (!intent.ok || !clock.ok) return;
  const candidate = candidateFixture(
    intent.value,
    [evidence.value],
    strategy.value,
    [{ capability: "order-create", scope: demoScope }],
  );
  const forgedObservation = {
    capability: "order-create",
    status: "supported",
    observedAt: "2026-09-19T10:00:00Z",
    source: "forged",
    evidence: candidate.marketSnapshot.evidence[0],
    scope: demoScope,
  } as never;
  const decision = evaluateRisk({
    decisionId: "risk-forged-capability",
    candidate,
    capabilities: [forgedObservation],
    clock: clock.value,
  });
  assert.equal(decision.ok, true);
  if (decision.ok) {
    assert.equal(decision.value.status, "blocked");
    assert.ok(decision.value.reasonCodes.includes("CAPABILITY_UNKNOWN"));
  }
});

test("stale evidence and unknown capabilities produce blocked typed decisions", () => {
  assert.equal(constraints.ok, true);
  assert.equal(evidence.ok, true);
  assert.equal(strategy.ok, true);
  if (!constraints.ok || !evidence.ok || !strategy.ok) return;
  const intent = normalizeOrderIntent(
    {
      intentId: "intent-risk-2",
      instrument: "DOGEUSDT",
      orderType: "limit",
      side: "buy",
      positionEffect: "open",
      price: "0.0887",
      quantity: "57",
      rounding: { price: "floor", quantity: "floor" },
    },
    constraints.value,
  );
  const capability = createCapabilityObservation({
    capability: "attached-protection",
    status: "unknown",
    observedAt: "2026-09-19T10:00:00Z",
    source: "fixture",
    evidence: evidence.value,
    scope: demoScope,
  });
  const clock = fixedClock("2026-09-19T10:01:00Z");
  assert.equal(intent.ok, true);
  assert.equal(capability.ok, true);
  assert.equal(clock.ok, true);
  if (!intent.ok || !capability.ok || !clock.ok) return;
  const decision = evaluateRisk({
    decisionId: "risk-2",
    candidate: candidateFixture(
      intent.value,
      [evidence.value],
      strategy.value,
      [protectionRequirement],
    ),
    capabilities: [capability.value],
    clock: clock.value,
  });
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  assert.equal(decision.value.status, "blocked");
  assert.deepEqual(decision.value.reasonCodes, [
    "CAPABILITY_UNKNOWN",
    "STALE_EVIDENCE",
  ]);
});

test("stale capability evidence and contradictory observations fail closed", () => {
  assert.equal(constraints.ok, true);
  assert.equal(evidence.ok, true);
  assert.equal(strategy.ok, true);
  if (!constraints.ok || !evidence.ok || !strategy.ok) return;
  const freshEvidence = createEvidenceRef({
    ...evidence.value,
    sourceId: "fresh-run",
    asOf: "2026-09-19T10:00:00Z",
  });
  const staleEvidence = createEvidenceRef({
    ...evidence.value,
    sourceId: "stale-run",
    asOf: "2026-09-19T09:00:00Z",
    validForMs: 1_000,
  });
  assert.equal(freshEvidence.ok, true);
  assert.equal(staleEvidence.ok, true);
  if (!freshEvidence.ok || !staleEvidence.ok) return;
  const intent = normalizeOrderIntent(
    {
      intentId: "intent-risk-3",
      instrument: "DOGEUSDT",
      orderType: "limit",
      side: "buy",
      positionEffect: "open",
      price: "0.0887",
      quantity: "57",
      rounding: { price: "floor", quantity: "floor" },
    },
    constraints.value,
  );
  const staleSupported = createCapabilityObservation({
    capability: "attached-protection",
    status: "supported",
    observedAt: "2026-09-19T09:00:00Z",
    source: "fixture",
    evidence: staleEvidence.value,
    scope: demoScope,
  });
  const freshUnsupported = createCapabilityObservation({
    capability: "attached-protection",
    status: "unsupported",
    observedAt: "2026-09-19T10:00:00Z",
    source: "fixture",
    evidence: freshEvidence.value,
    scope: demoScope,
  });
  const clock = fixedClock("2026-09-19T10:00:01Z");
  assert.equal(intent.ok, true);
  assert.equal(staleSupported.ok, true);
  assert.equal(freshUnsupported.ok, true);
  assert.equal(clock.ok, true);
  if (!intent.ok || !staleSupported.ok || !freshUnsupported.ok || !clock.ok)
    return;
  const decision = evaluateRisk({
    decisionId: "risk-3",
    candidate: candidateFixture(
      intent.value,
      [freshEvidence.value, staleEvidence.value],
      strategy.value,
      [protectionRequirement],
    ),
    capabilities: [staleSupported.value, freshUnsupported.value],
    clock: clock.value,
  });
  assert.equal(decision.ok, true);
  if (decision.ok) {
    assert.equal(decision.value.status, "blocked");
    assert.deepEqual(decision.value.reasonCodes, [
      "CAPABILITY_UNKNOWN",
      "STALE_EVIDENCE",
      "INCOMPATIBLE_EVIDENCE",
      "CAPABILITY_UNSUPPORTED",
    ]);
  }
});

test("risk blocks stale snapshot evidence even when candidate evidence is fresh", () => {
  assert.equal(constraints.ok, true);
  assert.equal(evidence.ok, true);
  assert.equal(strategy.ok, true);
  assert.equal(accountSnapshot.ok, true);
  if (!constraints.ok || !evidence.ok || !strategy.ok || !accountSnapshot.ok)
    return;
  const staleMarket = createMarketSnapshot({
    snapshotId: "market-risk-stale",
    instrument: "DOGEUSDT",
    scope: demoScope,
    asOf: "2026-09-19T09:00:00Z",
    bid: "0.0887",
    ask: "0.0888",
    last: "0.08875",
    constraints: rawConstraints,
    evidence: [
      {
        ...rawEvidence,
        sourceId: "stale-market",
        asOf: "2026-09-19T09:00:00Z",
        validForMs: 1_000,
      },
    ],
  });
  const intent = normalizeOrderIntent(
    {
      intentId: "intent-stale-snapshot",
      instrument: "DOGEUSDT",
      orderType: "limit",
      side: "buy",
      positionEffect: "open",
      price: "0.0887",
      quantity: "57",
      rounding: { price: "floor", quantity: "floor" },
    },
    constraints.value,
  );
  const clock = fixedClock("2026-09-19T10:00:01Z");
  assert.equal(staleMarket.ok, true);
  assert.equal(intent.ok, true);
  assert.equal(clock.ok, true);
  if (!staleMarket.ok || !intent.ok || !clock.ok) return;
  const decision = evaluateRisk({
    decisionId: "risk-stale-snapshot",
    candidate: {
      strategy: strategy.value,
      marketSnapshot: staleMarket.value,
      accountSnapshot: accountSnapshot.value,
      evidence: [evidence.value],
      desiredCurrentDiff: {},
      orderIntents: [intent.value],
      requiredCapabilities: [],
      executionScope: demoScope,
    },
    capabilities: [],
    clock: clock.value,
  });
  assert.equal(decision.ok, true);
  if (decision.ok) {
    assert.equal(decision.value.status, "blocked");
    assert.ok(decision.value.reasonCodes.includes("STALE_EVIDENCE"));
    assert.ok(decision.value.reasonCodes.includes("INCOMPATIBLE_EVIDENCE"));
  }
});

test("risk rejects structurally forged snapshots without domain provenance", () => {
  assert.equal(constraints.ok, true);
  assert.equal(evidence.ok, true);
  assert.equal(strategy.ok, true);
  if (!constraints.ok || !evidence.ok || !strategy.ok) return;
  const intent = normalizeOrderIntent(
    {
      intentId: "intent-forged-snapshot",
      instrument: "DOGEUSDT",
      orderType: "limit",
      side: "buy",
      positionEffect: "open",
      price: "0.0887",
      quantity: "57",
      rounding: { price: "floor", quantity: "floor" },
    },
    constraints.value,
  );
  const clock = fixedClock("2026-09-19T10:00:01Z");
  assert.equal(intent.ok, true);
  assert.equal(clock.ok, true);
  if (!intent.ok || !clock.ok) return;
  const candidate = candidateFixture(
    intent.value,
    [evidence.value],
    strategy.value,
  );
  const decision = evaluateRisk({
    decisionId: "risk-forged-snapshot",
    candidate: {
      ...candidate,
      marketSnapshot: {
        ...candidate.marketSnapshot,
        evidence: [],
      },
    },
    capabilities: [],
    clock: clock.value,
  });
  assert.equal(decision.ok, true);
  if (decision.ok) {
    assert.equal(decision.value.status, "blocked");
    assert.ok(decision.value.reasonCodes.includes("INVALID_EVIDENCE"));
  }
});

test("risk blocks an intent whose instrument or constraint version differs", () => {
  assert.equal(constraints.ok, true);
  assert.equal(evidence.ok, true);
  assert.equal(strategy.ok, true);
  if (!constraints.ok || !evidence.ok || !strategy.ok) return;
  const otherConstraints = createInstrumentConstraints({
    instrument: "BTCUSDT",
    priceTickSize: "0.1",
    quantityStep: "0.001",
    minQuantity: "0.001",
    version: "btc-constraints/v1",
  });
  assert.equal(otherConstraints.ok, true);
  if (!otherConstraints.ok) return;
  const intent = normalizeOrderIntent(
    {
      intentId: "intent-wrong-instrument",
      instrument: "BTCUSDT",
      orderType: "limit",
      side: "buy",
      positionEffect: "open",
      price: "100",
      quantity: "0.1",
      rounding: { price: "floor", quantity: "floor" },
    },
    otherConstraints.value,
  );
  const clock = fixedClock("2026-09-19T10:00:01Z");
  assert.equal(intent.ok, true);
  assert.equal(clock.ok, true);
  if (!intent.ok || !clock.ok) return;
  const decision = evaluateRisk({
    decisionId: "risk-wrong-instrument",
    candidate: candidateFixture(intent.value, [evidence.value], strategy.value),
    capabilities: [],
    clock: clock.value,
  });
  assert.equal(decision.ok, true);
  if (decision.ok) {
    assert.equal(decision.value.status, "blocked");
    assert.deepEqual(decision.value.reasonCodes, [
      "CAPABILITY_UNKNOWN",
      "CONSTRAINT_VIOLATION",
      "QUANTITY_TOO_SMALL",
    ]);
  }
});

test("risk blocks when required evidence is missing", () => {
  assert.equal(constraints.ok, true);
  assert.equal(strategy.ok, true);
  if (!constraints.ok || !strategy.ok) return;
  const intent = normalizeOrderIntent(
    {
      intentId: "intent-risk-4",
      instrument: "DOGEUSDT",
      orderType: "limit",
      side: "buy",
      positionEffect: "open",
      price: "0.0887",
      quantity: "57",
      rounding: { price: "floor", quantity: "floor" },
    },
    constraints.value,
  );
  const clock = fixedClock("2026-09-19T10:00:01Z");
  assert.equal(intent.ok, true);
  assert.equal(clock.ok, true);
  if (!intent.ok || !clock.ok) return;
  const decision = evaluateRisk({
    decisionId: "risk-4",
    candidate: candidateFixture(intent.value, [], strategy.value),
    capabilities: [],
    clock: clock.value,
  });
  assert.equal(decision.ok, true);
  if (decision.ok) {
    assert.equal(decision.value.status, "blocked");
    assert.deepEqual(decision.value.reasonCodes, [
      "CAPABILITY_UNKNOWN",
      "INVALID_EVIDENCE",
      "INCOMPATIBLE_EVIDENCE",
    ]);
  }
});

test("strategy protection and notional limits block risky intents", () => {
  assert.equal(constraints.ok, true);
  assert.equal(evidence.ok, true);
  if (!constraints.ok || !evidence.ok) return;
  const strictStrategy = createStrategyConfig({
    strategyId: "strict-risk",
    version: "v1",
    cadence: "daily",
    maxOrderNotional: "1",
    requiresProtection: true,
  });
  const intent = normalizeOrderIntent(
    {
      intentId: "intent-risk-5",
      instrument: "DOGEUSDT",
      orderType: "limit",
      side: "buy",
      positionEffect: "open",
      price: "0.0887",
      quantity: "57",
      rounding: { price: "floor", quantity: "floor" },
    },
    constraints.value,
  );
  const clock = fixedClock("2026-09-19T10:00:01Z");
  assert.equal(strictStrategy.ok, true);
  assert.equal(intent.ok, true);
  assert.equal(clock.ok, true);
  if (!strictStrategy.ok || !intent.ok || !clock.ok) return;
  const decision = evaluateRisk({
    decisionId: "risk-5",
    candidate: candidateFixture(
      intent.value,
      [evidence.value],
      strictStrategy.value,
    ),
    capabilities: [],
    clock: clock.value,
  });
  assert.equal(decision.ok, true);
  if (decision.ok) {
    assert.equal(decision.value.status, "blocked");
    assert.deepEqual(decision.value.reasonCodes, [
      "CAPABILITY_UNKNOWN",
      "PROTECTION_REQUIRED",
      "CONSTRAINT_VIOLATION",
    ]);
  }
});

test("risk rejects wrong-side protection even when protection is optional", () => {
  assert.equal(constraints.ok, true);
  assert.equal(evidence.ok, true);
  assert.equal(strategy.ok, true);
  if (!constraints.ok || !evidence.ok || !strategy.ok) return;
  const intent = normalizeOrderIntent(
    {
      intentId: "intent-optional-wrong-side",
      instrument: "DOGEUSDT",
      orderType: "limit",
      side: "buy",
      positionEffect: "open",
      price: "0.0887",
      quantity: "57",
      rounding: { price: "floor", quantity: "floor" },
      protection: { stopLoss: "0.1" },
    },
    constraints.value,
  );
  const clock = fixedClock("2026-09-19T10:00:01Z");
  assert.equal(intent.ok, true);
  assert.equal(clock.ok, true);
  if (!intent.ok || !clock.ok) return;
  const decision = evaluateRisk({
    decisionId: "risk-optional-wrong-side",
    candidate: candidateFixture(intent.value, [evidence.value], strategy.value),
    capabilities: [],
    clock: clock.value,
  });
  assert.equal(decision.ok, true);
  if (decision.ok) {
    assert.equal(decision.value.status, "blocked");
    assert.deepEqual(decision.value.reasonCodes, [
      "CAPABILITY_UNKNOWN",
      "PROTECTION_REQUIRED",
    ]);
  }
});

test("risk returns a typed block for malformed direct intent fields", () => {
  assert.equal(constraints.ok, true);
  assert.equal(evidence.ok, true);
  assert.equal(strategy.ok, true);
  if (!constraints.ok || !evidence.ok || !strategy.ok) return;
  const normalized = normalizeOrderIntent(
    {
      intentId: "intent-malformed-direct",
      instrument: "DOGEUSDT",
      orderType: "limit",
      side: "buy",
      positionEffect: "open",
      price: "0.0887",
      quantity: "57",
      rounding: { price: "floor", quantity: "floor" },
    },
    constraints.value,
  );
  const clock = fixedClock("2026-09-19T10:00:01Z");
  assert.equal(normalized.ok, true);
  assert.equal(clock.ok, true);
  if (!normalized.ok || !clock.ok) return;
  const offTickValue = parseDecimal("0.08001");
  assert.equal(offTickValue.ok, true);
  if (!offTickValue.ok) return;
  const malformedSide = {
    ...normalized.value,
    side: "BUY",
  } as never;
  const malformedProtection = {
    ...normalized.value,
    protection: { stopLoss: "not-a-decimal" },
  } as never;
  const offTickProtection = {
    ...normalized.value,
    protection: { stopLoss: offTickValue.value },
  } as never;
  for (const [decisionId, intent, expected] of [
    ["risk-malformed-side", malformedSide, "INVALID_PLAN"],
    ["risk-malformed-protection", malformedProtection, "PROTECTION_REQUIRED"],
    ["risk-off-tick-protection", offTickProtection, "CONSTRAINT_VIOLATION"],
  ] as const) {
    const decision = evaluateRisk({
      decisionId,
      candidate: candidateFixture(intent, [evidence.value], strategy.value),
      capabilities: [],
      clock: clock.value,
    });
    assert.equal(decision.ok, true);
    if (decision.ok) assert.ok(decision.value.reasonCodes.includes(expected));
  }
});

test("risk returns a typed block for a null direct intent", () => {
  assert.equal(constraints.ok, true);
  assert.equal(evidence.ok, true);
  assert.equal(strategy.ok, true);
  if (!constraints.ok || !evidence.ok || !strategy.ok) return;
  const valid = normalizeOrderIntent(
    {
      intentId: "intent-null-sibling",
      instrument: "DOGEUSDT",
      orderType: "limit",
      side: "buy",
      positionEffect: "open",
      price: "0.0887",
      quantity: "57",
      rounding: { price: "floor", quantity: "floor" },
    },
    constraints.value,
  );
  const clock = fixedClock("2026-09-19T10:00:01Z");
  assert.equal(valid.ok, true);
  assert.equal(clock.ok, true);
  if (!valid.ok || !clock.ok) return;
  const candidate = candidateFixture(
    valid.value,
    [evidence.value],
    strategy.value,
  );
  const decision = evaluateRisk({
    decisionId: "risk-null-intent",
    candidate: {
      ...candidate,
      orderIntents: [null, valid.value] as never,
    },
    capabilities: [],
    clock: clock.value,
  });
  assert.equal(decision.ok, true);
  if (decision.ok) {
    assert.equal(decision.value.status, "blocked");
    assert.ok(decision.value.reasonCodes.includes("INVALID_PLAN"));
  }
});

test("risk bounds close intents to the current position and side", () => {
  assert.equal(constraints.ok, true);
  assert.equal(evidence.ok, true);
  if (!constraints.ok || !evidence.ok) return;
  const strictStrategy = createStrategyConfig({
    strategyId: "strict-close",
    version: "v1",
    cadence: "daily",
    maxOrderNotional: "100",
    requiresProtection: true,
  });
  const closeIntent = normalizeOrderIntent(
    {
      intentId: "intent-close-position",
      instrument: "DOGEUSDT",
      orderType: "limit",
      side: "sell",
      positionEffect: "close",
      price: "0.0887",
      quantity: "57",
      rounding: { price: "floor", quantity: "floor" },
    },
    constraints.value,
  );
  const clock = fixedClock("2026-09-19T10:00:01Z");
  assert.equal(strictStrategy.ok, true);
  assert.equal(closeIntent.ok, true);
  assert.equal(clock.ok, true);
  if (!strictStrategy.ok || !closeIntent.ok || !clock.ok) return;
  const base = candidateFixture(
    closeIntent.value,
    [evidence.value],
    strictStrategy.value,
  );
  const flatDecision = evaluateRisk({
    decisionId: "risk-close-flat",
    candidate: base,
    capabilities: [],
    clock: clock.value,
  });
  assert.equal(flatDecision.ok, true);
  if (flatDecision.ok) {
    assert.equal(flatDecision.value.status, "blocked");
    assert.ok(flatDecision.value.reasonCodes.includes("CONSTRAINT_VIOLATION"));
  }
  const positioned = createAccountSnapshot({
    snapshotId: "account-close-position",
    accountScope: "demo:fixture",
    scope: demoScope,
    asOf: "2026-09-19T10:00:00Z",
    availableBalance: "1000",
    positions: [{ instrument: "DOGEUSDT", side: "long", quantity: "10" }],
    ownedOrders: [],
    evidence: [rawEvidence],
  });
  assert.equal(positioned.ok, true);
  if (!positioned.ok) return;
  const oversizedDecision = evaluateRisk({
    decisionId: "risk-close-oversized",
    candidate: { ...base, accountSnapshot: positioned.value },
    capabilities: [],
    clock: clock.value,
  });
  assert.equal(oversizedDecision.ok, true);
  if (oversizedDecision.ok) {
    assert.equal(oversizedDecision.value.status, "blocked");
    assert.ok(
      oversizedDecision.value.reasonCodes.includes("CONSTRAINT_VIOLATION"),
    );
  }
});

test("risk blocks empty protection and inconsistent intent notional", () => {
  assert.equal(constraints.ok, true);
  assert.equal(evidence.ok, true);
  assert.equal(strategy.ok, true);
  if (!constraints.ok || !evidence.ok || !strategy.ok) return;
  const normalized = normalizeOrderIntent(
    {
      intentId: "intent-risk-invalid-protection",
      instrument: "DOGEUSDT",
      orderType: "limit",
      side: "buy",
      positionEffect: "open",
      price: "0.0887",
      quantity: "57",
      rounding: { price: "floor", quantity: "floor" },
    },
    constraints.value,
  );
  assert.equal(normalized.ok, true);
  if (!normalized.ok) return;
  const clock = fixedClock("2026-09-19T10:00:01Z");
  assert.equal(clock.ok, true);
  if (!clock.ok) return;

  const emptyProtection = {
    ...normalized.value,
    protection: {},
  };
  const strictStrategy = createStrategyConfig({
    strategyId: "strict-protection",
    version: "v1",
    cadence: "daily",
    maxOrderNotional: "100",
    requiresProtection: true,
  });
  assert.equal(strictStrategy.ok, true);
  if (!strictStrategy.ok) return;
  const protectionDecision = evaluateRisk({
    decisionId: "risk-empty-protection",
    candidate: candidateFixture(
      emptyProtection,
      [evidence.value],
      strictStrategy.value,
    ),
    capabilities: [],
    clock: clock.value,
  });
  assert.equal(protectionDecision.ok, true);
  if (protectionDecision.ok) {
    assert.deepEqual(protectionDecision.value.reasonCodes, [
      "CAPABILITY_UNKNOWN",
      "PROTECTION_REQUIRED",
    ]);
  }

  const understated = parseDecimal("1");
  assert.equal(understated.ok, true);
  if (!understated.ok) return;
  const inconsistentNotional = {
    ...normalized.value,
    notional: understated.value,
  };
  const notionalDecision = evaluateRisk({
    decisionId: "risk-inconsistent-notional",
    candidate: candidateFixture(
      inconsistentNotional,
      [evidence.value],
      strategy.value,
    ),
    capabilities: [],
    clock: clock.value,
  });
  assert.equal(notionalDecision.ok, true);
  if (notionalDecision.ok) {
    assert.deepEqual(notionalDecision.value.reasonCodes, [
      "CAPABILITY_UNKNOWN",
      "CONSTRAINT_VIOLATION",
    ]);
  }
});

test("risk rechecks direct intents against instrument constraints", () => {
  assert.equal(evidence.ok, true);
  assert.equal(strategy.ok, true);
  if (!evidence.ok || !strategy.ok) return;
  const price = parseDecimal("0.08876");
  const quantity = parseDecimal("0.5");
  assert.equal(price.ok, true);
  assert.equal(quantity.ok, true);
  if (!price.ok || !quantity.ok) return;
  const intent = createOrderIntent({
    intentId: "intent-off-grid",
    instrument: "DOGEUSDT",
    orderType: "limit",
    side: "buy",
    positionEffect: "open",
    price: price.value,
    quantity: quantity.value,
    notional: price.value.multiply(quantity.value),
    normalization: {
      price: "floor",
      quantity: "floor",
      constraintVersion: "instrument-constraints/v1",
    },
  });
  const clock = fixedClock("2026-09-19T10:00:01Z");
  assert.equal(intent.ok, true);
  assert.equal(clock.ok, true);
  if (!intent.ok || !clock.ok) return;
  const decision = evaluateRisk({
    decisionId: "risk-off-grid",
    candidate: candidateFixture(intent.value, [evidence.value], strategy.value),
    capabilities: [],
    clock: clock.value,
  });
  assert.equal(decision.ok, true);
  if (decision.ok) {
    assert.deepEqual(decision.value.reasonCodes, [
      "CAPABILITY_UNKNOWN",
      "CONSTRAINT_VIOLATION",
      "QUANTITY_TOO_SMALL",
      "NOTIONAL_TOO_SMALL",
    ]);
  }
});
