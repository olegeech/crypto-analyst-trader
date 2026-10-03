import { hashCanonical } from "../identity/canonical-serialization.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import type { Result } from "../shared/result.js";

export const ACCOUNT_EVIDENCE_POLICY_VERSION =
  "account-evidence-collection-policy/v1" as const;
export const ACCOUNT_EVIDENCE_COLLECTION_POLICY = deepFreeze({
  schemaVersion: ACCOUNT_EVIDENCE_POLICY_VERSION,
  maxCollectionDurationMs: 30_000,
  historyWindowMs: 3_600_000,
  maxPagesPerPartition: 20,
  maxHttpAttempts: 80,
  maxRetainedRows: 10_000,
  maxResponseBytes: 1_048_576,
  maxRetriesPerRequest: 1,
  reconciliationUsdAbsoluteTolerance: "0.000001",
  supportedMarginMode: "REGULAR_MARGIN",
  categories: ["linear", "inverse", "spot", "option"],
  nativeEnums: {
    utaStatus: [3, 4, 5, 6],
    marginMode: ["REGULAR_MARGIN", "ISOLATED_MARGIN", "PORTFOLIO_MARGIN"],
    positionIdx: [0, 1, 2],
    positionSide: ["Buy", "Sell", "None"],
    side: ["Buy", "Sell"],
    orderType: ["Limit", "Market"],
    marketUnit: ["baseCoin", "quoteCoin"],
    tradeMode: [0, 1],
    triggerDirection: [0, 1, 2],
    timeInForce: ["GTC", "IOC", "FOK", "PostOnly"],
    triggerBy: ["LastPrice", "IndexPrice", "MarkPrice"],
    tpslMode: ["Full", "Partial"],
    orderFilter: [
      "Order",
      "StopOrder",
      "tpslOrder",
      "OcoOrder",
      "BidirectionalTpslOrder",
    ],
    stopOrderType: [
      "TakeProfit",
      "StopLoss",
      "TrailingStop",
      "Stop",
      "PartialTakeProfit",
      "PartialStopLoss",
      "tpslOrder",
      "OcoOrder",
      "MmRateClose",
      "BidirectionalTpslOrder",
    ],
    orderStatus: [
      "New",
      "PartiallyFilled",
      "Untriggered",
      "Triggered",
      "Filled",
      "Cancelled",
      "Rejected",
      "Deactivated",
      "PartiallyFilledCanceled",
    ],
    execType: [
      "Trade",
      "AdlTrade",
      "Funding",
      "BustTrade",
      "Settle",
      "Delivery",
      "BlockTrade",
      "MovePosition",
    ],
  },
  initialSettlementCoins: ["USDT", "USDC"],
  positionPageLimit: 200,
  orderPageLimit: 50,
  executionPageLimit: 100,
  // v1 endpoints do not publish a restriction fact. Preserve and compare it
  // when observed, but its absence cannot make the required proof unattainable.
  optionalStructuralFields: ["restricted"],
  criticalStructuralFields: {
    account: ["utaStatus", "marginMode", "spotHedging"],
    assets: [
      "coin",
      "walletBalance",
      "locked",
      "bonus",
      "borrowAmount",
      "spotBorrow",
      "accruedInterest",
      "collateralEligible",
      "collateralSwitch",
      "restricted",
    ],
    collateral: [
      "coin",
      "collateralEligible",
      "collateralSwitch",
      "restricted",
      "borrowable",
      "borrowAmount",
      "otherBorrowAmount",
      "maxBorrowingAmount",
    ],
    positions: [
      "category",
      "symbol",
      "positionIdx",
      "side",
      "size",
      "avgPrice",
      "seq",
      "createdAt",
      "leverage",
      "riskId",
      "tradeMode",
      "isReduceOnly",
      "takeProfit",
      "stopLoss",
      "trailingStop",
    ],
    orders: [
      "category",
      "symbol",
      "orderId",
      "status",
      "side",
      "orderType",
      "marketUnit",
      "price",
      "qty",
      "cumExecQty",
      "leavesQty",
      "positionIdx",
      "reduceOnly",
      "closeOnTrigger",
      "triggerPrice",
      "triggerDirection",
      "triggerBy",
      "stopOrderType",
      "takeProfit",
      "stopLoss",
      "tpslMode",
      "timeInForce",
      "orderFilter",
    ],
  },
} as const);
export type AccountEvidenceCollectionPolicy =
  typeof ACCOUNT_EVIDENCE_COLLECTION_POLICY;
