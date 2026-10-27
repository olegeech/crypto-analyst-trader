import assert from "node:assert/strict";
import test from "node:test";
import { prepareMainnetOperatorTest } from "../src/application/mainnet-operator-test-preparation-composition.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqlitePersistence } from "../src/adapters/sqlite/sqlite-persistence.js";
import {
  createOperatorMainnetRecoveryAttestation,
  type OperatorMainnetRecoveryAttestation,
} from "../src/domain/execution/operator-mainnet-recovery.js";
import { hashCanonical } from "../src/domain/identity/canonical-serialization.js";
import {
  accountInfoResponse,
  walletResponse,
  collateralResponse,
  tierResponse,
} from "./fixtures/bybit-account/read-fixtures.js";

const roots: string[] = [];
test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const now = Date.parse("2026-10-25T12:00:00.000Z");
const input = {
  symbol: "DOGEUSDT",
  allocation: "10",
  grossNotionalCap: "10",
  maxDeviationBps: "10",
};

async function prepare(options: {
  balance: string;
  fee?: string;
  feeReadThrows?: boolean;
  feeAge?: number;
  balanceAge?: number;
  unknownFirstBalance?: boolean;
  readOnly?: boolean;
  changingBalance?: boolean;
  failPositionRead?: boolean;
  failOpenOrdersRead?: boolean;
  recoveryAttestation?: OperatorMainnetRecoveryAttestation;
}) {
  const root = mkdtempSync(join(tmpdir(), "operator-prepare-capacity-"));
  roots.push(root);
  const paths: string[] = [];
  let opened = 0;
  let wallets = 0;
  const result = await prepareMainnetOperatorTest(
    {
      ...input,
      ...(options.recoveryAttestation
        ? {
            recoveryAttestationHash: options.recoveryAttestation.contentHash,
            recoveryAttestation: options.recoveryAttestation,
          }
        : {}),
    },
    {
      utcClock: () => now,
      credentialProvider: {
        load: async () => ({
          apiKey: "synthetic-key",
          apiSecret: "synthetic-secret",
          accountId: "123",
        }),
      },
      openPersistence: (settings) => {
        opened++;
        return openSqlitePersistence({
          ...settings,
          rootDirectory: root,
          runtime: { nodeVersion: "22.22.3", sqliteVersion: "3.51.3" },
        });
      },
      request: async (url, init) => {
        assert.equal(init?.method ?? "GET", "GET");
        const target = new URL(String(url));
        const path = target.pathname;
        paths.push(path);
        if (
          (options.failPositionRead && path === "/v5/position/list") ||
          (options.failOpenOrdersRead && path === "/v5/order/realtime")
        )
          throw new Error("synthetic target-state read failure");
        let time = now;
        let result: Record<string, unknown> = { list: [], nextPageCursor: "" };
        switch (path) {
          case "/v5/market/time":
            result = {
              timeSecond: String(now / 1000),
              timeNano: String(BigInt(now) * 1_000_000n),
            };
            break;
          case "/v5/user/query-api":
            result = {
              userID: 123,
              readOnly: options.readOnly ? 1 : 0,
              permissions: {
                ContractTrade: ["Order", "Position"],
                Spot: [],
                Wallet: [],
              },
              ips: ["127.0.0.1"],
              expiredAt: "",
            };
            break;
          case "/v5/account/info":
            result = structuredClone(accountInfoResponse.result);
            break;
          case "/v5/account/wallet-balance": {
            wallets++;
            result = structuredClone(walletResponse.result);
            const rows = result.list as Record<string, unknown>[];
            rows[0]!.coin = [];
            rows[0]!.totalAvailableBalance =
              options.unknownFirstBalance && wallets === 1
                ? ""
                : options.changingBalance && wallets === 2
                  ? "12"
                  : options.balance;
            time -= options.balanceAge ?? 0;
            break;
          }
          case "/v5/account/fee-rate":
            if (options.feeReadThrows) throw new Error("PRIVATE_FEE_RESPONSE");
            result = {
              list: [
                {
                  symbol: input.symbol,
                  makerFeeRate: "0.0002",
                  takerFeeRate: options.fee ?? "0.001",
                },
              ],
            };
            time -= options.feeAge ?? 0;
            break;
          case "/v5/market/instruments-info":
            result = {
              category: "linear",
              list: [
                {
                  symbol: input.symbol,
                  status: "Trading",
                  contractType: "LinearPerpetual",
                  quoteCoin: "USDT",
                  settleCoin: "USDT",
                  priceFilter: {
                    tickSize: "0.0001",
                    minPrice: "0.0001",
                    maxPrice: "1000",
                  },
                  lotSizeFilter: {
                    qtyStep: "1",
                    minOrderQty: "1",
                    maxOrderQty: "100000",
                    minNotionalValue: "5",
                  },
                },
              ],
              nextPageCursor: "",
            };
            break;
          case "/v5/market/tickers":
            result = {
              category: "linear",
              list: [
                {
                  symbol: input.symbol,
                  bid1Price: "0.1",
                  ask1Price: "0.1001",
                  lastPrice: "0.1",
                },
              ],
            };
            break;
          case "/v5/position/list":
            result = {
              category: target.searchParams.get("category"),
              list:
                target.searchParams.get("symbol") === input.symbol
                  ? [
                      {
                        symbol: input.symbol,
                        positionIdx: 0,
                        side: "",
                        size: "0",
                        leverage: "1",
                      },
                    ]
                  : [],
              nextPageCursor: "",
            };
            break;
          case "/v5/account/collateral-info":
            result = structuredClone(collateralResponse.result);
            break;
          case "/v5/spot-margin-trade/collateral":
            result = structuredClone(tierResponse.result);
            break;
          case "/v5/market/option-base-coins":
            result = { list: [{ baseCoin: "ETH", hasSymbol: 0 }] };
            break;
        }
        if (
          path === "/v5/market/instruments-info" &&
          target.searchParams.get("category") === "option"
        )
          result = { category: "option", list: [], nextPageCursor: "" };
        if (
          [
            "/v5/order/realtime",
            "/v5/order/history",
            "/v5/execution/list",
          ].includes(path)
        )
          result.category = target.searchParams.get("category");
        return new Response(
          JSON.stringify({ retCode: 0, retMsg: "OK", time, result }),
          { status: 200 },
        );
      },
    },
  );
  return { result, paths, opened, root };
}

