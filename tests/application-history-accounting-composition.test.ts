import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openSqliteConnection } from "../src/adapters/sqlite/connection.js";
import { mapBybitHistoryResponse } from "../src/adapters/bybit-v5/history-read-mappers.js";
import type { AccountReadResponse } from "../src/adapters/bybit-v5/account-read-transport.js";
import { createSqliteHistoryAccountingReportStore } from "../src/adapters/sqlite/history-accounting-report-store.js";
import { createSqliteHistoryStore } from "../src/adapters/sqlite/history-store.js";
import { captureHistoryAccountingAnchor } from "../src/application/history-accounting-anchor-capture.js";
import { reconcileHistoryAccounting } from "../src/application/history-accounting-composition.js";
import { resolveHistoryAccountingScope } from "../src/application/history-accounting-scope.js";
import { validateHistoryAccountingProof } from "../src/application/history-accounting-proof.js";
import { runHistoryAccountingCli } from "../src/cli/history-accounting.js";
import { OPERATOR_MAINNET_TEST_POLICY_VERSION } from "../src/domain/execution/operator-mainnet-test-plan.js";
import type { UtcTimestamp } from "../src/domain/shared/time.js";
import { HISTORY_READ_SOURCES } from "../src/ports/history-read.js";
import { HISTORY_ACCOUNTING_TEST_AUTH_KEY } from "./history-accounting-fixtures.js";

const runtime = { nodeVersion: "22.22.3", sqliteVersion: "3.51.3" } as const;
const accountId = "123456";

