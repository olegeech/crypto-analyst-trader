import { createCapabilityObservation } from "../src/domain/capabilities/capability.js";
import { createEvidenceRef } from "../src/domain/evidence/evidence-ref.js";
import {
  createExecutionPlan,
  type ExecutionPlan,
} from "../src/domain/planning/execution-plan.js";
import { createInstrumentConstraints } from "../src/domain/market/instrument-constraints.js";
import {
  createAccountSnapshot,
  createMarketSnapshot,
} from "../src/domain/market/snapshots.js";
import { createStrategyConfig } from "../src/domain/market/strategy-config.js";
import { normalizeOrderIntent } from "../src/domain/planning/normalize-order-intent.js";
import { evaluateRisk } from "../src/domain/risk/risk-decision.js";
import { fixedClock } from "../src/domain/shared/time.js";
import type { Result } from "../src/domain/shared/result.js";

function unwrap<T>(result: Result<T>): T {
  if (!result.ok)
    throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

export function createPlanFixture(): ExecutionPlan {
  const evidenceInput = {
    kind: "capability-probe",
    schemaVersion: "capability-probe/v1",
    producer: "fixture",
    sourceId: "plan-fixture",
    asOf: "2026-09-19T10:00:00Z",
    validForMs: 60_000,
    contentHash: `sha256:${"b".repeat(64)}`,
  };
  const constraintsInput = {
    instrument: "DOGEUSDT",
    priceTickSize: "0.0001",
    quantityStep: "1",
    minQuantity: "1",
    minNotional: "5",
  };
  const scope = {
    exchange: "bybit",
    environment: "demo",
    category: "linear",
    positionMode: "one-way" as const,
  };
  const evidence = unwrap(createEvidenceRef(evidenceInput));
  const constraints = unwrap(createInstrumentConstraints(constraintsInput));
  const strategy = unwrap(
    createStrategyConfig({
      strategyId: "fixture-strategy",
      version: "v1",
      cadence: "daily",
      maxOrderNotional: "100",
      requiresProtection: false,
    }),
  );
  const marketSnapshot = unwrap(
    createMarketSnapshot({
      snapshotId: "fixture-market",
      instrument: "DOGEUSDT",
      scope,
      asOf: "2026-09-19T10:00:00Z",
      bid: "0.0887",
      ask: "0.0888",
      last: "0.08875",
      constraints: constraintsInput,
      evidence: [evidenceInput],
    }),
  );
  const accountSnapshot = unwrap(
    createAccountSnapshot({
      snapshotId: "fixture-account",
      accountScope: "demo:fixture",
      scope,
      asOf: "2026-09-19T10:00:00Z",
      availableBalance: "1000",
      positions: [],
      ownedOrders: [],
      evidence: [evidenceInput],
    }),
  );
  const intent = unwrap(
    normalizeOrderIntent(
      {
        intentId: "fixture-intent",
        instrument: "DOGEUSDT",
        orderType: "limit",
        side: "buy",
        positionEffect: "open",
        price: "0.0887",
        quantity: "57",
        rounding: { price: "floor", quantity: "floor" },
      },
      constraints,
    ),
  );
  const capability = unwrap(
    createCapabilityObservation({
      capability: "order-create",
      status: "supported",
      observedAt: "2026-09-19T10:00:00Z",
      source: "fixture",
      evidence: evidenceInput,
      scope,
    }),
  );
  const candidate = {
    strategy,
    marketSnapshot,
    accountSnapshot,
    evidence: [evidence],
    desiredCurrentDiff: { desired: "open", current: null },
    orderIntents: [intent],
    requiredCapabilities: [{ capability: "order-create", scope }],
    executionScope: scope,
  };
  const clock = unwrap(fixedClock("2026-09-19T10:00:01Z"));
  const riskDecision = unwrap(
    evaluateRisk({
      decisionId: "fixture-risk",
      candidate,
      capabilities: [capability],
      clock,
    }),
  );
  return unwrap(
    createExecutionPlan({
      identityVersion: "execution-plan/v1",
      material: { ...candidate, riskDecision },
    }),
  );
}
