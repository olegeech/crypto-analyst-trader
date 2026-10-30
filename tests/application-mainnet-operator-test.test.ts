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
  createAccountOrderEvidence,
  createAccountPositionEvidence,
  type AccountEvidenceBundle,
} from "../src/domain/account/account-evidence-bundle.js";
import { createAdapterCapabilityObservation } from "../src/domain/capabilities/capability.js";
import {
  createOperatorMainnetQuote,
  createOperatorMainnetTestApproval,
  createOperatorMainnetTestPlan,
  deriveOperatorMainnetTestSourceId,
} from "../src/domain/execution/operator-mainnet-test-plan.js";
import { createOperatorMainnetRecoveryAttestation } from "../src/domain/execution/operator-mainnet-recovery.js";
import { recoverMainnetOperatorTest } from "../src/application/mainnet-operator-test-recovery.js";
import {
  resolveOperatorMainnetPlan,
  resolveOperatorMainnetSource,
} from "../src/adapters/sqlite/operator-mainnet-test-lookup.js";
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
  calculateOperatorMainnetTestCapacity,
  validateMainnetOperatorTestEvidence,
  createOperatorMainnetCreateRequest,
  createOperatorMainnetFeeRateEvidence,
  OPERATOR_MAINNET_COMPACT_ACCOUNT_SCHEMA_VERSION,
  type MainnetOperatorTestAdmissionEvidence,
  type MainnetOperatorTestFreshEvidence,
  type MainnetOperatorTestCompactFreshEvidence,
} from "../src/application/mainnet-entry-evidence.js";
import {
  extractOperatorFeeRate,
  collectOperatorAdmissionEvidence,
} from "../src/application/mainnet-operator-test-evidence.js";
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
import {
  fixture as accountFixture,
  order as accountOrder,
  position as accountPosition,
} from "./account-evidence-fixture.js";

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
    readonly recoveryAttestationHash?: PlanHash;
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
      ...(options.recoveryAttestationHash === undefined
        ? {}
        : { recoveryAttestationHash: options.recoveryAttestationHash }),
    }),
  );
}

