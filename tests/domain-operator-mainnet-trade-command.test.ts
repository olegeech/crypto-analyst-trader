import assert from "node:assert/strict";
import test from "node:test";

import {
  createOperatorMainnetQuote,
  createOperatorMainnetTestApproval,
  createOperatorMainnetTestPlan,
  OPERATOR_MAINNET_TRADE_COMMAND_PLAN_SCHEMA_VERSION,
  OPERATOR_MAINNET_TRADE_COMMAND_POLICY_VERSION,
  validateOperatorMainnetQuoteForPlan,
} from "../src/domain/execution/operator-mainnet-test-plan.js";
import {
  createOperatorMainnetTradeCommandBinding,
  createOperatorMainnetTradeCommandPlan,
  createOperatorMainnetTradeCommandReceipt,
  rehydrateOperatorMainnetTradeCommandBinding,
  rehydrateOperatorMainnetTradeCommandPlan,
  rehydrateOperatorMainnetTradeCommandReceipt,
  validateOperatorMainnetTradeCommandBinding,
} from "../src/domain/execution/operator-mainnet-trade-command.js";
import {
  encodeCanonicalArtifact,
  rehydrateArtifact,
} from "../src/domain/identity/canonical-artifact.js";
import {
  hashCanonical,
  type PlanHash,
} from "../src/domain/identity/canonical-serialization.js";
import { createInstrumentConstraints } from "../src/domain/market/instrument-constraints.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";
import type { UtcTimestamp } from "../src/domain/shared/time.js";

const now = "2026-10-31T10:00:00.020Z" as UtcTimestamp;
const accountIdentityHash = `sha256:${"a".repeat(64)}` as PlanHash;
const actorIdentityHash = `sha256:${"c".repeat(64)}` as PlanHash;
const payloadHash = `sha256:${"d".repeat(64)}` as PlanHash;

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
    observedAt: "2026-10-31T10:00:00.000Z",
    collectionStartedAt: "2026-10-31T09:59:59.990Z",
    collectionCompletedAt: "2026-10-31T10:00:00.010Z",
    bid: "0.08869",
    ask: "0.08870",
    last: "0.08869",
    ...overrides,
  };
}

function quote(overrides: Record<string, unknown> = {}) {
  return value(createOperatorMainnetQuote(quoteInput(overrides)));
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

function receipt(overrides: Record<string, unknown> = {}) {
  return createOperatorMainnetTradeCommandReceipt({
    commandId: "trade-20261031-0001",
    actorIdentityHash,
    accountIdentityHash,
    symbol: "DOGEUSDT",
    allocation: "10",
    grossNotionalCap: "8",
    maxDeviationBps: "10",
    acceptedAt: now,
    ...overrides,
  });
}

function commandPlan(receiptInput = value(receipt()), overrides = {}) {
  return createOperatorMainnetTradeCommandPlan({
    receipt: receiptInput,
    quote: quote(),
    warningCodes: [],
    constraints: constraints(),
    preparedAt: now,
    ...overrides,
  });
}

function binding(
  receiptInput = value(receipt()),
  planInput = value(commandPlan(receiptInput)),
  overrides: Record<string, unknown> = {},
) {
  return createOperatorMainnetTradeCommandBinding({
    receipt: receiptInput,
    plan: planInput,
    createPayloadHash: payloadHash,
    boundAt: now,
    ...overrides,
  });
}

test("receipt and v3 plan freeze one scoped command before deterministic derivation", () => {
  const commandReceipt = value(receipt());
  const plan = value(commandPlan(commandReceipt));
  assert.equal(commandReceipt.channel, "local-owner-cli/v1");
  assert.equal(commandReceipt.environment, "mainnet");
  assert.equal(commandReceipt.category, "linear");
  assert.equal(commandReceipt.side, "Buy");
  assert.equal(commandReceipt.leverage.toString(), "1");
  assert.equal(
    plan.schemaVersion,
    OPERATOR_MAINNET_TRADE_COMMAND_PLAN_SCHEMA_VERSION,
  );
  assert.equal(
    plan.policyVersion,
    OPERATOR_MAINNET_TRADE_COMMAND_POLICY_VERSION,
  );
  assert.equal(plan.commandId, commandReceipt.commandId);
  assert.equal(plan.commandReceiptHash, commandReceipt.contentHash);
  assert.equal(plan.accountIdentityHash, accountIdentityHash);
  assert.equal(plan.entry.limitPrice.toString(), "0.0886");
  assert.equal(plan.entry.quantity.toString(), "90.2");
  assert.equal(plan.entry.takeProfit.triggerPrice.toString(), "0.0888");
  assert.ok(Object.isFrozen(commandReceipt));
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.entry));

  const replayedReceipt = value(
    rehydrateOperatorMainnetTradeCommandReceipt(commandReceipt),
  );
  const replayedPlan = value(rehydrateOperatorMainnetTradeCommandPlan(plan));
  assert.equal(replayedReceipt.contentHash, commandReceipt.contentHash);
  assert.equal(replayedPlan.contentHash, plan.contentHash);
  assert.equal(replayedPlan.entry.limitPrice.toString(), "0.0886");
  assert.equal(replayedPlan.entry.quantity.toString(), "90.2");
  assert.equal(replayedPlan.entry.takeProfit.triggerPrice.toString(), "0.0888");
  assert.equal(
    value(commandPlan(commandReceipt)).contentHash,
    plan.contentHash,
  );

  const planArtifact = value(
    encodeCanonicalArtifact("operator-mainnet-execution-test", plan),
  );
  const planReplay = value(
    rehydrateArtifact("operator-mainnet-execution-test", planArtifact),
  );
  assert.equal(planReplay.contentHash, plan.contentHash);

  const receiptArtifact = value(
    encodeCanonicalArtifact(
      "operator-mainnet-trade-command-receipt",
      commandReceipt,
    ),
  );
  const receiptReplay = value(
    rehydrateArtifact(
      "operator-mainnet-trade-command-receipt",
      receiptArtifact,
    ),
  );
  assert.equal(receiptReplay.contentHash, commandReceipt.contentHash);
});

