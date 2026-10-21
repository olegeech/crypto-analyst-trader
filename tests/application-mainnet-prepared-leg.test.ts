import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { openSqlitePersistence } from "../src/adapters/sqlite/sqlite-persistence.js";
import { BYBIT_MAINNET_CAPABILITY_PROFILE } from "../src/adapters/bybit-v5/capability-profile.js";
import { createAdapterCapabilityObservation } from "../src/domain/capabilities/capability.js";
import { createEvidenceRef } from "../src/domain/evidence/evidence-ref.js";
import {
  createExchangeOrder,
  type ExchangeOrderObservation,
} from "../src/domain/execution/exchange-order.js";
import { createPreparedLegOrderProof } from "../src/domain/execution/prepared-leg-order-proof.js";
import {
  encodeCanonicalArtifact,
  rehydrateArtifact,
} from "../src/domain/identity/canonical-artifact.js";
import { hashCanonical } from "../src/domain/identity/canonical-serialization.js";
import { createMarketSnapshot } from "../src/domain/market/snapshots.js";
import {
  accountEvidenceContentHash,
  createAccountEvidenceBundle,
} from "../src/domain/account/account-evidence-bundle.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";
import { domainError } from "../src/domain/shared/errors.js";
import { fail, ok, type Result } from "../src/domain/shared/result.js";
import {
  parseUtcTimestamp,
  type UtcTimestamp,
} from "../src/domain/shared/time.js";
import type { PreparedArtifactStore } from "../src/ports/prepared-artifact-store.js";
import type {
  ExchangeCancelOrderRequest,
  ExchangeFillObservation,
  ExchangeOrderAcknowledgement,
  ExchangeOrderLookup,
  ExchangeOrderRequest,
  ExchangeReadStateRequest,
  ExchangeResult,
  ExchangeSetLeverageRequest,
  ExchangeSetLeverageResult,
  MainnetExchangeExecutionPort,
  MainnetExchangeReadState,
} from "../src/ports/exchange-execution.js";
import type { PersistenceScope } from "../src/ports/persistence.js";
import type {
  PreparedLegWriteAuthorizationBinding,
  PreparedLegWriteAuthorizationPort,
  PreparedLegWriteCapability,
} from "../src/ports/prepared-leg-write-authorization.js";
import { cancelMainnetPreparedLeg } from "../src/application/mainnet-prepared-leg-cancel.js";
import {
  createMainnetPreparedLeg,
  recoverMainnetPreparedLegSource,
  type MainnetPreparedLegFreshEvidence,
} from "../src/application/mainnet-prepared-leg-boundary.js";
import {
  derivePreparedLegClientOrderId,
  derivePreparedLegSourceId,
} from "../src/domain/execution/prepared-leg-execution.js";
import { PROVISIONAL_M1_POLICY_VERSION } from "../src/application/policies/provisional-m1.js";
import { preparedLegExecutionFixture } from "./fixtures/prepared-leg-execution-fixtures.js";

const runtime = { nodeVersion: "22.22.3", sqliteVersion: "3.51.3" } as const;
const scopeFor = (accountId: string): PersistenceScope => ({
  exchange: "bybit",
  environment: "mainnet",
  accountId,
  category: "linear",
  positionMode: "one-way",
});

function decimal(text: string): DecimalValue {
  const parsed = DecimalValue.fromString(text);
  if (!parsed.ok) throw new Error("invalid decimal fixture");
  return parsed.value;
}

function timestamp(text: string): UtcTimestamp {
  const parsed = parseUtcTimestamp(text);
  if (!parsed.ok) throw new Error("invalid timestamp fixture");
  return parsed.value;
}

function plusMs(text: UtcTimestamp, ms: number): UtcTimestamp {
  return timestamp(new Date(Date.parse(text) + ms).toISOString());
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok)
    throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

class TestWriteAuthorization implements PreparedLegWriteAuthorizationPort {
  readonly issued = new WeakMap<object, string>();
  readonly bindings: PreparedLegWriteAuthorizationBinding[] = [];
  deny = false;
  onAuthorize?: () => void;

  async authorize(
    binding: PreparedLegWriteAuthorizationBinding,
  ): Promise<PreparedLegWriteCapability | undefined> {
    this.bindings.push(binding);
    if (this.deny) return undefined;
    const capability = Object.freeze({});
    const hash = hashCanonical(binding);
    if (!hash.ok) return undefined;
    this.issued.set(capability, hash.value);
    this.onAuthorize?.();
    return capability;
  }

  isAdmitted(
    capability: PreparedLegWriteCapability,
    binding: PreparedLegWriteAuthorizationBinding,
  ): boolean {
    const hash = hashCanonical(binding);
    return hash.ok && this.issued.get(capability) === hash.value;
  }
}

class FakeMainnetExchange implements MainnetExchangeExecutionPort {
  readonly createRequests: ExchangeOrderRequest[] = [];
  readonly cancelRequests: ExchangeCancelOrderRequest[] = [];
  readonly leverageRequests: ExchangeSetLeverageRequest[] = [];
  readonly observationRequests: ExchangeOrderLookup[] = [];
  readonly readRequests: ExchangeReadStateRequest[] = [];
  clientOrderId: string | undefined;
  exchangeOrderId = "mainnet-order-21";
  orderStatus: ExchangeOrderObservation["status"] = "open";
  filledQuantity = "0";
  fills: readonly ExchangeFillObservation[] = [];
  attachedChildren: readonly ExchangeOrderObservation[] = [];
  exitFills: readonly ExchangeFillObservation[] = [];
  additionalOpenOrders: readonly ExchangeOrderObservation[] = [];
  positionSide: MainnetExchangeReadState["position"]["side"] = "flat";
  positionQuantity = "0";
  leverage = "1";
  beforeCreate?: () => void;
  beforeCancel?: () => void;
  afterCreate?: () => void;
  afterCancel?: () => void;
  cancelRemainsOpen = false;
  cancelFillRace = false;
  cancelThrows = false;

  constructor(
    readonly instrument: string,
    readonly constraints: unknown,
    private readonly clock: { value: UtcTimestamp },
  ) {}

  get currentTime(): UtcTimestamp {
    return this.clock.value;
  }
  set currentTime(value: UtcTimestamp) {
    this.clock.value = value;
  }

  private state(): MainnetExchangeReadState {
    const now = this.currentTime;
    const hash = unwrap(
      hashCanonical({ snapshot: now, instrument: this.instrument }),
    );
    const marketRef = unwrap(
      createEvidenceRef({
        kind: "market-snapshot",
        schemaVersion: "fixture/v1",
        producer: "mainnet-prepared-leg-test",
        sourceId: "mainnet-state-market",
        asOf: now,
        validForMs: 120_000,
        contentHash: hash,
      }),
    );
    const referencePrice =
      this.createRequests[0]?.intent.price ?? decimal("100");
    const market = unwrap(
      createMarketSnapshot({
        snapshotId: "mainnet-state-market",
        instrument: this.instrument,
        scope: {
          exchange: "bybit",
          environment: "mainnet",
          category: "linear",
          positionMode: "one-way",
        },
        asOf: now,
        bid: referencePrice.subtract(decimal("1")).toString(),
        ask: referencePrice.add(decimal("1")).toString(),
        last: referencePrice.toString(),
        constraints: this.constraints,
        evidence: [marketRef],
      }),
    );
    const capabilities = (
      ["order-create", "attached-protection", "reconciliation-reads"] as const
    ).map((capability) => {
      const contentHash = unwrap(hashCanonical({ capability, now }));
      const evidence = unwrap(
        createEvidenceRef({
          kind: "capability-probe",
          schemaVersion: "fixture/v1",
          producer: BYBIT_MAINNET_CAPABILITY_PROFILE.adapter,
          sourceId: `capability-${capability}`,
          asOf: now,
          validForMs: 120_000,
          contentHash,
        }),
      );
      return unwrap(
        createAdapterCapabilityObservation({
          capability,
          status: "supported",
          observedAt: now,
          source: BYBIT_MAINNET_CAPABILITY_PROFILE.adapter,
          evidence,
          scope: BYBIT_MAINNET_CAPABILITY_PROFILE.scope,
        }),
      );
    });
    const openOrders =
      this.clientOrderId !== undefined &&
      (this.orderStatus === "open" || this.orderStatus === "partially-filled")
        ? [this.order(now), ...this.additionalOpenOrders]
        : [...this.additionalOpenOrders];
    return {
      serverTime: now,
      market,
      position: {
        instrument: this.instrument,
        side: this.positionSide,
        quantity: decimal(this.positionQuantity),
        leverage: decimal(this.leverage),
      },
      openOrders,
      leverage: {
        buy: decimal(this.leverage),
        sell: decimal(this.leverage),
        effective: decimal(this.leverage),
      },
      capabilities,
    };
  }

  private order(observedAt: UtcTimestamp): ExchangeOrderObservation {
    const request = this.createRequests[0];
    if (!request || !this.clientOrderId)
      throw new Error("order fixture has no source request");
    return unwrap(
      createExchangeOrder({
        exchangeOrderId: this.exchangeOrderId,
        clientOrderId: this.clientOrderId,
        instrument: this.instrument,
        category: "linear",
        side: "buy",
        requestedQuantity: request.intent.quantity.toString(),
        filledQuantity: this.filledQuantity,
        status: this.orderStatus,
        orderType: "limit",
        price: request.intent.price.toString(),
        timeInForce: request.timeInForce,
        takeProfit: request.intent.protection?.takeProfit?.toString() ?? null,
        stopLoss: request.intent.protection?.stopLoss?.toString() ?? null,
        providerTpslMode: request.intent.protection?.takeProfitPolicy?.tpslMode,
        takeProfitTriggerBy:
          request.intent.protection?.takeProfitPolicy?.triggerBy,
        reduceOnly: request.reduceOnly,
        positionIdx: 0,
        observedAt,
        source: "bybit-mainnet/realtime",
      }),
    );
  }

  async readState(
    _request: ExchangeReadStateRequest,
  ): Promise<ExchangeResult<MainnetExchangeReadState>> {
    this.readRequests.push(_request);
    return { ok: true, value: this.state() };
  }

  async createOrder(
    request: ExchangeOrderRequest,
  ): Promise<ExchangeResult<ExchangeOrderAcknowledgement>> {
    this.beforeCreate?.();
    this.createRequests.push(request);
    this.clientOrderId = request.clientOrderId;
    this.afterCreate?.();
    return {
      ok: true,
      value: {
        clientOrderId: request.clientOrderId,
        exchangeOrderId: this.exchangeOrderId,
        acknowledgedAt: this.currentTime,
        status: "accepted",
      },
    };
  }

  async observeOrder(
    request: ExchangeOrderLookup,
  ): Promise<ExchangeResult<ExchangeOrderObservation>> {
    this.observationRequests.push(request);
    if (
      !this.clientOrderId ||
      request.clientOrderId !== this.clientOrderId ||
      (request.exchangeOrderId !== undefined &&
        request.exchangeOrderId !== this.exchangeOrderId)
    )
      return {
        ok: false,
        error: {
          kind: "ambiguous",
          message: "not found",
          retry: "reconcile",
          operation: "observe",
        },
      };
    return { ok: true, value: this.order(this.currentTime) };
  }

  async listAttachedProtection(_request: {
    readonly instrument: string;
    readonly parentClientOrderId: string;
  }): Promise<ExchangeResult<readonly ExchangeOrderObservation[]>> {
    void _request;
    return { ok: true, value: this.attachedChildren };
  }

