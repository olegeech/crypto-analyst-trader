import assert from "node:assert/strict";
import test from "node:test";

import * as domain from "../src/domain/index.js";

test("public domain surface exposes contracts and no raw exchange/storage shapes", () => {
  for (const exported of [
    "DecimalValue",
    "createMarketSnapshot",
    "createEvidenceRef",
    "createCapabilityObservation",
    "normalizeOrderIntent",
    "createExecutionPlan",
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