test("provider plan time may precede local command acceptance under clock skew", () => {
  const commandReceipt = value(receipt());
  const plan = commandPlan(commandReceipt, {
    quote: quote({
      observedAt: "2026-10-31T09:59:59.980Z",
      collectionStartedAt: "2026-10-31T09:59:59.970Z",
      collectionCompletedAt: "2026-10-31T09:59:59.990Z",
    }),
    preparedAt: "2026-10-31T10:00:00.000Z",
  });

  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.ok(plan.value.preparedAt < commandReceipt.acceptedAt);
  const replayed = rehydrateOperatorMainnetTradeCommandPlan(plan.value);
  assert.equal(
    replayed.ok,
    true,
    replayed.ok ? undefined : JSON.stringify(replayed.error),
  );
});

test("receipt, plan and binding reject unknown, malformed, expired and mismatched authority", () => {
  const commandReceipt = value(receipt());
  const plan = value(commandPlan(commandReceipt));
  const commandBinding = value(binding(commandReceipt, plan));
  const bindingArtifact = value(
    encodeCanonicalArtifact(
      "operator-mainnet-trade-command-binding",
      commandBinding,
    ),
  );
  const bindingReplay = value(
    rehydrateArtifact(
      "operator-mainnet-trade-command-binding",
      bindingArtifact,
    ),
  );
  assert.equal(bindingReplay.contentHash, commandBinding.contentHash);
  const changedPayloadBinding = {
    ...commandBinding,
    createPayloadHash: `sha256:${"e".repeat(64)}` as PlanHash,
  };
  delete (changedPayloadBinding as { contentHash?: PlanHash }).contentHash;
  const rehashedPayloadBinding = {
    ...changedPayloadBinding,
    contentHash: value(hashCanonical(changedPayloadBinding)),
  };
  assert.equal(
    validateOperatorMainnetTradeCommandBinding(
      commandReceipt,
      rehashedPayloadBinding,
      now,
      payloadHash,
    ).ok,
    false,
  );
  assert.equal(
    validateOperatorMainnetTradeCommandBinding(
      commandReceipt,
      commandBinding,
      now,
      `sha256:${"e".repeat(64)}`,
    ).ok,
    false,
    "the binding must match the exact CREATE payload verified by dispatch",
  );
  assert.equal(
    rehydrateOperatorMainnetTradeCommandReceipt({
      ...commandReceipt,
      injected: true,
    }).ok,
    false,
  );
  assert.equal(
    rehydrateOperatorMainnetTradeCommandReceipt({
      ...commandReceipt,
      symbol: "XRPUSDT",
    }).ok,
    false,
  );
  const extendedExpiry = {
    ...commandReceipt,
    expiresAt: "2026-10-31T10:30:00.000Z",
  };
  delete (extendedExpiry as { contentHash?: PlanHash }).contentHash;
  assert.equal(
    rehydrateOperatorMainnetTradeCommandReceipt({
      ...extendedExpiry,
      contentHash: value(hashCanonical(extendedExpiry)),
    }).ok,
    false,
  );
  assert.equal(
    receipt({ acceptedAt: "2026-10-31T09:44:59.999Z" as UtcTimestamp }).ok,
    true,
    "an instruction may be accepted in the past when it is still valid",
  );
  assert.equal(
    validateOperatorMainnetTradeCommandBinding(
      commandReceipt,
      commandBinding,
      "2026-10-31T10:15:00.020Z",
    ).ok,
    false,
    "submission authority expires at the 15-minute boundary",
  );
  assert.equal(
    createOperatorMainnetTradeCommandPlan({
      receipt: commandReceipt,
      quote: quote({ symbol: "ETHUSDT" }),
      warningCodes: [],
      constraints: constraints(),
      preparedAt: now,
    }).ok,
    false,
  );
  assert.equal(
    rehydrateOperatorMainnetTradeCommandPlan({ ...plan, injected: true }).ok,
    false,
  );
  assert.equal(
    rehydrateOperatorMainnetTradeCommandBinding({
      ...commandBinding,
      injected: true,
    }).ok,
    false,
  );
  assert.equal(
    validateOperatorMainnetTradeCommandBinding(
      value(receipt({ commandId: "trade-20261031-0002" })),
      commandBinding,
      now,
    ).ok,
    false,
  );
});

