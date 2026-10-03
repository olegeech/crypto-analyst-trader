import assert from "node:assert/strict";
import test from "node:test";
import { collectAccountEvidence } from "../src/application/account-evidence-collection.js";
import { BybitAccountReadError } from "../src/adapters/bybit-v5/account-read-transport.js";
import type { AccountEvidenceReadPort } from "../src/ports/account-evidence.js";
import { BybitAccountReadClient } from "../src/adapters/bybit-v5/account-read-client.js";
import {
  accountInfoResponse,
  walletResponse,
  tierResponse,
  manualOrder,
  fill,
} from "./fixtures/bybit-account/read-fixtures.js";
import type { AccountEvidenceCollectionOptions } from "../src/application/account-evidence-collection.js";
const start = Date.parse("2026-10-03T12:00:00Z");
const credentials = {
  apiKey: "synthetic-key",
  apiSecret: "synthetic-secret",
  accountId: "123",
};
const identity = {
  time: start,
  result: {
    userID: 123,
    readOnly: 1,
    permissions: { ContractTrade: [], Spot: [], Wallet: [] },
    ips: [],
    expiredAt: "",
  },
};
function port(): AccountEvidenceReadPort {
  return {
    readIdentity: async () => identity,
    readExchangeTime: async () => start,
    readPartition: async () => {
      throw new BybitAccountReadError("READ_PERMISSION_DENIED");
    },
    readOptionInstrument: async () => {
      throw new Error("not called");
    },
  };
}
test("credential failure emits no canonical account provenance", async () => {
  const result = await collectAccountEvidence({
    environment: "demo",
    runId: "test",
    configuredM1Symbols: ["BTCUSDT"],
    credentialLoader: {
      load: async () => {
        throw new Error("synthetic-secret");
      },
    },
    utcClock: () => start,
  });
  assert.equal(result.kind, "pre-auth-failure");
  assert.equal("bundle" in result, false);
  assert.doesNotMatch(
    JSON.stringify(result),
    /synthetic-secret|accountIdentityHash|canonicalHash/u,
  );
});
test("wrong UID and rejected authentication stop before other reads", async () => {
  for (const wrong of [true, false]) {
    const read = port();
    let reads = 0;
    read.readIdentity = async () => {
      if (!wrong) throw new BybitAccountReadError("AUTHENTICATION_FAILED");
      return { ...identity, result: { ...identity.result, userID: 456 } };
    };
    read.readExchangeTime = async () => {
      reads++;
      return start;
    };
    const result = await collectAccountEvidence({
      environment: "demo",
      runId: "test",
      configuredM1Symbols: ["BTCUSDT"],
      credentialLoader: { load: async () => credentials },
      createReadPort: () => read,
      utcClock: () => start,
    });
    assert.equal(result.kind, "pre-auth-failure");
    assert.equal(reads, 0);
  }
});
test("after proven identity endpoint failure yields bound failed evidence", async () => {
  const result = await collectAccountEvidence({
    environment: "testnet",
    runId: "test",
    configuredM1Symbols: ["BTCUSDT"],
    credentialLoader: { load: async () => credentials },
    createReadPort: () => port(),
    utcClock: () => start,
    monotonicClock: () => 0,
  });
  assert.equal(result.kind, "account-evidence");
  if (result.kind !== "account-evidence") return;
  assert.equal(result.bundle.collectionStatus, "failed");
  assert.equal(result.bundle.accountBinding.environment, "testnet");
  assert.ok(
    result.bundle.diagnostics.some((d) => d.code === "READ_PERMISSION_DENIED"),
  );
});
test("deadline before vs after identity keeps the result discriminator truthful", async () => {
  for (const after of [false, true]) {
    let elapsed = 0;
    const read = port();
    read.readIdentity = async () => {
      if (!after) elapsed = 30001;
      return identity;
    };
    read.readExchangeTime = async () => {
      elapsed = 30001;
      return start;
    };
    const result = await collectAccountEvidence({
      environment: "demo",
      runId: "test",
      configuredM1Symbols: ["BTCUSDT"],
      credentialLoader: { load: async () => credentials },
      createReadPort: () => read,
      utcClock: () => start,
      monotonicClock: () => elapsed,
    });
    assert.equal(result.kind, after ? "account-evidence" : "pre-auth-failure");
    if (result.kind === "account-evidence")
      assert.equal(result.bundle.collectionStatus, "failed");
  }
});