function manualRecoveryAttestation(
  observedAt = new Date(now - 1_000).toISOString(),
): OperatorMainnetRecoveryAttestation {
  const accountIdentity = hashCanonical({
    exchange: "bybit",
    environment: "mainnet",
    userID: "123",
  });
  assert.equal(accountIdentity.ok, true);
  if (!accountIdentity.ok) throw new Error("synthetic account hash failed");
  const result = createOperatorMainnetRecoveryAttestation({
    provenance: "MANUAL_ATTESTED_NOT_API_VERIFIED",
    exchange: "bybit",
    environment: "mainnet",
    accountIdentityHash: accountIdentity.value,
    sourceId: "operator-mainnet-test:prior-source",
    sourcePlanHash: `sha256:${"b".repeat(64)}`,
    sourceIntentId: "prior-intent",
    sourceRevision: 1,
    actor: "operator-test",
    observedAt,
    inspection: {
      accountOpenOrdersInspected: true,
      accountOpenOrders: [],
      accountPositionsInspected: true,
      accountPositions: [],
      sourceOrderHistoryInspected: true,
      sourceOrders: [
        {
          orderId: "prior-entry",
          clientOrderId: "prior-entry-client",
          symbol: input.symbol,
          side: "Buy",
          orderType: "Limit",
          quantity: "1",
          price: "0.1",
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
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("synthetic recovery attestation invalid");
  return result.value;
}

test("prepare blocks fee-inclusive insufficiency before target state and prepared persistence", async () => {
  for (const balance of ["0", "10"]) {
    const run = await prepare({ balance });
    assert.equal(run.result.ok, false);
    if (run.result.ok) return;
    assert.equal(
      run.result.error.details?.reasonCode,
      "AVAILABLE_MARGIN_OR_FEE_RESERVE_INSUFFICIENT",
    );
    assert.equal(run.result.error.details?.availableBalance, balance);
    assert.equal(
      run.result.error.details?.requiredAvailableBalance,
      balance === "0" ? undefined : "10.02002",
    );
    assert.equal(
      run.result.error.details?.shortfall,
      balance === "0" ? undefined : "0.02002",
    );
    if (balance === "0") {
      assert.equal(run.paths.includes("/v5/market/tickers"), false);
      assert.equal(run.paths.includes("/v5/market/instruments-info"), false);
    }
    assert.equal(run.opened, 0);
    assert.equal(run.paths.length, balance === "0" ? 7 : 11);
    assert.equal(run.paths.includes("/v5/position/list"), false);
    assert.equal(run.paths.includes("/v5/order/history"), false);
    assert.match(
      String(run.result.error.details?.exchangeGetCounts),
      /"fees":1/u,
    );
  }
});

test("prepare with sufficient fresh funds reaches persistence through production GET mappers", async () => {
  const run = await prepare({ balance: "11" });
  assert.equal(run.opened, 1, JSON.stringify(run.result));
  assert.equal(run.paths.length, 17);
  assert.equal(run.result.ok, true, JSON.stringify(run.result));
  if (!run.result.ok) return;
  const reopened = openSqlitePersistence({
    environment: "mainnet",
    rootDirectory: run.root,
    scope: {
      exchange: "bybit",
      environment: "mainnet",
      accountId: run.result.value.plan.accountIdentityHash,
      category: "linear",
      positionMode: "one-way",
    },
    runtime: { nodeVersion: "22.22.3", sqliteVersion: "3.51.3" },
  });
  assert.equal(reopened.ok, true);
  if (reopened.ok) {
    try {
      assert.deepEqual(
        reopened.value.operatorMainnetTest?.readPreparedPlan(
          run.result.value.plan.contentHash,
        ),
        { ok: true, value: run.result.value.plan },
      );
    } finally {
      reopened.value.close();
    }
  }
  assert.equal(run.paths.filter((p) => p === "/v5/account/fee-rate").length, 1);
  assert.equal(run.paths.includes("/v5/order/history"), false);
});

test("manual recovery preparation survives unavailable target GETs while retaining machine gates", async () => {
  const recoveryAttestation = manualRecoveryAttestation();
  const run = await prepare({
    balance: "11",
    failPositionRead: true,
    failOpenOrdersRead: true,
    recoveryAttestation,
  });

  assert.equal(run.result.ok, true, JSON.stringify(run.result));
  assert.equal(run.opened, 1);
  assert.equal(
    run.paths.every((path) => path !== "/v5/order/history"),
    true,
  );
  assert.equal(
    run.paths.every((path) => path !== "/v5/execution/list"),
    true,
  );
  assert.equal(
    run.paths.filter((path) => path === "/v5/position/list").length,
    1,
  );
  assert.equal(
    run.paths.filter((path) => path === "/v5/order/realtime").length,
    1,
  );
  if (run.result.ok) {
    assert.equal(
      run.result.value.plan.recoveryAttestationHash,
      recoveryAttestation.contentHash,
    );
    assert.equal(
      run.result.value.plan.schemaVersion,
      "operator-mainnet-execution-test/v2",
    );
  }

  const denied = await prepare({
    balance: "11",
    readOnly: true,
    recoveryAttestation,
  });
  assert.equal(denied.result.ok, false);
  if (!denied.result.ok)
    assert.equal(
      denied.result.error.details?.reasonCode,
      "CREDENTIAL_PERMISSION_BLOCKED",
    );
  assert.equal(denied.opened, 0);
});

test("manual recovery preparation rejects a UI observation older than five minutes", async () => {
  const recoveryAttestation = manualRecoveryAttestation(
    new Date(now - 300_001).toISOString(),
  );
  const run = await prepare({
    balance: "11",
    failPositionRead: true,
    failOpenOrdersRead: true,
    recoveryAttestation,
  });

  assert.equal(run.result.ok, false);
  if (run.result.ok) return;
  assert.equal(
    run.result.error.details?.reasonCode,
    "MANUAL_TARGET_EVIDENCE_STALE",
  );
  assert.equal(run.opened, 0, "stale manual evidence must not persist a plan");
  assert.equal(
    run.paths.filter((path) => path === "/v5/position/list").length,
    1,
  );
  assert.equal(
    run.paths.filter((path) => path === "/v5/order/realtime").length,
    1,
  );
});

test("unknown or stale fee cannot establish affordability or persist a plan", async () => {
  for (const options of [{ fee: "" }, { feeAge: 61_000 }]) {
    const run = await prepare({ balance: "11", ...options });
    assert.equal(run.opened, 0);
    assert.equal(run.result.ok, false);
    if (!run.result.ok)
      assert.notEqual(
        run.result.error.details?.reasonCode,
        "AVAILABLE_MARGIN_OR_FEE_RESERVE_INSUFFICIENT",
      );
  }
});

test("unknown or stale compact balance records fallback and cannot reuse it as proven capacity", async () => {
  for (const options of [
    { balance: "" },
    { balance: "0", balanceAge: 61_000 },
  ]) {
    const run = await prepare(options);
    assert.equal(run.opened, 0);
    assert.equal(run.result.ok, false);
    if (run.result.ok) return;
    assert.ok(run.result.error.details?.compactFallbackReason);
    assert.ok(run.result.error.details?.exchangeGetCounts);
    assert.notEqual(
      run.result.error.details?.reasonCode,
      "AVAILABLE_MARGIN_OR_FEE_RESERVE_INSUFFICIENT",
    );
    assert.ok(
      run.paths.includes("/v5/order/history"),
      JSON.stringify(run.paths),
    );
  }
});

test("full fallback uses its own balance and preserves fee-inclusive insufficiency", async () => {
  const run = await prepare({ balance: "0", unknownFirstBalance: true });
  assert.equal(run.opened, 0);
  assert.equal(run.result.ok, false);
  if (!run.result.ok) {
    assert.equal(
      run.result.error.details?.compactFallbackReason,
      "WALLET_A_BALANCE_UNPROVEN",
    );
    assert.equal(
      run.result.error.details?.reasonCode,
      "AVAILABLE_MARGIN_OR_FEE_RESERVE_INSUFFICIENT",
      JSON.stringify(run.result),
    );
    assert.equal(run.result.error.details?.availableBalance, "0");
  }
});

test("successful full fallback preserves its reason and endpoint counts", async () => {
  const run = await prepare({ balance: "11", unknownFirstBalance: true });
  assert.equal(run.result.ok, true, JSON.stringify(run.result));
  if (!run.result.ok) return;
  assert.equal(run.opened, 1);
  assert.equal(
    run.result.value.compactFallbackReason,
    "WALLET_A_BALANCE_UNPROVEN",
  );
  const counts = JSON.parse(run.result.value.exchangeGetCounts!) as Record<
    string,
    number
  >;
  assert.ok(counts["order-history"]! > 0);
  assert.equal(
    Object.values(counts).reduce((sum, count) => sum + count, 0),
    run.paths.length,
  );
});

test("proven compact permission and balance-change blockers do not trigger a full audit", async () => {
  for (const options of [{ readOnly: true }, { changingBalance: true }]) {
    const run = await prepare({ balance: "11", ...options });
    assert.equal(run.result.ok, false);
    assert.equal(run.opened, 0);
    if (!run.result.ok) {
      assert.equal(
        run.result.error.details?.reasonCode,
        options.readOnly
          ? "CREDENTIAL_PERMISSION_BLOCKED"
          : "AVAILABLE_BALANCE_SNAPSHOTS_DIFFER",
      );
      if (options.changingBalance) {
        assert.equal(run.result.error.details?.pass, "A/B");
        assert.equal(
          run.result.error.details?.predicate,
          "totalAvailableBalance",
        );
      }
      assert.equal(run.result.error.details?.compactFallbackReason, undefined);
    }
    assert.equal(run.paths.includes("/v5/order/history"), false);
  }
});

test("failed preparation fee read reports its source without target reads or a full audit", async () => {
  const run = await prepare({ balance: "11", feeReadThrows: true });
  assert.equal(run.result.ok, false);
  assert.equal(run.opened, 0);
  if (!run.result.ok) {
    assert.equal(run.result.error.details?.reasonCode, "FEE_RATE_READ_FAILED");
    assert.equal(run.result.error.details?.source, "fee");
    assert.equal(run.result.error.details?.compactFallbackReason, undefined);
    assert.doesNotMatch(JSON.stringify(run.result), /PRIVATE_FEE_RESPONSE/u);
  }
  assert.equal(
    run.paths.filter((path) => path === "/v5/account/fee-rate").length,
    2, // Existing transport retry policy; preparation does not start a full audit.
  );
  for (const path of [
    "/v5/position/list",
    "/v5/order/history",
    "/v5/market/instruments-info",
  ])
    assert.equal(run.paths.includes(path), false);
});