test("binding rejects rehashed price, quantity, TP, account and expiry mutations", () => {
  const commandReceipt = value(receipt());
  const plan = value(commandPlan(commandReceipt));
  const originalBinding = value(binding(commandReceipt, plan));

  const mutateAndRehash = (
    mutate: (candidate: Record<string, unknown>) => void,
  ) => {
    const changed = { ...plan } as unknown as Record<string, unknown>;
    mutate(changed);
    delete changed.contentHash;
    const planHash = value(hashCanonical(changed));
    const rehashedPlan = { ...changed, contentHash: planHash } as Record<
      string,
      unknown
    >;
    const alteredBinding = {
      ...originalBinding,
      replayInputs: {
        receipt: originalBinding.replayInputs.receipt,
        plan: rehashedPlan,
      },
    } as unknown as Record<string, unknown>;
    alteredBinding.planHash = planHash;
    alteredBinding.planArtifactHash = value(hashCanonical(rehashedPlan));
    alteredBinding.clientOrderId = rehashedPlan.clientOrderId;
    alteredBinding.commandId = rehashedPlan.commandId;
    alteredBinding.contentHash = undefined;
    delete alteredBinding.contentHash;
    alteredBinding.contentHash = value(hashCanonical(alteredBinding));
    assert.equal(
      rehydrateOperatorMainnetTradeCommandBinding(alteredBinding).ok,
      false,
    );
  };

  mutateAndRehash((candidate) => {
    const entry = candidate.entry as typeof plan.entry;
    candidate.entry = {
      ...entry,
      limitPrice: value(DecimalValue.fromString("0.0885")),
    };
  });
  mutateAndRehash((candidate) => {
    const entry = candidate.entry as typeof plan.entry;
    candidate.entry = {
      ...entry,
      quantity: value(DecimalValue.fromString("80")),
    };
  });
  mutateAndRehash((candidate) => {
    const entry = candidate.entry as typeof plan.entry;
    candidate.entry = {
      ...entry,
      takeProfit: {
        ...entry.takeProfit,
        triggerPrice: value(DecimalValue.fromString("0.089")),
      },
    };
  });
  mutateAndRehash((candidate) => {
    candidate.accountIdentityHash = `sha256:${"b".repeat(64)}`;
  });
  mutateAndRehash((candidate) => {
    candidate.commandExpiresAt = "2026-10-31T10:30:00.000Z";
  });
});