  async listFills(
    request: ExchangeOrderLookup,
  ): Promise<ExchangeResult<readonly ExchangeFillObservation[]>> {
    return {
      ok: true,
      value:
        request.exchangeOrderId === this.exchangeOrderId
          ? this.fills
          : this.exitFills.filter(
              (fill) => fill.exchangeOrderId === request.exchangeOrderId,
            ),
    };
  }

  async setLeverage(
    request: ExchangeSetLeverageRequest,
  ): Promise<ExchangeResult<ExchangeSetLeverageResult>> {
    this.leverageRequests.push(request);
    return {
      ok: false,
      error: {
        kind: "permission",
        message: "not allowed",
        retry: "never",
        operation: "set-leverage",
      },
    };
  }

  async cancelOrder(
    request: ExchangeCancelOrderRequest,
  ): Promise<ExchangeResult<ExchangeOrderAcknowledgement>> {
    this.beforeCancel?.();
    this.cancelRequests.push(request);
    if (this.cancelFillRace) {
      this.orderStatus = "partially-filled";
      this.filledQuantity = this.createRequests[0]!.intent.quantity.multiply(
        decimal("0.5"),
      ).toString();
    } else if (!this.cancelRemainsOpen) {
      this.orderStatus = "cancelled";
    }
    this.currentTime = plusMs(this.currentTime, 1000);
    this.afterCancel?.();
    if (this.cancelThrows) throw new Error("ambiguous cancel outcome");
    return {
      ok: true,
      value: {
        clientOrderId: request.clientOrderId,
        exchangeOrderId: this.exchangeOrderId,
        acknowledgedAt: this.currentTime,
        status: "accepted",
      },
    };
  }
}

function setup(
  options: {
    readonly accountEvidenceAgeMs?: number;
    readonly readinessAccountHash?: string;
    readonly targetSide?: MainnetExchangeReadState["position"]["side"];
    readonly targetQuantity?: string;
    readonly denyAuthorization?: boolean;
  } = {},
) {
  const fixture = preparedLegExecutionFixture();
  const prepared = fixture.prepared;
  const approval = fixture.approval;
  const rawAccount = prepared.replayInputs.preflight.replayInputs
    .account as Record<string, unknown>;
  const { consistency: _consistency, ...accountPayload } = rawAccount;
  void _consistency;
  const account = unwrap(createAccountEvidenceBundle(accountPayload));
  const accountHashEvidence = unwrap(accountEvidenceContentHash(account));
  const symbol = fixture.approval.replayInputs.prepared.summary.symbol;
  const dailyPlan = prepared.replayInputs.preflight.replayInputs.dailyPlan;
  const marketData = dailyPlan.inputs.market as {
    symbols: readonly {
      symbol: string;
      instrument?: { constraints: unknown };
    }[];
  };
  const instrumentEvidence = marketData.symbols.find(
    (row) => row.symbol === symbol,
  )?.instrument;
  assert.ok(instrumentEvidence);
  const accountHash = prepared.inputIdentity.accountIdentityHash;
  const root = mkdtempSync(join(tmpdir(), "mainnet-prepared-leg-"));
  const databasePath = join(root, "mainnet.db");
  const currentTime = { value: timestamp(fixture.now) };
  const localTime = { value: fixture.now };
  let persistence = unwrap(
    openSqlitePersistence({
      environment: "mainnet",
      databasePath,
      runtime,
      clock: { now: () => currentTime.value },
      scope: scopeFor(accountHash),
    }),
  );
  const preparedEnvelope = unwrap(
    encodeCanonicalArtifact("prepared-daily-plan", prepared),
  );
  const approvalEnvelope = unwrap(
    encodeCanonicalArtifact("prepared-plan-approval", approval),
  );
  unwrap(
    persistence.writeArtifact({
      artifactId: `prepared:${prepared.contentHash}`,
      artifactKind: "prepared-daily-plan",
      envelope: preparedEnvelope,
      materialHash: prepared.contentHash,
    }),
  );
  unwrap(
    persistence.writeArtifact({
      artifactId: `prepared-consent:${approval.contentHash}`,
      artifactKind: "prepared-plan-approval",
      envelope: approvalEnvelope,
      materialHash: approval.contentHash,
    }),
  );
  assert.ok(persistence.preparedLegExecution);
  let approvalLoads = 0;
  const artifacts: PreparedArtifactStore = {
    savePrepared: () => ok(undefined),
    loadPrepared: (hash) =>
      ok(hash === prepared.contentHash ? prepared : undefined),
    saveApproval: () => ok(undefined),
    loadApproval: (hash) => {
      approvalLoads += 1;
      return ok(hash === approval.contentHash ? approval : undefined);
    },
    close: () => undefined,
  };
  const authorization = new TestWriteAuthorization();
  authorization.deny = options.denyAuthorization ?? false;
  const exchange = new FakeMainnetExchange(
    symbol,
    instrumentEvidence.constraints,
    currentTime,
  );
  exchange.positionSide = options.targetSide ?? "flat";
  exchange.positionQuantity = options.targetQuantity ?? "0";
  let monotonicValue = 0;

  const makeEvidence = async (
    at: UtcTimestamp,
  ): Promise<MainnetPreparedLegFreshEvidence> => {
    currentTime.value = at;
    const observed = await exchange.readState({ instrument: symbol });
    if (!observed.ok) throw new Error("fixture account read failed");
    const state = observed.value;
    const readiness = {
      schemaVersion: "mainnet-execution-readiness/v1" as const,
      verdict: "READY" as const,
      evaluatedAt: at,
      environment: "mainnet" as const,
      symbol,
      policyVersion: PROVISIONAL_M1_POLICY_VERSION,
      capabilityProfile: {
        version: BYBIT_MAINNET_CAPABILITY_PROFILE.version,
        adapter: BYBIT_MAINNET_CAPABILITY_PROFILE.adapter,
        status: "SUPPORTED" as const,
        liveProof: "not-established" as const,
      },
      internalBinding: {
        accountIdentityHash: options.readinessAccountHash ?? accountHash,
        accountEvidenceHash: accountHashEvidence,
      },
      accountEvidenceAgeMs: options.accountEvidenceAgeMs ?? 0,
      unrelatedCoverageGapCount: 0,
      reasonCodes: [],
      providerReasonCodes: [],
      warningCodes: [],
    };
    return { account, readiness, state };
  };
  const dependencies = {
    artifacts,
    persistence,
    preparedLegs: persistence.preparedLegExecution,
    exchange,
    evidence: { collect: async () => makeEvidence(currentTime.value) },
    authorization,
    localClock: { now: () => localTime.value as UtcTimestamp },
    monotonicClock: () => monotonicValue++,
  };
  const reopenPersistence = () => {
    persistence.close();
    const reopened = openSqlitePersistence({
      environment: "mainnet",
      databasePath,
      runtime,
      clock: { now: () => currentTime.value },
      scope: scopeFor(accountHash),
    });
    persistence = unwrap(reopened);
    const preparedLegs = persistence.preparedLegExecution;
    assert.ok(preparedLegs);
    Object.assign(dependencies, { persistence, preparedLegs });
  };
  return {
    fixture,
    prepared,
    approval,
    accountHash,
    currentTime,
    localTime,
    get persistence() {
      return persistence;
    },
    exchange,
    dependencies,
    authorization,
    reopenPersistence,
    get approvalLoads() {
      return approvalLoads;
    },
    cleanup() {
      persistence.close();
      rmSync(root, { recursive: true, force: true });
    },
    advanceMonotonic(ms: number) {
      monotonicValue += ms;
    },
  };
}

async function createOpenPreparedLeg(
  state: ReturnType<typeof setup>,
  runId: string,
) {
  const result = await createMainnetPreparedLeg(
    {
      approvalHash: state.approval.contentHash,
      legId: state.fixture.legId,
      runId,
    },
    state.dependencies,
  );
  assert.equal(
    result.ok,
    true,
    result.ok ? "" : `${result.error.code}: ${result.error.message}`,
  );
  if (!result.ok) throw new Error("prepared-leg fixture create failed");
  assert.equal(result.value.status, "CONFIRMED_OPEN");
  return result.value;
}

async function createPartialProtectedPreparedLeg(
  state: ReturnType<typeof setup>,
  runId: string,
) {
  const leg =
    state.fixture.approval.replayInputs.prepared.replayInputs.preflight
      .replayInputs.dailyPlan.candidateLegs![0]!;
  const filledQuantity = leg.intent.quantity.multiply(decimal("0.5"));
  const clientOrderId = unwrap(
    derivePreparedLegClientOrderId(
      state.prepared.contentHash,
      state.fixture.legId,
    ),
  );
  state.exchange.afterCreate = () => {
    state.exchange.orderStatus = "partially-filled";
    state.exchange.filledQuantity = filledQuantity.toString();
    state.exchange.positionSide = "long";
    state.exchange.positionQuantity = filledQuantity.toString();
    state.exchange.fills = [
      {
        executionId: "exec-partial-entry-21",
        exchangeOrderId: state.exchange.exchangeOrderId,
        clientOrderId,
        instrument: leg.intent.instrument,
        side: "buy",
        quantity: filledQuantity,
        price: leg.intent.price,
        executedAt: state.currentTime.value,
        source: "bybit-mainnet/execution",
      },
    ];
    const child = unwrap(
      createExchangeOrder({
        exchangeOrderId: "mainnet-tp-partial-21",
        clientOrderId,
        providerOrderLinkId: clientOrderId,
        parentOrderLinkId: clientOrderId,
        providerStopOrderType: "PartialTakeProfit",
        providerTpslMode: "Partial",
        protectionType: "take-profit",
        instrument: leg.intent.instrument,
        category: "linear",
        side: "sell",
        orderType: "market",
        requestedQuantity: filledQuantity.toString(),
        filledQuantity: "0",
        status: "open",
        triggerPrice: leg.intent.protection!.takeProfit!.toString(),
        takeProfitTriggerBy: "LastPrice",
        triggerBy: "LastPrice",
        reduceOnly: true,
        positionIdx: 0,
        providerCreatedAt: state.currentTime.value,
        providerUpdatedAt: state.currentTime.value,
        observedAt: state.currentTime.value,
        source: "bybit-mainnet/protection/order/realtime",
      }),
    );
    state.exchange.attachedChildren = [child];
    state.exchange.additionalOpenOrders = [child];
  };
  const result = await createMainnetPreparedLeg(
    {
      approvalHash: state.approval.contentHash,
      legId: state.fixture.legId,
      runId,
    },
    state.dependencies,
  );
  assert.equal(
    result.ok,
    true,
    result.ok ? "" : `${result.error.code}: ${result.error.message}`,
  );
  if (!result.ok) throw new Error("partial protected fixture create failed");
  assert.equal(
    result.value.status,
    "PROTECTION_CONFIRMED",
    JSON.stringify(result.value),
  );
  return result.value;
}

