import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openSqlitePersistence } from "../../src/adapters/sqlite/sqlite-persistence.js";
import { BYBIT_MAINNET_CAPABILITY_PROFILE } from "../../src/adapters/bybit-v5/capability-profile.js";
import { createAdapterCapabilityObservation } from "../../src/domain/capabilities/capability.js";
import {
  accountEvidenceContentHash,
  createAccountEvidenceBundle,
  type AccountEvidenceBundle,
} from "../../src/domain/account/account-evidence-bundle.js";
import type { AccountOrderEvidence } from "../../src/domain/account/account-evidence-bundle.js";
import { createEvidenceRef } from "../../src/domain/evidence/evidence-ref.js";
import {
  createExchangeOrder,
  type ExchangeOrderObservation,
} from "../../src/domain/execution/exchange-order.js";
import { createPreparedLegGridExecution } from "../../src/domain/execution/prepared-leg-execution.js";
import type { PreparedLegExecution } from "../../src/domain/execution/prepared-leg-execution.js";
import { encodeCanonicalArtifact } from "../../src/domain/identity/canonical-artifact.js";
import { hashCanonical } from "../../src/domain/identity/canonical-serialization.js";
import { createMarketSnapshot } from "../../src/domain/market/snapshots.js";
import { DecimalValue } from "../../src/domain/shared/decimal.js";
import { ok, type Result } from "../../src/domain/shared/result.js";
import {
  parseUtcTimestamp,
  type UtcTimestamp,
} from "../../src/domain/shared/time.js";
import type { PreparedArtifactStore } from "../../src/ports/prepared-artifact-store.js";
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
} from "../../src/ports/exchange-execution.js";
import type { PersistenceScope } from "../../src/ports/persistence.js";
import type {
  PreparedLegWriteAuthorizationBinding,
  PreparedLegWriteAuthorizationPort,
  PreparedLegWriteCapability,
} from "../../src/ports/prepared-leg-write-authorization.js";
import { PROVISIONAL_M1_POLICY_VERSION } from "../../src/application/policies/provisional-m1.js";
import {
  decimal as accountDecimal,
  known as accountKnown,
  na as accountNotApplicable,
  order as accountOrder,
} from "../account-evidence-fixture.js";
import {
  PREPARED_LEG_FOUR_LEVELS,
  preparedLegExecutionFixture,
} from "./prepared-leg-execution-fixtures.js";

const runtime = { nodeVersion: "22.22.3", sqliteVersion: "3.51.3" } as const;
const evaluationTime = "2026-09-24T14:00:06.000Z";
export const symbol = "BTCUSDT";

function decimal(value: string): DecimalValue {
  const parsed = DecimalValue.fromString(value);
  if (!parsed.ok) throw new Error("invalid decimal fixture");
  return parsed.value;
}

export function timestamp(value: string): UtcTimestamp {
  const parsed = parseUtcTimestamp(value);
  if (!parsed.ok) throw new Error("invalid time fixture");
  return parsed.value;
}

