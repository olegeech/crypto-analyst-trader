import assert from "node:assert/strict";
import test from "node:test";

import * as domain from "../src/domain/index.js";

test("public domain surface exposes contracts and no raw exchange/storage shapes", () => {
  for (const exported of [
    "DecimalValue",
    "createMarketSnapshot",
    "createEvidenceRef",
    "createLiquidationEvidenceBundleV2",
    "rehydrateLiquidationEvidenceBundle",
    "LIQUIDATION_EVIDENCE_V2_SCHEMA_VERSION",
    "LIQUIDATION_EVIDENCE_V2_PROVIDER_SEMANTIC_IDENTITY",
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