for (const fault of ["unavailable", "fill-total-mismatch"] as const) {
  test(`positive parent fills with ${fault} entry evidence persist pending protection`, async () => {
    const state = setup();
    try {
      const runId = `prepared-leg-${fault}-entry-evidence-run`;
      const created = await createPartialProtectedPreparedLeg(state, runId);
      const parentOrderId = state.exchange.exchangeOrderId;
      const originalListFills = state.exchange.listFills.bind(state.exchange);
      state.exchange.listFills = async (request) => {
        if (request.exchangeOrderId === parentOrderId)
          return fault === "unavailable"
            ? {
                ok: false,
                error: {
                  kind: "transport",
                  message: "simulated entry-fill read failure",
                  retry: "reconcile",
                  operation: "fills",
                },
              }
            : { ok: true, value: [] };
        return originalListFills(request);
      };
      state.currentTime.value = plusMs(state.currentTime.value, 1000);
      state.localTime.value = state.currentTime.value;

      const recovered = await recoverMainnetPreparedLegSource(
        { sourceId: created.sourceId, runId },
        state.dependencies,
      );
      assert.equal(
        recovered.ok,
        true,
        recovered.ok
          ? ""
          : `${recovered.error.code}: ${recovered.error.message}`,
      );
      if (!recovered.ok) return;
      assert.equal(recovered.value.status, "PROTECTION_PENDING");
      assert.equal(state.exchange.createRequests.length, 1);
      assert.equal(unwrap(state.persistence.readHalt()).active, true);

      state.reopenPersistence();
      const saved = unwrap(
        state.persistence.preparedLegExecution!.readPreparedLegSource(
          created.sourceId,
        ),
      );
      const evidence = saved?.reconciliations.at(-1)?.protectionEvidence;
      assert.equal(saved?.reconciliations.at(-1)?.status, "PROTECTION_PENDING");
      assert.equal(evidence?.status, "PROTECTION_PENDING");
      assert.equal(evidence?.collection.entryFills, "incomplete");
      assert.equal(evidence?.entries.quantity, null);
      assert.equal(unwrap(state.persistence.readHalt()).active, true);
    } finally {
      state.cleanup();
    }
  });
}

test("persists exact intent before one authorized create and confirms known-open without HALT", async () => {
  const state = setup();
  try {
    const sourceId = unwrap(
      derivePreparedLegSourceId(
        state.accountHash,
        state.prepared.contentHash,
        state.fixture.legId,
      ),
    );
    state.exchange.beforeCreate = () => {
      const durable =
        state.persistence.preparedLegExecution!.readPreparedLegSource(sourceId);
      assert.equal(durable.ok, true);
      if (!durable.ok) return;
      assert.ok(durable.value);
      assert.equal(durable.value.createIntent.operation, "create");
      assert.equal(durable.value.createAttempt, undefined);
    };
    const run = await createMainnetPreparedLeg(
      {
        approvalHash: state.approval.contentHash,
        legId: state.fixture.legId,
        runId: "prepared-leg-run-1",
      },
      state.dependencies,
    );
    assert.equal(
      run.ok,
      true,
      run.ok ? "" : `${run.error.code}: ${run.error.message}`,
    );
    if (!run.ok) return;
    const observed = await state.exchange.observeOrder({
      instrument: state.fixture.approval.replayInputs.prepared.summary.symbol,
      clientOrderId: run.value.clientOrderId,
    });
    assert.equal(observed.ok, true);
    if (observed.ok) {
      const proof = createPreparedLegOrderProof(observed.value);
      assert.equal(
        proof.ok,
        true,
        `observed keys: ${Reflect.ownKeys(observed.value).join(",")}`,
      );
    }
    const durable = unwrap(
      state.persistence.preparedLegExecution!.readPreparedLegSource(sourceId),
    );
    assert.equal(
      run.value.status,
      "CONFIRMED_OPEN",
      durable?.reconciliations.at(-1)?.canonicalJson,
    );
    assert.equal(state.exchange.createRequests.length, 1);
    assert.equal(state.exchange.leverageRequests.length, 0);
    assert.equal(unwrap(state.persistence.readHalt()).active, false);
    const request = state.exchange.createRequests[0]!;
    const approvedLeg =
      state.fixture.approval.replayInputs.prepared.replayInputs.preflight
        .replayInputs.dailyPlan.candidateLegs![0]!;
    assert.equal(request.clientOrderId, run.value.clientOrderId);
    assert.equal(request.timeInForce, "GTC");
    assert.equal(request.reduceOnly, false);
    assert.equal(request.intent.price.compare(approvedLeg.intent.price), 0);
    assert.equal(
      request.intent.quantity.compare(approvedLeg.intent.quantity),
      0,
    );
    assert.equal(
      request.intent.protection?.takeProfit?.compare(
        approvedLeg.intent.protection!.takeProfit!,
      ),
      0,
    );
  } finally {
    state.cleanup();
  }
});

test("changed target state or wrong account identity blocks before durable intent and exchange writes", async () => {
  for (const invalid of [
    setup({ targetSide: "long", targetQuantity: "0.01" }),
    setup({ readinessAccountHash: `sha256:${"b".repeat(64)}` }),
  ]) {
    try {
      const result = await createMainnetPreparedLeg(
        {
          approvalHash: invalid.approval.contentHash,
          legId: invalid.fixture.legId,
          runId: "prepared-leg-blocked-run",
        },
        invalid.dependencies,
      );
      assert.equal(result.ok, false);
      assert.equal(invalid.exchange.createRequests.length, 0);
      const sourceId = unwrap(
        derivePreparedLegSourceId(
          invalid.accountHash,
          invalid.prepared.contentHash,
          invalid.fixture.legId,
        ),
      );
      const source = unwrap(
        invalid.persistence.preparedLegExecution!.readPreparedLegSource(
          sourceId,
        ),
      );
      assert.equal(source, undefined);
    } finally {
      invalid.cleanup();
    }
  }
});

test("full fills with an active attached TP enter protection-pending and retain attempt-linked accounting", async () => {
  const state = setup();
  try {
    const approvedLeg =
      state.fixture.approval.replayInputs.prepared.replayInputs.preflight
        .replayInputs.dailyPlan.candidateLegs![0]!;
    state.exchange.afterCreate = () => {
      state.exchange.orderStatus = "filled";
      state.exchange.filledQuantity = approvedLeg.intent.quantity.toString();
      state.exchange.positionSide = "long";
      state.exchange.positionQuantity = approvedLeg.intent.quantity.toString();
      const clientOrderId = unwrap(
        derivePreparedLegClientOrderId(
          state.prepared.contentHash,
          state.fixture.legId,
        ),
      );
      state.exchange.additionalOpenOrders = [
        unwrap(
          createExchangeOrder({
            exchangeOrderId: "mainnet-tp-child-21",
            clientOrderId,
            parentOrderLinkId: clientOrderId,
            protectionType: "take-profit",
            instrument: approvedLeg.intent.instrument,
            category: "linear",
            side: "sell",
            orderType: "market",
            requestedQuantity: approvedLeg.intent.quantity.toString(),
            filledQuantity: "0",
            status: "open",
            triggerPrice: approvedLeg.intent.protection!.takeProfit!.toString(),
            reduceOnly: true,
            positionIdx: 0,
            observedAt: state.currentTime.value,
            source: "bybit-mainnet/realtime",
          }),
        ),
      ];
      state.exchange.fills = [
        {
          executionId: "exec-mainnet-21",
          exchangeOrderId: state.exchange.exchangeOrderId,
          clientOrderId: unwrap(
            derivePreparedLegClientOrderId(
              state.prepared.contentHash,
              state.fixture.legId,
            ),
          ),
          instrument: approvedLeg.intent.instrument,
          side: "buy",
          quantity: approvedLeg.intent.quantity,
          price: approvedLeg.intent.price,
          executedAt: state.currentTime.value,
          source: "bybit-mainnet/execution",
          fee: decimal("0.01"),
          feeCurrency: "USDT",
        },
      ];
    };
    const run = await createMainnetPreparedLeg(
      {
        approvalHash: state.approval.contentHash,
        legId: state.fixture.legId,
        runId: "prepared-leg-fill-run",
      },
      state.dependencies,
    );
    assert.equal(
      run.ok,
      true,
      run.ok ? "" : `${run.error.code}: ${run.error.message}`,
    );
    if (!run.ok) return;
    const sourceId = unwrap(
      derivePreparedLegSourceId(
        state.accountHash,
        state.prepared.contentHash,
        state.fixture.legId,
      ),
    );
    const durable = unwrap(
      state.persistence.preparedLegExecution!.readPreparedLegSource(sourceId),
    );
    assert.equal(
      run.value.status,
      "PROTECTION_PENDING",
      durable?.reconciliations.at(-1)?.canonicalJson,
    );
    assert.equal(unwrap(state.persistence.readHalt()).active, true);
    const facts = unwrap(state.persistence.readFacts());
    assert.equal(facts.filter((fact) => fact.factKind === "fill").length, 1);
    assert.equal(facts.filter((fact) => fact.factKind === "fee").length, 1);
    assert.equal(
      facts.filter((fact) => fact.factKind === "ledger-entry").length,
      2,
    );
    assert.ok(durable?.createAttempt);
    const fillFact = facts.find((fact) => fact.factKind === "fill");
    assert.ok(fillFact);
    const persistedFill = unwrap(
      rehydrateArtifact("fill", fillFact.artifact.envelope),
    );
    assert.ok("attemptId" in persistedFill);
    assert.equal(persistedFill.attemptId, durable.createAttempt.attemptId);
  } finally {
    state.cleanup();
  }
});

test("exact attached TP coverage persists v2 quantities without raising HALT", async () => {
  const state = setup();
  try {
    const leg =
      state.fixture.approval.replayInputs.prepared.replayInputs.preflight
        .replayInputs.dailyPlan.candidateLegs![0]!;
    state.exchange.afterCreate = () => {
      const clientOrderId = unwrap(
        derivePreparedLegClientOrderId(
          state.prepared.contentHash,
          state.fixture.legId,
        ),
      );
      state.exchange.orderStatus = "filled";
      state.exchange.filledQuantity = leg.intent.quantity.toString();
      state.exchange.positionSide = "long";
      state.exchange.positionQuantity = leg.intent.quantity.toString();
      const firstEntryQuantity = leg.intent.quantity.multiply(decimal("0.4"));
      const secondEntryQuantity =
        leg.intent.quantity.subtract(firstEntryQuantity);
      state.exchange.fills = [
        {
          executionId: "exec-covered-entry-21-a",
          exchangeOrderId: state.exchange.exchangeOrderId,
          clientOrderId,
          instrument: leg.intent.instrument,
          side: "buy",
          quantity: firstEntryQuantity,
          price: leg.intent.price,
          executedAt: state.currentTime.value,
          source: "bybit-mainnet/execution",
        },
        {
          executionId: "exec-covered-entry-21-b",
          exchangeOrderId: state.exchange.exchangeOrderId,
          clientOrderId,
          instrument: leg.intent.instrument,
          side: "buy",
          quantity: secondEntryQuantity,
          price: leg.intent.price,
          executedAt: state.currentTime.value,
          source: "bybit-mainnet/execution",
        },
      ];
      const createChild = (
        exchangeOrderId: string,
        quantity: DecimalValue,
        providerOrderLinkId?: string,
      ) =>
        unwrap(
          createExchangeOrder({
            exchangeOrderId,
            clientOrderId: providerOrderLinkId ?? clientOrderId,
            ...(providerOrderLinkId === undefined
              ? {}
              : { providerOrderLinkId }),
            parentOrderLinkId: clientOrderId,
            providerStopOrderType: "PartialTakeProfit",
            providerTpslMode: "Partial",
            protectionType: "take-profit",
            instrument: leg.intent.instrument,
            category: "linear",
            side: "sell",
            orderType: "market",
            requestedQuantity: quantity.toString(),
            filledQuantity: "0",
            status: "open",
            triggerPrice: leg.intent.protection!.takeProfit!.toString(),
            takeProfitTriggerBy: "LastPrice",
            triggerBy: "LastPrice",
            reduceOnly: true,
            positionIdx: 0,
            providerCreatedAt: state.currentTime.value,
            providerUpdatedAt: state.currentTime.value,
            observedAt: state.currentTime.value,
            source: "bybit-mainnet/protection/order/realtime",
          }),
        );
      const children = [
        createChild("mainnet-tp-child-covered-21-a", firstEntryQuantity),
        createChild(
          "mainnet-tp-child-covered-21-b",
          secondEntryQuantity,
          "mainnet-tp-link-covered-21-b",
        ),
      ];
      state.exchange.attachedChildren = children;
      state.exchange.additionalOpenOrders = children;
    };

    const run = await createMainnetPreparedLeg(
      {
        approvalHash: state.approval.contentHash,
        legId: state.fixture.legId,
        runId: "prepared-leg-covered-run",
      },
      state.dependencies,
    );
    assert.equal(
      run.ok,
      true,
      run.ok ? "" : `${run.error.code}: ${run.error.message}`,
    );
    if (!run.ok) return;
    assert.equal(run.value.status, "PROTECTION_CONFIRMED");
    const durable = unwrap(
      state.persistence.preparedLegExecution!.readPreparedLegSource(
        run.value.sourceId,
      ),
    );
    const reconciliation = durable?.reconciliations.at(-1);
    assert.equal(reconciliation?.legacyStatus, "PROTECTION_PENDING");
    assert.equal(
      reconciliation?.protectionEvidence?.schemaVersion,
      "prepared-leg-protection-evidence/v2",
    );
    assert.equal(
      reconciliation?.protectionEvidence?.entries.quantity,
      leg.intent.quantity.toString(),
    );
    assert.equal(
      reconciliation?.protectionEvidence?.coverage.outstandingQuantity,
      leg.intent.quantity.toString(),
    );
    assert.equal(
      reconciliation?.protectionEvidence?.coverage.activeRemainingQuantity,
      leg.intent.quantity.toString(),
    );
    assert.equal(unwrap(state.persistence.readHalt()).active, false);
  } finally {
    state.cleanup();
  }
});

