import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BYBIT_MAINNET_CAPABILITY_PROFILE } from "../src/adapters/bybit-v5/capability-profile.js";
import { mapCreateOrderRequest } from "../src/adapters/bybit-v5/order-mappers.js";
import { openSqliteConnection } from "../src/adapters/sqlite/connection.js";
import { openSqlitePersistence } from "../src/adapters/sqlite/sqlite-persistence.js";
import {
  createAccountEvidenceBundle,
  createAccountEvidenceCollectionResult,
} from "../src/domain/account/account-evidence-bundle.js";
import { createAdapterCapabilityObservation } from "../src/domain/capabilities/capability.js";
import {
  createOperatorMainnetQuote,
  createOperatorMainnetTestApproval,
  createOperatorMainnetTestPlan,
  deriveOperatorMainnetTestSourceId,
} from "../src/domain/execution/operator-mainnet-test-plan.js";
import { createExchangeOrder } from "../src/domain/execution/exchange-order.js";
import { createEvidenceRef } from "../src/domain/evidence/evidence-ref.js";
import {
  hashCanonical,
  type PlanHash,
} from "../src/domain/identity/canonical-serialization.js";
import { createInstrumentConstraints } from "../src/domain/market/instrument-constraints.js";
import { createMarketSnapshot } from "../src/domain/market/snapshots.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";
import {
  parseUtcTimestamp,
  type UtcTimestamp,
} from "../src/domain/shared/time.js";
import {
  createOperatorMainnetCreateRequest,
  createOperatorMainnetFeeRateEvidence,
  type MainnetOperatorTestFreshEvidence,
} from "../src/application/mainnet-entry-evidence.js";
import { deriveMainnetExecutionReadiness } from "../src/application/mainnet-execution-readiness.js";
import {
  executeMainnetOperatorTest,
  type MainnetOperatorTestDependencies,
} from "../src/application/mainnet-operator-test.js";
import {
  runMainnetOperatorTestStatus,
  type MainnetOperatorTestStatusObservation,
} from "../src/application/mainnet-operator-test-status.js";
import type { BybitInstrumentInfo } from "../src/adapters/bybit-v5/read-mappers.js";
import type { OperatorMainnetTestAuthorizationPort } from "../src/ports/operator-mainnet-test-authorization.js";
import type { PersistenceScope } from "../src/ports/persistence.js";
import type { Result } from "../src/domain/shared/result.js";
import type { OperatorMainnetTestPlan } from "../src/domain/execution/operator-mainnet-test-plan.js";
import { fixture as accountFixture } from "./account-evidence-fixture.js";

