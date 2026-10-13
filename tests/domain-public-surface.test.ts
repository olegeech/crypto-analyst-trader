import assert from "node:assert/strict";
import test from "node:test";

import * as domain from "../src/domain/index.js";

test("public domain surface exposes contracts and no raw exchange/storage shapes", () => {
  for (const exported of [
    "DecimalValue",
    "createMarketSnapshot",
    "createEvidenceRef",
    "createLiquidationEvidenceBundleV2",
    "createLiquidationEvidenceBundleV3",
    "rehydrateLiquidationEvidenceBundle",
    "LIQUIDATION_EVIDENCE_V2_SCHEMA_VERSION",
    "LIQUIDATION_EVIDENCE_V2_PROVIDER_SEMANTIC_IDENTITY",
    "LIQUIDATION_EVIDENCE_V3_SCHEMA_VERSION",
    "LIQUIDATION_EVIDENCE_V3_POLICY_VERSION",
    "DECISION_COVERAGE_POLICY_VERSION",
    "selectDecisionLiquidationMarkets",
    "createCapabilityObservation",
    "normalizeOrderIntent",
    "createExecutionPlan",
    "createDecisionPolicy",
    "createPlanningPolicy",
    "createDailyDecisionPlan",
    "rehydrateDailyDecisionPlan",
    "createApproval",
    "createExecutionAttempt",
    "reconcileAttempt",
    "createLedgerEntry",
  ]) {
    assert.ok(exported in domain, exported);
  }
  for (const exported of Object.keys(domain)) {
    assert.doesNotMatch(exported, /bybit|sqlite|raw|signedrequest/iu);
  }
});