test("unlisted active TP in position reads cannot be hidden by exact child coverage", async () => {
  const state = setup();
  try {
    const leg =
      state.fixture.approval.replayInputs.prepared.replayInputs.preflight
        .replayInputs.dailyPlan.candidateLegs![0]!;
    state.exchange.afterCreate = () => {
      const clientOrderId = unwrap(
        derivePreparedLegClientOrderId(
          state.prepared.contentHash,
          state.fixture.legId,
        ),
      );
      state.exchange.orderStatus = "filled";
      state.exchange.filledQuantity = leg.intent.quantity.toString();
      state.exchange.positionSide = "long";
      state.exchange.positionQuantity = leg.intent.quantity.toString();
      state.exchange.fills = [
        {
          executionId: "exec-unlisted-child-entry-21",
          exchangeOrderId: state.exchange.exchangeOrderId,
          clientOrderId,
          instrument: leg.intent.instrument,
          side: "buy",
          quantity: leg.intent.quantity,
          price: leg.intent.price,
          executedAt: state.currentTime.value,
          source: "bybit-mainnet/execution",
        },
      ];
      const createChild = (exchangeOrderId: string, quantity: string) =>
        unwrap(
          createExchangeOrder({
            exchangeOrderId,
            clientOrderId,
            parentOrderLinkId: clientOrderId,
            providerStopOrderType: "PartialTakeProfit",
            providerTpslMode: "Partial",
            protectionType: "take-profit",
            instrument: leg.intent.instrument,
            category: "linear",
            side: "sell",
            orderType: "market",
            requestedQuantity: quantity,
            filledQuantity: "0",
            status: "open",
            triggerPrice: leg.intent.protection!.takeProfit!.toString(),
            takeProfitTriggerBy: "LastPrice",
            triggerBy: "LastPrice",
            reduceOnly: true,
            positionIdx: 0,
            providerCreatedAt: state.currentTime.value,
            providerUpdatedAt: state.currentTime.value,
            observedAt: state.currentTime.value,
            source: "bybit-mainnet/protection/order/realtime",
          }),
        );
      const listed = createChild(
        "mainnet-tp-listed-child-21",
        leg.intent.quantity.toString(),
      );
      const unlisted = createChild("mainnet-tp-unlisted-child-21", "0.01");
      state.exchange.attachedChildren = [listed];
      state.exchange.additionalOpenOrders = [listed, unlisted];
    };

    const result = await createMainnetPreparedLeg(
      {
        approvalHash: state.approval.contentHash,
        legId: state.fixture.legId,
        runId: "prepared-leg-unlisted-child-run",
      },
      state.dependencies,
    );

    assert.equal(
      result.ok,
      true,
      result.ok ? "" : `${result.error.code}: ${result.error.message}`,
    );
    if (!result.ok) return;
    assert.equal(result.value.status, "PROTECTION_PENDING");
    const source = unwrap(
      state.persistence.preparedLegExecution!.readPreparedLegSource(
        result.value.sourceId,
      ),
    );
    assert.ok(
      source?.reconciliations
        .at(-1)
        ?.protectionEvidence?.reasonCodes.includes(
          "READ_STATE_PROTECTION_CHILD_MISMATCH",
        ),
    );
    assert.equal(unwrap(state.persistence.readHalt()).active, true);
  } finally {
    state.cleanup();
  }
});

test("missing, under, and over TP coverage persist v2 pending evidence with HALT", async () => {
  for (const scenario of ["missing", "under", "over"] as const) {
    const state = setup();
    try {
      const leg =
        state.fixture.approval.replayInputs.prepared.replayInputs.preflight
          .replayInputs.dailyPlan.candidateLegs![0]!;
      const clientOrderId = unwrap(
        derivePreparedLegClientOrderId(
          state.prepared.contentHash,
          state.fixture.legId,
        ),
      );
      state.exchange.afterCreate = () => {
        state.exchange.orderStatus = "filled";
        state.exchange.filledQuantity = leg.intent.quantity.toString();
        state.exchange.positionSide = "long";
        state.exchange.positionQuantity = leg.intent.quantity.toString();
        state.exchange.fills = [
          {
            executionId: `exec-${scenario}-entry`,
            exchangeOrderId: state.exchange.exchangeOrderId,
            clientOrderId,
            instrument: leg.intent.instrument,
            side: "buy",
            quantity: leg.intent.quantity,
            price: leg.intent.price,
            executedAt: state.currentTime.value,
            source: "bybit-mainnet/execution",
          },
        ];
        const count = scenario === "over" ? 2 : scenario === "under" ? 1 : 0;
        const childQuantity =
          scenario === "under"
            ? leg.intent.quantity.multiply(decimal("0.5"))
            : leg.intent.quantity;
        state.exchange.attachedChildren = Array.from(
          { length: count },
          (_, index) =>
            unwrap(
              createExchangeOrder({
                exchangeOrderId: `mainnet-tp-${scenario}-${index}`,
                clientOrderId,
                providerOrderLinkId: clientOrderId,
                parentOrderLinkId: clientOrderId,
                providerStopOrderType: "PartialTakeProfit",
                providerTpslMode: "Partial",
                protectionType: "take-profit",
                instrument: leg.intent.instrument,
                category: "linear",
                side: "sell",
                orderType: "market",
                requestedQuantity: childQuantity.toString(),
                filledQuantity: "0",
                status: "open",
                triggerPrice: leg.intent.protection!.takeProfit!.toString(),
                takeProfitTriggerBy: "LastPrice",
                triggerBy: "LastPrice",
                reduceOnly: true,
                positionIdx: 0,
                providerCreatedAt: state.currentTime.value,
                providerUpdatedAt: state.currentTime.value,
                observedAt: state.currentTime.value,
                source: "bybit-mainnet/protection/order/realtime",
              }),
            ),
        );
      };

      const run = await createMainnetPreparedLeg(
        {
          approvalHash: state.approval.contentHash,
          legId: state.fixture.legId,
          runId: `prepared-leg-${scenario}-coverage-run`,
        },
        state.dependencies,
      );
      assert.equal(
        run.ok,
        true,
        run.ok ? "" : `${run.error.code}: ${run.error.message}`,
      );
      if (!run.ok) continue;
      assert.equal(run.value.status, "PROTECTION_PENDING", scenario);
      const source = unwrap(
        state.persistence.preparedLegExecution!.readPreparedLegSource(
          run.value.sourceId,
        ),
      );
      const latest = source?.reconciliations.at(-1);
      assert.equal(latest?.protectionEvidence?.status, "PROTECTION_PENDING");
      assert.equal(latest?.protectionEvidence?.coverage.covered, false);
      assert.equal(unwrap(state.persistence.readHalt()).active, true);
    } finally {
      state.cleanup();
    }
  }
});

test("authorized exact remainder cancel journals v2 intent, keeps TP coverage, and recovers without another POST", async () => {
  const state = setup();
  try {
    const runId = "prepared-leg-partial-cancel-run";
    const created = await createPartialProtectedPreparedLeg(state, runId);
    state.currentTime.value = plusMs(state.currentTime.value, 1000);
    state.localTime.value = state.currentTime.value;
    state.exchange.beforeCancel = () => {
      const source = unwrap(
        state.persistence.preparedLegExecution!.readPreparedLegSource(
          created.sourceId,
        ),
      );
      assert.ok(source?.cancelIntent);
      assert.ok(source.cancelIntent.remainderCancelProof);
      assert.equal(source.cancelIntent.operation, "cancel");
      assert.match(
        source.cancelIntent.canonicalJson,
        /prepared-leg-write-intent\/v2/u,
      );
    };

    const result = await cancelMainnetPreparedLeg(
      { sourceId: created.sourceId, runId },
      state.dependencies,
    );
    assert.equal(
      result.ok,
      true,
      result.ok ? "" : `${result.error.code}: ${result.error.message}`,
    );
    if (!result.ok) return;
    assert.equal(
      result.value.status,
      "PROTECTION_CONFIRMED",
      JSON.stringify(result.value),
    );
    assert.equal(state.exchange.cancelRequests.length, 1);
    const saved = unwrap(
      state.persistence.preparedLegExecution!.readPreparedLegSource(
        created.sourceId,
      ),
    );
    assert.ok(saved?.cancelIntent?.remainderCancelProof);
    assert.ok(saved?.cancelAttempt);
    assert.equal(saved?.cancelAttempt.operation, "cancel");
    assert.equal(
      saved?.reconciliations.at(-1)?.protectionEvidence?.status,
      "PROTECTION_CONFIRMED",
    );
    assert.equal(
      saved?.reconciliations.at(-1)?.protectionEvidence?.coverage
        .activeRemainingQuantity,
      saved?.reconciliations.at(-1)?.protectionEvidence?.coverage
        .outstandingQuantity,
    );
    const cancelBinding = state.authorization.bindings.at(-1);
    assert.equal(cancelBinding?.operation, "cancel");
    assert.equal(cancelBinding?.zeroFillProofHash, undefined);
    assert.ok(cancelBinding?.remainderCancelProofHash);
    assert.ok(cancelBinding?.approvedCancelPlanHash);
    assert.ok(cancelBinding?.coverageHash);
    assert.ok(cancelBinding?.unfilledRemainder);

    const recovered = await cancelMainnetPreparedLeg(
      { sourceId: created.sourceId, runId },
      state.dependencies,
    );
    assert.equal(recovered.ok, true);
    if (recovered.ok)
      assert.equal(recovered.value.status, "PROTECTION_CONFIRMED");
    assert.equal(state.exchange.cancelRequests.length, 1);
  } finally {
    state.cleanup();
  }
});

