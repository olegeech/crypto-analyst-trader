import type {
  AccountSnapshot,
  MarketSnapshot,
} from "../../domain/market/snapshots.js";
import {
  createAdapterCapabilityObservation,
  type CapabilityObservation,
} from "../../domain/capabilities/capability.js";
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
  ExchangeAccountMetadata,
  ExchangeAttachedProtectionLookup,
  ExchangeSetLeverageRequest,
  ExchangeSetLeverageResult,
  ExchangeExecutionPort,
  MainnetExchangeExecutionPort,
  MainnetExchangeReadState,
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
import {
  BYBIT_DEMO_CAPABILITY_PROFILE,
  bybitDemoCapabilityScope,
  BYBIT_MAINNET_CAPABILITY_PROFILE,
  bybitMainnetCapabilityScope,
} from "./capability-profile.js";
import {
  BYBIT_DEMO_ORIGIN,
  BYBIT_MAINNET_ORIGIN,
  type BybitPrivateTransport,
} from "./transport.js";
import {
  mapOrderObservation,
  type BybitInstrumentInfo,
} from "./read-mappers.js";

export type MainnetOperatorTargetPartition<T> =
  | {
      readonly status: "available";
      readonly observedAt: UtcTimestamp;
      readonly value: T;
    }
  | {
      readonly status: "unavailable";
      readonly reasonCode: string;
    };

/** Separate provider partitions used only when a scoped manual recovery must
 * replace unavailable current position/order facts. */