const NOW = "2026-10-02T12:00:02.000Z" as UtcTimestamp;
const ACCOUNT = `sha256:${"a".repeat(64)}`;
const runtime = { nodeVersion: "22.22.3", sqliteVersion: "3.51.3" } as const;
const roots: string[] = [];

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function unwrap<T>(result: Result<T>): T {
  if (!result.ok)
    throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function at(ms: number): UtcTimestamp {
  return unwrap(parseUtcTimestamp(new Date(ms).toISOString()));
}

function decimal(value: string): DecimalValue {
  return unwrap(DecimalValue.fromString(value));
}

function scope(accountId = ACCOUNT): PersistenceScope {
  return {
    exchange: "bybit",
    environment: "mainnet",
    accountId,
    category: "linear",
    positionMode: "one-way",
  };
}

function plan(
  options: {
    readonly nonce?: string;
    readonly accountIdentityHash?: string;
    readonly warningCodes?: readonly "API_KEY_IP_UNBOUND"[];
    readonly preparedAt?: UtcTimestamp;
  } = {},
): OperatorMainnetTestPlan {
  const preparedAt = options.preparedAt ?? NOW;
  const quoteObservedAt = at(Date.parse(preparedAt) - 500);
  const quote = unwrap(
    createOperatorMainnetQuote({
      symbol: "BTCUSDT",
      exchange: "bybit",
      environment: "mainnet",
      category: "linear",
      origin: "https://api.bybit.com",
      observedAt: quoteObservedAt,
      collectionStartedAt: at(Date.parse(quoteObservedAt) - 10),
      collectionCompletedAt: at(Date.parse(quoteObservedAt) + 10),
      bid: "100",
      ask: "100.1",
      last: "100",
    }),
  );
  const constraints = unwrap(
    createInstrumentConstraints({
      instrument: "BTCUSDT",
      version: "bybit-linear-instrument/v1",
      priceTickSize: "0.1",
      quantityStep: "0.001",
      minQuantity: "0.001",
      minNotional: "5",
      minPrice: "0.1",
      maxPrice: "1000000",
      maxLimitQuantity: "100000",
    }),
  );
  return unwrap(
    createOperatorMainnetTestPlan({
      accountIdentityHash: options.accountIdentityHash ?? ACCOUNT,
      symbol: "BTCUSDT",
      nonce: options.nonce ?? "operator-test-01",
      allocation: "10",
      grossNotionalCap: "8",
      maxDeviationBps: "10",
      quote,
      warningCodes: options.warningCodes ?? [],
      constraints,
      preparedAt,
    }),
  );
}

function approval(valuePlan: OperatorMainnetTestPlan, approvedAt = NOW) {
  return unwrap(
    createOperatorMainnetTestApproval({
      plan: valuePlan,
      planHash: valuePlan.contentHash,
      actor: "operator-test",
      consent: true,
      approvedAt,
    }),
  );
}

interface EvidenceOverrides {
  readonly accountIdentityHash?: string;
  readonly readOnly?: boolean;
  readonly contractOrder?: boolean;
  readonly contractPosition?: boolean;
  readonly walletTransfer?: boolean;
  readonly ipBound?: boolean;
  readonly availableBalance?: string;
  readonly serverTime?: UtcTimestamp;
  readonly quoteObservedAt?: UtcTimestamp;
  readonly positionSide?: "long" | "short" | "flat";
  readonly positionQuantity?: string;
  readonly openOrder?: boolean;
  readonly leverage?: string;
  readonly instrumentSymbol?: string;
  readonly instrumentStatus?: string;
  readonly constraintTick?: string;
}

function freshEvidence(
  valuePlan: OperatorMainnetTestPlan,
  overrides: EvidenceOverrides = {},
) {
  const accountInput = accountFixture() as unknown as {
    accountBinding: Record<string, unknown>;
    credentialPosture: Record<string, unknown>;
    criticalPasses: {
      A: { totals: { totalAvailableBalance: { value: string } } };
      B: { totals: { totalAvailableBalance: { value: string } } };
    };
  };
  const accountHash =
    overrides.accountIdentityHash ?? valuePlan.accountIdentityHash;
  accountInput.accountBinding = {
    ...accountInput.accountBinding,
    environment: "mainnet",
    origin: "https://api.bybit.com",
    accountIdentityHash: accountHash,
  };
  const ipBound = overrides.ipBound ?? true;
  accountInput.credentialPosture = {
    readOnly: overrides.readOnly ?? false,
    permissions: {
      contractOrder: overrides.contractOrder ?? true,
      contractPosition: overrides.contractPosition ?? true,
      spotTrade: false,
      walletTransfer: overrides.walletTransfer ?? false,
      withdraw: false,
    },
    ipBound,
    expiresAt: null,
    warnings: ipBound ? [] : ["API_KEY_IP_UNBOUND"],
  };
  if (overrides.availableBalance !== undefined) {
    for (const pass of [
      accountInput.criticalPasses.A,
      accountInput.criticalPasses.B,
    ])
      pass.totals.totalAvailableBalance.value = overrides.availableBalance;
  }
  const account = unwrap(createAccountEvidenceBundle(accountInput));
  const accountResult = unwrap(
    createAccountEvidenceCollectionResult({
      kind: "account-evidence",
      bundle: account,
    }),
  );
  const instrumentConstraints =
    overrides.constraintTick === undefined
      ? valuePlan.constraints
      : unwrap(
          createInstrumentConstraints({
            ...valuePlan.constraints,
            priceTickSize: overrides.constraintTick,
          }),
        );
  const instrument = {
    symbol: overrides.instrumentSymbol ?? valuePlan.symbol,
    status: overrides.instrumentStatus ?? "Trading",
    contractType: "LinearPerpetual",
    quoteCoin: "USDT",
    settleCoin: "USDT",
    constraints: instrumentConstraints,
  } as unknown as BybitInstrumentInfo;
  const serverTime = overrides.serverTime ?? NOW;
  const readiness = deriveMainnetExecutionReadiness({
    accountResult,
    symbol: valuePlan.symbol,
    instrument,
    evaluatedAt: serverTime,
  });
  const marketHash = unwrap(
    hashCanonical({ market: serverTime, symbol: valuePlan.symbol }),
  );
  const marketRef = unwrap(
    createEvidenceRef({
      kind: "market-snapshot",
      schemaVersion: "operator-test/v1",
      producer: "application-mainnet-operator-test.test",
      sourceId: "operator-test-market",
      asOf: serverTime,
      validForMs: 120_000,
      contentHash: marketHash,
    }),
  );
  const market = unwrap(
    createMarketSnapshot({
      snapshotId: "operator-test-market",
      instrument: valuePlan.symbol,
      scope: {
        exchange: "bybit",
        environment: "mainnet",
        category: "linear",
        positionMode: "one-way",
      },
      asOf: serverTime,
      bid: "100",
      ask: "100.1",
      last: "100",
      constraints: valuePlan.constraints,
      evidence: [marketRef],
    }),
  );
  const capabilities = (
    ["order-create", "attached-protection", "reconciliation-reads"] as const
  ).map((capability) => {
    const contentHash = unwrap(hashCanonical({ capability, serverTime }));
    const evidence = unwrap(
      createEvidenceRef({
        kind: "capability-probe",
        schemaVersion: "operator-test/v1",
        producer: BYBIT_MAINNET_CAPABILITY_PROFILE.adapter,
        sourceId: `operator-${capability}`,
        asOf: serverTime,
        validForMs: 120_000,
        contentHash,
      }),
    );
    return unwrap(
      createAdapterCapabilityObservation({
        capability,
        status: "supported",
        observedAt: serverTime,
        source: BYBIT_MAINNET_CAPABILITY_PROFILE.adapter,
        evidence,
        scope: BYBIT_MAINNET_CAPABILITY_PROFILE.scope,
      }),
    );
  });
  const quoteObservedAt =
    overrides.quoteObservedAt ?? at(Date.parse(serverTime) - 100);
  const quote = unwrap(
    createOperatorMainnetQuote({
      symbol: valuePlan.symbol,
      exchange: "bybit",
      environment: "mainnet",
      category: "linear",
      origin: "https://api.bybit.com",
      observedAt: quoteObservedAt,
      collectionStartedAt: at(Date.parse(quoteObservedAt) - 10),
      collectionCompletedAt: at(Date.parse(quoteObservedAt) + 10),
      bid: "100",
      ask: "100.1",
      last: "100",
    }),
  );
  const feeRate = unwrap(
    createOperatorMainnetFeeRateEvidence({
      schemaVersion: "bybit-mainnet-operator-fee-rate/v1",
      symbol: valuePlan.symbol,
      makerFeeRate: "0.0002",
      takerFeeRate: "0.00055",
      observedAt: serverTime,
    }),
  );
  const state: MainnetOperatorTestFreshEvidence["state"] = {
    serverTime,
    market,
    position: {
      instrument: valuePlan.symbol,
      side: overrides.positionSide ?? "flat",
      quantity: decimal(overrides.positionQuantity ?? "0"),
      leverage: decimal(overrides.leverage ?? "1"),
    },
    openOrders: overrides.openOrder ? ([{}] as never) : [],
    leverage: {
      buy: decimal(overrides.leverage ?? "1"),
      sell: decimal(overrides.leverage ?? "1"),
      effective: decimal(overrides.leverage ?? "1"),
    },
    capabilities,
  };
  assert.equal(Object.getPrototypeOf(instrument), Object.prototype);
  assert.equal(createInstrumentConstraints(instrument.constraints).ok, true);
  return {
    account,
    readiness,
    state,
    instrument,
    quote,
    feeRate,
  } satisfies MainnetOperatorTestFreshEvidence;
}

class TestAuthorization implements OperatorMainnetTestAuthorizationPort {
  readonly issued = new WeakMap<object, string>();
  readonly consumed = new WeakSet<object>();
  denyIssue = false;
  denyConsume = false;
  forgeIssue = false;
  consumeCalls = 0;
  onConsume?: () => void;

  async issue(
    binding: Parameters<OperatorMainnetTestAuthorizationPort["issue"]>[0],
  ) {
    if (this.denyIssue) return undefined;
    const capability = Object.freeze({});
    if (!this.forgeIssue) this.issued.set(capability, JSON.stringify(binding));
    return capability;
  }

  consume(
    capability: Parameters<OperatorMainnetTestAuthorizationPort["consume"]>[0],
    binding: Parameters<OperatorMainnetTestAuthorizationPort["consume"]>[1],
    now: UtcTimestamp,
  ) {
    this.consumeCalls += 1;
    if (
      this.denyConsume ||
      this.issued.get(capability) !== JSON.stringify(binding) ||
      this.consumed.has(capability) ||
      Date.parse(now) >= Date.parse(binding.expiresAt)
    )
      return false;
    this.consumed.add(capability);
    this.onConsume?.();
    return true;
  }
}

function setup(
  options: {
    readonly valuePlan?: OperatorMainnetTestPlan;
    readonly evidence?: MainnetOperatorTestFreshEvidence;
    readonly persistenceAccount?: string;
    readonly runId?: string;
    readonly failSourceInsert?: boolean;
    readonly failAttemptInsert?: boolean;
    readonly onCollect?: (
      persistence: MainnetOperatorTestDependencies["persistence"],
    ) => void;
  } = {},
) {
  const root = mkdtempSync(
    join(tmpdir(), "application-mainnet-operator-test-"),
  );
  roots.push(root);
  const databasePath = join(root, "mainnet.db");
  const valuePlan = options.valuePlan ?? plan();
  const valueApproval = approval(valuePlan);
  const clock = { now: NOW };
  const persistence = unwrap(
    openSqlitePersistence({
      environment: "mainnet",
      databasePath,
      scope: scope(options.persistenceAccount ?? valuePlan.accountIdentityHash),
      runtime,
      clock: { now: () => clock.now },
    }),
  );
  const journal = persistence.operatorMainnetTest;
  assert.ok(journal);
  if (options.failAttemptInsert || options.failSourceInsert) {
    persistence.close();
    const connection = unwrap(
      openSqliteConnection({
        environment: "mainnet",
        databasePath,
        runtime,
        clock: { now: () => clock.now },
      }),
    );
    connection.db.exec(
      options.failSourceInsert
        ? "CREATE TRIGGER fail_operator_test_source BEFORE INSERT ON operator_mainnet_test_sources BEGIN SELECT RAISE(ABORT, 'forced source failure'); END;"
        : "CREATE TRIGGER fail_operator_test_attempt BEFORE INSERT ON operator_mainnet_test_attempts BEGIN SELECT RAISE(ABORT, 'forced attempt failure'); END;",
    );
    connection.close();
    const reopened = unwrap(
      openSqlitePersistence({
        environment: "mainnet",
        databasePath,
        scope: scope(
          options.persistenceAccount ?? valuePlan.accountIdentityHash,
        ),
        runtime,
        clock: { now: () => clock.now },
      }),
    );
    return setupWithPersistence(
      root,
      databasePath,
      valuePlan,
      valueApproval,
      clock,
      reopened,
      options.evidence,
      options.onCollect,
    );
  }
  return setupWithPersistence(
    root,
    databasePath,
    valuePlan,
    valueApproval,
    clock,
    persistence,
    options.evidence,
    options.onCollect,
  );
}

function setupWithPersistence(
  root: string,
  databasePath: string,
  valuePlan: OperatorMainnetTestPlan,
  valueApproval: ReturnType<typeof approval>,
  clock: { now: UtcTimestamp },
  persistence: ReturnType<typeof openSqlitePersistence> extends Result<infer T>
    ? T
    : never,
  suppliedEvidence?: MainnetOperatorTestFreshEvidence,
  onCollect?: (
    persistence: MainnetOperatorTestDependencies["persistence"],
  ) => void,
) {
  const journal = persistence.operatorMainnetTest;
  assert.ok(journal);
  const authorization = new TestAuthorization();
  const selectedEvidence = suppliedEvidence ?? freshEvidence(valuePlan);
  const createObservations: Array<{
    readonly durableIntent: boolean;
    readonly payloadMatches: boolean;
  }> = [];
  const dependencies: MainnetOperatorTestDependencies = {
    persistence,
    journal,
    evidence: {
      collect: async () => {
        onCollect?.(persistence);
        return selectedEvidence;
      },
    },
    authorization,
    localClock: { now: () => clock.now },
    monotonicClock: () => 10,
    exchange: {
      async createOrder(request) {
        const sourceId = unwrap(
          deriveOperatorMainnetTestSourceId(valuePlan.contentHash),
        );
        const source = unwrap(journal.readOperatorMainnetTestSource(sourceId));
        const expected = unwrap(createOperatorMainnetCreateRequest(valuePlan));
        createObservations.push({
          durableIntent:
            source !== undefined &&
            source.intent.operation === "CREATE" &&
            source.attempt === undefined,
          payloadMatches:
            source?.source.payloadJson ===
              JSON.stringify(mapCreateOrderRequest(request)) &&
            source?.source.payloadJson === expected.payloadJson,
        });
        return {
          ok: true as const,
          value: {
            clientOrderId: valuePlan.clientOrderId,
            exchangeOrderId: "test-exchange-order-1",
            acknowledgedAt: NOW,
            status: "accepted" as const,
          },
        };
      },
    },
  };
  const input = {
    approval: valueApproval,
    approvalHash: valueApproval.contentHash,
    runId: "operator-run-01",
  };
  return {
    root,
    databasePath,
    clock,
    valuePlan,
    valueApproval,
    persistence,
    journal,
    authorization,
    dependencies,
    input,
    createObservations,
    run: () => executeMainnetOperatorTest(input, dependencies),
  };
}

test("one durable exact CREATE intent exists before the only exchange dispatch", async () => {
  const harness = setup();
  const result = await harness.run();
  const outcome = unwrap(result);
  assert.equal(outcome.kind, "attempted");
  assert.equal(outcome.attemptOutcome, "accepted");
  assert.equal(outcome.attemptJournaled, true);
  assert.equal(harness.authorization.consumeCalls, 1);
  assert.deepEqual(harness.createObservations, [
    { durableIntent: true, payloadMatches: true },
  ]);
  const sourceId = unwrap(
    deriveOperatorMainnetTestSourceId(harness.valuePlan.contentHash),
  );
  const source = unwrap(
    harness.journal.readOperatorMainnetTestSource(sourceId),
  );
  assert.equal(source?.attempt?.outcome, "accepted");
  assert.equal(
    source?.source.payloadHash,
    unwrap(createOperatorMainnetCreateRequest(harness.valuePlan)).payloadHash,
  );
  harness.persistence.close();
  const reopened = unwrap(
    openSqlitePersistence({
      environment: "mainnet",
      databasePath: harness.databasePath,
      scope: scope(harness.valuePlan.accountIdentityHash),
      runtime,
      clock: { now: () => harness.clock.now },
    }),
  );
  const reopenedJournal = reopened.operatorMainnetTest;
  assert.ok(reopenedJournal);
  const restart = await executeMainnetOperatorTest(harness.input, {
    ...harness.dependencies,
    persistence: reopened,
    journal: reopenedJournal,
  });
  assert.equal(unwrap(restart).kind, "recovery");
  assert.equal(harness.createObservations.length, 1);
  reopened.close();
});

// Production preparation binds OS Keychain and Bybit reads; persist the same
// canonical prepared artifact here, then exercise app-level CREATE and status
// with fake exchange ports and a reopened SQLite connection.
test("temporary SQLite prepared plan survives reopen between one fake CREATE and TP cleanup status", async () => {
  const harness = setup();
  assert.equal(harness.journal.persistPreparedPlan(harness.valuePlan).ok, true);
  const prepared = unwrap(
    harness.journal.readPreparedPlan(harness.valuePlan.contentHash),
  );
  assert.equal(prepared?.contentHash, harness.valuePlan.contentHash);

  const execute = unwrap(await harness.run());
  assert.equal(execute.kind, "attempted");
  assert.equal(execute.attemptOutcome, "accepted");
  assert.equal(harness.createObservations.length, 1);
  assert.deepEqual(harness.createObservations, [
    { durableIntent: true, payloadMatches: true },
  ]);

  const observedAt = at(Date.parse(NOW) + 2_000);
  harness.clock.now = observedAt;
  harness.persistence.close();
  const reopenedPersistence = unwrap(
    openSqlitePersistence({
      environment: "mainnet",
      databasePath: harness.databasePath,
      scope: scope(harness.valuePlan.accountIdentityHash),
      runtime,
      clock: { now: () => harness.clock.now },
    }),
  );
  const reopenedJournal = reopenedPersistence.operatorMainnetTest;
  assert.ok(reopenedJournal);
  const entryOrder = unwrap(
    createExchangeOrder({
      exchangeOrderId: "test-exchange-order-1",
      clientOrderId: harness.valuePlan.clientOrderId,
      instrument: harness.valuePlan.symbol,
      side: "buy",
      requestedQuantity: harness.valuePlan.entry.quantity.toString(),
      filledQuantity: harness.valuePlan.entry.quantity.toString(),
      status: "filled",
      observedAt,
      source: "bybit-mainnet/order/realtime",
      category: "linear",
      orderType: "limit",
      price: harness.valuePlan.entry.limitPrice.toString(),
      timeInForce: "GTC",
      takeProfit: harness.valuePlan.entry.takeProfit.triggerPrice.toString(),
      stopLoss: null,
      reduceOnly: false,
      positionIdx: 0,
      providerCreatedAt: at(Date.parse(NOW) + 100),
      providerUpdatedAt: at(Date.parse(NOW) + 1_500),
    }),
  );
  const tpOrder = unwrap(
    createExchangeOrder({
      exchangeOrderId: "test-exchange-tp-order-1",
      clientOrderId: "test-exchange-tp-client-1",
      providerOrderLinkId: "test-exchange-tp-client-1",
      parentOrderLinkId: harness.valuePlan.clientOrderId,
      instrument: harness.valuePlan.symbol,
      side: "sell",
      requestedQuantity: harness.valuePlan.entry.quantity.toString(),
      filledQuantity: harness.valuePlan.entry.quantity.toString(),
      status: "filled",
      observedAt,
      source: "bybit-mainnet/protection/order/realtime",
      category: "linear",
      orderType: "market",
      triggerPrice: harness.valuePlan.entry.takeProfit.triggerPrice.toString(),
      protectionType: "take-profit",
      providerStopOrderType: "PartialTakeProfit",
      providerTpslMode: "Partial",
      triggerBy: "LastPrice",
      takeProfitTriggerBy: "LastPrice",
      stopLoss: null,
      reduceOnly: true,
      positionIdx: 0,
      providerCreatedAt: at(Date.parse(NOW) + 1_000),
      providerUpdatedAt: at(Date.parse(NOW) + 1_500),
    }),
  );
  const entryFill = {
    executionId: "test-entry-execution-1",
    exchangeOrderId: entryOrder.exchangeOrderId,
    clientOrderId: harness.valuePlan.clientOrderId,
    instrument: harness.valuePlan.symbol,
    side: "buy" as const,
    quantity: harness.valuePlan.entry.quantity,
    price: harness.valuePlan.entry.limitPrice,
    executedAt: at(Date.parse(NOW) + 500),
    source: "bybit-mainnet/execution",
  };
  const exitFill = {
    executionId: "test-tp-execution-1",
    exchangeOrderId: tpOrder.exchangeOrderId,
    clientOrderId: tpOrder.clientOrderId,
    instrument: harness.valuePlan.symbol,
    side: "sell" as const,
    quantity: harness.valuePlan.entry.quantity,
    price: harness.valuePlan.entry.takeProfit.triggerPrice,
    executedAt: at(Date.parse(NOW) + 1_500),
    source: "bybit-mainnet/execution",
  };
  let statusReads = 0;
  const observation: MainnetOperatorTestStatusObservation = {
    observedAt,
    parentLookupComplete: true,
    parent: entryOrder,
    entryFills: [entryFill],
    children: [tpOrder],
    childFills: [
      {
        exchangeOrderId: tpOrder.exchangeOrderId,
        clientOrderId: tpOrder.clientOrderId,
        fills: [exitFill],
      },
    ],
    position: {
      instrument: harness.valuePlan.symbol,
      side: "flat",
      quantity: decimal("0"),
    },
    activeOrders: [],
    exchangeReads: 9,
  };
  const sourceId = unwrap(
    deriveOperatorMainnetTestSourceId(harness.valuePlan.contentHash),
  );
  const status = unwrap(
    await runMainnetOperatorTestStatus(
      { sourceId },
      {
        persistence: reopenedPersistence,
        journal: reopenedJournal,
        exchange: {
          async observe() {
            statusReads += 1;
            return { ok: true, value: observation };
          },
        },
        clock: { now: () => harness.clock.now },
      },
    ),
  );
  assert.equal(statusReads, 1);
  assert.equal(status.exchangeReads, 9);
  assert.equal(status.lifecycleOutcome, "TP_LIFECYCLE_PASS");
  assert.equal(status.cleanupStatus, "verified-clean");
  assert.equal(status.latestSnapshot.reconciliations.length, 1);
  assert.equal(harness.createObservations.length, 1);
  const durableSource = unwrap(
    reopenedJournal.readOperatorMainnetTestSource(sourceId),
  );
  assert.equal(durableSource?.attempt?.outcome, "accepted");
  assert.equal(
    status.latestSnapshot.source.payloadHash,
    durableSource?.source.payloadHash,
  );
  reopenedPersistence.close();
});

test("IP-unbound is admitted only as the same explicit plan warning", async () => {
  const unboundPlan = plan({ warningCodes: ["API_KEY_IP_UNBOUND"] });
  const harness = setup({
    valuePlan: unboundPlan,
    evidence: freshEvidence(unboundPlan, { ipBound: false }),
  });
  const result = await harness.run();
  const outcome = unwrap(result);
  assert.equal(outcome.kind, "attempted");
  assert.equal(harness.createObservations.length, 1);
  harness.persistence.close();
});

test("account, credentials, capacity, position, orders, leverage and instrument admission failures dispatch no CREATE", async () => {
  const cases: Array<[string, EvidenceOverrides]> = [
    [
      "wrong authenticated account",
      { accountIdentityHash: `sha256:${"b".repeat(64)}` },
    ],
    ["read-only key", { readOnly: true }],
    ["missing order permission", { contractOrder: false }],
    ["missing position permission", { contractPosition: false }],
    ["transfer permission", { walletTransfer: true }],
    [
      "insufficient available margin and fee reserve",
      { availableBalance: "0" },
    ],
    [
      "target position is not flat",
      { positionSide: "long", positionQuantity: "0.01" },
    ],
    ["target has an active order", { openOrder: true }],
    ["leverage is not one-way 1x", { leverage: "2" }],
    ["wrong instrument", { instrumentSymbol: "ETHUSDT" }],
    ["instrument is not trading", { instrumentStatus: "Suspended" }],
    ["approved instrument limit changed", { constraintTick: "1" }],
  ];
  for (const [name, overrides] of cases) {
    const valuePlan = plan({ nonce: `blocked-${name.replaceAll(" ", "-")}` });
    const harness = setup({
      valuePlan,
      evidence: freshEvidence(valuePlan, overrides),
    });
    const result = await harness.run();
    assert.equal(
      harness.createObservations.length,
      0,
      `${name} must not dispatch`,
    );
    assert.equal(result.ok, false, `${name} must fail admission`);
    const sourceId = unwrap(
      deriveOperatorMainnetTestSourceId(valuePlan.contentHash),
    );
    assert.equal(
      unwrap(harness.journal.readOperatorMainnetTestSource(sourceId)),
      undefined,
    );
    harness.persistence.close();
  }
});

test("persistence scope mismatch, approval expiry, stale quote and HALT all block before dispatch", async () => {
  const wrongScope = setup({ persistenceAccount: `sha256:${"c".repeat(64)}` });
  const scopeResult = await wrongScope.run();
  assert.equal(scopeResult.ok, false);
  assert.equal(wrongScope.createObservations.length, 0);
  wrongScope.persistence.close();

  const expiredAt = at(Date.parse(NOW) - 900_001);
  const expiredPlan = plan({
    nonce: "expired-approval",
    preparedAt: expiredAt,
  });
  const expiredHarness = setup({ valuePlan: expiredPlan });
  const expiredApproval = approval(expiredPlan, expiredAt);
  const expiredResult = await executeMainnetOperatorTest(
    {
      ...expiredHarness.input,
      approval: expiredApproval,
      approvalHash: expiredApproval.contentHash,
    },
    expiredHarness.dependencies,
  );
  assert.equal(expiredResult.ok, false);
  assert.equal(expiredHarness.createObservations.length, 0);
  expiredHarness.persistence.close();

  const stalePlan = plan({ nonce: "stale-evidence" });
  const staleEvidence = freshEvidence(stalePlan, {
    serverTime: at(Date.parse(NOW) + 6_000),
    quoteObservedAt: NOW,
  });
  const staleHarness = setup({ valuePlan: stalePlan, evidence: staleEvidence });
  const staleResult = await staleHarness.run();
  assert.equal(staleResult.ok, false);
  assert.equal(staleHarness.createObservations.length, 0);
  staleHarness.persistence.close();

  const haltHarness = setup();
  const lease = unwrap(
    haltHarness.persistence.acquireLease({
      scope: haltHarness.persistence.scope,
      ownerRunId: haltHarness.input.runId,
      now: NOW,
      ttlMs: 60_000,
    }),
  );
  unwrap(
    haltHarness.persistence.raiseHalt(
      { ownerRunId: lease.ownerRunId, epoch: lease.epoch },
      "test HALT",
      NOW,
    ),
  );
  const haltResult = await haltHarness.run();
  assert.equal(haltResult.ok, false);
  assert.equal(haltHarness.createObservations.length, 0);
  haltHarness.persistence.close();
});

test("same-account pending source blocks a different nonce even with fresh evidence", async () => {
  const secondPlan = plan({ nonce: "new-nonce" });
  const harness = setup({ valuePlan: secondPlan });
  const firstPlan = plan({ nonce: "unresolved-prior-source" });
  const lease = unwrap(
    harness.persistence.acquireLease({
      scope: harness.persistence.scope,
      ownerRunId: harness.input.runId,
      now: NOW,
      ttlMs: 60_000,
    }),
  );
  const firstApproval = approval(firstPlan);
  const firstCreate = unwrap(createOperatorMainnetCreateRequest(firstPlan));
  unwrap(
    harness.journal.prepareCreateIntent({
      authority: { ownerRunId: lease.ownerRunId, epoch: lease.epoch },
      runId: harness.input.runId,
      plan: firstPlan,
      approval: firstApproval,
      payloadJson: firstCreate.payloadJson,
      payloadHash: firstCreate.payloadHash as PlanHash,
      preparedAt: NOW,
    }),
  );
  const result = await harness.run();
  assert.equal(result.ok, false);
  assert.equal(harness.createObservations.length, 0);
  harness.persistence.close();
});

test("lost lease and failed intent commit both leave the exchange untouched", async () => {
  const lostLease = setup({
    onCollect: (persistence) => {
      const snapshot = unwrap(persistence.readScopeSnapshot());
      assert.ok(snapshot.lease);
      unwrap(
        persistence.releaseLease({
          ownerRunId: snapshot.lease.ownerRunId,
          epoch: snapshot.lease.epoch,
        }),
      );
    },
  });
  const leaseResult = await lostLease.run();
  assert.equal(leaseResult.ok, false);
  assert.equal(lostLease.createObservations.length, 0);
  lostLease.persistence.close();

  const failedCommit = setup({ failSourceInsert: true });
  const commitResult = await failedCommit.run();
  assert.equal(commitResult.ok, false);
  assert.equal(failedCommit.createObservations.length, 0);
  const sourceId = unwrap(
    deriveOperatorMainnetTestSourceId(failedCommit.valuePlan.contentHash),
  );
  assert.equal(
    unwrap(failedCommit.journal.readOperatorMainnetTestSource(sourceId)),
    undefined,
  );
  failedCommit.persistence.close();
});

test("consumed capability denial after durable intent is recovery-only and never resends", async () => {
  const harness = setup();
  harness.authorization.denyConsume = true;
  const result = await harness.run();
  assert.equal(unwrap(result).kind, "recovery");
  assert.equal(harness.createObservations.length, 0);
  harness.authorization.denyConsume = false;
  const restart = await harness.run();
  assert.equal(unwrap(restart).kind, "recovery");
  assert.equal(harness.createObservations.length, 0);
  harness.persistence.close();
});

test("a forged object capability cannot authorize the persisted intent", async () => {
  const harness = setup();
  harness.authorization.forgeIssue = true;
  const result = await harness.run();
  assert.equal(unwrap(result).kind, "recovery");
  assert.equal(harness.authorization.consumeCalls, 1);
  assert.equal(harness.createObservations.length, 0);
  harness.persistence.close();
});

test("post-dispatch journal failure remains ambiguous and restart cannot resend", async () => {
  const harness = setup({ failAttemptInsert: true });
  const result = await harness.run();
  const outcome = unwrap(result);
  assert.equal(outcome.kind, "recovery");
  assert.equal(outcome.attemptOutcome, "ambiguous");
  assert.equal(harness.createObservations.length, 1);
  const restart = await harness.run();
  assert.equal(unwrap(restart).kind, "recovery");
  assert.equal(harness.createObservations.length, 1);
  harness.persistence.close();
});