function manualTargetAttestation(
  accountIdentityHash: string,
  options: {
    readonly observedAt?: UtcTimestamp;
    readonly targetLeverage?: string;
    readonly accountPositions?: readonly {
      readonly symbol: string;
      readonly side: "Buy" | "Sell";
      readonly quantity: string;
    }[];
  } = {},
) {
  const priorPlan = plan({ nonce: "manual-recovery-prior-plan" });
  return unwrap(
    createOperatorMainnetRecoveryAttestation({
      provenance: "MANUAL_ATTESTED_NOT_API_VERIFIED",
      exchange: "bybit",
      environment: "mainnet",
      accountIdentityHash,
      sourceId: "manual-recovery-prior-source",
      sourcePlanHash: priorPlan.contentHash,
      sourceIntentId: "manual-recovery-prior-intent",
      sourceRevision: 1,
      actor: "operator-test",
      observedAt: options.observedAt ?? at(Date.parse(NOW) - 1_000),
      inspection: {
        accountOpenOrdersInspected: true,
        accountOpenOrders: [],
        accountPositionsInspected: true,
        accountPositions: options.accountPositions ?? [],
        sourceOrderHistoryInspected: true,
        sourceOrders: [],
        sourceFillsInspected: true,
        sourceFills: [],
        sourcePositionInspected: true,
        sourcePosition: null,
        targetLeverage: options.targetLeverage ?? "1",
        sourceTakeProfitInspected: true,
        sourceTakeProfitOrders: [],
      },
      manualActions: ["none"],
      acceptedUncertainty: ["manual-ui-may-be-stale"],
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

function compactEvidence(
  valuePlan: OperatorMainnetTestPlan,
  availableBalance = "1000",
): MainnetOperatorTestCompactFreshEvidence {
  const fresh = freshEvidence(valuePlan);
  const passA = fresh.account.criticalPasses.A;
  const passB = fresh.account.criticalPasses.B;
  assert.ok(passA);
  assert.ok(passB);
  const observation = (mode: typeof passA.account) =>
    Object.freeze({
      mode,
      availableBalance: decimal(availableBalance),
      modeObservedAt: NOW,
      balanceObservedAt: NOW,
    });
  return {
    compactAccount: {
      schemaVersion: OPERATOR_MAINNET_COMPACT_ACCOUNT_SCHEMA_VERSION,
      accountBinding: fresh.account.accountBinding,
      credentialPosture: fresh.account.credentialPosture,
      observations: [observation(passA.account), observation(passB.account)],
    },
    state: fresh.state,
    instrument: fresh.instrument,
    quote: fresh.quote,
    feeRate: fresh.feeRate,
  };
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
    readonly evidence?: MainnetOperatorTestAdmissionEvidence;
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
  suppliedEvidence?: MainnetOperatorTestAdmissionEvidence,
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
  assert.equal(unwrap(harness.persistence.readHalt()).active, false);
  assert.equal(
    unwrap(harness.journal.findPendingOperatorMainnetTestSource())?.sourceId,
    sourceId,
  );
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

test("UNKNOWN status raises a source-linked incident HALT and clean status keeps it active", async () => {
  const harness = setup();
  const execute = unwrap(await harness.run());
  assert.equal(execute.attemptOutcome, "accepted");
  assert.equal(unwrap(harness.persistence.readHalt()).active, false);

  const sourceId = unwrap(
    deriveOperatorMainnetTestSourceId(harness.valuePlan.contentHash),
  );
  const unknown = await runMainnetOperatorTestStatus(
    { sourceId },
    {
      persistence: harness.persistence,
      journal: harness.journal,
      exchange: {
        async observe() {
          throw new Error("temporary status read failure");
        },
      },
      clock: { now: () => harness.clock.now },
    },
  );
  const unknownStatus = unwrap(unknown);
  assert.equal(unknownStatus.lifecycleOutcome, "UNKNOWN");
  assert.equal(unknownStatus.halt.active, true);

  const observedAt = at(Date.parse(NOW) + 1_000);
  const cancelledParent = unwrap(
    createExchangeOrder({
      exchangeOrderId: "test-exchange-order-1",
      clientOrderId: harness.valuePlan.clientOrderId,
      instrument: harness.valuePlan.symbol,
      side: "buy",
      requestedQuantity: harness.valuePlan.entry.quantity.toString(),
      filledQuantity: "0",
      status: "cancelled",
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
      providerUpdatedAt: observedAt,
    }),
  );
  const resolved = unwrap(
    await runMainnetOperatorTestStatus(
      { sourceId },
      {
        persistence: harness.persistence,
        journal: harness.journal,
        exchange: {
          async observe() {
            return {
              ok: true as const,
              value: {
                observedAt,
                parentLookupComplete: true,
                parent: cancelledParent,
                entryFills: [],
                children: [],
                childFills: [],
                position: {
                  instrument: harness.valuePlan.symbol,
                  side: "flat",
                  quantity: decimal("0"),
                },
                activeOrders: [],
                exchangeReads: 3,
              },
            };
          },
        },
        clock: { now: () => observedAt },
      },
    ),
  );
  assert.equal(resolved.lifecycleOutcome, "NOT_EXERCISED");
  assert.equal(resolved.cleanupStatus, "verified-clean");
  assert.equal(resolved.halt.active, true);

  harness.persistence.close();
  const connection = unwrap(
    openSqliteConnection({
      environment: "mainnet",
      databasePath: harness.databasePath,
      runtime,
      clock: { now: () => observedAt },
    }),
  );
  const event = connection.db
    .prepare("SELECT evidence_json FROM halt_events WHERE account_id = ?")
    .get(ACCOUNT) as { readonly evidence_json: string | null } | undefined;
  assert.ok(event?.evidence_json);
  const evidence = JSON.parse(event.evidence_json) as Record<string, unknown>;
  assert.equal(evidence.schemaVersion, "operator-mainnet-halt-origin/v1");
  assert.equal(evidence.sourceId, sourceId);
  assert.equal(
    evidence.writeIntentId,
    resolved.latestSnapshot.intent.writeIntentId,
  );
  connection.close();
});

test("compact admission accepts the same exact-plan CREATE proof without full account history", async () => {
  const valuePlan = plan({ nonce: "compact-admission-success" });
  const harness = setup({
    valuePlan,
    evidence: compactEvidence(valuePlan),
  });

  const result = await harness.run();

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.kind, "attempted");
  assert.equal(harness.authorization.consumeCalls, 1);
  assert.deepEqual(harness.createObservations, [
    { durableIntent: true, payloadMatches: true },
  ]);
  harness.persistence.close();
});

test("compact capacity check blocks before durable intent and retains exact shortfall", async () => {
  const valuePlan = plan({ nonce: "compact-insufficient-capacity" });
  const harness = setup({
    valuePlan,
    evidence: compactEvidence(valuePlan, "1.25"),
  });

  const result = await harness.run();

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(
    result.error.details?.reasonCode,
    "AVAILABLE_MARGIN_OR_FEE_RESERVE_INSUFFICIENT",
  );
  assert.equal(result.error.details?.availableBalance, "1.25");
  assert.equal(typeof result.error.details?.shortfall, "string");
  assert.equal(harness.authorization.consumeCalls, 0);
  assert.equal(harness.createObservations.length, 0);
  const sourceId = unwrap(
    deriveOperatorMainnetTestSourceId(valuePlan.contentHash),
  );
  assert.equal(
    unwrap(harness.journal.readOperatorMainnetTestSource(sourceId)),
    undefined,
  );
  harness.persistence.close();
});

test("compact A/B balance disagreement is reported as a safe capacity predicate", async () => {
  const valuePlan = plan({ nonce: "compact-balance-disagreement" });
  const evidence = compactEvidence(valuePlan);
  const first = evidence.compactAccount.observations[0];
  const second = evidence.compactAccount.observations[1];
  const changed: MainnetOperatorTestCompactFreshEvidence = {
    ...evidence,
    compactAccount: {
      ...evidence.compactAccount,
      observations: [first, { ...second, availableBalance: decimal("999.99") }],
    },
  };
  const harness = setup({ valuePlan, evidence: changed });

  const result = await harness.run();

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(
    result.error.details?.reasonCode,
    "AVAILABLE_BALANCE_SNAPSHOTS_DIFFER",
  );
  assert.equal(result.error.details?.pass, "A/B");
  assert.equal(result.error.details?.predicate, "totalAvailableBalance");
  assert.equal(result.error.details?.availableBalance, undefined);
  assert.equal(harness.authorization.consumeCalls, 0);
  assert.equal(harness.createObservations.length, 0);
  const sourceId = unwrap(
    deriveOperatorMainnetTestSourceId(valuePlan.contentHash),
  );
  assert.equal(
    unwrap(harness.journal.readOperatorMainnetTestSource(sourceId)),
    undefined,
  );
  harness.persistence.close();
});

test("incomplete current positions and orders identify the account pass and predicate", () => {
  const cases = [
    { pass: "A", group: "positions", predicate: "position-margin" },
    { pass: "B", group: "orders", predicate: "order-price" },
  ] as const;

  for (const [index, item] of cases.entries()) {
    const valuePlan = plan({ nonce: `incomplete-commitment-${index}` });
    const evidence = freshEvidence(valuePlan);
    let account = evidence.account;
    const sourcePass =
      item.pass === "A" ? account.criticalPasses.A : account.criticalPasses.B;
    assert.ok(sourcePass);
    let changedPass: typeof sourcePass;
    if (item.group === "positions") {
      const positions = [
        ...sourcePass.positions,
        unwrap(
          createAccountPositionEvidence({
            ...accountPosition(),
            side: "Buy",
            size: { state: "known", value: "1", unit: "contracts" },
            positionValue: { state: "known", value: "100", unit: "USD" },
            positionIM: { state: "known", value: "10", unit: "USD" },
            leverage: { state: "known", value: "1", unit: "rate" },
          }),
        ),
      ];
      const rowIndex = positions.findIndex(
        (position) => position.category === "linear",
      );
      assert.notEqual(rowIndex, -1);
      changedPass = {
        ...sourcePass,
        positions: positions.map((position, currentIndex) =>
          currentIndex === rowIndex
            ? ({
                ...position,
                size: {
                  state: "known",
                  value: decimal("1"),
                  unit: "contracts",
                },
                positionValue: {
                  state: "known",
                  value: decimal("100"),
                  unit: "USD",
                },
                positionIM: {
                  state: "unavailable",
                  reason: "not-returned",
                  unit: "USD",
                },
              } as typeof position)
            : position,
        ),
      };
    } else {
      const orders = [
        ...sourcePass.orders,
        unwrap(createAccountOrderEvidence(accountOrder())),
      ];
      const rowIndex = orders.findIndex((order) => order.category === "linear");
      assert.notEqual(rowIndex, -1);
      changedPass = {
        ...sourcePass,
        orders: orders.map((order, currentIndex) =>
          currentIndex === rowIndex
            ? ({
                ...order,
                price: {
                  state: "unavailable",
                  reason: "not-returned",
                  unit: "price",
                },
              } as typeof order)
            : order,
        ),
      };
    }
    account = {
      ...account,
      criticalPasses: {
        ...account.criticalPasses,
        [item.pass]: changedPass,
      },
    } as AccountEvidenceBundle;

    const capacity = calculateOperatorMainnetTestCapacity(
      valuePlan,
      account,
      evidence.feeRate,
    );

    assert.equal(capacity.ok, false);
    if (capacity.ok) continue;
    assert.equal(
      capacity.error.details?.reasonCode,
      "CURRENT_COMMITMENTS_INCOMPLETE",
    );
    assert.equal(capacity.error.details?.pass, item.pass);
    assert.equal(capacity.error.details?.group, item.group);
    assert.equal(capacity.error.details?.predicate, item.predicate);
  }
});

test("compact admission blocks a non-flat target position without durable intent", async () => {
  const valuePlan = plan({ nonce: "compact-target-state-changed" });
  const evidence = compactEvidence(valuePlan);
  assert.ok(evidence.state);
  const state = evidence.state;
  const changedEvidence: MainnetOperatorTestCompactFreshEvidence = {
    ...evidence,
    state: {
      ...state,
      position: {
        ...state.position,
        side: "long",
        quantity: decimal("0.01"),
      },
    },
  };
  const harness = setup({ valuePlan, evidence: changedEvidence });

  const result = await harness.run();

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(
    result.error.details?.reasonCode,
    "TARGET_STATE_OR_CAPABILITY_BLOCKED",
  );
  assert.equal(result.error.details?.source, "position");
  assert.equal(result.error.details?.positionSide, "long");
  assert.equal(result.error.details?.positionQuantity, "0.01");
  assert.equal(harness.createObservations.length, 0);
  harness.persistence.close();
});

test("scoped manual recovery replaces only unavailable target position and order facts", () => {
  const attestation = manualTargetAttestation(ACCOUNT);
  const valuePlan = plan({
    nonce: "manual-target-fallback",
    recoveryAttestationHash: attestation.contentHash,
  });
  const compact = compactEvidence(valuePlan);
  const fresh = freshEvidence(valuePlan);
  const evidence: MainnetOperatorTestCompactFreshEvidence = {
    compactAccount: compact.compactAccount,
    manualTargetState: {
      serverTime: NOW,
      capabilities: fresh.state.capabilities,
      position: {
        status: "unavailable",
        reasonCode: "TARGET_POSITION_READ_FAILED",
      },
      openOrders: {
        status: "unavailable",
        reasonCode: "TARGET_ORDERS_READ_FAILED",
      },
      attestation,
    },
    instrument: fresh.instrument,
    quote: fresh.quote,
    feeRate: fresh.feeRate,
  };

  const result = validateMainnetOperatorTestEvidence(valuePlan, evidence);

  assert.equal(
    result.ok,
    true,
    result.ok ? undefined : JSON.stringify(result.error),
  );
  if (result.ok) assert.equal(result.value.manualTargetAgeAtReadMs, 1_000);
});

test("manual recovery blocks stale, exposed or non-1x UI target facts", () => {
  const cases = [
    {
      name: "stale UI observation",
      options: { observedAt: at(Date.parse(NOW) - 301_000) },
      expected: "MANUAL_TARGET_EVIDENCE_STALE",
    },
    {
      name: "unrelated account position",
      options: {
        accountPositions: [
          { symbol: "ETHUSDT", side: "Buy" as const, quantity: "1" },
        ],
      },
      expected: "MANUAL_TARGET_EVIDENCE_INVALID",
    },
    {
      name: "target leverage differs from the required 1x",
      options: { targetLeverage: "2" },
      expected: "MANUAL_TARGET_EVIDENCE_INVALID",
    },
  ] as const;

  for (const [index, item] of cases.entries()) {
    const attestation = manualTargetAttestation(ACCOUNT, item.options);
    const valuePlan = plan({
      nonce: `manual-target-block-${index}`,
      recoveryAttestationHash: attestation.contentHash,
    });
    const compact = compactEvidence(valuePlan);
    const fresh = freshEvidence(valuePlan);
    const result = validateMainnetOperatorTestEvidence(valuePlan, {
      compactAccount: compact.compactAccount,
      manualTargetState: {
        serverTime: NOW,
        capabilities: fresh.state.capabilities,
        position: {
          status: "unavailable",
          reasonCode: "TARGET_POSITION_READ_FAILED",
        },
        openOrders: {
          status: "unavailable",
          reasonCode: "TARGET_ORDERS_READ_FAILED",
        },
        attestation,
      },
      instrument: fresh.instrument,
      quote: fresh.quote,
      feeRate: fresh.feeRate,
    });
    assert.equal(result.ok, false, item.name);
    if (!result.ok)
      assert.equal(result.error.details?.reasonCode, item.expected);
  }
});

test("fresh API target facts at or after the UI observation override manual flat claims", () => {
  const attestation = manualTargetAttestation(ACCOUNT);
  const valuePlan = plan({
    nonce: "manual-target-api-contradiction",
    recoveryAttestationHash: attestation.contentHash,
  });
  const compact = compactEvidence(valuePlan);
  const fresh = freshEvidence(valuePlan);
  const evidence: MainnetOperatorTestCompactFreshEvidence = {
    compactAccount: compact.compactAccount,
    manualTargetState: {
      serverTime: NOW,
      capabilities: fresh.state.capabilities,
      position: {
        status: "available",
        observedAt: NOW,
        value: {
          ...fresh.state.position,
          side: "long",
          quantity: decimal("0.01"),
        },
      },
      openOrders: {
        status: "available",
        observedAt: NOW,
        value: [],
      },
      attestation,
    },
    instrument: fresh.instrument,
    quote: fresh.quote,
    feeRate: fresh.feeRate,
  };

  const result = validateMainnetOperatorTestEvidence(valuePlan, evidence);

  assert.equal(result.ok, false);
  if (!result.ok)
    assert.equal(
      result.error.details?.causeCode,
      "MANUAL_API_POSITION_CONTRADICTION",
    );
});

test("compact account consistency identifies the changing balance group", async () => {
  const valuePlan = plan({ nonce: "compact-account-balance-changed" });
  const evidence = compactEvidence(valuePlan);
  const changedEvidence: MainnetOperatorTestCompactFreshEvidence = {
    ...evidence,
    compactAccount: {
      ...evidence.compactAccount,
      observations: [
        evidence.compactAccount.observations[0],
        {
          ...evidence.compactAccount.observations[1],
          availableBalance: decimal("999"),
        },
      ],
    },
  };
  const harness = setup({ valuePlan, evidence: changedEvidence });

  const result = await harness.run();

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(
    result.error.details?.reasonCode,
    "AVAILABLE_BALANCE_SNAPSHOTS_DIFFER",
  );
  assert.equal(result.error.details?.pass, "A/B");
  assert.equal(result.error.details?.predicate, "totalAvailableBalance");
  assert.equal(harness.createObservations.length, 0);
  harness.persistence.close();
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

test("one manual recovery grant is consumed with one separately approved CREATE through application and SQLite", async () => {
  const priorPlan = plan({ nonce: "manual-recovery-prior" });
  const base = setup({ valuePlan: priorPlan });
  const journal = base.journal;
  assert.equal(journal.persistPreparedPlan(priorPlan).ok, true);
  const priorCreate = unwrap(createOperatorMainnetCreateRequest(priorPlan));
  const priorSourceId = unwrap(
    deriveOperatorMainnetTestSourceId(priorPlan.contentHash),
  );
  const priorApproval = approval(priorPlan);
  unwrap(
    journal.prepareCreateIntent({
      runId: "prior-run",
      plan: priorPlan,
      approval: priorApproval,
      payloadJson: priorCreate.payloadJson,
      payloadHash: priorCreate.payloadHash as PlanHash,
      preparedAt: NOW,
    }),
  );
  unwrap(
    journal.recordAttempt({
      runId: "prior-run",
      sourceId: priorSourceId,
      attemptId: "prior-attempt",
      outcome: "accepted",
      exchangeOrderId: "prior-exchange-order",
      recordedAt: NOW,
    }),
  );
  unwrap(journal.raiseHalt(priorSourceId, "status evidence unresolved", NOW));
  const prior = unwrap(journal.readOperatorMainnetTestSource(priorSourceId));
  assert.ok(prior);

  const attestation = unwrap(
    createOperatorMainnetRecoveryAttestation({
      provenance: "MANUAL_ATTESTED_NOT_API_VERIFIED",
      exchange: "bybit",
      environment: "mainnet",
      accountIdentityHash: ACCOUNT,
      sourceId: priorSourceId,
      sourcePlanHash: priorPlan.contentHash,
      sourceIntentId: prior.intent.writeIntentId,
      sourceRevision: 1,
      actor: "operator-test",
      observedAt: at(Date.parse(NOW) - 1_000),
      inspection: {
        accountOpenOrdersInspected: true,
        accountOpenOrders: [],
        accountPositionsInspected: true,
        accountPositions: [],
        sourceOrderHistoryInspected: true,
        sourceOrders: [
          {
            orderId: "prior-exchange-order",
            clientOrderId: priorPlan.clientOrderId,
            symbol: priorPlan.symbol,
            side: "Buy",
            orderType: "Limit",
            quantity: priorPlan.entry.quantity.toString(),
            price: priorPlan.entry.limitPrice.toString(),
            status: "Cancelled",
          },
        ],
        sourceFillsInspected: true,
        sourceFills: [],
        sourcePositionInspected: true,
        sourcePosition: null,
        targetLeverage: "1",
        sourceTakeProfitInspected: true,
        sourceTakeProfitOrders: [],
      },
      manualActions: ["none"],
      acceptedUncertainty: ["manual-ui-may-be-stale"],
    }),
  );
  assert.equal(
    journal.persistOperatorMainnetRecoveryAttestation({
      attestation,
      recordedAt: NOW,
    }).ok,
    true,
  );
  const nextPlan = plan({
    nonce: "manual-recovery-next",
    recoveryAttestationHash: attestation.contentHash,
  });
  assert.equal(journal.persistPreparedPlan(nextPlan).ok, true);

  const lookupOptions = {
    databasePath: base.databasePath,
    clock: { now: () => base.clock.now },
  };
  const recovery = unwrap(
    recoverMainnetOperatorTest(
      {
        sourceId: priorSourceId,
        planHash: nextPlan.contentHash,
        resolution: "manual-attested",
        actor: "operator-test",
        consent: true,
        issuedAt: NOW,
      },
      {
        resolveSource: (id: unknown) =>
          resolveOperatorMainnetSource(id, lookupOptions),
        resolvePlan: (hash: unknown) =>
          resolveOperatorMainnetPlan(hash, lookupOptions),
        openPersistence: (settings) =>
          openSqlitePersistence({
            ...settings,
            databasePath: base.databasePath,
            runtime,
            clock: { now: () => base.clock.now },
          }),
      },
    ),
  );
  assert.equal(recovery.exchangeReads, 0);
  assert.equal(recovery.exchangeWrites, 0);
  assert.equal(unwrap(base.persistence.readHalt()).active, false);
  assert.equal(
    unwrap(journal.findPendingOperatorMainnetTestSource())?.sourceId,
    priorSourceId,
    "recovery alone leaves the old source pending",
  );

  const compact = compactEvidence(nextPlan);
  const fresh = freshEvidence(nextPlan);
  const evidence: MainnetOperatorTestCompactFreshEvidence = {
    compactAccount: compact.compactAccount,
    manualTargetState: {
      serverTime: NOW,
      capabilities: fresh.state.capabilities,
      position: {
        status: "unavailable",
        reasonCode: "TARGET_POSITION_READ_FAILED",
      },
      openOrders: {
        status: "unavailable",
        reasonCode: "TARGET_ORDERS_READ_FAILED",
      },
      attestation,
    },
    instrument: fresh.instrument,
    quote: fresh.quote,
    feeRate: fresh.feeRate,
  };
  const next = setupWithPersistence(
    base.root,
    base.databasePath,
    nextPlan,
    approval(nextPlan),
    base.clock,
    base.persistence,
    evidence,
  );
  const outcome = unwrap(await next.run());
  assert.equal(outcome.kind, "attempted");
  assert.equal(outcome.attemptOutcome, "accepted");
  assert.equal(next.authorization.consumeCalls, 1);
  assert.deepEqual(next.createObservations, [
    { durableIntent: true, payloadMatches: true },
  ]);
  const nextSourceId = unwrap(
    deriveOperatorMainnetTestSourceId(nextPlan.contentHash),
  );
  const resolvedPrior = unwrap(
    journal.readOperatorMainnetTestSource(priorSourceId),
  );
  assert.equal(resolvedPrior?.sourceDisposition?.disposition, "human-attested");
  assert.equal(resolvedPrior?.sourceDisposition?.nextSourceId, nextSourceId);
  assert.equal(
    unwrap(journal.findPendingOperatorMainnetTestSource())?.sourceId,
    nextSourceId,
  );
  assert.equal(
    unwrap(journal.findOperatorMainnetRecoveryGrant(nextPlan.contentHash, NOW)),
    undefined,
  );
  base.persistence.close();
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

test("insufficient available balance returns exact capacity amounts and positive shortfall", async () => {
  const valuePlan = plan({ nonce: "insufficient-capacity-details" });
  const availableBalance = decimal("1.25");
  const harness = setup({
    valuePlan,
    evidence: freshEvidence(valuePlan, {
      availableBalance: availableBalance.toString(),
    }),
  });

  const result = await harness.run();

  assert.equal(result.ok, false);
  if (result.ok) return;
  const details = result.error.details;
  assert.equal(
    details?.reasonCode,
    "AVAILABLE_MARGIN_OR_FEE_RESERVE_INSUFFICIENT",
  );
  assert.equal(details?.availableBalance, availableBalance.toString());
  assert.equal(
    details?.orderNotional,
    valuePlan.effectiveGrossNotional.toString(),
  );
  const entryFeeReserve = valuePlan.effectiveGrossNotional.multiply(
    decimal("0.00055"),
  );
  const exitFeeReserve = valuePlan.entry.takeProfit.triggerPrice
    .multiply(valuePlan.entry.quantity)
    .multiply(decimal("0.00055"));
  const totalReserve = entryFeeReserve.add(exitFeeReserve);
  const requiredAvailableBalance =
    valuePlan.effectiveGrossNotional.add(totalReserve);
  assert.equal(details?.entryFeeReserve, entryFeeReserve.toString());
  assert.equal(details?.exitFeeReserve, exitFeeReserve.toString());
  assert.equal(details?.totalReserve, totalReserve.toString());
  assert.equal(
    details?.requiredAvailableBalance,
    requiredAvailableBalance.toString(),
  );
  assert.equal(
    details?.shortfall,
    requiredAvailableBalance.subtract(availableBalance).toString(),
  );
  assert.equal(harness.createObservations.length, 0);
  const sourceId = unwrap(
    deriveOperatorMainnetTestSourceId(valuePlan.contentHash),
  );
  assert.equal(
    unwrap(harness.journal.readOperatorMainnetTestSource(sourceId)),
    undefined,
  );
  harness.persistence.close();
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
  const firstApproval = approval(firstPlan);
  const firstCreate = unwrap(createOperatorMainnetCreateRequest(firstPlan));
  unwrap(
    harness.journal.prepareCreateIntent({
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

test("failed intent commit leaves the exchange untouched", async () => {
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
  assert.equal(unwrap(harness.persistence.readHalt()).active, false);
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
  assert.equal(unwrap(harness.persistence.readHalt()).active, true);
  assert.equal(harness.createObservations.length, 1);
  const restart = await harness.run();
  assert.equal(unwrap(restart).kind, "recovery");
  assert.equal(harness.createObservations.length, 1);
  harness.persistence.close();
});

test("Bybit fee-rate contract accepts legacy and additive RPI rows without changing the fee reserve", () => {
  const row = {
    symbol: "BTCUSDT",
    makerFeeRate: "0.0002",
    takerFeeRate: "0.00055",
  };
  const response = (value: unknown) => ({
    retCode: 0,
    retMsg: "OK",
    result: { list: [value] },
    time: Date.parse(NOW),
  });
  const legacy = extractOperatorFeeRate(response(row), "BTCUSDT");
  assert.ok(legacy.ok);
  for (const rpiMakerFeeRate of ["0.0001", "0", "-0.0001", ""]) {
    const current = extractOperatorFeeRate(
      response({ ...row, rpiMakerFeeRate }),
      "BTCUSDT",
    );
    assert.deepEqual(current, legacy);
  }
  for (const patch of [
    { symbol: "DOGEUSDT" },
    { makerFeeRate: undefined },
    { makerFeeRate: "-0.1" },
    { makerFeeRate: "0.5" },
    { takerFeeRate: "0" },
    { takerFeeRate: "1" },
    { takerFeeRate: "NaN" },
    { rpiMakerFeeRate: null },
    { rpiMakerFeeRate: 0.001 },
    { rpiMakerFeeRate: "NaN" },
    { rpiMakerFeeRate: "1" },
    { rpiMakerFeeRate: "-1" },
  ])
    assert.equal(
      extractOperatorFeeRate(response({ ...row, ...patch }), "BTCUSDT").ok,
      false,
    );
  assert.equal(
    extractOperatorFeeRate(
      { retCode: 0, retMsg: "OK", result: { list: [row] } },
      "BTCUSDT",
    ).ok,
    false,
  );
  for (const time of [0, -1, 1.5, Number.MAX_SAFE_INTEGER])
    assert.equal(
      extractOperatorFeeRate(
        { ...response(row), ...(time === undefined ? {} : { time }) },
        "BTCUSDT",
      ).ok,
      false,
    );
  assert.equal(
    extractOperatorFeeRate(
      { ...response(row), result: { list: [row, row] } },
      "BTCUSDT",
    ).ok,
    false,
  );
});

test("admission collection preserves a safe stage reason and never creates an intent on failure", async () => {
  for (const stage of [
    "fee",
    "quote",
    "state",
    "validation",
    "quote-validation",
    "unexpected",
  ] as const) {
    const harness = setup();
    const fresh = freshEvidence(harness.valuePlan);
    const failure = () => {
      throw new Error("secret private provider payload");
    };
    harness.dependencies.evidence.collect = async () => {
      if (stage === "unexpected") return failure();
      return (
        await collectOperatorAdmissionEvidence(
          harness.valuePlan,
          {
            account: fresh.account,
            readiness: fresh.readiness,
            instrument: fresh.instrument,
          },
          {
            fee: async () =>
              stage === "fee"
                ? failure()
                : {
                    retCode: 0,
                    retMsg: "OK",
                    result: {
                      list: [
                        {
                          symbol: fresh.feeRate.symbol,
                          makerFeeRate: "0.0002",
                          takerFeeRate: "0.00055",
                          rpiMakerFeeRate: "0.0001",
                        },
                      ],
                    },
                    time: Date.parse(NOW),
                  },
            quote: async () => {
              if (stage === "quote") return failure();
              if (stage === "quote-validation")
                return unwrap(
                  createOperatorMainnetQuote({
                    symbol: fresh.quote.symbol,
                    exchange: "bybit",
                    environment: "mainnet",
                    category: "linear",
                    origin: "https://api.bybit.com",
                    observedAt: fresh.quote.observedAt,
                    collectionStartedAt: fresh.quote.collectionStartedAt,
                    collectionCompletedAt: fresh.quote.collectionCompletedAt,
                    bid: "101",
                    ask: "101.1",
                    last: "101",
                  }),
                );
              return fresh.quote;
            },
            state: async () =>
              stage === "state"
                ? failure()
                : {
                    ok: true,
                    value:
                      stage === "validation"
                        ? {
                            ...fresh.state,
                            serverTime: at(Date.parse(NOW) + 60_000),
                          }
                        : fresh.state,
                  },
          },
        )
      ).fresh;
    };
    const result = await harness.run();
    assert.equal(result.ok, false);
    if (!result.ok) {
      const code = result.error.details?.reasonCode;
      if (stage === "fee") {
        assert.equal(code, "FEE_RATE_READ_FAILED");
        assert.equal(result.error.details?.source, "fee");
      }
      if (stage === "quote") {
        assert.equal(code, "QUOTE_READ_FAILED");
        assert.equal(result.error.details?.source, "quote");
      }
      if (stage === "state") {
        assert.equal(code, "TARGET_STATE_READ_FAILED");
        assert.equal(result.error.details?.source, "target-state");
      }
      if (stage === "quote-validation") {
        assert.equal(code, "QUOTE_OUTSIDE_APPROVED_RANGE");
        assert.equal(result.error.details?.source, "quote");
        assert.equal(result.error.details?.quoteBid, "101");
        assert.equal(
          result.error.details?.approvedBidLower,
          harness.valuePlan.quoteBidRange.lower.toString(),
        );
        assert.equal(
          result.error.details?.approvedBidUpper,
          harness.valuePlan.quoteBidRange.upper.toString(),
        );
        assert.equal(
          result.error.details?.allowedDeviationBps,
          harness.valuePlan.maxDeviationBps.toString(),
        );
      }
      if (stage === "unexpected")
        assert.equal(code, "FRESH_MAINNET_EVIDENCE_UNAVAILABLE");
      assert.doesNotMatch(JSON.stringify(result), /secret|private provider/u);
    }
    assert.equal(harness.createObservations.length, 0);
    assert.equal(harness.authorization.consumeCalls, 0);
    assert.equal(
      unwrap(
        harness.journal.readOperatorMainnetTestSource(
          unwrap(
            deriveOperatorMainnetTestSourceId(harness.valuePlan.contentHash),
          ),
        ),
      ),
      undefined,
    );
    harness.persistence.close();
  }
});

test("real fee-rate response with RPI passes the complete production admission validator", async () => {
  const valuePlan = plan();
  const fresh = freshEvidence(valuePlan);
  const result = await collectOperatorAdmissionEvidence(valuePlan, fresh, {
    fee: async () => ({
      retCode: 0,
      retMsg: "OK",
      result: {
        list: [
          {
            symbol: valuePlan.symbol,
            makerFeeRate: "0.0002",
            takerFeeRate: "0.00055",
            rpiMakerFeeRate: "",
          },
        ],
      },
      time: Date.parse(NOW),
    }),
    quote: async () => fresh.quote,
    state: async () => ({ ok: true, value: fresh.state }),
  });
  assert.deepEqual(result.fresh.feeRate, fresh.feeRate);
});

test("pre-intent evidence failure permits a clean second attended run despite an abandoned expired lease", async () => {
  const harness = setup();
  const abandoned = unwrap(
    harness.persistence.acquireLease({
      scope: harness.persistence.scope,
      ownerRunId: "abandoned-pre-intent",
      now: at(Date.parse(NOW) - 120_000),
      ttlMs: 60_000,
    }),
  );
  const initialHalt = unwrap(harness.persistence.readHalt());
  const noLease = new Proxy(harness.persistence, {
    get(target, key) {
      if (["acquireLease", "renewLease", "releaseLease"].includes(String(key)))
        return () => {
          throw new Error("operator CREATE must not manage leases");
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let unavailable = true;
  const dependencies: MainnetOperatorTestDependencies = {
    ...harness.dependencies,
    persistence: noLease,
    evidence: {
      collect: async () => {
        if (unavailable) throw new Error("read failed before intent");
        return freshEvidence(harness.valuePlan);
      },
    },
  };
  const first = await executeMainnetOperatorTest(harness.input, dependencies);
  assert.equal(first.ok, false);
  const sourceId = unwrap(
    deriveOperatorMainnetTestSourceId(harness.valuePlan.contentHash),
  );
  assert.equal(
    unwrap(harness.journal.readOperatorMainnetTestSource(sourceId)),
    undefined,
  );
  assert.deepEqual(unwrap(harness.persistence.readHalt()), initialHalt);
  assert.equal(
    unwrap(harness.persistence.readScopeSnapshot()).lease?.epoch,
    abandoned.epoch,
  );
  assert.equal(harness.createObservations.length, 0);
  unavailable = false;
  const secondApproval = unwrap(
    createOperatorMainnetTestApproval({
      plan: harness.valuePlan,
      planHash: harness.valuePlan.contentHash,
      actor: "second-attended-consent",
      consent: true,
      approvedAt: NOW,
    }),
  );
  const second = await executeMainnetOperatorTest(
    {
      approval: secondApproval,
      approvalHash: secondApproval.contentHash,
      runId: "second-attended-run",
    },
    dependencies,
  );
  assert.equal(unwrap(second).kind, "attempted");
  assert.equal(harness.createObservations.length, 1);
  const stored = unwrap(
    harness.journal.readOperatorMainnetTestSource(sourceId),
  );
  assert.equal(stored?.intent.runId, "second-attended-run");
  assert.equal(stored?.intent.canonicalJson.includes("lease"), false);
  assert.equal(
    unwrap(harness.persistence.readScopeSnapshot()).lease?.epoch,
    abandoned.epoch,
  );
  harness.persistence.close();
});

test("admission preserves quote deviation and malformed fee diagnostics", async () => {
  const valuePlan = plan();
  const fresh = freshEvidence(valuePlan);
  const quote = unwrap(
    createOperatorMainnetQuote({
      symbol: valuePlan.symbol,
      exchange: "bybit",
      environment: "mainnet",
      category: "linear",
      origin: "https://api.bybit.com",
      observedAt: fresh.quote.observedAt,
      collectionStartedAt: fresh.quote.collectionStartedAt,
      collectionCompletedAt: fresh.quote.collectionCompletedAt,
      bid: "101",
      ask: "101.1",
      last: "101",
    }),
  );
  const drift = validateMainnetOperatorTestEvidence(valuePlan, {
    ...fresh,
    quote,
  });
  assert.equal(drift.ok, false);
  if (!drift.ok)
    assert.equal(
      drift.error.details?.reasonCode,
      "QUOTE_OUTSIDE_APPROVED_RANGE",
    );
  const harness = setup({ valuePlan, evidence: { ...fresh, quote } });
  const stageStarted = performance.now();
  const execution = await harness.run();
  const stageElapsedMs = performance.now() - stageStarted;
  assert.equal(execution.ok, false);
  if (!execution.ok)
    assert.equal(
      execution.error.details?.reasonCode,
      "QUOTE_OUTSIDE_APPROVED_RANGE",
    );
  if (!execution.ok)
    assert.equal(execution.error.details?.causeCode, "CONSTRAINT_VIOLATION");
  if (!execution.ok) {
    assert.equal(execution.error.details?.source, "quote");
    assert.equal(execution.error.details?.quoteBid, "101");
    assert.equal(
      execution.error.details?.approvedBidLower,
      valuePlan.quoteBidRange.lower.toString(),
    );
    assert.equal(
      execution.error.details?.approvedBidUpper,
      valuePlan.quoteBidRange.upper.toString(),
    );
    assert.equal(
      execution.error.details?.allowedDeviationBps,
      valuePlan.maxDeviationBps.toString(),
    );
  }
  assert.equal(harness.createObservations.length, 0);
  assert.equal(harness.authorization.consumeCalls, 0);
  assert.equal(
    unwrap(harness.journal.findPendingOperatorMainnetTestSource()),
    undefined,
  );
  console.log(
    `U2_QUOTE_DRIFT_PROFILE ${JSON.stringify({
      baselineSha: "f107f0fc4b5ef5f0af9874fea68e754ac1fa0b20",
      fixture: "synthetic-collected-evidence-quote-outside-approved-range",
      commandContext: "application-admission-after-evidence-collection",
      stage: "admission",
      stageTimingModel:
        "observed local duration with supplied synthetic evidence; excludes provider reads",
      stageElapsedMs,
      physicalGetAttempts: 0,
      groups: { other: 0 },
      independentStubFetchAttemptLogEntries: 0,
      evidencePath: "provided-synthetic-evidence",
      refusalPredicate: "QUOTE_OUTSIDE_APPROVED_RANGE",
      exchangeWrites: 0,
      persistedIntent: false,
      authorizationConsumed: harness.authorization.consumeCalls,
    })}`,
  );
  harness.persistence.close();
  const fee = validateMainnetOperatorTestEvidence(valuePlan, {
    ...fresh,
    feeRate: {},
  } as unknown as MainnetOperatorTestFreshEvidence);
  assert.equal(fee.ok, false);
  if (!fee.ok)
    assert.equal(fee.error.details?.reasonCode, "FEE_RATE_EVIDENCE_INVALID");
});

test("actual changed account bundle preserves groups through execution without intent", async () => {
  const valuePlan = plan();
  const fresh = freshEvidence(valuePlan);
  const { consistency, ...payload } = fresh.account;
  assert.equal(consistency.structuralComparison, "unchanged");
  assert.ok(payload.criticalPasses.B);
  const account = unwrap(
    createAccountEvidenceBundle({
      ...payload,
      collectionStatus: "incomplete",
      criticalPasses: {
        ...payload.criticalPasses,
        B: {
          ...payload.criticalPasses.B,
          account: {
            ...payload.criticalPasses.B.account,
            marginMode: { state: "known", value: "PORTFOLIO_MARGIN" },
          },
        },
      },
    }),
  );
  const accountResult = unwrap(
    createAccountEvidenceCollectionResult({
      kind: "account-evidence",
      bundle: account,
    }),
  );
  const readiness = deriveMainnetExecutionReadiness({
    accountResult,
    symbol: valuePlan.symbol,
    instrument: fresh.instrument,
    evaluatedAt: NOW,
  });
  assert.ok(readiness.reasonCodes.includes("CRITICAL_STATE_CHANGED"));
  const harness = setup({
    valuePlan,
    evidence: { ...fresh, account, readiness },
  });
  const result = await harness.run();
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.details?.reasonCode, "CRITICAL_STATE_CHANGED");
    assert.equal(result.error.details?.criticalChangedGroups, "account");
  }
  assert.equal(harness.createObservations.length, 0);
  assert.equal(
    unwrap(harness.journal.findPendingOperatorMainnetTestSource()),
    undefined,
  );
  harness.persistence.close();
});
