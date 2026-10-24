import assert from "node:assert/strict";
import test from "node:test";

import {
  createOperatorMainnetQuote,
  createOperatorMainnetTestApproval,
  createOperatorMainnetTestPlan,
  deriveOperatorMainnetTestSourceId,
  validateOperatorMainnetQuoteForPlan,
  validateOperatorMainnetTestApproval,
} from "../src/domain/execution/operator-mainnet-test-plan.js";
import {
  encodeCanonicalArtifact,
  rehydrateArtifact,
} from "../src/domain/identity/canonical-artifact.js";
import { hashCanonical } from "../src/domain/identity/canonical-serialization.js";
import { createInstrumentConstraints } from "../src/domain/market/instrument-constraints.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";
import type { UtcTimestamp } from "../src/domain/shared/time.js";

const now = "2026-10-22T10:00:00.020Z" as UtcTimestamp;
const accountIdentityHash = `sha256:${"a".repeat(64)}`;

function value<T>(
  result: { ok: true; value: T } | { ok: false; error: unknown },
): T {
  assert.equal(
    result.ok,
    true,
    result.ok ? undefined : JSON.stringify(result.error),
  );
  if (!result.ok) throw new Error("expected successful domain value");
  return result.value;
}

function quoteInput(overrides: Record<string, unknown> = {}) {
  return {
    symbol: "DOGEUSDT",
    exchange: "bybit",
    environment: "mainnet",
    category: "linear",
    origin: "https://api.bybit.com",
    observedAt: "2026-10-22T10:00:00.000Z",
    collectionStartedAt: "2026-10-22T09:59:59.990Z",
    collectionCompletedAt: "2026-10-22T10:00:00.010Z",
    bid: "0.08869",
    ask: "0.08870",
    last: "0.08869",
    ...overrides,
  };
}

function constraints(overrides: Record<string, unknown> = {}) {
  return value(
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
      ...overrides,
    }),
  );
}

function validPlan(overrides: Record<string, unknown> = {}) {
  return createOperatorMainnetTestPlan({
    accountIdentityHash,
    symbol: "DOGEUSDT",
    nonce: "experiment-20261022-01",
    allocation: "10",
    grossNotionalCap: "8",
    maxDeviationBps: "10",
    quote: value(createOperatorMainnetQuote(quoteInput())),
    warningCodes: [],
    constraints: constraints(),
    preparedAt: now,
    ...overrides,
  });
}

test("operator quote plan rounds the bid, budget quantity and attached TP exactly", () => {
  const plan = value(validPlan());
  assert.equal(plan.schemaVersion, "operator-mainnet-execution-test/v1");
  assert.equal(plan.policyVersion, "operator-mainnet-test/v1");
  assert.equal(plan.quote.bid.toString(), "0.08869");
  assert.equal(plan.entry.side, "Buy");
  assert.equal(plan.entry.orderType, "Limit");
  assert.equal(plan.entry.timeInForce, "GTC");
  assert.equal(plan.entry.limitPrice.toString(), "0.0886");
  assert.equal(plan.entry.quantity.toString(), "90.2");
  assert.equal(plan.effectiveGrossNotional.toString(), "7.99172");
  assert.equal(plan.entry.takeProfit.triggerPrice.toString(), "0.0888");
  assert.equal(plan.entry.takeProfit.tpslMode, "Partial");
  assert.equal(plan.entry.takeProfit.orderType, "Market");
  assert.equal(plan.entry.takeProfit.triggerBy, "LastPrice");
  assert.equal(plan.entry.stopLoss, "none");
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.quote));
  assert.ok(Object.isFrozen(plan.entry));

  const encoded = value(
    encodeCanonicalArtifact("operator-mainnet-execution-test", plan),
  );
  const decoded = value(
    rehydrateArtifact("operator-mainnet-execution-test", encoded),
  );
  assert.equal(decoded.contentHash, plan.contentHash);
  assert.equal(Object.hasOwn(decoded, "sourceId"), false);
  assert.equal(decoded.clientOrderId, plan.clientOrderId);
  assert.equal(encoded.canonicalJson.includes('"sourceId"'), false);
});