function closePartialTp(state: ReturnType<typeof setup>) {
  const original = state.exchange.attachedChildren[0]!;
  state.currentTime.value = plusMs(state.currentTime.value, 1000);
  state.localTime.value = state.currentTime.value;
  const child = unwrap(
    createExchangeOrder({
      ...original,
      requestedQuantity: original.requestedQuantity.toString(),
      filledQuantity: original.requestedQuantity.toString(),
      triggerPrice: original.triggerPrice!.toString(),
      status: "filled",
      observedAt: state.currentTime.value,
      providerUpdatedAt: state.currentTime.value,
    }),
  );
  state.exchange.attachedChildren = [child];
  state.exchange.additionalOpenOrders = [];
  state.exchange.positionSide = "flat";
  state.exchange.positionQuantity = "0";
  state.exchange.exitFills = [
    {
      executionId: "complete-partial-tp-exit",
      exchangeOrderId: child.exchangeOrderId,
      clientOrderId: child.clientOrderId,
      instrument: child.instrument,
      side: "sell",
      quantity: child.filledQuantity,
      price: child.triggerPrice!,
      executedAt: state.currentTime.value,
      source: "bybit-mainnet/execution",
    },
  ];
}

test("complete TP exit preserves separately authorized entry remainder cancellation across restart", async (t) => {
  for (const reconcileFirst of [true, false])
    await t.test(
      reconcileFirst
        ? "durable verified closed"
        : "fresh exit since confirmed protection",
      async () => {
        const state = setup();
        try {
          const runId = "closed-exposure-open-parent";
          const created = await createPartialProtectedPreparedLeg(state, runId);
          closePartialTp(state);
          const child = state.exchange.attachedChildren[0]!;
          if (reconcileFirst) {
            const closed = unwrap(
              await recoverMainnetPreparedLegSource(
                { sourceId: created.sourceId, runId },
                state.dependencies,
              ),
            );
            assert.equal(closed.status, "VERIFIED_CLOSED");
            state.reopenPersistence();
          }
          state.exchange.beforeCancel = () => {
            const saved = unwrap(
              state.persistence.preparedLegExecution!.readPreparedLegSource(
                created.sourceId,
              ),
            );
            assert.equal(
              saved?.cancelIntent?.remainderCancelProof?.outstandingQuantity,
              "0",
            );
            assert.equal(
              saved?.reconciliations.at(-1)?.status,
              "VERIFIED_CLOSED",
            );
            assert.equal(
              saved?.cancelIntent?.remainderCancelProof?.protectionEvidenceHash,
              saved?.reconciliations.at(-1)?.protectionCanonicalHash,
            );
            assert.equal(
              saved?.cancelIntent?.remainderCancelProof?.unfilledRemainder,
              state.exchange.filledQuantity,
            );
          };
          const cancelled = unwrap(
            await cancelMainnetPreparedLeg(
              { sourceId: created.sourceId, runId },
              state.dependencies,
            ),
          );
          assert.equal(cancelled.status, "VERIFIED_CLOSED");
          assert.equal(state.exchange.orderStatus, "cancelled");
          assert.equal(state.exchange.cancelRequests.length, 1);
          assert.equal(
            state.exchange.cancelRequests[0]?.exchangeOrderId,
            state.exchange.exchangeOrderId,
          );
          assert.equal(state.exchange.attachedChildren[0], child);
          state.reopenPersistence();
          const recovery = unwrap(
            await cancelMainnetPreparedLeg(
              { sourceId: created.sourceId, runId },
              state.dependencies,
            ),
          );
          assert.equal(recovery.status, "VERIFIED_CLOSED");
          assert.equal(state.exchange.cancelRequests.length, 1);
          assert.equal(unwrap(state.persistence.readHalt()).active, false);
        } finally {
          state.cleanup();
        }
      },
    );
});

test("verified closed exposure fails closed on unavailable, malformed or mismatched fresh cancel proof", async (t) => {
  for (const fault of [
    "state-read",
    "malformed-parent",
    "exit-mismatch",
    "recovery-state-read",
    "recovery-parent-read",
  ] as const)
    await t.test(fault, async () => {
      const state = setup();
      try {
        const runId = "closed-exposure-cancel-fault";
        const created = await createPartialProtectedPreparedLeg(state, runId);
        closePartialTp(state);
        assert.equal(
          unwrap(
            await recoverMainnetPreparedLegSource(
              { sourceId: created.sourceId, runId },
              state.dependencies,
            ),
          ).status,
          "VERIFIED_CLOSED",
        );
        state.reopenPersistence();
        if (fault.startsWith("recovery-")) {
          assert.equal(
            unwrap(
              await cancelMainnetPreparedLeg(
                { sourceId: created.sourceId, runId },
                state.dependencies,
              ),
            ).status,
            "VERIFIED_CLOSED",
          );
          state.reopenPersistence();
        }
        if (fault === "state-read" || fault === "recovery-state-read")
          state.exchange.readState = async () => {
            throw new Error("state unavailable");
          };
        else if (
          fault === "malformed-parent" ||
          fault === "recovery-parent-read"
        ) {
          const observe = state.exchange.observeOrder.bind(state.exchange);
          state.exchange.observeOrder = async (request) => {
            if (fault === "recovery-parent-read")
              throw new Error("parent unavailable");
            const result = await observe(request);
            return result.ok
              ? {
                  ok: true,
                  value: {
                    ...result.value,
                    exchangeOrderId: "contradictory-parent",
                  },
                }
              : result;
          };
        } else state.exchange.exitFills = [];
        const blocked = unwrap(
          await cancelMainnetPreparedLeg(
            { sourceId: created.sourceId, runId },
            state.dependencies,
          ),
        );
        assert.equal(blocked.status, "PROTECTION_PENDING");
        assert.equal(
          state.exchange.cancelRequests.length,
          fault.startsWith("recovery-") ? 1 : 0,
        );
        state.reopenPersistence();
        assert.equal(unwrap(state.persistence.readHalt()).active, true);
        assert.equal(
          unwrap(
            state.persistence.preparedLegExecution!.readPreparedLegSource(
              created.sourceId,
            ),
          )?.reconciliations.at(-1)?.status,
          "PROTECTION_PENDING",
        );
      } finally {
        state.cleanup();
      }
    });
});

test("remainder cancel is blocked when active TP reads disagree", async () => {
  const state = setup();
  try {
    const runId = "prepared-leg-partial-cancel-tp-read-mismatch-run";
    const created = await createPartialProtectedPreparedLeg(state, runId);
    state.currentTime.value = plusMs(state.currentTime.value, 1000);
    state.localTime.value = state.currentTime.value;
    state.exchange.additionalOpenOrders = [];

    const result = await cancelMainnetPreparedLeg(
      { sourceId: created.sourceId, runId },
      state.dependencies,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.status, "PROTECTION_PENDING");
    assert.equal(state.exchange.cancelRequests.length, 0);
    assert.equal(unwrap(state.persistence.readHalt()).active, true);
  } finally {
    state.cleanup();
  }
});

test("remainder-cancel preflight uncertainty persists pending protection and HALT", async (t) => {
  for (const fault of [
    "state-read",
    "parent-read",
    "malformed-parent",
    "protection-read",
    "fill-read",
  ] as const) {
    await t.test(fault, async () => {
      const state = setup();
      try {
        const runId = `prepared-leg-cancel-preflight-${fault}-run`;
        const created = await createPartialProtectedPreparedLeg(state, runId);
        state.currentTime.value = plusMs(state.currentTime.value, 1000);
        state.localTime.value = state.currentTime.value;

        const readFailure = {
          ok: false as const,
          error: {
            kind: "transport" as const,
            message: "simulated preflight read failure",
            retry: "reconcile" as const,
            operation: "read" as const,
          },
        };
        if (fault === "state-read") {
          state.exchange.readState = async () => readFailure;
        } else if (fault === "parent-read") {
          state.exchange.observeOrder = async () => ({
            ...readFailure,
            error: { ...readFailure.error, operation: "observe" as const },
          });
        } else if (fault === "malformed-parent") {
          const observe = state.exchange.observeOrder.bind(state.exchange);
          state.exchange.observeOrder = async (request) => {
            const result = await observe(request);
            return result.ok
              ? {
                  ok: true,
                  value: {
                    ...result.value,
                    category: "spot",
                  },
                }
              : result;
          };
        } else if (fault === "protection-read") {
          state.exchange.listAttachedProtection = async () => ({
            ...readFailure,
            error: { ...readFailure.error, operation: "observe" as const },
          });
        } else {
          state.exchange.listFills = async () => ({
            ...readFailure,
            error: { ...readFailure.error, operation: "fills" as const },
          });
        }

        const result = await cancelMainnetPreparedLeg(
          { sourceId: created.sourceId, runId },
          state.dependencies,
        );
        assert.equal(
          result.ok,
          true,
          result.ok ? "" : `${result.error.code}: ${result.error.message}`,
        );
        if (!result.ok) return;
        assert.equal(result.value.status, "PROTECTION_PENDING");
        assert.equal(state.exchange.cancelRequests.length, 0);
        assert.equal(unwrap(state.persistence.readHalt()).active, true);

        state.reopenPersistence();
        const saved = unwrap(
          state.persistence.preparedLegExecution!.readPreparedLegSource(
            created.sourceId,
          ),
        );
        const latest = saved?.reconciliations.at(-1);
        assert.equal(latest?.status, "PROTECTION_PENDING");
        assert.equal(latest?.protectionEvidence?.status, "PROTECTION_PENDING");
        assert.equal(
          latest?.protectionEvidence?.collection.position,
          "incomplete",
        );
        assert.equal(
          latest?.protectionEvidence?.coverage.outstandingQuantity,
          null,
        );
        assert.equal(unwrap(state.persistence.readHalt()).active, true);
      } finally {
        state.cleanup();
      }
    });
  }
});

test("remainder cancel needs its own authority and writes nothing when denied", async () => {
  const state = setup();
  try {
    const created = await createPartialProtectedPreparedLeg(
      state,
      "prepared-leg-partial-cancel-denied-run",
    );
    state.currentTime.value = plusMs(state.currentTime.value, 1000);
    state.localTime.value = state.currentTime.value;
    state.authorization.deny = true;

    const denied = await cancelMainnetPreparedLeg(
      {
        sourceId: created.sourceId,
        runId: "prepared-leg-partial-cancel-denied-run",
      },
      state.dependencies,
    );
    assert.equal(denied.ok, false);
    assert.equal(state.exchange.cancelRequests.length, 0);
    const source = unwrap(
      state.persistence.preparedLegExecution!.readPreparedLegSource(
        created.sourceId,
      ),
    );
    assert.equal(source?.cancelIntent, undefined);
    assert.equal(source?.cancelAttempt, undefined);
  } finally {
    state.cleanup();
  }
});

