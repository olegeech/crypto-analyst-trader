import assert from "node:assert/strict";
import test from "node:test";

import {
  createOperatorMainnetRecoveryAttestation,
  createOperatorMainnetRecoveryGrant,
  recoveryGrantPlanExpiry,
  rehydrateOperatorMainnetRecoveryAttestation,
  rehydrateOperatorMainnetRecoveryGrant,
  validateOperatorMainnetRecoveryAttestationBinding,
  validateOperatorMainnetRecoveryGrantForPlan,
} from "../src/domain/execution/operator-mainnet-recovery.js";
import {
  createOperatorMainnetQuote,
  createOperatorMainnetTestPlan,
} from "../src/domain/execution/operator-mainnet-test-plan.js";
import { createInstrumentConstraints } from "../src/domain/market/instrument-constraints.js";
import {
  parseUtcTimestamp,
  type UtcTimestamp,
} from "../src/domain/shared/time.js";
import type { Result } from "../src/domain/shared/result.js";

const ACCOUNT = `sha256:${"a".repeat(64)}`;
const PRIOR_PLAN = `sha256:${"b".repeat(64)}`;
const NOW = "2026-10-22T10:01:00.000Z" as UtcTimestamp;

function value<T>(result: Result<T>): T {
  if (!result.ok)
    throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function plan(nonce = "recovery-plan") {
  const quote = value(
    createOperatorMainnetQuote({
      symbol: "DOGEUSDT",
      exchange: "bybit",
      environment: "mainnet",
      category: "linear",
      origin: "https://api.bybit.com",
      observedAt: "2026-10-22T10:00:59.990Z",
      collectionStartedAt: "2026-10-22T10:00:59.980Z",
      collectionCompletedAt: "2026-10-22T10:00:59.995Z",
      bid: "0.08869",
      ask: "0.08870",
      last: "0.08869",
    }),
  );
  const constraints = value(
    createInstrumentConstraints({
      instrument: "DOGEUSDT",
      version: "bybit-v5:public-instrument/v2",
      priceTickSize: "0.0001",
      quantityStep: "0.1",
      minQuantity: "1",
      minNotional: "5",
      minPrice: "0.0001",
      maxPrice: "100",
      maxLimitQuantity: "100000",
    }),
  );
  return value(
    createOperatorMainnetTestPlan({
      accountIdentityHash: ACCOUNT,
      symbol: "DOGEUSDT",
      nonce,
      allocation: "10",
      grossNotionalCap: "8",
      maxDeviationBps: "10",
      quote,
      warningCodes: [],
      constraints,
      preparedAt: NOW,
    }),
  );
}

function attestationInput(sourceRevision = 2) {
  return {
    provenance: "MANUAL_ATTESTED_NOT_API_VERIFIED",
    exchange: "bybit",
    environment: "mainnet",
    accountIdentityHash: ACCOUNT,
    sourceId: "operator-source-01",
    sourcePlanHash: PRIOR_PLAN,
    sourceIntentId: "operator-intent-01",
    sourceRevision,
    actor: "operator-01",
    observedAt: NOW,
    inspection: {
      accountOpenOrdersInspected: true,
      accountOpenOrders: [],
      accountPositionsInspected: true,
      accountPositions: [],
      sourceOrderHistoryInspected: true,
      sourceOrders: [
        {
          orderId: "exchange-parent-01",
          clientOrderId: "entry-client-01",
          symbol: "DOGEUSDT",
          side: "Buy",
          orderType: "Limit",
          quantity: "129",
          price: "0.07699",
          status: "Filled",
        },
      ],
      sourceFillsInspected: true,
      sourceFills: [
        {
          executionId: "execution-entry-01",
          orderId: "exchange-parent-01",
          clientOrderId: "entry-client-01",
          symbol: "DOGEUSDT",
          side: "Buy",
          quantity: "129",
          price: "0.07699",
          executedAt: NOW,
        },
      ],
      sourcePositionInspected: true,
      sourcePosition: null,
      targetLeverage: "1",
      sourceTakeProfitInspected: true,
      sourceTakeProfitOrders: [],
    },
    manualActions: ["position-closed"],
    acceptedUncertainty: ["manual-ui-may-be-stale"],
  };
}

function createGrant(
  valuePlan = plan(),
  overrides: Record<string, unknown> = {},
) {
  const planExpiresAt = value(recoveryGrantPlanExpiry(valuePlan));
  return createOperatorMainnetRecoveryGrant({
    plan: valuePlan,
    resolution: {
      kind: "manual-attested",
      attestationId: "operator-mainnet-recovery-attestation:test",
      attestationHash: `sha256:${"c".repeat(64)}`,
      observedAt: NOW,
    },
    exchange: "bybit",
    environment: "mainnet",
    accountIdentityHash: ACCOUNT,
    sourceId: "operator-source-01",
    sourcePlanHash: PRIOR_PLAN,
    sourceIntentId: "operator-intent-01",
    sourceRevision: 2,
    haltRevision: 0,
    haltOrigin: null,
    planHash: valuePlan.contentHash,
    planExpiresAt,
    actor: "operator-01",
    consent: true,
    issuedAt: NOW,
    expiresAt: "2026-10-22T10:05:59.000Z",
    ...overrides,
  });
}

test("manual recovery attestation replays its hash and binds the exact source revision", () => {
  const attestation = value(
    createOperatorMainnetRecoveryAttestation(attestationInput()),
  );
  assert.equal(
    value(rehydrateOperatorMainnetRecoveryAttestation(attestation)).contentHash,
    attestation.contentHash,
  );
  assert.equal(
    validateOperatorMainnetRecoveryAttestationBinding(attestation, {
      accountIdentityHash: ACCOUNT,
      sourceId: "operator-source-01",
      sourcePlanHash: PRIOR_PLAN,
      sourceIntentId: "operator-intent-01",
      sourceRevision: 2,
      entryClientOrderId: "entry-client-01",
    }).ok,
    true,
  );
  const stale = validateOperatorMainnetRecoveryAttestationBinding(attestation, {
    accountIdentityHash: ACCOUNT,
    sourceId: "operator-source-01",
    sourcePlanHash: PRIOR_PLAN,
    sourceIntentId: "operator-intent-01",
    sourceRevision: 3,
    entryClientOrderId: "entry-client-01",
  });
  assert.equal(stale.ok, false);
  const foreignEntry = validateOperatorMainnetRecoveryAttestationBinding(
    attestation,
    {
      accountIdentityHash: ACCOUNT,
      sourceId: "operator-source-01",
      sourcePlanHash: PRIOR_PLAN,
      sourceIntentId: "operator-intent-01",
      sourceRevision: 2,
      entryClientOrderId: "another-order",
    },
  );
  assert.equal(foreignEntry.ok, false);

  const tampered = {
    ...attestation,
    manualActions: ["none"],
  };
  assert.equal(rehydrateOperatorMainnetRecoveryAttestation(tampered).ok, false);
  assert.equal(
    createOperatorMainnetRecoveryAttestation({
      ...attestationInput(),
      inspection: {
        ...attestationInput().inspection,
        sourceFillsInspected: false,
      },
    }).ok,
    false,
  );
});

test("recovery grant is immutable, short-lived and bound to one exact saved plan", () => {
  const valuePlan = plan();
  const grant = value(createGrant(valuePlan));
  assert.equal(
    value(rehydrateOperatorMainnetRecoveryGrant(grant)).contentHash,
    grant.contentHash,
  );
  assert.equal(
    validateOperatorMainnetRecoveryGrantForPlan(grant, valuePlan, NOW).ok,
    true,
  );
  assert.equal(
    validateOperatorMainnetRecoveryGrantForPlan(
      grant,
      plan("different-exact-plan"),
      NOW,
    ).ok,
    false,
  );
  assert.equal(
    validateOperatorMainnetRecoveryGrantForPlan(
      grant,
      valuePlan,
      "2026-10-22T10:06:00.000Z",
    ).ok,
    false,
  );

  const tooOld = createGrant(valuePlan, {
    issuedAt: "2026-10-22T10:06:01.000Z",
    expiresAt: "2026-10-22T10:06:02.000Z",
  });
  assert.equal(tooOld.ok, false);
  const mismatchedHalt = createGrant(valuePlan, {
    haltRevision: 7,
    haltOrigin: {
      eventId: "halt-event-06",
      revision: 5,
      originHash: `sha256:${"d".repeat(64)}`,
    },
  });
  assert.equal(mismatchedHalt.ok, false);
  assert.equal(
    value(parseUtcTimestamp(grant.expiresAt)) >
      value(parseUtcTimestamp(grant.issuedAt)),
    true,
  );
});
