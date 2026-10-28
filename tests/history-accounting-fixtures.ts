import { DecimalValue } from "../src/domain/shared/decimal.js";
import { hashCanonical } from "../src/domain/identity/canonical-serialization.js";
import type { UtcTimestamp } from "../src/domain/shared/time.js";
import type { AccountAssetEvidence } from "../src/domain/account/account-evidence-bundle.js";
import type {
  HistoryAccountingWalletAnchor,
  HistoryAccountingWalletAnchorStorePort,
} from "../src/ports/history-accounting-anchor-store.js";
import type {
  HistoryCheckpoint,
  HistoryStoreScope,
} from "../src/ports/history-store.js";
import { HISTORY_READ_SOURCES } from "../src/ports/history-read.js";
import type { CreateHistoryAccountingReportInput } from "../src/application/history-accounting-report.js";
import { authenticateWalletAnchorCapture } from "../src/ports/history-accounting-anchor-capture-provenance.js";
import { createHistoryAccountingAnchorMac } from "../src/application/history-accounting-anchor-authentication.js";

export const HISTORY_ACCOUNTING_TEST_AUTH_KEY = new Uint8Array(32).fill(0x42);

export const historyAccountingScope: HistoryStoreScope = {
  exchange: "bybit",
  environment: "demo",
  accountId: `sha256:${"a".repeat(64)}`,
};

export const openingBoundary = "2026-10-27T10:00:00.000Z" as UtcTimestamp;
export const closingBoundary = "2026-10-27T10:10:00.000Z" as UtcTimestamp;

function decimal(value: string): DecimalValue {
  const result = DecimalValue.fromString(value);
  if (!result.ok) throw new Error(`invalid fixture decimal: ${value}`);
  return result.value;
}

function coinFact(value: string) {
  return {
    state: "known" as const,
    value: decimal(value),
    unit: "coin" as const,
  };
}

function usdFact(value: string) {
  return {
    state: "known" as const,
    value: decimal(value),
    unit: "USD" as const,
  };
}

function rateFact(value: string) {
  return {
    state: "known" as const,
    value: decimal(value),
    unit: "rate" as const,
  };
}

function asset(balance: string): AccountAssetEvidence {
  return {
    coin: "USDT",
    walletBalance: coinFact(balance),
    equity: coinFact(balance),
    usdValue: usdFact(balance),
    usdEquity: usdFact(balance),
    locked: coinFact("0"),
    bonus: coinFact("0"),
    borrowAmount: coinFact("0"),
    spotBorrow: coinFact("0"),
    accruedInterest: coinFact("0"),
    totalOrderIM: usdFact("0"),
    totalPositionIM: usdFact("0"),
    totalPositionMM: usdFact("0"),
    unrealisedPnl: coinFact("0"),
    collateralEligible: { state: "known", value: true },
    collateralSwitch: { state: "known", value: true },
    restricted: { state: "known", value: "unrestricted" },
  };
}

export function walletAnchor(
  kind: "opening" | "closing",
  at: UtcTimestamp,
  balance = "100",
): Omit<HistoryAccountingWalletAnchor, "contentHash" | "recordedAt"> {
  const boundary = Date.parse(at);
  const before = new Date(boundary - 300).toISOString() as UtcTimestamp;
  const identity = new Date(boundary - 200).toISOString() as UtcTimestamp;
  const after = new Date(boundary + 300).toISOString() as UtcTimestamp;
  return capturedWalletAnchorForStoreTest({
    schemaVersion: "history-accounting-wallet-anchor/v1",
    anchorId: `${kind}-fixture-anchor`,
    kind,
    scope: historyAccountingScope,
    accountBinding: {
      exchange: "bybit",
      environment: "demo",
      origin: "https://api-demo.bybit.com",
      accountIdentityHash: historyAccountingScope.accountId,
      authenticatedAt: new Date(boundary - 500).toISOString() as UtcTimestamp,
      identityVerified: true,
    },
    credentialPosture: {
      readOnly: true,
      permissions: {
        contractOrder: false,
        contractPosition: false,
        spotTrade: false,
        walletTransfer: false,
        withdraw: false,
      },
      ipBound: true,
      expiresAt: null,
      warnings: [],
    },
    capture: {
      identityEndpoint: "/v5/user/query-api",
      walletEndpoint: "/v5/account/wallet-balance",
      accountType: "UNIFIED",
      identityObservedAt: identity,
      collectionStartedAt: before,
      collectionEndedAt: after,
      providerTimeBefore: before,
      providerResponseTime: at,
      providerTimeAfter: after,
    },
    totals: {
      totalEquity: usdFact(balance),
      totalWalletBalance: usdFact(balance),
      totalMarginBalance: usdFact(balance),
      totalPerpUPL: usdFact("0"),
      totalAvailableBalance: usdFact(balance),
      totalInitialMargin: usdFact("0"),
      totalMaintenanceMargin: usdFact("0"),
      accountIMRate: rateFact("0"),
      accountMMRate: rateFact("0"),
      equityBasis: "unestablished",
    },
    assets: [asset(balance)],
  });
}