function response(result: Record<string, unknown>, time: number): Response {
  return new Response(
    JSON.stringify({ retCode: 0, retMsg: "OK", result, time }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function walletCoin(coin: string, balance: string, usdValue: string) {
  return {
    coin,
    walletBalance: balance,
    equity: balance,
    usdValue,
    locked: "0",
    bonus: "0",
    borrowAmount: "0",
    spotBorrow: "0",
    accruedInterest: "0",
    totalOrderIM: "0",
    totalPositionIM: "0",
    totalPositionMM: "0",
    unrealisedPnl: "0",
    marginCollateral: false,
    colRes: "0",
  };
}

function walletResponse() {
  return {
    list: [
      {
        accountType: "UNIFIED",
        totalEquity: "105",
        totalWalletBalance: "105",
        totalMarginBalance: "105",
        totalPerpUPL: "0",
        totalAvailableBalance: "105",
        totalInitialMargin: "0",
        totalMaintenanceMargin: "0",
        accountIMRate: "0",
        accountMMRate: "0",
        coin: [walletCoin("USDT", "100", "100"), walletCoin("MNT", "5", "5")],
      },
    ],
  };
}

function mappedHistoryResponse(
  source: (typeof HISTORY_READ_SOURCES)[number],
  time: number,
  list: readonly Record<string, unknown>[] = [],
): AccountReadResponse {
  return {
    result:
      source === "transaction-log"
        ? { accountType: "UNIFIED", list }
        : { category: "linear", list },
    time,
  };
}

function technicalMntTransferRow(time: number): Record<string, unknown> {
  return {
    id: "synthetic-mnt-transfer",
    type: "TRANSFER_IN",
    transSubType: "MANUAL",
    side: "None",
    category: "linear",
    symbol: "",
    currency: "MNT",
    qty: "0",
    size: "0",
    tradePrice: "0",
    cashFlow: "1",
    funding: "0",
    fee: "0",
    feeRate: "",
    change: "1",
    bonusChange: "0",
    availableBalance: "6",
    tradeId: "",
    orderId: "",
    transactionTime: String(time),
    cashBalance: "6",
    orderLinkId: "",
    displayType: "",
  };
}

function outputBuffer() {
  let value = "";
  return {
    output: { write: (text: string) => (value += text) },
    read: () => value,
  };
}

test("mapped Bybit-shaped wallet and history complete scoped reconcile, CLI, proof and legacy replay offline", async () => {
  const root = mkdtempSync(join(tmpdir(), "scoped-history-accounting-e2e-"));
  const databasePath = join(root, "account.db");
  let providerTime = Date.parse("2026-10-27T10:00:00.000Z");
  let requestCount = 0;
  let monotonic = 0;
  const monotonicClock = () => ++monotonic;
  const request: typeof fetch = async (input, init) => {
    assert.equal(init?.method, "GET");
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    requestCount += 1;
    providerTime += 250;
    if (url.pathname === "/v5/market/time")
      return response(
        {
          timeSecond: String(Math.floor(providerTime / 1_000)),
          timeNano: String(BigInt(providerTime) * 1_000_000n),
        },
        providerTime,
      );
    if (url.pathname === "/v5/user/query-api")
      return response(
        {
          userID: accountId,
          readOnly: 1,
          permissions: { ContractTrade: [], Wallet: [], Spot: [] },
          ips: ["127.0.0.1"],
          expiredAt: "",
        },
        providerTime,
      );
    if (url.pathname === "/v5/account/wallet-balance")
      return response(walletResponse(), providerTime);
    throw new Error(`unexpected offline request: ${url.pathname}`);
  };
  const keyProvider = {
    async getOrCreate() {
      return { ok: true as const, value: HISTORY_ACCOUNTING_TEST_AUTH_KEY };
    },
    async read() {
      return { ok: true as const, value: HISTORY_ACCOUNTING_TEST_AUTH_KEY };
    },
  };
  const credentialProvider = {
    async load() {
      return {
        apiKey: "synthetic-key",
        apiSecret: "synthetic-secret",
        accountId,
      };
    },
  };
  const openConnection: typeof openSqliteConnection = (options) =>
    openSqliteConnection({
      ...options,
      runtime,
      clock: {
        now: () => new Date(providerTime).toISOString() as UtcTimestamp,
      },
    });
  const captureDependencies = {
    anchorKeyProvider: keyProvider,
    credentialProvider,
    request,
    utcClock: () => providerTime,
    monotonicClock,
    openConnection,
    createAnchorId: (() => {
      let id = 0;
      return () => `synthetic-anchor-${++id}`;
    })(),
  };

  try {
    const opening = await captureHistoryAccountingAnchor(
      { environment: "demo", databasePath, kind: "opening" },
      captureDependencies,
    );
    assert.equal(opening.ok, true, opening.ok ? "" : opening.error.message);
    if (!opening.ok) return;
    // Leave a clean in-period interval between the opening and closing
    // collection brackets, as a real supervised accounting period requires.
    providerTime += 5_000;
    const closing = await captureHistoryAccountingAnchor(
      { environment: "demo", databasePath, kind: "closing" },
      captureDependencies,
    );
    assert.equal(closing.ok, true, closing.ok ? "" : closing.error.message);
    if (!closing.ok) return;
    assert.deepEqual(
      opening.value.anchor.assets.map((asset) => asset.coin),
      ["MNT", "USDT"],
    );

    const scope = opening.value.anchor.scope;
    const fromMs = Date.parse(opening.value.anchor.capture.providerTimeBefore);
    const toMs = Date.parse(closing.value.anchor.capture.providerTimeAfter);
    assert.ok(toMs > fromMs);
    const technicalTransferTime =
      Date.parse(opening.value.anchor.capture.providerResponseTime) + 2_000;
    const historyConnection = openConnection({
      environment: "demo",
      databasePath,
    });
    assert.equal(historyConnection.ok, true);
    if (!historyConnection.ok) return;
    const history = createSqliteHistoryStore(historyConnection.value);
    for (const source of HISTORY_READ_SOURCES) {
      const providerResponse = mappedHistoryResponse(
        source,
        toMs,
        source === "transaction-log"
          ? [technicalMntTransferRow(technicalTransferTime)]
          : [],
      );
      const facts = mapBybitHistoryResponse(source, providerResponse, toMs);
      const filters = {
        ...(source === "transaction-log"
          ? { accountType: "UNIFIED" }
          : { category: "linear" }),
        purpose: "backfill",
        rangeStartMs: fromMs,
        rangeEndMs: toMs,
      };
      const committed = history.commitPage({
        scope,
        source,
        filters,
        window: { fromMs, toMs },
        expectedRevision: 0,
        cursor: null,
        nextCursor: null,
        facts,
      });
      assert.equal(
        committed.ok,
        true,
        committed.ok ? "" : committed.error.message,
      );
    }
    historyConnection.value.close();

    const input = {
      environment: "demo" as const,
      databasePath,
      openingAnchorId: opening.value.anchor.anchorId,
      closingAnchorId: closing.value.anchor.anchorId,
    };
    const accountingScope = resolveHistoryAccountingScope(
      OPERATOR_MAINNET_TEST_POLICY_VERSION,
    );
    assert.equal(accountingScope.ok, true);
    if (!accountingScope.ok) return;
    const reconcile = (accountingPolicyVersion?: string) =>
      reconcileHistoryAccounting(
        {
          ...input,
          ...(accountingPolicyVersion === undefined
            ? {}
            : { accountingPolicyVersion }),
        },
        { openConnection, anchorKeyProvider: keyProvider },
      );

    const legacy = await reconcile();
    assert.equal(legacy.ok, true, legacy.ok ? "" : legacy.error.message);
    if (!legacy.ok) return;
    assert.equal(
      legacy.value.schemaVersion,
      "history-accounting-reconciliation-report/v1",
    );
    assert.equal(legacy.value.status, "NOT_READY");
    assert.ok(legacy.value.epoch.reasonCodes.includes("UNSUPPORTED_CURRENCY"));
    const legacyReadConnection = openConnection({
      environment: "demo",
      databasePath,
    });
    assert.equal(legacyReadConnection.ok, true);
    if (!legacyReadConnection.ok) return;
    const legacyCanonical = createSqliteHistoryAccountingReportStore(
      legacyReadConnection.value,
    ).readById(legacy.value.reportId);
    legacyReadConnection.value.close();
    assert.equal(legacyCanonical.ok, true);
    if (!legacyCanonical.ok || !legacyCanonical.value) return;

    const legacyCliOutput = outputBuffer();
    const legacyCliExit = await runHistoryAccountingCli(
      [
        "--mode",
        "reconcile",
        "--environment",
        "demo",
        "--database",
        databasePath,
        "--opening-anchor-id",
        input.openingAnchorId,
        "--closing-anchor-id",
        input.closingAnchorId,
      ],
      {
        output: legacyCliOutput.output,
        reconcile: (cliInput) =>
          reconcileHistoryAccounting(cliInput, {
            openConnection,
            anchorKeyProvider: keyProvider,
          }),
      },
    );
    assert.equal(legacyCliExit, 4);
    assert.match(
      legacyCliOutput.read(),
      /SCOPED_SELECTOR_HINT=.*--accounting-policy/u,
    );

    const scopedOutput = outputBuffer();
    const scopedCliExit = await runHistoryAccountingCli(
      [
        "--mode",
        "reconcile",
        "--environment",
        "demo",
        "--database",
        databasePath,
        "--opening-anchor-id",
        input.openingAnchorId,
        "--closing-anchor-id",
        input.closingAnchorId,
        "--accounting-policy",
        OPERATOR_MAINNET_TEST_POLICY_VERSION,
      ],
      {
        output: scopedOutput.output,
        reconcile: (cliInput) =>
          reconcileHistoryAccounting(cliInput, {
            openConnection,
            anchorKeyProvider: keyProvider,
          }),
      },
    );
    assert.equal(scopedCliExit, 0);
    assert.match(
      scopedOutput.read(),
      /REPORT_CONTRACT=history-accounting-reconciliation-report\/v2/u,
    );
    assert.match(scopedOutput.read(), /INCLUDED_CURRENCIES=USDT/u);
    assert.match(scopedOutput.read(), /EXCLUDED_ANCHOR_CURRENCIES=MNT/u);
    assert.match(
      scopedOutput.read(),
      /WHOLE_ACCOUNT_RECONCILIATION=UNCLAIMED/u,
    );
    assert.match(scopedOutput.read(), /EXCHANGE_READS=0\nEXCHANGE_WRITES=0/u);
    const scopedReportId = /REPORT_ID=([^\n]+)/u.exec(scopedOutput.read())?.[1];
    assert.ok(scopedReportId);
    if (!scopedReportId) return;
    const scoped = await reconcile(OPERATOR_MAINNET_TEST_POLICY_VERSION);
    assert.equal(scoped.ok, true, scoped.ok ? "" : scoped.error.message);
    if (!scoped.ok) return;
    assert.equal(scoped.value.reportId, scopedReportId);
    assert.equal(scoped.value.status, "ACCOUNTING_READY");
    assert.equal(
      scoped.value.transactions.some(
        (transaction) => transaction.currency === "MNT",
      ),
      false,
    );

    const proof = await validateHistoryAccountingProof(
      {
        schemaVersion: "history-accounting-proof-request/v2",
        ...input,
        reportId: scoped.value.reportId,
        expectedScope: scope,
        dependencyHash: scoped.value.dependencyHash,
        accountingScope: accountingScope.value,
        accountingScopeHash: accountingScope.value.scopeHash,
      },
      { openConnection, anchorKeyProvider: keyProvider },
    );
    assert.equal(proof.ok, true, proof.ok ? "" : proof.error.message);
    assert.equal(proof.ok && proof.value.decision, "ACCEPT");
    assert.equal(requestCount, 10);

    const beforeNewEvidence = requestCount;
    const coverageConnection = openConnection({
      environment: "demo",
      databasePath,
    });
    assert.equal(coverageConnection.ok, true);
    if (!coverageConnection.ok) return;
    const latestCoverage = createSqliteHistoryStore(
      coverageConnection.value,
    ).listCoverage(scope);
    coverageConnection.value.close();
    assert.equal(latestCoverage.ok, true);
    if (!latestCoverage.ok) return;
    const transactionCheckpoint = latestCoverage.value.find(
      (row) => row.source === "transaction-log",
    );
    assert.ok(transactionCheckpoint);
    if (!transactionCheckpoint) return;
    const transactionTime =
      Date.parse(opening.value.anchor.capture.providerTimeAfter) + 2_000;
    const transfer = mapBybitHistoryResponse(
      "transaction-log",
      mappedHistoryResponse("transaction-log", toMs, [
        {
          id: "synthetic-usdt-transfer",
          type: "TRANSFER_IN",
          transSubType: "MANUAL",
          side: "None",
          category: "linear",
          symbol: "",
          currency: "USDT",
          qty: "0",
          size: "0",
          tradePrice: "0",
          cashFlow: "1",
          funding: "0",
          fee: "0",
          feeRate: "",
          change: "1",
          bonusChange: "0",
          availableBalance: "101",
          tradeId: "",
          orderId: "",
          transactionTime: String(transactionTime),
          cashBalance: "101",
          orderLinkId: "",
          displayType: "",
        },
      ]),
      toMs,
    );
    const updateConnection = openConnection({
      environment: "demo",
      databasePath,
    });
    assert.equal(updateConnection.ok, true);
    if (!updateConnection.ok) return;
    const updateStore = createSqliteHistoryStore(updateConnection.value);
    const appended = updateStore.commitPage({
      scope,
      source: transactionCheckpoint.source,
      filters: transactionCheckpoint.filters,
      window: transactionCheckpoint.window,
      expectedRevision: transactionCheckpoint.revision,
      cursor: transactionCheckpoint.cursor,
      nextCursor: transactionCheckpoint.cursor,
      facts: transfer,
    });
    assert.equal(appended.ok, true, appended.ok ? "" : appended.error.message);
    updateConnection.value.close();

    const notReadyOutput = outputBuffer();
    const notReadyExit = await runHistoryAccountingCli(
      [
        "--mode",
        "reconcile",
        "--environment",
        "demo",
        "--database",
        databasePath,
        "--opening-anchor-id",
        input.openingAnchorId,
        "--closing-anchor-id",
        input.closingAnchorId,
        "--accounting-policy",
        OPERATOR_MAINNET_TEST_POLICY_VERSION,
      ],
      {
        output: notReadyOutput.output,
        reconcile: (cliInput) =>
          reconcileHistoryAccounting(cliInput, {
            openConnection,
            anchorKeyProvider: keyProvider,
          }),
      },
    );
    assert.equal(notReadyExit, 4);
    assert.match(notReadyOutput.read(), /ACCOUNTING_READY=NO/u);
    assert.match(notReadyOutput.read(), /REASON_CODES=UNEXPLAINED_DRIFT/u);
    assert.match(notReadyOutput.read(), /NEXT_ACTION=Review the reason codes/u);
    const staleProof = await validateHistoryAccountingProof(
      {
        schemaVersion: "history-accounting-proof-request/v2",
        ...input,
        reportId: scoped.value.reportId,
        expectedScope: scope,
        dependencyHash: scoped.value.dependencyHash,
        accountingScope: accountingScope.value,
        accountingScopeHash: accountingScope.value.scopeHash,
      },
      { openConnection, anchorKeyProvider: keyProvider },
    );
    assert.equal(staleProof.ok && staleProof.value.decision, "REFUSE");
    assert.equal(requestCount, beforeNewEvidence);

    const finalConnection = openConnection({
      environment: "demo",
      databasePath,
    });
    assert.equal(finalConnection.ok, true);
    if (!finalConnection.ok) return;
    const legacyAfterScoped = createSqliteHistoryAccountingReportStore(
      finalConnection.value,
    ).readById(legacy.value.reportId);
    assert.equal(legacyAfterScoped.ok, true);
    assert.ok(legacyAfterScoped.ok && legacyAfterScoped.value);
    if (!legacyAfterScoped.ok || !legacyAfterScoped.value) return;
    assert.equal(
      legacyAfterScoped.value.canonicalJson,
      legacyCanonical.value.canonicalJson,
    );
    finalConnection.value.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