test("IP-unbound remains a hashed warning and cannot become an implicit blocker", () => {
  const plan = value(validPlan({ warningCodes: ["API_KEY_IP_UNBOUND"] }));
  assert.deepEqual(plan.warningCodes, ["API_KEY_IP_UNBOUND"]);
  assert.equal(
    plan.effectiveGrossNotional.compare(plan.effectiveBudget) <= 0,
    true,
  );
  assert.notEqual(plan.contentHash, value(validPlan()).contentHash);
  assert.equal(
    validPlan({ warningCodes: ["WITHDRAW_PERMISSION_ENABLED"] }).ok,
    false,
  );
  assert.equal(
    validPlan({ warningCodes: ["UNRELATED_ACCOUNT_COVERAGE_INCOMPLETE"] }).ok,
    false,
    "unknown account exposure stays outside the admissible warning set",
  );
});

test("operator quote attribution rejects wrong symbol, scope, origin and invalid books", () => {
  for (const invalid of [
    { symbol: "BNBUSDT" },
    { category: "spot" },
    { origin: "https://api-testnet.bybit.com" },
    { bid: "0" },
    { bid: "0.09", ask: "0.0887" },
    { bid: "not-a-decimal" },
    { observedAt: "2026-10-22T10:00:01.000Z" },
    { collectionStartedAt: "2026-10-22T10:00:00.010Z" },
  ]) {
    assert.equal(createOperatorMainnetQuote(quoteInput(invalid)).ok, false);
  }
});

test("operator plan rejects stale or future provider quotes and invalid deviation", () => {
  const staleQuote = value(
    createOperatorMainnetQuote(
      quoteInput({
        observedAt: "2026-10-22T09:59:54.999Z",
        collectionStartedAt: "2026-10-22T09:59:54.990Z",
        collectionCompletedAt: "2026-10-22T09:59:55.000Z",
      }),
    ),
  );
  const futureQuote = value(
    createOperatorMainnetQuote(
      quoteInput({
        observedAt: "2026-10-22T10:00:00.030Z",
        collectionStartedAt: "2026-10-22T10:00:00.020Z",
        collectionCompletedAt: "2026-10-22T10:00:00.040Z",
      }),
    ),
  );
  assert.equal(validPlan({ quote: staleQuote }).ok, false);
  assert.equal(validPlan({ quote: futureQuote }).ok, false);
  assert.equal(
    validPlan({ preparedAt: "2026-10-22T10:00:05.000Z" as UtcTimestamp }).ok,
    true,
    "the exact five-second quote freshness boundary is inclusive",
  );
  assert.equal(
    validPlan({ preparedAt: "2026-10-22T10:00:05.001Z" as UtcTimestamp }).ok,
    false,
  );
  assert.equal(validPlan({ maxDeviationBps: "0" }).ok, false);
  assert.equal(validPlan({ maxDeviationBps: "10000" }).ok, false);
  assert.equal(validPlan({ maxDeviationBps: "Infinity" }).ok, false);
});

test("operator budget floors quantity and never raises an impossible minimum", () => {
  const tooSmallQuantity = validPlan({
    allocation: "0.001",
    grossNotionalCap: "0.001",
  });
  assert.equal(tooSmallQuantity.ok, false);
  if (!tooSmallQuantity.ok)
    assert.equal(tooSmallQuantity.error.code, "QUANTITY_TOO_SMALL");

  const belowMinimumNotional = validPlan({
    allocation: "9",
    grossNotionalCap: "9",
    quote: value(
      createOperatorMainnetQuote(
        quoteInput({ bid: "10", ask: "10.1", last: "10" }),
      ),
    ),
    constraints: constraints({
      instrument: "DOGEUSDT",
      priceTickSize: "1",
      quantityStep: "0.1",
      minQuantity: "0.1",
      minNotional: "10",
      minPrice: "1",
      maxPrice: "100",
      maxLimitQuantity: "100",
    }),
  });
  assert.equal(belowMinimumNotional.ok, false);
  if (!belowMinimumNotional.ok)
    assert.equal(belowMinimumNotional.error.code, "NOTIONAL_TOO_SMALL");

  assert.equal(
    validPlan({ constraints: constraints({ maxLimitQuantity: "50" }) }).ok,
    false,
  );
  assert.equal(
    validPlan({
      quote: value(
        createOperatorMainnetQuote(
          quoteInput({ bid: "99.9", ask: "100", last: "99.9" }),
        ),
      ),
      constraints: constraints({ priceTickSize: "0.1", maxPrice: "100" }),
    }).ok,
    false,
    "TP tick-up beyond the venue maximum must block",
  );
});