test("fills racing the remainder cancel recompute outstanding coverage", async () => {
  const state = setup();
  try {
    const runId = "prepared-leg-partial-cancel-fill-race-run";
    const created = await createPartialProtectedPreparedLeg(state, runId);
    const leg =
      state.fixture.approval.replayInputs.prepared.replayInputs.preflight
        .replayInputs.dailyPlan.candidateLegs![0]!;
    const clientOrderId = unwrap(
      derivePreparedLegClientOrderId(
        state.prepared.contentHash,
        state.fixture.legId,
      ),
    );
    const filled = leg.intent.quantity.multiply(decimal("0.75"));
    const exited = leg.intent.quantity.multiply(decimal("0.25"));
    const outstanding = filled.subtract(exited);
    state.currentTime.value = plusMs(state.currentTime.value, 1000);
    state.localTime.value = state.currentTime.value;
    state.exchange.afterCancel = () => {
      state.exchange.filledQuantity = filled.toString();
      state.exchange.positionSide = "long";
      state.exchange.positionQuantity = outstanding.toString();
      state.exchange.fills = [
        {
          executionId: "exec-partial-entry-after-cancel",
          exchangeOrderId: state.exchange.exchangeOrderId,
          clientOrderId,
          instrument: leg.intent.instrument,
          side: "buy",
          quantity: filled,
          price: leg.intent.price,
          executedAt: state.currentTime.value,
          source: "bybit-mainnet/execution",
        },
      ];
      state.exchange.exitFills = [
        {
          executionId: "exec-partial-exit-after-cancel",
          exchangeOrderId: "mainnet-tp-partial-21",
          clientOrderId,
          instrument: leg.intent.instrument,
          side: "sell",
          quantity: exited,
          price: leg.intent.protection!.takeProfit!,
          executedAt: state.currentTime.value,
          source: "bybit-mainnet/execution",
        },
      ];
      const child = unwrap(
        createExchangeOrder({
          exchangeOrderId: "mainnet-tp-partial-21",
          clientOrderId,
          providerOrderLinkId: clientOrderId,
          parentOrderLinkId: clientOrderId,
          providerStopOrderType: "PartialTakeProfit",
          providerTpslMode: "Partial",
          protectionType: "take-profit",
          instrument: leg.intent.instrument,
          category: "linear",
          side: "sell",
          orderType: "market",
          requestedQuantity: filled.toString(),
          filledQuantity: exited.toString(),
          status: "partially-filled",
          triggerPrice: leg.intent.protection!.takeProfit!.toString(),
          takeProfitTriggerBy: "LastPrice",
          triggerBy: "LastPrice",
          reduceOnly: true,
          positionIdx: 0,
          providerCreatedAt: state.currentTime.value,
          providerUpdatedAt: state.currentTime.value,
          observedAt: state.currentTime.value,
          source: "bybit-mainnet/protection/order/realtime",
        }),
      );
      state.exchange.attachedChildren = [child];
      state.exchange.additionalOpenOrders = [child];
    };

    const result = await cancelMainnetPreparedLeg(
      { sourceId: created.sourceId, runId },
      state.dependencies,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.status, "PROTECTION_CONFIRMED");
    const source = unwrap(
      state.persistence.preparedLegExecution!.readPreparedLegSource(
        created.sourceId,
      ),
    );
    const evidence = source?.reconciliations.at(-1)?.protectionEvidence;
    assert.equal(evidence?.entries.quantity, filled.toString());
    assert.equal(evidence?.exits.quantity, exited.toString());
    assert.equal(
      evidence?.coverage.outstandingQuantity,
      outstanding.toString(),
    );
    assert.equal(
      evidence?.coverage.activeRemainingQuantity,
      outstanding.toString(),
    );
    assert.equal(state.exchange.cancelRequests.length, 1);
  } finally {
    state.cleanup();
  }
});

test("already-filled partial parent is reconciled without a remainder-cancel POST", async () => {
  const state = setup();
  try {
    const runId = "prepared-leg-already-filled-cancel-run";
    const created = await createPartialProtectedPreparedLeg(state, runId);
    const leg =
      state.fixture.approval.replayInputs.prepared.replayInputs.preflight
        .replayInputs.dailyPlan.candidateLegs![0]!;
    const clientOrderId = unwrap(
      derivePreparedLegClientOrderId(
        state.prepared.contentHash,
        state.fixture.legId,
      ),
    );
    state.currentTime.value = plusMs(state.currentTime.value, 1000);
    state.localTime.value = state.currentTime.value;
    state.exchange.orderStatus = "filled";
    state.exchange.filledQuantity = leg.intent.quantity.toString();
    state.exchange.positionSide = "long";
    state.exchange.positionQuantity = leg.intent.quantity.toString();
    state.exchange.fills = [
      {
        executionId: "exec-partial-parent-filled-before-cancel",
        exchangeOrderId: state.exchange.exchangeOrderId,
        clientOrderId,
        instrument: leg.intent.instrument,
        side: "buy",
        quantity: leg.intent.quantity,
        price: leg.intent.price,
        executedAt: state.currentTime.value,
        source: "bybit-mainnet/execution",
      },
    ];
    const child = unwrap(
      createExchangeOrder({
        exchangeOrderId: "mainnet-tp-parent-filled-21",
        clientOrderId,
        providerOrderLinkId: clientOrderId,
        parentOrderLinkId: clientOrderId,
        providerStopOrderType: "PartialTakeProfit",
        providerTpslMode: "Partial",
        protectionType: "take-profit",
        instrument: leg.intent.instrument,
        category: "linear",
        side: "sell",
        orderType: "market",
        requestedQuantity: leg.intent.quantity.toString(),
        filledQuantity: "0",
        status: "open",
        triggerPrice: leg.intent.protection!.takeProfit!.toString(),
        takeProfitTriggerBy: "LastPrice",
        triggerBy: "LastPrice",
        reduceOnly: true,
        positionIdx: 0,
        providerCreatedAt: state.currentTime.value,
        providerUpdatedAt: state.currentTime.value,
        observedAt: state.currentTime.value,
        source: "bybit-mainnet/protection/order/realtime",
      }),
    );
    state.exchange.attachedChildren = [child];
    state.exchange.additionalOpenOrders = [child];

    const result = await cancelMainnetPreparedLeg(
      { sourceId: created.sourceId, runId },
      state.dependencies,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.status, "PROTECTION_CONFIRMED");
    assert.equal(state.exchange.cancelRequests.length, 0);
    const source = unwrap(
      state.persistence.preparedLegExecution!.readPreparedLegSource(
        created.sourceId,
      ),
    );
    assert.equal(source?.cancelIntent, undefined);
  } finally {
    state.cleanup();
  }
});

test("fully executed TP is verified closed across SQLite reopen without replacement writes", async () => {
  const state = setup();
  try {
    const runId = "prepared-leg-verified-closed-recovery-run";
    const created = await createPartialProtectedPreparedLeg(state, runId);
    const leg =
      state.fixture.approval.replayInputs.prepared.replayInputs.preflight
        .replayInputs.dailyPlan.candidateLegs![0]!;
    const clientOrderId = unwrap(
      derivePreparedLegClientOrderId(
        state.prepared.contentHash,
        state.fixture.legId,
      ),
    );
    const quantity = leg.intent.quantity;
    state.currentTime.value = plusMs(state.currentTime.value, 1000);
    state.localTime.value = state.currentTime.value;
    state.exchange.orderStatus = "filled";
    state.exchange.filledQuantity = quantity.toString();
    state.exchange.positionSide = "flat";
    state.exchange.positionQuantity = "0";
    state.exchange.fills = [
      {
        executionId: "exec-entry-fully-closed",
        exchangeOrderId: state.exchange.exchangeOrderId,
        clientOrderId,
        instrument: leg.intent.instrument,
        side: "buy",
        quantity,
        price: leg.intent.price,
        executedAt: state.currentTime.value,
        source: "bybit-mainnet/execution",
      },
    ];
    const child = unwrap(
      createExchangeOrder({
        exchangeOrderId: "mainnet-tp-fully-closed",
        clientOrderId,
        providerOrderLinkId: clientOrderId,
        parentOrderLinkId: clientOrderId,
        providerStopOrderType: "PartialTakeProfit",
        providerTpslMode: "Partial",
        protectionType: "take-profit",
        instrument: leg.intent.instrument,
        category: "linear",
        side: "sell",
        orderType: "market",
        requestedQuantity: quantity.toString(),
        filledQuantity: quantity.toString(),
        status: "filled",
        triggerPrice: leg.intent.protection!.takeProfit!.toString(),
        takeProfitTriggerBy: "LastPrice",
        triggerBy: "LastPrice",
        reduceOnly: true,
        positionIdx: 0,
        providerCreatedAt: state.currentTime.value,
        providerUpdatedAt: state.currentTime.value,
        observedAt: state.currentTime.value,
        source: "bybit-mainnet/protection/order/realtime",
      }),
    );
    state.exchange.attachedChildren = [child];
    state.exchange.additionalOpenOrders = [];
    state.exchange.exitFills = [
      {
        executionId: "exec-tp-fully-closed",
        exchangeOrderId: child.exchangeOrderId,
        clientOrderId,
        instrument: leg.intent.instrument,
        side: "sell",
        quantity,
        price: leg.intent.protection!.takeProfit!,
        executedAt: state.currentTime.value,
        source: "bybit-mainnet/execution",
      },
    ];

    const recovered = await recoverMainnetPreparedLegSource(
      { sourceId: created.sourceId, runId },
      state.dependencies,
    );
    assert.equal(
      recovered.ok,
      true,
      recovered.ok ? "" : `${recovered.error.code}: ${recovered.error.message}`,
    );
    if (!recovered.ok) return;
    assert.equal(recovered.value.status, "VERIFIED_CLOSED");
    assert.equal(state.exchange.createRequests.length, 1);
    assert.equal(state.exchange.cancelRequests.length, 0);

    state.reopenPersistence();
    const saved = unwrap(
      state.persistence.preparedLegExecution!.readPreparedLegSource(
        created.sourceId,
      ),
    );
    const evidence = saved?.reconciliations.at(-1)?.protectionEvidence;
    assert.equal(saved?.reconciliations.at(-1)?.status, "VERIFIED_CLOSED");
    assert.equal(evidence?.status, "VERIFIED_CLOSED");
    assert.equal(evidence?.coverage.outstandingQuantity, "0");
    assert.equal(evidence?.coverage.activeRemainingQuantity, "0");
    assert.equal(evidence?.position.side, "flat");
    assert.equal(evidence?.position.quantity, "0");

    const resumed = await recoverMainnetPreparedLegSource(
      { sourceId: created.sourceId, runId },
      state.dependencies,
    );
    assert.equal(resumed.ok, true);
    if (resumed.ok) assert.equal(resumed.value.status, "VERIFIED_CLOSED");
    assert.equal(state.exchange.createRequests.length, 1);
  } finally {
    state.cleanup();
  }
});