export function accountEvidencePolicyHash(): Result<string> {
  return hashCanonical(ACCOUNT_EVIDENCE_COLLECTION_POLICY);
}

export type AccountEvidenceCategory = "linear" | "inverse" | "spot" | "option";
export type AccountEvidenceEndpoint =
  | "account-info"
  | "wallet"
  | "collateral"
  | "tiers"
  | "settlement-discovery"
  | "option-base-discovery"
  | "instrument-metadata"
  | "positions"
  | "mode-probe"
  | "open-orders"
  | "order-history"
  | "executions";
export interface AccountEvidencePartition {
  readonly endpoint: AccountEvidenceEndpoint;
  readonly pass: "A" | "B" | "auxiliary";
  readonly category: AccountEvidenceCategory | null;
  readonly settleCoin: string | null;
  readonly baseCoin: string | null;
  readonly symbol: string | null;
}
export interface AccountEvidenceDiscovery {
  readonly settlementCoins: readonly string[];
  readonly optionBaseCoins: readonly string[];
  readonly exposureOptionBaseCoins: readonly string[];
  readonly passBSettlementCoins: readonly string[];
  readonly passBOptionBaseCoins: readonly string[];
  readonly uncoveredScopes: boolean;
  readonly upgradeOverlap: boolean;
  readonly separateInverseWallet: boolean;
}
export function accountEvidencePartitionKey(
  value: AccountEvidencePartition,
): string {
  return JSON.stringify([
    value.endpoint,
    value.pass,
    value.category,
    value.settleCoin,
    value.baseCoin,
    value.symbol,
  ]);
}
/** Derivation is independent of requests actually issued. Discovery completeness is separately required. */
export function deriveExpectedAccountEvidencePartitions(
  symbols: readonly string[],
  discovery: AccountEvidenceDiscovery,
): readonly AccountEvidencePartition[] {
  const partitions: AccountEvidencePartition[] = [];
  const add = (
    endpoint: AccountEvidenceEndpoint,
    pass: AccountEvidencePartition["pass"],
    category: AccountEvidenceCategory | null = null,
    settleCoin: string | null = null,
    baseCoin: string | null = null,
    symbol: string | null = null,
  ) =>
    partitions.push({ endpoint, pass, category, settleCoin, baseCoin, symbol });
  const settlements = [
    ...new Set([
      ...ACCOUNT_EVIDENCE_COLLECTION_POLICY.initialSettlementCoins,
      ...discovery.settlementCoins,
    ]),
  ].sort();
  const bases = [
    ...new Set([
      ...discovery.optionBaseCoins,
      ...discovery.exposureOptionBaseCoins,
    ]),
  ].sort();
  for (const pass of ["A", "B"] as const) {
    for (const endpoint of ["account-info", "wallet", "collateral"] as const)
      add(endpoint, pass);
    for (const coin of settlements) {
      add("positions", pass, "linear", coin);
      add("open-orders", pass, "linear", coin);
    }
    for (const category of ["inverse", "option"] as const)
      add("positions", pass, category);
    for (const category of ["inverse", "option", "spot"] as const)
      add("open-orders", pass, category);
    for (const symbol of symbols)
      add("mode-probe", pass, "linear", null, null, symbol);
  }
  for (const endpoint of [
    "tiers",
    "settlement-discovery",
    "option-base-discovery",
  ] as const)
    add(endpoint, "auxiliary");
  for (const base of discovery.exposureOptionBaseCoins)
    add("instrument-metadata", "auxiliary", "option", null, base);
  for (const category of ACCOUNT_EVIDENCE_COLLECTION_POLICY.categories)
    add("order-history", "auxiliary", category);
  for (const category of ["linear", "inverse", "spot"] as const)
    add("executions", "auxiliary", category);
  for (const base of bases)
    add("executions", "auxiliary", "option", null, base);
  return deepFreeze(
    partitions.sort((a, b) =>
      accountEvidencePartitionKey(a).localeCompare(
        accountEvidencePartitionKey(b),
      ),
    ),
  );
}