test("frozen quote deviation accepts inclusive endpoints and rejects one tick outside", () => {
  const plan = value(validPlan());
  const lower = value(
    createOperatorMainnetQuote(
      quoteInput({
        observedAt: "2026-10-22T10:00:01.000Z",
        collectionStartedAt: "2026-10-22T10:00:00.990Z",
        collectionCompletedAt: "2026-10-22T10:00:01.010Z",
        bid: plan.quoteBidRange.lower.toString(),
        ask: "0.0887",
        last: "0.0887",
      }),
    ),
  );
  const upper = value(
    createOperatorMainnetQuote(
      quoteInput({
        observedAt: "2026-10-22T10:00:01.000Z",
        collectionStartedAt: "2026-10-22T10:00:00.990Z",
        collectionCompletedAt: "2026-10-22T10:00:01.010Z",
        bid: plan.quoteBidRange.upper.toString(),
        ask: "0.089",
        last: "0.089",
      }),
    ),
  );
  const outside = value(
    createOperatorMainnetQuote(
      quoteInput({
        observedAt: "2026-10-22T10:00:01.000Z",
        collectionStartedAt: "2026-10-22T10:00:00.990Z",
        collectionCompletedAt: "2026-10-22T10:00:01.010Z",
        bid: plan.quoteBidRange.upper
          .add(value(DecimalValue.fromString("0.0001")))
          .toString(),
        ask: "0.09",
        last: "0.09",
      }),
    ),
  );
  const belowLower = value(
    createOperatorMainnetQuote(
      quoteInput({
        observedAt: "2026-10-22T10:00:01.000Z",
        collectionStartedAt: "2026-10-22T10:00:00.990Z",
        collectionCompletedAt: "2026-10-22T10:00:01.010Z",
        bid: plan.quoteBidRange.lower
          .subtract(value(DecimalValue.fromString("0.0001")))
          .toString(),
        ask: "0.0887",
        last: "0.0887",
      }),
    ),
  );
  assert.equal(
    validateOperatorMainnetQuoteForPlan(plan, lower, "2026-10-22T10:00:01.020Z")
      .ok,
    true,
  );
  assert.equal(
    validateOperatorMainnetQuoteForPlan(plan, upper, "2026-10-22T10:00:01.020Z")
      .ok,
    true,
  );
  assert.equal(
    validateOperatorMainnetQuoteForPlan(
      plan,
      outside,
      "2026-10-22T10:00:01.020Z",
    ).ok,
    false,
  );
  assert.equal(
    validateOperatorMainnetQuoteForPlan(
      plan,
      belowLower,
      "2026-10-22T10:00:01.020Z",
    ).ok,
    false,
  );
});