test("ambiguous remainder cancel journals once and stays recovery-only", async () => {
  const state = setup();
  try {
    const runId = "prepared-leg-partial-cancel-ambiguous-run";
    const created = await createPartialProtectedPreparedLeg(state, runId);
    state.currentTime.value = plusMs(state.currentTime.value, 1000);
    state.localTime.value = state.currentTime.value;
    state.exchange.cancelRemainsOpen = true;
    state.exchange.cancelThrows = true;

    const result = await cancelMainnetPreparedLeg(
      { sourceId: created.sourceId, runId },
      state.dependencies,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.status, "PROTECTION_PENDING");
    assert.equal(state.exchange.cancelRequests.length, 1);
    assert.equal(unwrap(state.persistence.readHalt()).active, true);
    const source = unwrap(
      state.persistence.preparedLegExecution!.readPreparedLegSource(
        created.sourceId,
      ),
    );
    assert.equal(source?.reconciliations.at(-1)?.status, "PROTECTION_PENDING");
    assert.equal(
      source?.reconciliations.at(-1)?.protectionEvidence?.status,
      "PROTECTION_PENDING",
    );
    assert.ok(source?.cancelIntent?.remainderCancelProof);
    assert.ok(source?.cancelAttempt);
    assert.match(source.cancelAttempt.canonicalJson, /"outcome":"ambiguous"/u);

    const recovered = await cancelMainnetPreparedLeg(
      { sourceId: created.sourceId, runId },
      state.dependencies,
    );
    assert.equal(recovered.ok, true);
    if (recovered.ok)
      assert.equal(recovered.value.status, "PROTECTION_PENDING");
    assert.equal(state.exchange.cancelRequests.length, 1);
  } finally {
    state.cleanup();
  }
});

test("lost lease after durable remainder intent prevents the cancel POST", async () => {
  const state = setup();
  try {
    const runId = "prepared-leg-partial-cancel-lost-lease-run";
    const created = await createPartialProtectedPreparedLeg(state, runId);
    state.currentTime.value = plusMs(state.currentTime.value, 1000);
    state.localTime.value = state.currentTime.value;
    const store = state.dependencies.preparedLegs!;
    const prepare = store.preparePreparedLegCancel.bind(store);
    store.preparePreparedLegCancel = (request) => {
      const prepared = prepare(request);
      if (prepared.ok) {
        const released = state.persistence.releaseLease(request.authority);
        assert.equal(released.ok, true);
        const acquired = state.persistence.acquireLease({
          scope: state.persistence.scope,
          ownerRunId: "replacement-lease-owner",
          now: state.currentTime.value,
          ttlMs: 60_000,
        });
        assert.equal(acquired.ok, true);
      }
      return prepared;
    };

    const stopped = await cancelMainnetPreparedLeg(
      { sourceId: created.sourceId, runId },
      state.dependencies,
    );
    assert.equal(stopped.ok, false);
    assert.equal(state.exchange.cancelRequests.length, 0);
    const source = unwrap(
      state.persistence.preparedLegExecution!.readPreparedLegSource(
        created.sourceId,
      ),
    );
    assert.ok(source?.cancelIntent?.remainderCancelProof);
    assert.equal(source?.cancelAttempt, undefined);
    const lease = unwrap(state.persistence.readScopeSnapshot()).lease;
    assert.equal(lease?.ownerRunId, "replacement-lease-owner");
  } finally {
    state.cleanup();
  }
});

test("crash after remainder intent and restart is recovery-only before cancel POST", async () => {
  const state = setup();
  try {
    const runId = "prepared-leg-partial-cancel-pre-post-crash-run";
    const created = await createPartialProtectedPreparedLeg(state, runId);
    state.currentTime.value = plusMs(state.currentTime.value, 1000);
    state.localTime.value = state.currentTime.value;
    const store = state.dependencies.preparedLegs!;
    const prepare = store.preparePreparedLegCancel.bind(store);
    store.preparePreparedLegCancel = (request) => {
      const prepared = prepare(request);
      if (prepared.ok) {
        state.reopenPersistence();
        throw new Error("simulated crash after durable intent");
      }
      return prepared;
    };

    await assert.rejects(
      cancelMainnetPreparedLeg(
        { sourceId: created.sourceId, runId },
        state.dependencies,
      ),
      /simulated crash after durable intent/u,
    );
    assert.equal(state.exchange.cancelRequests.length, 0);
    let source = unwrap(
      state.persistence.preparedLegExecution!.readPreparedLegSource(
        created.sourceId,
      ),
    );
    assert.ok(source?.cancelIntent?.remainderCancelProof);
    assert.equal(source?.cancelAttempt, undefined);

    const recovered = await cancelMainnetPreparedLeg(
      { sourceId: created.sourceId, runId },
      state.dependencies,
    );
    assert.equal(recovered.ok, true);
    if (recovered.ok)
      assert.equal(recovered.value.status, "PROTECTION_PENDING");
    assert.equal(state.exchange.cancelRequests.length, 0);
    source = unwrap(
      state.persistence.preparedLegExecution!.readPreparedLegSource(
        created.sourceId,
      ),
    );
    assert.equal(source?.cancelAttempt, undefined);
    assert.equal(
      source?.reconciliations.at(-1)?.protectionEvidence?.status,
      "PROTECTION_PENDING",
    );
    assert.equal(unwrap(state.persistence.readHalt()).active, true);
  } finally {
    state.cleanup();
  }
});

test("attempt-journal interruption after remainder POST recovers without retry", async () => {
  const state = setup();
  try {
    const runId = "prepared-leg-partial-cancel-attempt-crash-run";
    const created = await createPartialProtectedPreparedLeg(state, runId);
    state.currentTime.value = plusMs(state.currentTime.value, 1000);
    state.localTime.value = state.currentTime.value;
    const cancel = state.exchange.cancelOrder.bind(state.exchange);
    state.exchange.cancelOrder = async (request) => {
      const acknowledgement = await cancel(request);
      state.reopenPersistence();
      state.dependencies.preparedLegs!.appendPreparedLegAttempt = () =>
        fail(
          domainError(
            "PERSISTENCE_INTEGRITY",
            "injected attempt interruption after restart",
          ),
        );
      return acknowledgement;
    };

    const interrupted = await cancelMainnetPreparedLeg(
      { sourceId: created.sourceId, runId },
      state.dependencies,
    );
    assert.equal(interrupted.ok, false);
    assert.equal(state.exchange.cancelRequests.length, 1);
    let source = unwrap(
      state.persistence.preparedLegExecution!.readPreparedLegSource(
        created.sourceId,
      ),
    );
    assert.ok(source?.cancelIntent?.remainderCancelProof);
    assert.equal(source?.cancelAttempt, undefined);
    assert.equal(unwrap(state.persistence.readHalt()).active, true);

    state.reopenPersistence();
    const recovered = await cancelMainnetPreparedLeg(
      { sourceId: created.sourceId, runId },
      state.dependencies,
    );
    assert.equal(recovered.ok, true);
    if (recovered.ok)
      assert.equal(recovered.value.status, "PROTECTION_PENDING");
    assert.equal(state.exchange.cancelRequests.length, 1);
    source = unwrap(
      state.persistence.preparedLegExecution!.readPreparedLegSource(
        created.sourceId,
      ),
    );
    assert.equal(source?.cancelAttempt, undefined);
  } finally {
    state.cleanup();
  }
});

test("recovery creates one deterministic attempt identity after dispatch-before-attempt interruption", async () => {
  const state = setup();
  try {
    const approvedLeg =
      state.fixture.approval.replayInputs.prepared.replayInputs.preflight
        .replayInputs.dailyPlan.candidateLegs![0]!;
    state.exchange.afterCreate = () => {
      state.exchange.orderStatus = "filled";
      state.exchange.filledQuantity = approvedLeg.intent.quantity.toString();
      state.exchange.positionSide = "long";
      state.exchange.positionQuantity = approvedLeg.intent.quantity.toString();
      state.exchange.fills = [
        {
          executionId: "exec-recovered-mainnet-21",
          exchangeOrderId: state.exchange.exchangeOrderId,
          clientOrderId: unwrap(
            derivePreparedLegClientOrderId(
              state.prepared.contentHash,
              state.fixture.legId,
            ),
          ),
          instrument: approvedLeg.intent.instrument,
          side: "buy",
          quantity: approvedLeg.intent.quantity,
          price: approvedLeg.intent.price,
          executedAt: state.currentTime.value,
          source: "bybit-mainnet/execution",
        },
      ];
    };
    const preparedLegStore = state.dependencies.preparedLegs;
    const appendAttempt =
      preparedLegStore.appendPreparedLegAttempt.bind(preparedLegStore);
    preparedLegStore.appendPreparedLegAttempt = (request) =>
      request.operation === "create"
        ? fail(
            domainError(
              "PERSISTENCE_INTEGRITY",
              "simulated interruption after exchange dispatch",
            ),
          )
        : appendAttempt(request);

    const dispatched = await createMainnetPreparedLeg(
      {
        approvalHash: state.approval.contentHash,
        legId: state.fixture.legId,
        runId: "prepared-leg-recovered-attempt-run",
      },
      state.dependencies,
    );
    assert.equal(dispatched.ok, false);
    assert.equal(state.exchange.createRequests.length, 1);

    const sourceId = unwrap(
      derivePreparedLegSourceId(
        state.accountHash,
        state.prepared.contentHash,
        state.fixture.legId,
      ),
    );
    const interrupted = unwrap(
      state.dependencies.preparedLegs.readPreparedLegSource(sourceId),
    );
    assert.ok(interrupted?.createIntent);
    assert.equal(interrupted.createAttempt, undefined);

    preparedLegStore.appendPreparedLegAttempt = appendAttempt;
    const recovered = await recoverMainnetPreparedLegSource(
      {
        sourceId,
        runId: "prepared-leg-recovered-attempt-run",
      },
      state.dependencies,
    );
    assert.equal(
      recovered.ok,
      true,
      recovered.ok ? "" : `${recovered.error.code}: ${recovered.error.message}`,
    );
    if (!recovered.ok) return;
    assert.equal(recovered.value.status, "PROTECTION_PENDING");
    assert.equal(state.exchange.createRequests.length, 1);

    const durable = unwrap(
      state.dependencies.preparedLegs.readPreparedLegSource(sourceId),
    );
    assert.ok(durable?.createAttempt);
    assert.equal(
      durable.createAttempt.writeIntentId,
      durable.createIntent.writeIntentId,
    );
    assert.match(durable.createAttempt.attemptId, /^recovered-create-/u);
    assert.notEqual(
      durable.createAttempt.attemptId,
      durable.createIntent.writeIntentId,
    );
    const fillFact = unwrap(state.persistence.readFacts()).find(
      (fact) => fact.factKind === "fill",
    );
    assert.ok(fillFact);
    const persistedFill = unwrap(
      rehydrateArtifact("fill", fillFact.artifact.envelope),
    );
    assert.ok("attemptId" in persistedFill);
    assert.equal(persistedFill.attemptId, durable.createAttempt.attemptId);
  } finally {
    state.cleanup();
  }
});

test("a post-create unowned target order makes reconciliation unresolved and prevents replacement create", async () => {
  const state = setup();
  try {
    state.exchange.afterCreate = () => {
      state.exchange.additionalOpenOrders = [
        unwrap(
          createExchangeOrder({
            exchangeOrderId: "manual-order-21",
            clientOrderId: "manual-order-link-21",
            instrument:
              state.fixture.approval.replayInputs.prepared.summary.symbol,
            category: "linear",
            side: "buy",
            requestedQuantity: "0.01",
            filledQuantity: "0",
            status: "open",
            orderType: "limit",
            price: "100",
            timeInForce: "GTC",
            takeProfit: null,
            stopLoss: null,
            reduceOnly: false,
            positionIdx: 0,
            observedAt: state.currentTime.value,
            source: "fixture/manual-order",
          }),
        ),
      ];
    };
    const created = await createMainnetPreparedLeg(
      {
        approvalHash: state.approval.contentHash,
        legId: state.fixture.legId,
        runId: "prepared-leg-conflict-run",
      },
      state.dependencies,
    );
    assert.equal(
      created.ok,
      true,
      created.ok ? "" : `${created.error.code}: ${created.error.message}`,
    );
    if (!created.ok) return;
    assert.equal(created.value.status, "UNRESOLVED");
    assert.equal(unwrap(state.persistence.readHalt()).active, true);
    assert.equal(state.exchange.createRequests.length, 1);

    const resumed = await createMainnetPreparedLeg(
      {
        approvalHash: state.approval.contentHash,
        legId: state.fixture.legId,
        runId: "prepared-leg-conflict-run",
      },
      state.dependencies,
    );
    assert.equal(
      resumed.ok,
      true,
      resumed.ok ? "" : `${resumed.error.code}: ${resumed.error.message}`,
    );
    assert.equal(state.exchange.createRequests.length, 1);
  } finally {
    state.cleanup();
  }
});