function scriptedOptions(
  mutate?: (
    path: string,
    query: Readonly<Record<string, string>>,
    result: Record<string, unknown>,
    phase: number,
  ) => void,
) {
  const queries: { path: string; query: Readonly<Record<string, string>> }[] =
    [];
  let phase = 0;
  const options: AccountEvidenceCollectionOptions = {
    environment: "demo",
    runId: "scripted",
    configuredM1Symbols: ["BTCUSDT"],
    credentialLoader: { load: async () => credentials },
    utcClock: () => start,
    monotonicClock: () => 0,
    createReadPort: ({ budget }) =>
      new BybitAccountReadClient({
        utcClock: () => start,
        transport: {
          readExchangeTime: async () => {
            budget.attempts++;
            const result = start + phase * 1000;
            phase++;
            return result;
          },
          get: async (path, query = {}) => {
            budget.attempts++;
            queries.push({ path, query });
            let result: Record<string, unknown> = {
              category: query.category,
              list: [],
              nextPageCursor: "",
            };
            if (path === "/v5/user/query-api")
              result = structuredClone(identity.result);
            if (path === "/v5/account/info")
              result = structuredClone(accountInfoResponse.result);
            if (path === "/v5/account/wallet-balance") {
              const wallet = structuredClone(
                walletResponse.result.list,
              ) as Record<string, unknown>[];
              wallet[0]!.coin = [];
              result = { list: wallet };
            }
            if (path === "/v5/spot-margin-trade/collateral")
              result = structuredClone(tierResponse.result);
            if (path === "/v5/market/instruments-info")
              result = {
                category: query.category,
                list: [{ symbol: "BTCUSDT", settleCoin: "USDT" }],
                nextPageCursor: "",
              };
            if (path === "/v5/market/option-base-coins")
              result = { list: [{ baseCoin: "ETH", hasSymbol: 0 }] };
            if (path === "/v5/position/list" && query.symbol)
              result = {
                category: "linear",
                list: [
                  { symbol: query.symbol, positionIdx: 0, size: "0", side: "" },
                ],
                nextPageCursor: "",
              };
            mutate?.(path, query, result, phase);
            return { time: start + (phase - 1) * 1000, result };
          },
        },
      }),
  };
  return { options, queries };
}
test("production-shaped stable traversal completes and closing time does not move T", async () => {
  const { options, queries } = scriptedOptions();
  const result = await collectAccountEvidence(options);
  assert.equal(result.kind, "account-evidence");
  if (result.kind !== "account-evidence") return;
  assert.equal(
    result.bundle.collectionStatus,
    "complete",
    JSON.stringify(result.bundle.consistency.reasonCodes),
  );
  assert.equal(
    result.bundle.bundleCutoff,
    new Date(start + 1000).toISOString(),
  );
  assert.equal(
    result.bundle.collectionEndedAt,
    new Date(start + 2000).toISOString(),
  );
  for (const request of queries.filter(
    (q) => q.path === "/v5/order/history" || q.path === "/v5/execution/list",
  )) {
    assert.equal(request.query.endTime, String(start + 1000));
    assert.equal(request.query.startTime, String(start + 1000 - 3600000));
  }
  assert.ok(
    queries.some(
      (q) => q.path === "/v5/position/list" && q.query.settleCoin === "USDC",
    ),
  );
  assert.ok(
    queries.some(
      (q) => q.path === "/v5/execution/list" && q.query.baseCoin === "ETH",
    ),
  );
});
test("new closing discovery scope invalidates coverage without retrospectively expanding pass A", async () => {
  const { options } = scriptedOptions((path, _query, result, phase) => {
    if (path === "/v5/market/instruments-info" && phase === 2)
      result.list = [{ symbol: "BTCEUR", settleCoin: "EUR" }];
  });
  const result = await collectAccountEvidence(options);
  assert.equal(result.kind, "account-evidence");
  if (result.kind !== "account-evidence") return;
  assert.equal(result.bundle.collectionStatus, "incomplete");
  assert.ok(
    result.bundle.consistency.reasonCodes.includes("CRITICAL_STATE_CHANGED"),
  );
  assert.ok(result.bundle.discovery?.passBSettlementCoins.includes("EUR"));
});
test("missing tiers retains account facts and incomplete verdict", async () => {
  const { options } = scriptedOptions((path) => {
    if (path === "/v5/spot-margin-trade/collateral")
      throw new BybitAccountReadError("UNSUPPORTED_CAPABILITY");
  });
  const result = await collectAccountEvidence(options);
  assert.equal(result.kind, "account-evidence");
  if (result.kind !== "account-evidence") return;
  assert.equal(result.bundle.collectionStatus, "incomplete");
  assert.equal(
    result.bundle.criticalPasses.A?.account.marginMode.state,
    "known",
  );
  assert.ok(
    result.bundle.diagnostics.some((d) => d.code === "UNSUPPORTED_CAPABILITY"),
  );
});