/** Test-only writer fixture; production code marks anchors only after GET capture. */
export function capturedWalletAnchorForStoreTest<T extends object>(
  anchor: T,
): T {
  authenticateWalletAnchorCapture(
    anchor,
    walletAnchorCaptureMacForStoreTest(anchor),
    HISTORY_ACCOUNTING_TEST_AUTH_KEY,
  );
  return anchor;
}

export function walletAnchorCaptureMacForStoreTest<T extends object>(
  anchor: T,
): string {
  const mac = createHistoryAccountingAnchorMac(
    anchor as never,
    HISTORY_ACCOUNTING_TEST_AUTH_KEY,
  );
  if (!mac.ok) throw new Error("fixture anchor authentication failed");
  return mac.value;
}

export function appendAuthenticatedWalletAnchorForStoreTest(
  store: HistoryAccountingWalletAnchorStorePort,
  anchor: Omit<HistoryAccountingWalletAnchor, "contentHash" | "recordedAt">,
) {
  return store.append({ anchor: capturedWalletAnchorForStoreTest(anchor) });
}

export function completeHistoryCoverage(): readonly HistoryCheckpoint[] {
  const fromMs = Date.parse(openingBoundary);
  const toMs = Date.parse(closingBoundary);
  return HISTORY_READ_SOURCES.map((source) => {
    const filters = {
      ...(source === "transaction-log"
        ? { accountType: "UNIFIED" }
        : { category: "linear" }),
      purpose: "backfill",
      rangeStartMs: fromMs,
      rangeEndMs: toMs,
    };
    const filterHash = hashCanonical(filters);
    if (!filterHash.ok) throw new Error("fixture filter hash failed");
    return {
      scope: historyAccountingScope,
      source,
      filters,
      window: { fromMs, toMs },
      filterHash: filterHash.value,
      cursor: null,
      status: "traversed" as const,
      rowCount: 0,
      insertedCount: 0,
      duplicateCount: 0,
      conflictCount: 0,
      reasonCode: null,
      updatedAt: closingBoundary,
      revision: 1,
    };
  });
}

export function completeReportInput(
  overrides: Partial<CreateHistoryAccountingReportInput> = {},
): CreateHistoryAccountingReportInput {
  return {
    scope: historyAccountingScope,
    opening: capturedWalletAnchorForStoreTest({
      ...walletAnchor("opening", openingBoundary),
      contentHash: `sha256:${"b".repeat(64)}`,
      recordedAt: new Date(
        Date.parse(openingBoundary) + 1_000,
      ).toISOString() as UtcTimestamp,
    }),
    closing: capturedWalletAnchorForStoreTest({
      ...walletAnchor("closing", closingBoundary),
      contentHash: `sha256:${"c".repeat(64)}`,
      recordedAt: new Date(
        Date.parse(closingBoundary) + 1_000,
      ).toISOString() as UtcTimestamp,
    }),
    observations: [],
    conflicts: [],
    coverage: completeHistoryCoverage(),
    operatorSources: [],
    preparedSources: [],
    settlementCurrencyBySymbol: {},
    ...overrides,
  };
}