export function unwrap<T>(result: Result<T>): T {
  if (!result.ok)
    throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

class TestWriteAuthorization implements PreparedLegWriteAuthorizationPort {
  readonly issued = new WeakMap<object, string>();
  onAuthorize?: (binding: PreparedLegWriteAuthorizationBinding) => void;

  async authorize(
    binding: PreparedLegWriteAuthorizationBinding,
  ): Promise<PreparedLegWriteCapability | undefined> {
    const capability = Object.freeze({});
    const hash = hashCanonical(binding);
    if (!hash.ok) return undefined;
    this.issued.set(capability, hash.value);
    this.onAuthorize?.(binding);
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

type DispatchBehavior =
  | "open"
  | "rejected"
  | "partial"
  | "filled"
  | "cancelled"
  | "invisible-timeout"
  | "wrong-tp"
  | "wrong-order";

export type ProtectionBehavior =
  | "normal"
  | "missing"
  | "missing-parent"
  | "wrong-parent"
  | "wrong-trigger"
  | "partial-exit"
  | "complete-exit"
  | "distinct-child-link";

interface FakeOrder {
  readonly request: ExchangeOrderRequest;
  readonly exchangeOrderId: string;
  readonly createdAt: UtcTimestamp;
  status: ExchangeOrderObservation["status"];
  filledQuantity: string;
  fills: readonly ExchangeFillObservation[];
  observedClientOrderId?: string;
  observedTakeProfit?: string;
}

class FakeGridExchange implements MainnetExchangeExecutionPort {
  readonly createRequests: ExchangeOrderRequest[] = [];
  readonly cancelRequests: ExchangeCancelOrderRequest[] = [];
  readonly readRequests: ExchangeReadStateRequest[] = [];
  readonly observeRequests: ExchangeOrderLookup[] = [];
  readonly orders = new Map<string, FakeOrder>();
  readonly additionalOpenOrders: ExchangeOrderObservation[] = [];
  readonly protectionBehaviorByParent = new Map<string, ProtectionBehavior>();
  behaviorForDispatch: (index: number) => DispatchBehavior = () => "open";
  afterCreate?: (request: ExchangeOrderRequest, index: number) => void;

  constructor(
    readonly constraints: unknown,
    readonly clock: { value: UtcTimestamp },
  ) {}

  private orderObservation(order: FakeOrder): ExchangeOrderObservation {
    return unwrap(
      createExchangeOrder({
        exchangeOrderId: order.exchangeOrderId,
        clientOrderId:
          order.observedClientOrderId ?? order.request.clientOrderId,
        instrument: order.request.intent.instrument,
        category: "linear",
        side: "buy",
        requestedQuantity: order.request.intent.quantity.toString(),
        filledQuantity: order.filledQuantity,
        status: order.status,
        orderType: "limit",
        price: order.request.intent.price.toString(),
        timeInForce: order.request.timeInForce,
        takeProfit:
          order.observedTakeProfit ??
          order.request.intent.protection?.takeProfit?.toString() ??
          null,
        stopLoss: order.request.intent.protection?.stopLoss?.toString() ?? null,
        providerTpslMode:
          order.request.intent.protection?.takeProfitPolicy?.tpslMode,
        takeProfitTriggerBy:
          order.request.intent.protection?.takeProfitPolicy?.triggerBy,
        reduceOnly: order.request.reduceOnly,
        positionIdx: 0,
        observedAt: this.clock.value,
        source: "bybit-mainnet/realtime",
      }),
    );
  }

  private protectionChild(
    parent: FakeOrder,
  ): ExchangeOrderObservation | undefined {
    if (
      !Number.isFinite(Number(parent.filledQuantity)) ||
      Number(parent.filledQuantity) <= 0
    )
      return undefined;
    const behavior =
      this.protectionBehaviorByParent.get(parent.request.clientOrderId) ??
      "normal";
    if (behavior === "missing") return undefined;

    const requestedQuantity = decimal(parent.filledQuantity);
    const filledQuantity =
      behavior === "partial-exit"
        ? requestedQuantity.multiply(decimal("0.4"))
        : behavior === "complete-exit"
          ? requestedQuantity
          : decimal("0");
    const takeProfit = parent.request.intent.protection?.takeProfit;
    const takeProfitPolicy = parent.request.intent.protection?.takeProfitPolicy;
    if (!takeProfit || !takeProfitPolicy) return undefined;
    return unwrap(
      createExchangeOrder({
        exchangeOrderId: `grid-tp-${parent.exchangeOrderId}`,
        // Bybit may return an empty child orderLinkId. Its mapped client id is
        // then the parent alias, while raw parentOrderLinkId remains proof.
        clientOrderId:
          behavior === "distinct-child-link"
            ? `${parent.request.clientOrderId}-tp-child`
            : parent.request.clientOrderId,
        ...(behavior === "distinct-child-link"
          ? {
              providerOrderLinkId: `${parent.request.clientOrderId}-tp-child`,
            }
          : {}),
        instrument: parent.request.intent.instrument,
        category: "linear",
        protectionType: "take-profit",
        side: "sell",
        requestedQuantity: requestedQuantity.toString(),
        filledQuantity: filledQuantity.toString(),
        status: filledQuantity.isZero()
          ? "open"
          : filledQuantity.compare(requestedQuantity) === 0
            ? "filled"
            : "partially-filled",
        orderType: "market",
        triggerPrice:
          behavior === "wrong-trigger"
            ? takeProfit.add(decimal("1")).toString()
            : takeProfit.toString(),
        reduceOnly: true,
        positionIdx: 0,
        ...(behavior === "missing-parent"
          ? {}
          : {
              parentOrderLinkId:
                behavior === "wrong-parent"
                  ? "foreign-parent-order"
                  : parent.request.clientOrderId,
            }),
        providerStopOrderType: "PartialTakeProfit",
        providerTpslMode: takeProfitPolicy.tpslMode,
        triggerBy: takeProfitPolicy.triggerBy,
        takeProfitTriggerBy: takeProfitPolicy.triggerBy,
        providerCreatedAt: parent.createdAt,
        providerUpdatedAt: filledQuantity.isZero()
          ? parent.createdAt
          : this.clock.value,
        observedAt: this.clock.value,
        source: "bybit-mainnet/protection/order/realtime",
      }),
    );
  }

  private protectionChildren(): ExchangeOrderObservation[] {
    return [...this.orders.values()].flatMap((order) => {
      const child = this.protectionChild(order);
      return child &&
        (child.status === "open" || child.status === "partially-filled")
        ? [child]
        : [];
    });
  }

  private protectionFills(): ExchangeFillObservation[] {
    return [...this.orders.values()].flatMap((parent) => {
      const child = this.protectionChild(parent);
      if (!child || child.filledQuantity.isZero()) return [];
      const takeProfit = parent.request.intent.protection?.takeProfit;
      if (!takeProfit) return [];
      return [
        {
          executionId: `grid-tp-fill-${parent.exchangeOrderId}`,
          exchangeOrderId: child.exchangeOrderId,
          clientOrderId: child.providerOrderLinkId ?? child.clientOrderId,
          instrument: parent.request.intent.instrument,
          side: "sell" as const,
          quantity: child.filledQuantity,
          price: takeProfit,
          executedAt: this.clock.value,
          source: "bybit-mainnet/execution",
        },
      ];
    });
  }

  private readStateValue(): MainnetExchangeReadState {
    const now = this.clock.value;
    const marketHash = unwrap(
      hashCanonical({ scope: "market", at: now, symbol }),
    );
    const marketRef = unwrap(
      createEvidenceRef({
        kind: "market-snapshot",
        schemaVersion: "fixture/v1",
        producer: "mainnet-prepared-grid-test",
        sourceId: "grid-market",
        asOf: now,
        validForMs: 60_000,
        contentHash: marketHash,
      }),
    );
    const market = unwrap(
      createMarketSnapshot({
        snapshotId: "grid-market",
        instrument: symbol,
        scope: {
          exchange: "bybit",
          environment: "mainnet",
          category: "linear",
          positionMode: "one-way",
        },
        asOf: now,
        bid: "99",
        ask: "101",
        last: "100",
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
          sourceId: `grid-capability-${capability}`,
          asOf: now,
          validForMs: 60_000,
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
    const activeOrders = [...this.orders.values()]
      .filter(
        (order) =>
          order.status === "open" || order.status === "partially-filled",
      )
      .map((order) => this.orderObservation(order));
    const entryFills = [...this.orders.values()].flatMap(
      (order) => order.fills,
    );
    const exitFills = this.protectionFills();
    const entryQuantity = entryFills.reduce(
      (total, fill) => total.add(fill.quantity),
      decimal("0"),
    );
    const exitQuantity = exitFills.reduce(
      (total, fill) => total.add(fill.quantity),
      decimal("0"),
    );
    const filledQuantity = entryQuantity.subtract(exitQuantity);
    return {
      serverTime: now,
      market,
      position: {
        instrument: symbol,
        side: filledQuantity.isPositive() ? "long" : "flat",
        quantity: filledQuantity,
        leverage: decimal("1"),
      },
      openOrders: [
        ...activeOrders,
        ...this.protectionChildren(),
        ...this.additionalOpenOrders,
      ],
      leverage: {
        buy: decimal("1"),
        sell: decimal("1"),
        effective: decimal("1"),
      },
      capabilities,
    };
  }

  async readState(
    request: ExchangeReadStateRequest,
  ): Promise<ExchangeResult<MainnetExchangeReadState>> {
    this.readRequests.push(request);
    return { ok: true, value: this.readStateValue() };
  }

  async createOrder(
    request: ExchangeOrderRequest,
  ): Promise<ExchangeResult<ExchangeOrderAcknowledgement>> {
    const index = this.createRequests.length;
    this.createRequests.push(request);
    const behavior = this.behaviorForDispatch(index);
    if (behavior !== "invisible-timeout") {
      const order: FakeOrder = {
        request,
        exchangeOrderId: `grid-exchange-order-${index}`,
        createdAt: this.clock.value,
        status:
          behavior === "rejected"
            ? "rejected"
            : behavior === "cancelled"
              ? "cancelled"
              : behavior === "filled"
                ? "filled"
                : behavior === "partial"
                  ? "partially-filled"
                  : "open",
        filledQuantity: "0",
        fills: [],
        ...(behavior === "wrong-tp" ? { observedTakeProfit: "2" } : {}),
        ...(behavior === "wrong-order"
          ? { observedClientOrderId: "m1-contradictory-order" }
          : {}),
      };
      if (behavior === "partial") {
        const quantity = request.intent.quantity.multiply(decimal("0.25"));
        order.filledQuantity = quantity.toString();
        order.fills = [
          {
            executionId: `grid-fill-${index}`,
            exchangeOrderId: order.exchangeOrderId,
            clientOrderId: request.clientOrderId,
            instrument: request.intent.instrument,
            side: "buy",
            quantity,
            price: request.intent.price,
            executedAt: this.clock.value,
            source: "bybit-mainnet/execution",
          },
        ];
      }
      if (behavior === "filled") {
        order.filledQuantity = request.intent.quantity.toString();
        order.fills = [
          {
            executionId: `grid-fill-${index}`,
            exchangeOrderId: order.exchangeOrderId,
            clientOrderId: request.clientOrderId,
            instrument: request.intent.instrument,
            side: "buy",
            quantity: request.intent.quantity,
            price: request.intent.price,
            executedAt: this.clock.value,
            source: "bybit-mainnet/execution",
          },
        ];
      }
      this.orders.set(request.clientOrderId, order);
      this.afterCreate?.(request, index);
    }
    if (behavior === "invisible-timeout")
      return {
        ok: false,
        error: {
          kind: "ambiguous",
          message: "dispatch outcome is unknown",
          retry: "reconcile",
          operation: "create",
        },
      };
    const order = this.orders.get(request.clientOrderId)!;
    return {
      ok: true,
      value: {
        clientOrderId: request.clientOrderId,
        exchangeOrderId: order.exchangeOrderId,
        acknowledgedAt: this.clock.value,
        status: "accepted",
      },
    };
  }

  async observeOrder(
    request: ExchangeOrderLookup,
  ): Promise<ExchangeResult<ExchangeOrderObservation>> {
    this.observeRequests.push(request);
    const order = this.orders.get(request.clientOrderId);
    if (
      !order ||
      (request.exchangeOrderId !== undefined &&
        request.exchangeOrderId !== order.exchangeOrderId)
    )
      return {
        ok: false,
        error: {
          kind: "ambiguous",
          message: "order was not observable",
          retry: "reconcile",
          operation: "observe",
        },
      };
    return { ok: true, value: this.orderObservation(order) };
  }

  async listAttachedProtection(request: {
    readonly instrument: string;
    readonly parentClientOrderId: string;
  }): Promise<ExchangeResult<readonly ExchangeOrderObservation[]>> {
    return {
      ok: true,
      value: [
        ...[...this.orders.values()].flatMap((order) => {
          if (order.request.clientOrderId !== request.parentClientOrderId)
            return [];
          const child = this.protectionChild(order);
          return child ? [child] : [];
        }),
        ...this.additionalOpenOrders.filter(
          (order) => order.parentOrderLinkId === request.parentClientOrderId,
        ),
      ],
    };
  }

  async listFills(
    request: ExchangeOrderLookup,
  ): Promise<ExchangeResult<readonly ExchangeFillObservation[]>> {
    const order = this.orders.get(request.clientOrderId);
    if (order && order.exchangeOrderId === request.exchangeOrderId)
      return { ok: true, value: order.fills };
    const child = [...this.orders.values()]
      .map((parent) => ({ parent, child: this.protectionChild(parent) }))
      .find((row) => row.child?.exchangeOrderId === request.exchangeOrderId);
    if (!child?.child || !child.parent) return { ok: true, value: [] };
    return {
      ok: true,
      value: this.protectionFills().filter(
        (fill) => fill.exchangeOrderId === child.child!.exchangeOrderId,
      ),
    };
  }

  async setLeverage(
    _request: ExchangeSetLeverageRequest,
  ): Promise<ExchangeResult<ExchangeSetLeverageResult>> {
    void _request;
    return {
      ok: false,
      error: {
        kind: "permission",
        message: "not permitted by the test adapter",
        retry: "never",
        operation: "set-leverage",
      },
    };
  }

  async cancelOrder(
    request: ExchangeCancelOrderRequest,
  ): Promise<ExchangeResult<ExchangeOrderAcknowledgement>> {
    this.cancelRequests.push(request);
    const order = this.orders.get(request.clientOrderId);
    if (!order || order.exchangeOrderId !== request.exchangeOrderId)
      throw new Error("cancel identity mismatch");
    order.status = "cancelled";
    return {
      ok: true,
      value: {
        clientOrderId: request.clientOrderId,
        exchangeOrderId: order.exchangeOrderId,
        acknowledgedAt: this.clock.value,
        status: "accepted",
      },
    };
  }
}

function accountOrderFor(
  execution: PreparedLegExecution,
  exchangeOrderId: string,
  order?: FakeOrder,
): AccountOrderEvidence {
  const filledQuantity = decimal(order?.filledQuantity ?? "0");
  const remainingQuantity =
    execution.leg.intent.quantity.subtract(filledQuantity);
  const fact = <const Unit extends "price" | "contracts">(
    value: string,
    unit: Unit,
  ) => ({ state: "known" as const, value: decimal(value), unit });
  return {
    ...accountOrder(),
    category: "linear",
    symbol: execution.leg.intent.instrument,
    orderId: exchangeOrderId,
    orderLinkId: execution.clientOrderId,
    status:
      order?.status === "partially-filled"
        ? "PartiallyFilled"
        : order?.status === "filled"
          ? "Filled"
          : "New",
    side: "Buy",
    orderType: "Limit",
    triggerPrice: { ...accountNotApplicable, unit: "price" as const },
    price: fact(execution.leg.intent.price.toString(), "price"),
    qty: fact(execution.leg.intent.quantity.toString(), "contracts"),
    cumExecQty: fact(filledQuantity.toString(), "contracts"),
    leavesQty: fact(remainingQuantity.toString(), "contracts"),
    positionIdx: accountKnown(0),
    reduceOnly: accountKnown(false),
    takeProfit: fact(
      execution.leg.intent.protection!.takeProfit!.toString(),
      "price",
    ),
    stopLoss: { ...accountNotApplicable, unit: "price" },
    timeInForce: accountKnown("GTC"),
    orderFilter: accountKnown("Order"),
    createdAt: accountKnown(timestamp("2026-09-24T14:00:00.000Z")),
    updatedAt: accountKnown(timestamp("2026-09-24T14:00:00.000Z")),
  };
}

function accountTakeProfitOrderFor(
  execution: PreparedLegExecution,
  exchangeOrderId: string,
  requestedQuantity = execution.leg.intent.quantity,
  filledQuantity = decimal("0"),
): AccountOrderEvidence {
  return {
    ...accountOrder(),
    category: "linear",
    symbol: execution.leg.intent.instrument,
    orderId: exchangeOrderId,
    orderLinkId: null,
    status: filledQuantity.isZero() ? "Untriggered" : "PartiallyFilled",
    side: "Sell",
    orderType: "Market",
    price: { ...accountNotApplicable, unit: "price" as const },
    qty: {
      state: "known",
      value: requestedQuantity,
      unit: "contracts",
    },
    cumExecQty: {
      state: "known",
      value: filledQuantity,
      unit: "contracts",
    },
    leavesQty: {
      state: "known",
      value: requestedQuantity.subtract(filledQuantity),
      unit: "contracts",
    },
    positionIdx: accountKnown(0),
    reduceOnly: accountKnown(true),
    triggerPrice: {
      state: "known",
      value: decimal(execution.leg.intent.protection!.takeProfit!.toString()),
      unit: "price",
    },
    stopOrderType: accountKnown("PartialTakeProfit"),
    tpslMode: accountKnown("Partial"),
    takeProfit: { ...accountNotApplicable, unit: "price" as const },
    stopLoss: { ...accountNotApplicable, unit: "price" as const },
    timeInForce: accountKnown("IOC"),
    orderFilter: accountKnown("Order"),
    createdAt: accountKnown(timestamp("2026-09-24T14:00:00.000Z")),
    updatedAt: accountKnown(timestamp("2026-09-24T14:00:00.000Z")),
  };
}

function accountWithOrders(
  account: AccountEvidenceBundle,
  rows: readonly AccountOrderEvidence[],
): AccountEvidenceBundle {
  const { consistency: _consistency, ...payload } = account;
  void _consistency;
  const passA = payload.criticalPasses.A!;
  const passB = payload.criticalPasses.B!;
  const externalOrders = passB.orders.filter((row) => row.symbol !== symbol);
  const orders = [...externalOrders, ...rows];
  return unwrap(
    createAccountEvidenceBundle({
      ...payload,
      criticalPasses: {
        A: { ...passA, orders },
        B: { ...passB, orders },
      },
      coverage: payload.coverage.map((entry) => ({
        ...entry,
        ...(entry.partition.endpoint === "open-orders"
          ? {
              rows: orders.filter(
                (row) => row.category === entry.partition.category,
              ).length,
            }
          : {}),
      })),
      budget: {
        ...payload.budget,
        retainedRows: payload.budget.retainedRows + rows.length * 2,
      },
    }),
  );
}

export function accountWithAvailableBalance(
  account: AccountEvidenceBundle,
  amount: string,
): AccountEvidenceBundle {
  const { consistency: _consistency, ...payload } = account;
  void _consistency;
  const passA = payload.criticalPasses.A!;
  const passB = payload.criticalPasses.B!;
  const available = accountDecimal(amount, "USD");
  return unwrap(
    createAccountEvidenceBundle({
      ...payload,
      criticalPasses: {
        A: {
          ...passA,
          totals: { ...passA.totals, totalAvailableBalance: available },
        },
        B: {
          ...passB,
          totals: { ...passB.totals, totalAvailableBalance: available },
        },
      },
    }),
  );
}

export function setup() {
  const fixture = preparedLegExecutionFixture({
    planningLevels: PREPARED_LEG_FOUR_LEVELS,
  });
  const approval = fixture.approval;
  const prepared = fixture.prepared;
  const admittedGrid = unwrap(
    createPreparedLegGridExecution({
      approval,
      approvalHash: approval.contentHash,
      now: approval.approvedAt,
    }),
  );
  const accountRaw = prepared.replayInputs.preflight.replayInputs
    .account as Record<string, unknown> & { readonly consistency?: unknown };
  const { consistency: _consistency, ...accountPayload } = accountRaw;
  void _consistency;
  const account = unwrap(createAccountEvidenceBundle(accountPayload));
  const accountHash = prepared.inputIdentity.accountIdentityHash;
  const marketSymbols = prepared.replayInputs.preflight.replayInputs.dailyPlan
    .inputs.market as {
    readonly symbols: readonly {
      readonly symbol: string;
      readonly instrument?: { readonly constraints: unknown };
    }[];
  };
  const instrument = marketSymbols.symbols.find(
    (row) => row.symbol === symbol,
  )?.instrument;
  assert.ok(instrument);
  const root = mkdtempSync(join(tmpdir(), "mainnet-prepared-grid-"));
  const currentTime = { value: timestamp(evaluationTime) };
  let persistence = unwrap(
    openSqlitePersistence({
      environment: "mainnet",
      databasePath: join(root, "mainnet.db"),
      runtime,
      clock: { now: () => currentTime.value },
      scope: {
        exchange: "bybit",
        environment: "mainnet",
        accountId: accountHash,
        category: "linear",
        positionMode: "one-way",
      } satisfies PersistenceScope,
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
  const approvalsByHash = new Map<string, typeof approval>([
    [approval.contentHash, approval],
  ]);
  const artifacts: PreparedArtifactStore = {
    savePrepared: () => ok(undefined),
    loadPrepared: (hash) =>
      ok(hash === prepared.contentHash ? prepared : undefined),
    saveApproval: () => ok(undefined),
    loadApproval: (hash) => ok(approvalsByHash.get(hash)),
    close: () => undefined,
  };
  const exchange = new FakeGridExchange(instrument.constraints, currentTime);
  const accountsByOpenPrefixCount = new Map<number, AccountEvidenceBundle>([
    [0, account],
  ]);
  const localTime = { value: evaluationTime };
  const leaseObservations: {
    readonly epoch: number;
    readonly expiresAt: string;
  }[] = [];
  const authorization = new TestWriteAuthorization();
  let evidenceCollections = 0;
  let monotonicValue = 0;
  const evidence = {
    collect: async (requestedSymbol: string) => {
      if (requestedSymbol !== symbol)
        throw new Error("unexpected symbol in fresh-evidence request");
      const collectionIndex = evidenceCollections++;
      const lease = unwrap(persistence.readScopeSnapshot()).lease;
      if (lease)
        leaseObservations.push({
          epoch: lease.epoch,
          expiresAt: lease.expiresAt,
        });
      if (collectionIndex === 0) stateAdvanceClock(40_000);
      const stateResult = await exchange.readState({ instrument: symbol });
      if (!stateResult.ok) throw new Error("test read-state unavailable");
      const state = stateResult.value;
      const activeRows = admittedGrid.legs.filter(({ execution }) => {
        const order = exchange.orders.get(execution.clientOrderId);
        return order?.status === "open" || order?.status === "partially-filled";
      });
      const index = activeRows.length;
      let liveAccount = accountsByOpenPrefixCount.get(index);
      if (!liveAccount) {
        const accountRows = activeRows.map(({ execution }) => {
          const order = exchange.orders.get(execution.clientOrderId)!;
          return accountOrderFor(execution, order.exchangeOrderId, order);
        });
        const protectionRows = state.openOrders.flatMap((order) => {
          const parentClientOrderId = order.parentOrderLinkId;
          if (parentClientOrderId === undefined) return [];
          const execution = admittedGrid.legs.find(
            (row) => row.execution.clientOrderId === parentClientOrderId,
          )?.execution;
          return execution
            ? [
                accountTakeProfitOrderFor(
                  execution,
                  order.exchangeOrderId,
                  order.requestedQuantity,
                  order.filledQuantity,
                ),
              ]
            : [];
        });
        liveAccount = accountWithOrders(account, [
          ...accountRows,
          ...protectionRows,
        ]);
        accountsByOpenPrefixCount.set(index, liveAccount);
      }
      const liveAccountHash = unwrap(accountEvidenceContentHash(liveAccount));
      const readiness = {
        schemaVersion: "mainnet-execution-readiness/v1" as const,
        verdict: "READY" as const,
        evaluatedAt: currentTime.value,
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
          accountIdentityHash: accountHash,
          accountEvidenceHash: liveAccountHash,
        },
        accountEvidenceAgeMs:
          Date.parse(currentTime.value) -
          Date.parse(liveAccount.collectionEndedAt ?? currentTime.value),
        unrelatedCoverageGapCount: 0,
        reasonCodes: [],
        providerReasonCodes: [],
        warningCodes: [],
      };
      return { account: liveAccount, readiness, state };
    },
  };
  const dependencies = {
    artifacts,
    persistence,
    preparedLegs: persistence.preparedLegExecution,
    exchange,
    evidence,
    authorization,
    localClock: { now: () => localTime.value as UtcTimestamp },
    monotonicClock: () => monotonicValue++,
  };
  function stateAdvanceClock(milliseconds: number) {
    const next = Date.parse(currentTime.value) + milliseconds;
    currentTime.value = timestamp(new Date(next).toISOString());
    localTime.value = currentTime.value;
  }
  return {
    fixture,
    admittedGrid,
    prepared,
    approval,
    approvalsByHash,
    artifacts,
    account,
    accountsByOpenPrefixCount,
    currentTime,
    localTime,
    get persistence() {
      return persistence;
    },
    reopenPersistence() {
      persistence.close();
      persistence = unwrap(
        openSqlitePersistence({
          environment: "mainnet",
          databasePath: join(root, "mainnet.db"),
          runtime,
          clock: { now: () => currentTime.value },
          scope: {
            exchange: "bybit",
            environment: "mainnet",
            accountId: accountHash,
            category: "linear",
            positionMode: "one-way",
          },
        }),
      );
      assert.ok(persistence.preparedLegExecution);
      dependencies.persistence = persistence;
      dependencies.preparedLegs = persistence.preparedLegExecution;
    },
    exchange,
    authorization,
    dependencies,
    leaseObservations,
    get evidenceCollections() {
      return evidenceCollections;
    },
    cleanup() {
      persistence.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