test("deadline mid critical pass preserves already mapped account and wallet facts", async () => {
  let elapsed = 0;
  const { options } = scriptedOptions((path) => {
    if (path === "/v5/account/collateral-info") elapsed = 30001;
  });
  const result = await collectAccountEvidence({
    ...options,
    monotonicClock: () => elapsed,
  });
  assert.equal(result.kind, "account-evidence");
  if (result.kind !== "account-evidence") return;
  assert.equal(result.bundle.collectionStatus, "incomplete");
  assert.equal(
    result.bundle.criticalPasses.A?.account.utaStatus.state,
    "known",
  );
});

test("account-wide scopes retain USDC, inverse manual orders and two same-time ETH option fills", async () => {
  const { options, queries } = scriptedOptions((path, query, result) => {
    if (path === "/v5/market/option-base-coins")
      result.list = [{ baseCoin: "BTC", hasSymbol: 0 }];
    if (path === "/v5/position/list" && query.settleCoin === "USDC")
      result.list = [
        { symbol: "ETHPERP", positionIdx: 0, side: "Buy", size: "2" },
      ];
    if (path === "/v5/order/realtime" && query.category === "inverse")
      result.list = [
        { ...manualOrder, symbol: "BTCUSD", orderId: "inverse-manual" },
      ];
    if (path === "/v5/order/history" && query.category === "option")
      result.list = [
        {
          ...manualOrder,
          symbol: fill.symbol,
          side: "Sell",
          createdTime: String(start - 7200000),
        },
      ];
    if (path === "/v5/market/instruments-info" && query.category === "option")
      result.list = [
        {
          symbol: query.symbol ?? fill.symbol,
          baseCoin: "ETH",
          settleCoin: "USDC",
        },
      ];
    if (path === "/v5/execution/list" && query.baseCoin === "ETH")
      result.list = [
        { ...fill, execTime: String(start + 1000) },
        { ...fill, execId: "fill-2", execTime: String(start + 1000) },
      ];
  });
  const result = await collectAccountEvidence(options);
  assert.equal(result.kind, "account-evidence");
  if (result.kind !== "account-evidence") return;
  assert.ok(
    result.bundle.criticalPasses.A?.positions.some(
      (p) => p.symbol === "ETHPERP",
    ),
  );
  assert.ok(
    result.bundle.criticalPasses.B?.orders.some(
      (o) => o.orderId === "inverse-manual" && o.orderLinkId === null,
    ),
  );
  assert.equal(result.bundle.auxiliary.executions.length, 2);
  assert.deepEqual(result.bundle.discovery?.exposureOptionBaseCoins, ["ETH"]);
  assert.ok(
    queries.some(
      (q) => q.query.baseCoin === "ETH" && q.path === "/v5/execution/list",
    ),
  );
});
test("partial response remains incomplete and source-local facts survive a missing closing read", async () => {
  const { options } = scriptedOptions();
  const factory = options.createReadPort!;
  let times = 0;
  const result = await collectAccountEvidence({
    ...options,
    createReadPort: (context) => {
      const reader = factory(context);
      const original = reader.readExchangeTime.bind(reader);
      reader.readExchangeTime = async () => {
        if (++times === 3) throw new BybitAccountReadError("TRANSPORT_FAILED");
        return original();
      };
      return reader;
    },
  });
  assert.equal(result.kind, "account-evidence");
  if (result.kind !== "account-evidence") return;
  assert.equal(result.bundle.collectionStatus, "incomplete");
  assert.notEqual(result.bundle.criticalPasses.B, null);
  assert.equal(result.bundle.collectionEndedAt, null);
  assert.equal(
    result.bundle.bundleCutoff,
    new Date(start + 1000).toISOString(),
  );
});

