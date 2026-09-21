import type {
  AccountSnapshot,
  MarketSnapshot,
} from "../../domain/market/snapshots.js";
import { createExchangeOrder } from "../../domain/execution/exchange-order.js";
import {
  createAccountSnapshot,
  createMarketSnapshot,
} from "../../domain/market/snapshots.js";
import {
  createEvidenceRef,
  type EvidenceRef,
} from "../../domain/evidence/evidence-ref.js";
import { hashCanonical } from "../../domain/identity/plan-hash.js";
import type { Clock, UtcTimestamp } from "../../domain/shared/time.js";
import { systemClock } from "../../domain/shared/time.js";
import type {
  ExchangeCancelOrderRequest,
  ExchangeExecutionPort,
  ExchangeFillLookupRequest,
  ExchangeFillObservation,
  ExchangeOrderAcknowledgement,
  ExchangeOrderLookup,
  ExchangeOrderObservation,
  ExchangeOrderRequest,
  ExchangeReadState,
  ExchangeReadStateRequest,
  ExchangeResult,
} from "../../ports/exchange-execution.js";
import {
  exchangeFailure,
  exchangeSuccess,
} from "../../ports/exchange-execution.js";
import {
  BybitDemoExecutionClient,
  type BybitDemoExecutionClientOptions,
  type BybitDemoWriteTransport,
} from "./client.js";
import {
  normalizeBybitFailure,
  type BybitFailureContext,
} from "./error-mapping.js";
import { listOwnedFills, reconcileOrder } from "./reconciliation.js";

const DEMO_SCOPE = {
  exchange: "bybit",
  environment: "demo",
  category: "linear",
  positionMode: "one-way" as const,
};
const EVIDENCE_VALID_FOR_MS = 60_000;

export interface BybitDemoExecutionAdapterOptions extends Omit<
  BybitDemoExecutionClientOptions,
  "clock" | "transport"
> {
  readonly transport: BybitDemoWriteTransport;
  readonly accountId: string;
  readonly clock?: Clock;
}

function context(
  operation: BybitFailureContext["operation"],
  request?: ExchangeOrderLookup,
): BybitFailureContext {
  return {
    operation,
    ...(request?.clientOrderId === undefined
      ? {}
      : { clientOrderId: request.clientOrderId }),
    ...(request?.exchangeOrderId === undefined
      ? {}
      : { exchangeOrderId: request.exchangeOrderId }),
  };
}

function hashMaterial(material: unknown): string {
  const hash = hashCanonical(material);
  if (!hash.ok)
    throw new Error("adapter evidence material could not be hashed");
  return hash.value;
}

function evidence(
  kind: "market-snapshot" | "account-snapshot",
  sourceId: string,
  asOf: UtcTimestamp,
  contentHash: string,
): EvidenceRef {
  const parsed = createEvidenceRef({
    kind,
    schemaVersion: "bybit-demo/v1",
    producer: "bybit-demo-adapter/v1",
    sourceId,
    asOf,
    validForMs: EVIDENCE_VALID_FOR_MS,
    contentHash,
  });
  if (!parsed.ok) throw new Error("adapter evidence metadata is invalid");
  return parsed.value;
}

function scopeObject() {
  return { ...DEMO_SCOPE };
}