test("client ID precedes plan hash and derived source identity; approval identity remains separate", () => {
  const plan = value(validPlan());
  const repeated = value(validPlan());
  const changedCap = value(validPlan({ grossNotionalCap: "7" }));
  const changedDeviation = value(validPlan({ maxDeviationBps: "11" }));
  const changedNonce = value(validPlan({ nonce: "experiment-20261022-02" }));
  const changedQuote = value(
    validPlan({
      quote: value(
        createOperatorMainnetQuote(
          quoteInput({ bid: "0.08870", ask: "0.08871", last: "0.08870" }),
        ),
      ),
    }),
  );
  assert.equal(plan.contentHash, repeated.contentHash);
  assert.equal(plan.clientOrderId, repeated.clientOrderId);
  assert.notEqual(plan.contentHash, changedCap.contentHash);
  assert.notEqual(plan.contentHash, changedDeviation.contentHash);
  assert.notEqual(plan.contentHash, changedNonce.contentHash);
  assert.notEqual(plan.contentHash, changedQuote.contentHash);
  assert.notEqual(plan.clientOrderId, changedNonce.clientOrderId);
  assert.equal(plan.clientOrderId, changedCap.clientOrderId);
  const sourceId = value(deriveOperatorMainnetTestSourceId(plan.contentHash));
  const repeatedSourceId = value(
    deriveOperatorMainnetTestSourceId(repeated.contentHash),
  );
  const changedCapSourceId = value(
    deriveOperatorMainnetTestSourceId(changedCap.contentHash),
  );
  assert.match(sourceId, /^operator-mainnet-test:[a-f0-9]{40}$/);
  assert.equal(sourceId, repeatedSourceId);
  assert.notEqual(sourceId, changedCapSourceId);
  const { contentHash, ...planPayload } = plan;
  assert.equal(value(hashCanonical(planPayload)), contentHash);
  assert.equal(Object.hasOwn(planPayload, "sourceId"), false);
  const expectedSourceHash = value(
    hashCanonical({
      identityVersion: "operator-mainnet-source/v1",
      planHash: contentHash,
    }),
  );
  assert.equal(
    sourceId,
    `operator-mainnet-test:${expectedSourceHash.slice(7, 47)}`,
  );

  const firstApproval = value(
    createOperatorMainnetTestApproval({
      plan,
      planHash: plan.contentHash,
      actor: "operator",
      consent: true,
      approvedAt: "2026-10-22T10:01:00.000Z",
    }),
  );
  const renewedApproval = value(
    createOperatorMainnetTestApproval({
      plan,
      planHash: plan.contentHash,
      actor: "operator",
      consent: true,
      approvedAt: "2026-10-22T10:02:00.000Z",
    }),
  );
  assert.notEqual(firstApproval.contentHash, renewedApproval.contentHash);
  assert.equal(firstApproval.sourceId, sourceId);
  assert.equal(renewedApproval.sourceId, sourceId);
  assert.equal(firstApproval.clientOrderId, plan.clientOrderId);
  assert.equal(renewedApproval.clientOrderId, plan.clientOrderId);
  assert.equal(firstApproval.expiresAt, "2026-10-22T10:16:00.000Z");
  assert.equal(
    validateOperatorMainnetTestApproval(
      firstApproval,
      plan,
      firstApproval.contentHash,
      firstApproval.expiresAt,
    ).ok,
    false,
    "exact expiry is invalid",
  );
  assert.equal(
    validateOperatorMainnetTestApproval(
      firstApproval,
      changedCap,
      firstApproval.contentHash,
      "2026-10-22T10:02:00.000Z",
    ).ok,
    false,
  );

  const encoded = value(
    encodeCanonicalArtifact(
      "operator-mainnet-execution-approval",
      firstApproval,
    ),
  );
  const decoded = value(
    rehydrateArtifact("operator-mainnet-execution-approval", encoded),
  );
  assert.equal(decoded.contentHash, firstApproval.contentHash);
});

test("canonical operator quote identity changes when provider facts change", () => {
  const original = value(createOperatorMainnetQuote(quoteInput()));
  const changed = value(
    createOperatorMainnetQuote(quoteInput({ bid: "0.0887", ask: "0.0888" })),
  );
  assert.notEqual(original.contentHash, changed.contentHash);
  assert.equal(original.symbol, "DOGEUSDT");
});

test("missing venue bounds block the operator plan with a safe diagnostic code", () => {
  for (const field of ["minPrice", "maxPrice", "maxLimitQuantity"] as const) {
    const venue = { ...constraints() };
    delete venue[field];
    const result = validPlan({ constraints: venue });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "INVALID_PLAN");
      assert.equal(
        result.error.details?.reasonCode,
        "INSTRUMENT_CONSTRAINTS_INCOMPLETE_OR_MISMATCHED",
      );
    }
  }
});
