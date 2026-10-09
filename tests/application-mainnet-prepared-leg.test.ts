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
  deny = false;
  onAuthorize?: () => void;

  async authorize(
    binding: PreparedLegWriteAuthorizationBinding,
  ): Promise<PreparedLegWriteCapability | undefined> {
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
  additionalOpenOrders: readonly ExchangeOrderObservation[] = [];
  positionSide: MainnetExchangeReadState["position"]["side"] = "flat";
  positionQuantity = "0";
  leverage = "1";
  beforeCreate?: () => void;
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

  async listAttachedProtection(): Promise<
    ExchangeResult<readonly ExchangeOrderObservation[]>
  > {
    return { ok: true, value: [] };
  }

  async listFills(): Promise<
    ExchangeResult<readonly ExchangeFillObservation[]>
  > {
    return { ok: true, value: this.fills };
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
  const currentTime = { value: timestamp(fixture.now) };
  const localTime = { value: fixture.now };
  const persistence = unwrap(
    openSqlitePersistence({
      environment: "mainnet",
      databasePath: join(root, "mainnet.db"),
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
        accountEvidenceHash: `sha256:${"a".repeat(64)}`,
      },
      accountEvidenceAgeMs: options.accountEvidenceAgeMs ?? 0,
      unrelatedCoverageGapCount: 0,
      reasonCodes: [],
      providerReasonCodes: [],
      warningCodes: [],
    };
    return { readiness, state };
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
  return {
    fixture,
    prepared,
    approval,
    accountHash,
    currentTime,
    localTime,
    persistence,
    exchange,
    dependencies,
    authorization,
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
            side: "sell",
            requestedQuantity: approvedLeg.intent.quantity.toString(),
            filledQuantity: "0",
            status: "open",
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

test("ambiguous cancel and fill race remain unresolved without replacement writes", async () => {
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
    assert.equal(result.value.status, "UNRESOLVED");
    assert.equal(fillRace.exchange.cancelRequests.length, 1);
    assert.equal(fillRace.exchange.createRequests.length, 1);
    assert.equal(unwrap(fillRace.persistence.readHalt()).active, true);
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