test("recovery and exact cancel use durable source without approval lookup or duplicate cancel POST", async () => {
  const state = setup();
  try {
    const created = await createMainnetPreparedLeg(
      {
        approvalHash: state.approval.contentHash,
        legId: state.fixture.legId,
        runId: "prepared-leg-recovery-run",
      },
      state.dependencies,
    );
    assert.equal(
      created.ok,
      true,
      created.ok ? "" : `${created.error.code}: ${created.error.message}`,
    );
    if (!created.ok) return;
    const loadCountAfterCreate = state.approvalLoads;
    const recovered = await recoverMainnetPreparedLegSource(
      {
        sourceId: created.value.sourceId,
        runId: "prepared-leg-recovery-next",
      },
      state.dependencies,
    );
    assert.equal(recovered.ok, true);
    if (!recovered.ok) return;
    assert.equal(recovered.value.status, "CONFIRMED_OPEN");
    assert.equal(state.approvalLoads, loadCountAfterCreate);
    assert.equal(state.exchange.createRequests.length, 1);

    state.currentTime.value = plusMs(state.currentTime.value, 1000);
    const cancelled = await cancelMainnetPreparedLeg(
      {
        sourceId: created.value.sourceId,
        runId: "prepared-leg-cancel-run",
      },
      state.dependencies,
    );
    assert.equal(cancelled.ok, true);
    if (!cancelled.ok) return;
    assert.equal(cancelled.value.status, "CANCELLED");
    assert.equal(state.exchange.cancelRequests.length, 1);
    assert.equal(state.approvalLoads, loadCountAfterCreate);

    const resumed = await cancelMainnetPreparedLeg(
      {
        sourceId: created.value.sourceId,
        runId: "prepared-leg-cancel-resume",
      },
      state.dependencies,
    );
    assert.equal(resumed.ok, true);
    if (!resumed.ok) return;
    assert.equal(resumed.value.status, "CANCELLED");
    assert.equal(state.exchange.cancelRequests.length, 1);
    assert.equal(state.exchange.createRequests.length, 1);
  } finally {
    state.cleanup();
  }
});

test("stale cancel authorization leaves durable cancel intent unresolved on create rerun", async () => {
  const state = setup();
  try {
    const created = await createOpenPreparedLeg(
      state,
      "prepared-leg-cancel-stale-run",
    );
    state.currentTime.value = plusMs(state.currentTime.value, 1000);
    state.localTime.value = state.currentTime.value;
    state.authorization.onAuthorize = () => {
      state.advanceMonotonic(60_001);
    };

    const cancelled = await cancelMainnetPreparedLeg(
      {
        sourceId: created.sourceId,
        runId: "prepared-leg-cancel-stale-run",
      },
      state.dependencies,
    );
    assert.equal(cancelled.ok, false);
    assert.equal(state.exchange.cancelRequests.length, 0);
    assert.equal(unwrap(state.persistence.readHalt()).active, true);
    const pending = unwrap(
      state.persistence.preparedLegExecution!.readPreparedLegSource(
        created.sourceId,
      ),
    );
    assert.equal(
      pending?.cancelIntent?.exchangeOrderId,
      state.exchange.exchangeOrderId,
    );
    assert.equal(pending?.cancelAttempt, undefined);

    const resumed = await createMainnetPreparedLeg(
      {
        approvalHash: state.approval.contentHash,
        legId: state.fixture.legId,
        runId: "prepared-leg-cancel-stale-run",
      },
      state.dependencies,
    );
    assert.equal(
      resumed.ok,
      true,
      resumed.ok ? "" : `${resumed.error.code}: ${resumed.error.message}`,
    );
    if (!resumed.ok) return;
    assert.equal(resumed.value.status, "UNRESOLVED");
    assert.equal(state.exchange.cancelRequests.length, 0);
    assert.equal(state.exchange.createRequests.length, 1);
    assert.equal(unwrap(state.persistence.readHalt()).active, true);
  } finally {
    state.cleanup();
  }
});

test("ambiguous cancel stays unresolved and fill race becomes protection-pending without replacement writes", async () => {
  const ambiguous = setup();
  try {
    const created = await createOpenPreparedLeg(
      ambiguous,
      "prepared-leg-cancel-ambiguous-run",
    );
    ambiguous.currentTime.value = plusMs(ambiguous.currentTime.value, 1000);
    ambiguous.localTime.value = ambiguous.currentTime.value;
    ambiguous.exchange.cancelRemainsOpen = true;
    ambiguous.exchange.cancelThrows = true;
    const result = await cancelMainnetPreparedLeg(
      {
        sourceId: created.sourceId,
        runId: "prepared-leg-cancel-ambiguous-run",
      },
      ambiguous.dependencies,
    );
    assert.equal(
      result.ok,
      true,
      result.ok ? "" : `${result.error.code}: ${result.error.message}`,
    );
    if (!result.ok) return;
    assert.equal(result.value.status, "UNRESOLVED");
    assert.equal(unwrap(ambiguous.persistence.readHalt()).active, true);
    const resumed = await cancelMainnetPreparedLeg(
      {
        sourceId: created.sourceId,
        runId: "prepared-leg-cancel-ambiguous-run",
      },
      ambiguous.dependencies,
    );
    assert.equal(resumed.ok, true);
    if (resumed.ok) assert.equal(resumed.value.status, "UNRESOLVED");
    assert.equal(ambiguous.exchange.cancelRequests.length, 1);
    assert.equal(ambiguous.exchange.createRequests.length, 1);
  } finally {
    ambiguous.cleanup();
  }

  const fillRace = setup();
  try {
    const created = await createOpenPreparedLeg(
      fillRace,
      "prepared-leg-cancel-fill-race-run",
    );
    fillRace.currentTime.value = plusMs(fillRace.currentTime.value, 1000);
    fillRace.localTime.value = fillRace.currentTime.value;
    fillRace.exchange.cancelFillRace = true;
    const result = await cancelMainnetPreparedLeg(
      {
        sourceId: created.sourceId,
        runId: "prepared-leg-cancel-fill-race-run",
      },
      fillRace.dependencies,
    );
    assert.equal(
      result.ok,
      true,
      result.ok ? "" : `${result.error.code}: ${result.error.message}`,
    );
    if (!result.ok) return;
    assert.equal(result.value.status, "PROTECTION_PENDING");
    assert.equal(fillRace.exchange.cancelRequests.length, 1);
    assert.equal(fillRace.exchange.createRequests.length, 1);
    assert.equal(unwrap(fillRace.persistence.readHalt()).active, true);
    const saved = unwrap(
      fillRace.persistence.preparedLegExecution!.readPreparedLegSource(
        created.sourceId,
      ),
    );
    assert.equal(saved?.reconciliations.at(-1)?.status, "PROTECTION_PENDING");
    assert.equal(
      saved?.reconciliations.at(-1)?.protectionEvidence?.status,
      "PROTECTION_PENDING",
    );
  } finally {
    fillRace.cleanup();
  }
});

test("provider-time approval expiry blocks dispatch when the local clock lags", async () => {
  const state = setup();
  try {
    const remainingMs =
      Date.parse(state.approval.expiresAt) -
      Date.parse(state.currentTime.value);
    state.authorization.onAuthorize = () => {
      state.advanceMonotonic(remainingMs + 1);
      state.localTime.value = state.fixture.now;
    };
    const result = await createMainnetPreparedLeg(
      {
        approvalHash: state.approval.contentHash,
        legId: state.fixture.legId,
        runId: "prepared-leg-provider-expiry",
      },
      state.dependencies,
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "PLAN_EXPIRED");
    assert.equal(state.exchange.createRequests.length, 0);
    assert.equal(unwrap(state.persistence.readHalt()).active, true);
    const sourceId = unwrap(
      derivePreparedLegSourceId(
        state.accountHash,
        state.prepared.contentHash,
        state.fixture.legId,
      ),
    );
    const source = unwrap(
      state.persistence.preparedLegExecution!.readPreparedLegSource(sourceId),
    );
    assert.ok(source?.createIntent);
  } finally {
    state.cleanup();
  }
});

test("authorization and final evidence gates fail closed; lost post-write local time remains journaled", async () => {
  const unauthorized = setup({ denyAuthorization: true });
  try {
    const result = await createMainnetPreparedLeg(
      {
        approvalHash: unauthorized.approval.contentHash,
        legId: unauthorized.fixture.legId,
        runId: "prepared-leg-no-auth",
      },
      unauthorized.dependencies,
    );
    assert.equal(result.ok, false);
    assert.equal(unauthorized.exchange.createRequests.length, 0);
    assert.equal(unwrap(unauthorized.persistence.readRuns()).length, 0);
  } finally {
    unauthorized.cleanup();
  }

  const stale = setup({ accountEvidenceAgeMs: 59_999 });
  try {
    const result = await createMainnetPreparedLeg(
      {
        approvalHash: stale.approval.contentHash,
        legId: stale.fixture.legId,
        runId: "prepared-leg-stale-final",
      },
      stale.dependencies,
    );
    assert.equal(result.ok, false);
    assert.equal(stale.exchange.createRequests.length, 0);
    assert.equal(unwrap(stale.persistence.readHalt()).active, true);
  } finally {
    stale.cleanup();
  }

  const lostLocalTime = setup();
  try {
    lostLocalTime.exchange.afterCreate = () => {
      lostLocalTime.localTime.value = "invalid-timestamp";
    };
    const created = await createMainnetPreparedLeg(
      {
        approvalHash: lostLocalTime.approval.contentHash,
        legId: lostLocalTime.fixture.legId,
        runId: "prepared-leg-lost-local-time",
      },
      lostLocalTime.dependencies,
    );
    assert.equal(
      created.ok,
      true,
      created.ok ? "" : `${created.error.code}: ${created.error.message}`,
    );
    if (!created.ok) return;
    assert.equal(created.value.status, "UNRESOLVED");
    assert.equal(lostLocalTime.exchange.createRequests.length, 1);
    assert.equal(unwrap(lostLocalTime.persistence.readHalt()).active, true);
    const sourceId = unwrap(
      derivePreparedLegSourceId(
        lostLocalTime.accountHash,
        lostLocalTime.prepared.contentHash,
        lostLocalTime.fixture.legId,
      ),
    );
    const source = unwrap(
      lostLocalTime.persistence.preparedLegExecution!.readPreparedLegSource(
        sourceId,
      ),
    );
    assert.equal(source?.createAttempt?.operation, "create");
    assert.match(
      source?.createAttempt?.canonicalJson ?? "",
      /ATTEMPT_TIMESTAMP_UNAVAILABLE/u,
    );
  } finally {
    lostLocalTime.cleanup();
  }
});