test("out-of-range exchange and observation times report INVALID_RESPONSE", async () => {
  for (const source of ["exchange", "observation"] as const) {
    const { options } = scriptedOptions();
    const factory = options.createReadPort!;
    const result = await collectAccountEvidence({
      ...options,
      createReadPort: (context) => {
        const reader = factory(context);
        if (source === "exchange")
          reader.readExchangeTime = async () => Number.MAX_SAFE_INTEGER;
        else {
          const original = reader.readPartition.bind(reader);
          const invalid = new BybitAccountReadClient({
            utcClock: () => start,
            transport: {
              readExchangeTime: async () => start,
              get: async () => ({
                ...accountInfoResponse,
                time: Number.MAX_SAFE_INTEGER,
              }),
            },
          });
          reader.readPartition = (p, window) =>
            p.endpoint === "account-info"
              ? invalid.readPartition(p, window)
              : original(p, window);
        }
        return reader;
      },
    });
    assert.equal(result.kind, "account-evidence");
    if (result.kind !== "account-evidence") continue;
    assert.notEqual(result.bundle.collectionStatus, "complete");
    assert.ok(
      result.bundle.diagnostics.some((d) => d.code === "INVALID_RESPONSE"),
    );
    assert.equal(
      result.bundle.diagnostics.some((d) => d.code === "TRANSPORT_FAILED"),
      false,
    );
    if (source === "observation") {
      assert.ok(
        result.bundle.coverage.some(
          (c) =>
            c.partition.endpoint === "account-info" &&
            c.status === "failed" &&
            c.reasonCodes.includes("INVALID_RESPONSE"),
        ),
      );
      assert.equal(
        result.bundle.criticalPasses.A?.observations.some(
          (o) => o.partition.endpoint === "account-info",
        ),
        false,
      );
    }
  }
});

test("terminal budgets retain successful current-partition pages and stop subsequent reads", async () => {
  for (const code of [
    "ATTEMPT_BUDGET_EXCEEDED",
    "ROW_BUDGET_EXCEEDED",
  ] as const)
    for (const path of [
      "/v5/order/realtime",
      "/v5/order/history",
      "/v5/execution/list",
    ]) {
      const { options, queries } = scriptedOptions(
        (requestPath, query, response) => {
          if (requestPath !== path) return;
          if (query.cursor) throw new BybitAccountReadError(code);
          response.list =
            path === "/v5/execution/list"
              ? [{ ...fill, execTime: String(start + 1000) }]
              : [manualOrder];
          response.nextPageCursor = "next";
        },
      );
      const result = await collectAccountEvidence(options);
      assert.equal(result.kind, "account-evidence");
      if (result.kind !== "account-evidence") continue;
      assert.equal(result.bundle.collectionStatus, "incomplete");
      const facts =
        path === "/v5/order/realtime"
          ? result.bundle.criticalPasses.A?.orders
          : path === "/v5/order/history"
            ? result.bundle.auxiliary.orders
            : result.bundle.auxiliary.executions;
      assert.equal(facts?.length, 1);
      const failed = result.bundle.coverage.find((c) =>
        c.reasonCodes.includes(code),
      );
      assert.equal(failed?.status, "failed");
      assert.equal(failed?.pages, 1);
      assert.equal(failed?.rows, 1);
      assert.ok(
        result.bundle.diagnostics.some(
          (d) => d.code === code && d.scope === "coverage",
        ),
      );
      assert.ok(
        result.bundle.diagnostics.some(
          (d) => d.code === code && d.scope === "collection",
        ),
      );
      assert.equal(queries.at(-1)?.path, path);
      assert.equal(queries.at(-1)?.query.cursor, "next");
      assert.equal(result.bundle.criticalPasses.B, null);
      assert.equal(result.bundle.collectionEndedAt, null);
    }
});