test("legacy approval cannot authorize v3 and command receipt cannot bind v1 or v2", () => {
  const commandReceipt = value(receipt());
  const plan = value(commandPlan(commandReceipt));
  assert.equal(
    createOperatorMainnetTestApproval({
      plan,
      planHash: plan.contentHash,
      actor: "legacy-operator",
      consent: true,
      approvedAt: now,
    }).ok,
    false,
  );

  const legacyPlan = value(
    createOperatorMainnetTestPlan({
      accountIdentityHash,
      symbol: "DOGEUSDT",
      nonce: commandReceipt.commandId,
      allocation: commandReceipt.allocation.toString(),
      grossNotionalCap: commandReceipt.grossNotionalCap.toString(),
      maxDeviationBps: commandReceipt.maxDeviationBps.toString(),
      quote: quote(),
      warningCodes: [],
      constraints: constraints(),
      preparedAt: now,
    }),
  );
  assert.equal(
    createOperatorMainnetTradeCommandBinding({
      receipt: commandReceipt,
      plan: legacyPlan,
      createPayloadHash: payloadHash,
      boundAt: now,
    }).ok,
    false,
  );
  const recoveryPlan = value(
    createOperatorMainnetTestPlan({
      accountIdentityHash,
      symbol: "DOGEUSDT",
      nonce: commandReceipt.commandId,
      allocation: commandReceipt.allocation.toString(),
      grossNotionalCap: commandReceipt.grossNotionalCap.toString(),
      maxDeviationBps: commandReceipt.maxDeviationBps.toString(),
      quote: quote(),
      warningCodes: [],
      constraints: constraints(),
      preparedAt: now,
      recoveryAttestationHash: `sha256:${"f".repeat(64)}`,
    }),
  );
  assert.equal(
    createOperatorMainnetTradeCommandBinding({
      receipt: commandReceipt,
      plan: recoveryPlan,
      createPayloadHash: payloadHash,
      boundAt: now,
    }).ok,
    false,
  );
});

test("v3 permits only lower-bid drift while legacy remains symmetric", () => {
  const commandReceipt = value(receipt());
  const plan = value(commandPlan(commandReceipt));
  const legacyPlan = value(
    createOperatorMainnetTestPlan({
      accountIdentityHash,
      symbol: "DOGEUSDT",
      nonce: commandReceipt.commandId,
      allocation: commandReceipt.allocation.toString(),
      grossNotionalCap: commandReceipt.grossNotionalCap.toString(),
      maxDeviationBps: commandReceipt.maxDeviationBps.toString(),
      quote: quote(),
      warningCodes: [],
      constraints: constraints(),
      preparedAt: now,
    }),
  );
  const lowerBid = quote({
    observedAt: "2026-10-31T10:00:01.000Z",
    collectionStartedAt: "2026-10-31T10:00:00.990Z",
    collectionCompletedAt: "2026-10-31T10:00:01.010Z",
    bid: plan.quoteBidRange.lower
      .subtract(value(DecimalValue.fromString("0.0001")))
      .toString(),
    ask: "0.0887",
    last: "0.0887",
  });
  assert.equal(
    validateOperatorMainnetQuoteForPlan(
      plan,
      lowerBid,
      "2026-10-31T10:00:01.020Z",
    ).ok,
    true,
  );
  assert.equal(
    validateOperatorMainnetQuoteForPlan(
      legacyPlan,
      lowerBid,
      "2026-10-31T10:00:01.020Z",
    ).ok,
    false,
  );

  const upperBreach = quote({
    observedAt: "2026-10-31T10:00:01.000Z",
    collectionStartedAt: "2026-10-31T10:00:00.990Z",
    collectionCompletedAt: "2026-10-31T10:00:01.010Z",
    bid: plan.quoteBidRange.upper
      .add(value(DecimalValue.fromString("0.0001")))
      .toString(),
    ask: "0.089",
    last: "0.089",
  });
  assert.equal(
    validateOperatorMainnetQuoteForPlan(
      plan,
      upperBreach,
      "2026-10-31T10:00:01.020Z",
    ).ok,
    false,
  );

  assert.equal(
    createOperatorMainnetQuote(quoteInput({ bid: "0.09", ask: "0.089" })).ok,
    false,
  );
  assert.equal(createOperatorMainnetQuote(quoteInput({ bid: "0" })).ok, false);
  const futureQuote = quote({
    observedAt: "2026-10-31T10:00:02.000Z",
    collectionStartedAt: "2026-10-31T10:00:01.990Z",
    collectionCompletedAt: "2026-10-31T10:00:02.010Z",
  });
  const staleQuote = quote({
    observedAt: "2026-10-31T09:59:54.000Z",
    collectionStartedAt: "2026-10-31T09:59:53.990Z",
    collectionCompletedAt: "2026-10-31T09:59:54.010Z",
  });
  assert.equal(
    validateOperatorMainnetQuoteForPlan(plan, futureQuote, now).ok,
    false,
  );
  assert.equal(
    validateOperatorMainnetQuoteForPlan(plan, staleQuote, now).ok,
    false,
  );
});