function snapshots(
  input: Awaited<ReturnType<BybitDemoExecutionClient["readPreflight"]>>,
  accountId: string,
): {
  market: MarketSnapshot;
  account: AccountSnapshot;
  openOrders: readonly ExchangeOrderObservation[];
} {
  const marketMaterial = {
    instrument: input.instrument.symbol,
    bid: input.ticker.bid,
    ask: input.ticker.ask,
    last: input.ticker.last,
    constraints: input.instrument.constraints,
  };
  const accountMaterial = {
    accountId,
    availableBalance: input.wallet.availableBalance,
    position: input.position,
    openOrders: input.openOrders,
  };
  const marketContentHash = hashMaterial(marketMaterial);
  const accountContentHash = hashMaterial(accountMaterial);
  const marketHash = marketContentHash.slice(-12);
  const accountHash = accountContentHash.slice(-12);
  const marketEvidence = evidence(
    "market-snapshot",
    `demo-market-${marketHash}`,
    input.serverTime,
    marketContentHash,
  );
  const accountEvidence = evidence(
    "account-snapshot",
    `demo-account-${accountHash}`,
    input.serverTime,
    accountContentHash,
  );
  const minNotional = input.instrument.constraints.minNotional;
  const constraints: Record<string, unknown> = {
    instrument: input.instrument.constraints.instrument,
    version: input.instrument.constraints.version,
    priceTickSize: input.instrument.constraints.priceTickSize.toString(),
    quantityStep: input.instrument.constraints.quantityStep.toString(),
    minQuantity: input.instrument.constraints.minQuantity.toString(),
  };
  if (minNotional !== undefined) {
    constraints.minNotional = minNotional.toString();
  }
  const market = createMarketSnapshot({
    snapshotId: `demo-market-${marketHash}`,
    instrument: input.instrument.symbol,
    scope: scopeObject(),
    asOf: input.serverTime,
    bid: input.ticker.bid.toString(),
    ask: input.ticker.ask.toString(),
    last: input.ticker.last.toString(),
    constraints,
    evidence: [marketEvidence],
  });
  if (!market.ok) throw new Error("normalized Demo market snapshot is invalid");
  const positions = [
    {
      instrument: input.position.instrument,
      side: input.position.side,
      quantity: input.position.quantity.toString(),
      ...(input.position.entryPrice === undefined
        ? {}
        : { entryPrice: input.position.entryPrice.toString() }),
    },
  ];
  const openOrders = input.openOrders.map((order) => {
    const observation = createExchangeOrder({
      exchangeOrderId: order.exchangeOrderId,
      clientOrderId: order.clientOrderId,
      instrument: order.instrument,
      side: order.side,
      requestedQuantity: order.requestedQuantity.toString(),
      filledQuantity: order.filledQuantity.toString(),
      status: order.status,
      observedAt: input.serverTime,
      source: "bybit-demo/order-realtime",
      ...(order.averagePrice === undefined
        ? {}
        : { averagePrice: order.averagePrice.toString() }),
    });
    if (!observation.ok)
      throw new Error("normalized Demo open order is invalid");
    return observation.value;
  });
  const account = createAccountSnapshot({
    snapshotId: `demo-account-${accountHash}`,
    accountScope: `demo:${accountId}`,
    scope: scopeObject(),
    asOf: input.serverTime,
    availableBalance: input.wallet.availableBalance.toString(),
    positions,
    ownedOrders: [],
    evidence: [accountEvidence],
  });
  if (!account.ok)
    throw new Error("normalized Demo account snapshot is invalid");
  return { market: market.value, account: account.value, openOrders };
}

export class BybitDemoExecutionAdapter implements ExchangeExecutionPort {
  private readonly client: BybitDemoExecutionClient;
  private readonly accountId: string;
  private readonly clock: Clock;

  constructor(options: BybitDemoExecutionAdapterOptions) {
    this.client = new BybitDemoExecutionClient(options);
    this.accountId = options.accountId;
    this.clock = options.clock ?? systemClock;
  }

  async readState(
    request: ExchangeReadStateRequest,
  ): Promise<ExchangeResult<ExchangeReadState>> {
    try {
      const read = await this.client.readPreflight(
        request.instrument,
        `state-read-${request.instrument}`,
      );
      const normalized = snapshots(read, this.accountId);
      return exchangeSuccess({
        serverTime: read.serverTime,
        market: normalized.market,
        account: normalized.account,
        openOrders: normalized.openOrders,
        accountReadiness: { status: "ready" },
      });
    } catch (error) {
      return exchangeFailure(normalizeBybitFailure(error, context("read")));
    }
  }

  async createOrder(
    request: ExchangeOrderRequest,
  ): Promise<ExchangeResult<ExchangeOrderAcknowledgement>> {
    try {
      return exchangeSuccess(await this.client.createOrder(request));
    } catch (error) {
      return exchangeFailure(
        normalizeBybitFailure(
          error,
          context("create", {
            instrument: request.intent.instrument,
            clientOrderId: request.clientOrderId,
          }),
        ),
      );
    }
  }

  async observeOrder(
    request: ExchangeOrderLookup,
  ): Promise<ExchangeResult<ExchangeOrderObservation>> {
    return reconcileOrder(this.client, request, this.clock.now());
  }

  async listFills(
    request: ExchangeFillLookupRequest,
  ): Promise<ExchangeResult<readonly ExchangeFillObservation[]>> {
    return listOwnedFills(this.client, request);
  }

  async cancelOrder(
    request: ExchangeCancelOrderRequest,
  ): Promise<ExchangeResult<ExchangeOrderAcknowledgement>> {
    try {
      return exchangeSuccess(await this.client.cancelOrder(request));
    } catch (error) {
      return exchangeFailure(
        normalizeBybitFailure(error, context("cancel", request)),
      );
    }
  }
}