export interface MainnetOperatorTargetStateParts {
  readonly serverTime: UtcTimestamp | undefined;
  readonly capabilities?: readonly CapabilityObservation[];
  readonly position: MainnetOperatorTargetPartition<
    MainnetExchangeReadState["position"]
  >;
  readonly openOrders: MainnetOperatorTargetPartition<
    MainnetExchangeReadState["openOrders"]
  >;
}

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
  const openOrders = input.openOrders.map((order) =>
    mapOrderObservation(order, input.serverTime, "bybit-demo/order-realtime"),
  );
  const account = createAccountSnapshot({
    snapshotId: `demo-account-${accountHash}`,
    accountScope: accountId,
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

function accountMetadata(
  input: Awaited<ReturnType<BybitDemoExecutionClient["readPreflight"]>>,
): ExchangeAccountMetadata {
  return Object.freeze({
    accountId: input.accountKey.userId,
    userId: input.accountKey.userId,
    apiKey: Object.freeze({
      readOnly: input.accountKey.readOnly,
      contractTrade: input.accountKey.contractTrade,
      wallet: input.accountKey.wallet,
      ips: input.accountKey.ips,
      ipBinding: input.accountKey.ips.length === 0 ? "unbound" : "bound",
      warningCodes: input.accountKey.warningCodes,
      ...(input.accountKey.expiresAt === undefined
        ? {}
        : { expiresAt: input.accountKey.expiresAt }),
    }),
  });
}

function capabilities(
  input: Awaited<ReturnType<BybitDemoExecutionClient["readPreflight"]>>,
): readonly CapabilityObservation[] {
  const material = {
    accountId: input.accountKey.userId,
    instrument: input.instrument.symbol,
    leverage: input.position.leverage,
    reconciliationReads: input.reconciliationReads,
  };
  return BYBIT_DEMO_CAPABILITY_PROFILE.capabilities.map((capability) => {
    const contentHash = hashMaterial({ capability, ...material });
    const evidenceResult = createEvidenceRef({
      kind: "capability-probe",
      schemaVersion: BYBIT_DEMO_CAPABILITY_PROFILE.version,
      producer: BYBIT_DEMO_CAPABILITY_PROFILE.adapter,
      sourceId: `demo-capability-${capability}-${contentHash.slice(-12)}`,
      asOf: input.serverTime,
      validForMs: EVIDENCE_VALID_FOR_MS,
      contentHash,
    });
    if (!evidenceResult.ok) {
      throw new Error("adapter capability evidence metadata is invalid");
    }
    const observation = createAdapterCapabilityObservation({
      capability,
      status: "supported",
      observedAt: input.serverTime,
      source: BYBIT_DEMO_CAPABILITY_PROFILE.adapter,
      evidence: evidenceResult.value,
      scope: bybitDemoCapabilityScope(),
    });
    if (!observation.ok) {
      throw new Error("adapter capability observation is invalid");
    }
    return observation.value;
  });
}

export class BybitDemoExecutionAdapter implements ExchangeExecutionPort {
  private readonly client: BybitDemoExecutionClient;
  private readonly accountId: string;
  private readonly clock: Clock;

  constructor(options: BybitDemoExecutionAdapterOptions) {
    if (
      options.transport.environment !== "demo" ||
      options.transport.origin !== BYBIT_DEMO_ORIGIN
    ) {
      throw new TypeError(
        "Bybit Demo adapter requires its canonical Demo transport.",
      );
    }
    this.client = new BybitDemoExecutionClient({
      ...options,
      expectedAccountId: options.accountId,
    });
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
        leverage: {
          buy: read.position.leverage,
          sell: read.position.leverage,
          effective: read.position.leverage,
        },
        accountMetadata: accountMetadata(read),
        capabilities: capabilities(read),
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

  async listAttachedProtection(
    request: ExchangeAttachedProtectionLookup,
  ): Promise<ExchangeResult<readonly ExchangeOrderObservation[]>> {
    try {
      const records = await this.client.readAttachedProtectionOrders(
        request.instrument,
        request.parentClientOrderId,
      );
      const observedAt = this.clock.now();
      const observations = records.map((record) =>
        mapOrderObservation(record, observedAt, "bybit-demo/protection"),
      );
      return exchangeSuccess(Object.freeze(observations));
    } catch (error) {
      return exchangeFailure(
        normalizeBybitFailure(
          error,
          context("observe", {
            instrument: request.instrument,
            clientOrderId: request.parentClientOrderId,
          }),
        ),
      );
    }
  }

  async listFills(
    request: ExchangeFillLookupRequest,
  ): Promise<ExchangeResult<readonly ExchangeFillObservation[]>> {
    return listOwnedFills(this.client, request);
  }

  async setLeverage(
    request: ExchangeSetLeverageRequest,
  ): Promise<ExchangeResult<ExchangeSetLeverageResult>> {
    try {
      return exchangeSuccess(await this.client.setLeverage(request));
    } catch (error) {
      return exchangeFailure(
        normalizeBybitFailure(error, context("set-leverage")),
      );
    }
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

export interface BybitMainnetExecutionAdapterOptions {
  readonly transport: BybitPrivateTransport;
  readonly clock?: Clock;
}

function mainnetMarketSnapshot(
  instrument: BybitInstrumentInfo,
  ticker: Awaited<ReturnType<BybitDemoExecutionClient["readTicker"]>>,
  serverTime: UtcTimestamp,
): MarketSnapshot {
  const material = {
    environment: "mainnet",
    instrument: instrument.symbol,
    bid: ticker.bid,
    ask: ticker.ask,
    last: ticker.last,
    constraints: instrument.constraints,
  };
  const contentHash = hashMaterial(material);
  const sourceId = `mainnet-market-${contentHash.slice(-12)}`;
  const evidenceResult = createEvidenceRef({
    kind: "market-snapshot",
    schemaVersion: "bybit-mainnet/v1",
    producer: BYBIT_MAINNET_CAPABILITY_PROFILE.adapter,
    sourceId,
    asOf: serverTime,
    validForMs: EVIDENCE_VALID_FOR_MS,
    contentHash,
  });
  if (!evidenceResult.ok)
    throw new Error("Mainnet market evidence metadata is invalid");
  const constraints: Record<string, unknown> = {
    instrument: instrument.constraints.instrument,
    version: instrument.constraints.version,
    priceTickSize: instrument.constraints.priceTickSize.toString(),
    quantityStep: instrument.constraints.quantityStep.toString(),
    minQuantity: instrument.constraints.minQuantity.toString(),
  };
  if (instrument.constraints.minNotional !== undefined)
    constraints.minNotional = instrument.constraints.minNotional.toString();
  for (const bound of ["minPrice", "maxPrice", "maxLimitQuantity"] as const) {
    const value = instrument.constraints[bound];
    if (value !== undefined) constraints[bound] = value.toString();
  }
  const snapshot = createMarketSnapshot({
    snapshotId: sourceId,
    instrument: instrument.symbol,
    scope: bybitMainnetCapabilityScope(),
    asOf: serverTime,
    bid: ticker.bid.toString(),
    ask: ticker.ask.toString(),
    last: ticker.last.toString(),
    constraints,
    evidence: [evidenceResult.value],
  });
  if (!snapshot.ok)
    throw new Error("normalized Mainnet market snapshot is invalid");
  return snapshot.value;
}

function mainnetCapabilities(
  instrument: string,
  serverTime: UtcTimestamp,
): readonly CapabilityObservation[] {
  return BYBIT_MAINNET_CAPABILITY_PROFILE.capabilities.map((capability) => {
    const contentHash = hashMaterial({
      capability,
      instrument,
      environment: "mainnet",
      adapter: BYBIT_MAINNET_CAPABILITY_PROFILE.adapter,
    });
    const evidenceResult = createEvidenceRef({
      kind: "capability-probe",
      schemaVersion: BYBIT_MAINNET_CAPABILITY_PROFILE.version,
      producer: BYBIT_MAINNET_CAPABILITY_PROFILE.adapter,
      sourceId: `mainnet-capability-${capability}-${contentHash.slice(-12)}`,
      asOf: serverTime,
      validForMs: EVIDENCE_VALID_FOR_MS,
      contentHash,
    });
    if (!evidenceResult.ok)
      throw new Error("Mainnet capability evidence metadata is invalid");
    const observation = createAdapterCapabilityObservation({
      capability,
      status: "supported",
      observedAt: serverTime,
      source: BYBIT_MAINNET_CAPABILITY_PROFILE.adapter,
      evidence: evidenceResult.value,
      scope: bybitMainnetCapabilityScope(),
    });
    if (!observation.ok)
      throw new Error("Mainnet capability observation is invalid");
    return observation.value;
  });
}

/**
 * Mainnet exposes the bounded typed order lifecycle, but its read projection
 * deliberately contains no account snapshot, account scope, UID or IP data.
 */
export class BybitMainnetExecutionAdapter implements MainnetExchangeExecutionPort {
  private readonly client: BybitDemoExecutionClient;

  constructor(options: BybitMainnetExecutionAdapterOptions) {
    if (
      options.transport.environment !== "mainnet" ||
      options.transport.origin !== BYBIT_MAINNET_ORIGIN
    ) {
      throw new TypeError(
        "Bybit Mainnet adapter requires its canonical Mainnet transport.",
      );
    }
    this.client = new BybitDemoExecutionClient({
      transport: options.transport,
      clock: options.clock ?? systemClock,
    });
  }

  async readState(
    request: ExchangeReadStateRequest,
  ): Promise<ExchangeResult<MainnetExchangeReadState>> {
    try {
      // The first signed read establishes the transport clock offset before
      // concurrent requests use it; avoid duplicate initialization races.
      const instrument = await this.client.readInstrument(request.instrument);
      const [ticker, position, openOrders] = await Promise.all([
        this.client.readTicker(request.instrument),
        this.client.readPosition(request.instrument),
        this.client.readOpenOrders(request.instrument),
      ]);
      const serverTime = await this.client.readServerTime();
      const normalizedPosition: MainnetExchangeReadState["position"] =
        Object.freeze({
          instrument: position.instrument,
          side: position.side,
          quantity: position.quantity,
          leverage: position.leverage,
          ...(position.entryPrice === undefined
            ? {}
            : { entryPrice: position.entryPrice }),
        });
      const observedOrders = Object.freeze(
        openOrders.map((record) =>
          mapOrderObservation(
            record,
            serverTime,
            "bybit-mainnet/order-realtime",
          ),
        ),
      );
      return exchangeSuccess({
        serverTime,
        market: mainnetMarketSnapshot(instrument, ticker, serverTime),
        position: normalizedPosition,
        openOrders: observedOrders,
        leverage: {
          buy: position.leverage,
          sell: position.leverage,
          effective: position.leverage,
        },
        capabilities: mainnetCapabilities(instrument.symbol, serverTime),
      });
    } catch (error) {
      return exchangeFailure(
        normalizeBybitFailure(error, context("read"), "mainnet"),
      );
    }
  }

  /** Preserve independently successful target partitions for the named #25
   * manual exception. A failure in one partition never fabricates success in
   * another, and provider-time failure prevents any ordering conclusion. */
  async readOperatorTargetStateParts(
    request: ExchangeReadStateRequest,
  ): Promise<MainnetOperatorTargetStateParts> {
    const [positionResult, orderResult] = await Promise.allSettled([
      this.client.readPosition(request.instrument),
      this.client.readOpenOrders(request.instrument),
    ]);
    let serverTime: UtcTimestamp | undefined;
    try {
      serverTime = await this.client.readServerTime();
    } catch {
      return {
        serverTime: undefined,
        position: {
          status: "unavailable",
          reasonCode: "PROVIDER_TIME_UNAVAILABLE",
        },
        openOrders: {
          status: "unavailable",
          reasonCode: "PROVIDER_TIME_UNAVAILABLE",
        },
      };
    }
    const position: MainnetOperatorTargetStateParts["position"] =
      positionResult.status === "fulfilled"
        ? {
            status: "available",
            observedAt: serverTime,
            value: Object.freeze({
              instrument: positionResult.value.instrument,
              side: positionResult.value.side,
              quantity: positionResult.value.quantity,
              leverage: positionResult.value.leverage,
              ...(positionResult.value.entryPrice === undefined
                ? {}
                : { entryPrice: positionResult.value.entryPrice }),
            }),
          }
        : {
            status: "unavailable",
            reasonCode: "TARGET_POSITION_READ_FAILED",
          };
    const openOrders: MainnetOperatorTargetStateParts["openOrders"] =
      orderResult.status === "fulfilled"
        ? {
            status: "available",
            observedAt: serverTime,
            value: Object.freeze(
              orderResult.value.map((record) =>
                mapOrderObservation(
                  record,
                  serverTime!,
                  "bybit-mainnet/order-realtime",
                ),
              ),
            ),
          }
        : {
            status: "unavailable",
            reasonCode: "TARGET_ORDERS_READ_FAILED",
          };
    return {
      serverTime,
      capabilities: mainnetCapabilities(request.instrument, serverTime),
      position,
      openOrders,
    };
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
          "mainnet",
        ),
      );
    }
  }

  async observeOrder(
    request: ExchangeOrderLookup,
  ): Promise<ExchangeResult<ExchangeOrderObservation>> {
    try {
      const observedAt = await this.client.readServerTime();
      return await reconcileOrder(this.client, request, observedAt, "mainnet");
    } catch (error) {
      return exchangeFailure(
        normalizeBybitFailure(error, context("observe", request), "mainnet"),
      );
    }
  }

  async listAttachedProtection(
    request: ExchangeAttachedProtectionLookup,
  ): Promise<ExchangeResult<readonly ExchangeOrderObservation[]>> {
    try {
      const records = await this.client.readAttachedProtectionOrders(
        request.instrument,
        request.parentClientOrderId,
      );
      // Child update times and the observation must share the provider clock.
      // Sample after both child reads so valid updates cannot appear future-dated
      // merely because the local wall clock trails Bybit.
      const observedAt = await this.client.readServerTime();
      return exchangeSuccess(
        Object.freeze(
          records.map((record) =>
            mapOrderObservation(record, observedAt, "bybit-mainnet/protection"),
          ),
        ),
      );
    } catch (error) {
      return exchangeFailure(
        normalizeBybitFailure(
          error,
          context("observe", {
            instrument: request.instrument,
            clientOrderId: request.parentClientOrderId,
          }),
          "mainnet",
        ),
      );
    }
  }

  listFills(
    request: ExchangeFillLookupRequest,
  ): Promise<ExchangeResult<readonly ExchangeFillObservation[]>> {
    return listOwnedFills(this.client, request, "mainnet");
  }

  async setLeverage(
    request: ExchangeSetLeverageRequest,
  ): Promise<ExchangeResult<ExchangeSetLeverageResult>> {
    try {
      return exchangeSuccess(await this.client.setLeverage(request));
    } catch (error) {
      return exchangeFailure(
        normalizeBybitFailure(error, context("set-leverage"), "mainnet"),
      );
    }
  }

  async cancelOrder(
    request: ExchangeCancelOrderRequest,
  ): Promise<ExchangeResult<ExchangeOrderAcknowledgement>> {
    try {
      return exchangeSuccess(await this.client.cancelOrder(request));
    } catch (error) {
      return exchangeFailure(
        normalizeBybitFailure(error, context("cancel", request), "mainnet"),
      );
    }
  }
}
