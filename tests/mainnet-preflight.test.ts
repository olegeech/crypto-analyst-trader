import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveMainnetExecutionReadiness,
  type MainnetExecutionReadiness,
} from "../src/application/mainnet-execution-readiness.js";
import {
  runMainnetPreflight,
  type MainnetPreflightResult,
} from "../src/application/mainnet-preflight-composition.js";
import {
  MAINNET_PREFLIGHT_USAGE,
  parseMainnetPreflightArgs,
  runMainnetPreflightCli,
} from "../src/cli/mainnet-preflight.js";
import { BybitAccountReadError } from "../src/adapters/bybit-v5/account-read-transport.js";
import { createInstrumentConstraints } from "../src/domain/market/instrument-constraints.js";
import type { UtcTimestamp } from "../src/domain/shared/time.js";
import type { AccountEvidenceFailureCode } from "../src/domain/account/account-evidence-diagnostics.js";
import {
  accountInfoResponse,
  tierResponse,
  walletResponse,
} from "./fixtures/bybit-account/read-fixtures.js";
import {
  createAccountEvidenceBundle,
  createAccountEvidenceCollectionResult,
} from "../src/domain/account/account-evidence-bundle.js";
import { fixture } from "./account-evidence-fixture.js";
import type { AccountEvidenceReadPort } from "../src/ports/account-evidence.js";
import type { AccountEvidencePartition } from "../src/domain/account/account-evidence-policy.js";

const symbol = "BTCUSDT";
const evaluatedAt = "2026-10-02T12:00:02.000Z";
const credentials = {
  apiKey: "synthetic-mainnet-key",
  apiSecret: "synthetic-mainnet-secret",
  accountId: "123",
};

function fixtureReadiness(
  options: {
    readonly incompleteRequiredReasonCode?: AccountEvidenceFailureCode;
  } = {},
): MainnetExecutionReadiness {
  const payload = fixture() as unknown as Record<string, unknown>;
  payload.accountBinding = {
    ...(payload.accountBinding as Record<string, unknown>),
    environment: "mainnet",
    origin: "https://api.bybit.com",
  };
  payload.credentialPosture = {
    readOnly: false,
    permissions: {
      contractOrder: true,
      contractPosition: true,
      spotTrade: false,
      walletTransfer: false,
      withdraw: false,
    },
    ipBound: false,
    expiresAt: null,
    warnings: ["API_KEY_IP_UNBOUND"],
  };
  if (options.incompleteRequiredReasonCode !== undefined) {
    const coverage = payload.coverage as {
      partition: {
        pass: string;
        endpoint: string;
        category: string | null;
        settleCoin: string | null;
      };
      status: string;
      reasonCodes: string[];
    }[];
    const requiredPartition = coverage.find(
      (entry) =>
        entry.partition.pass === "A" &&
        entry.partition.endpoint === "positions" &&
        entry.partition.category === "linear" &&
        entry.partition.settleCoin === "USDT",
    );
    assert.ok(requiredPartition, "fixture has the required linear partition");
    requiredPartition.status = "failed";
    requiredPartition.reasonCodes = [options.incompleteRequiredReasonCode];
    payload.collectionStatus = "incomplete";
    payload.diagnostics = [
      {
        code: options.incompleteRequiredReasonCode,
        severity: "error",
        scope: "coverage",
      },
    ];
  }
  const bundle = createAccountEvidenceBundle(payload);
  assert.equal(bundle.ok, true);
  if (!bundle.ok) throw new Error("invalid account fixture");
  const accountResult = createAccountEvidenceCollectionResult({
    kind: "account-evidence",
    bundle: bundle.value,
  });
  assert.equal(accountResult.ok, true);
  if (!accountResult.ok) throw new Error("invalid collection fixture");
  const constraints = createInstrumentConstraints({
    instrument: symbol,
    version: "bybit-linear-instrument/v1",
    priceTickSize: "0.1",
    quantityStep: "0.001",
    minQuantity: "0.001",
    minNotional: "5",
  });
  assert.equal(constraints.ok, true);
  if (!constraints.ok) throw new Error("invalid instrument fixture");
  const readiness = deriveMainnetExecutionReadiness({
    accountResult: accountResult.value,
    symbol,
    instrument: {
      symbol,
      status: "Trading",
      contractType: "LinearPerpetual",
      quoteCoin: "USDT",
      settleCoin: "USDT",
      constraints: constraints.value,
    },
    evaluatedAt,
  });
  assert.equal(
    readiness.verdict,
    options.incompleteRequiredReasonCode === undefined ? "READY" : "BLOCKED",
  );
  return readiness;
}

function fixtureReadPort(): AccountEvidenceReadPort {
  const now = Date.parse(evaluatedAt);
  return {
    readIdentity: async () => ({
      time: now,
      result: {
        userID: 123,
        readOnly: 0,
        permissions: {
          ContractTrade: ["Order", "Position"],
          Spot: [],
          Wallet: [],
        },
        ips: [],
        expiredAt: "",
      },
    }),
    readExchangeTime: async () => now,
    readPartition: async (partition: AccountEvidencePartition) => ({
      responses: [],
      coverage: {
        partition,
        status: "failed",
        pages: 0,
        rows: 0,
        startedAt: evaluatedAt as UtcTimestamp,
        endedAt: evaluatedAt as UtcTimestamp,
        reasonCodes: ["TRANSPORT_FAILED"],
      },
      observation: null,
    }),
    readOptionInstrument: async () => {
      throw new BybitAccountReadError("UNSUPPORTED_CAPABILITY");
    },
  };
}

function productionMainnetFetchFixture(delayAfterInstrumentMs = 0) {
  const startedAtMs = Date.parse(evaluatedAt);
  const calls: { method: string; path: string }[] = [];
  let providerTimeMs = startedAtMs;
  let advanced = false;
  const request: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, path: url.pathname });
    const query = Object.fromEntries(url.searchParams.entries());
    const responseTimeMs = providerTimeMs;
    let result: Record<string, unknown>;
    let includeEnvelopeTime = true;

    switch (url.pathname) {
      case "/v5/market/time":
        result = { timeSecond: String(Math.floor(responseTimeMs / 1000)) };
        break;
      case "/v5/user/query-api":
        result = {
          userID: 123,
          readOnly: 0,
          permissions: {
            ContractTrade: ["Order", "Position"],
            Spot: [],
            Wallet: [],
          },
          ips: [],
          expiredAt: "",
        };
        break;
      case "/v5/account/info":
        result = structuredClone(accountInfoResponse.result);
        includeEnvelopeTime = false;
        break;
      case "/v5/account/wallet-balance": {
        const wallet = structuredClone(walletResponse.result);
        const accounts = wallet.list as Record<string, unknown>[];
        accounts[0]!.coin = [];
        result = wallet;
        break;
      }
      case "/v5/account/collateral-info":
        result = { list: [] };
        break;
      case "/v5/spot-margin-trade/collateral":
        result = structuredClone(tierResponse.result);
        break;
      case "/v5/market/option-base-coins":
        result = { list: [{ baseCoin: "ETH", hasSymbol: 0 }] };
        break;
      case "/v5/market/instruments-info":
        if (query.category === "option") {
          result = { category: "option", list: [], nextPageCursor: "" };
        } else if (query.symbol === symbol) {
          result = {
            category: "linear",
            list: [
              {
                symbol,
                status: "Trading",
                contractType: "LinearPerpetual",
                quoteCoin: "USDT",
                settleCoin: "USDT",
                priceFilter: { tickSize: "0.1" },
                lotSizeFilter: {
                  qtyStep: "0.001",
                  minOrderQty: "0.001",
                  minNotionalValue: "5",
                },
              },
            ],
          };
        } else {
          result = {
            category: "linear",
            list: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "DOGEUSDT"].map(
              (listedSymbol) => ({
                symbol: listedSymbol,
                settleCoin: "USDT",
              }),
            ),
            nextPageCursor: "",
          };
        }
        break;
      case "/v5/position/list":
        result = {
          category: query.category ?? "linear",
          list: query.symbol
            ? [
                {
                  symbol: query.symbol,
                  positionIdx: 0,
                  size: "0",
                  side: "",
                },
              ]
            : [],
          nextPageCursor: "",
        };
        break;
      case "/v5/order/realtime":
      case "/v5/order/history":
      case "/v5/execution/list":
        result = {
          ...(query.category === undefined ? {} : { category: query.category }),
          list: [],
          nextPageCursor: "",
        };
        break;
      default:
        throw new Error(`Unexpected fixture path: ${url.pathname}`);
    }

    const envelope = {
      retCode: 0,
      retMsg: "OK",
      ...(includeEnvelopeTime ? { time: responseTimeMs } : {}),
      result,
    };
    if (
      url.pathname === "/v5/market/instruments-info" &&
      query.symbol === symbol &&
      !advanced
    ) {
      advanced = true;
      providerTimeMs += delayAfterInstrumentMs;
    }
    return new Response(JSON.stringify(envelope), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { request, calls };
}

test("CLI accepts only the fixed M1 symbol option and rejects authority knobs", () => {
  assert.deepEqual(parseMainnetPreflightArgs(["--symbol", symbol]), {
    ok: true,
    symbol,
  });
  for (const args of [
    [],
    ["--symbol"],
    ["--symbol", "BTCUSDT", "--origin", "https://api.bybit.com"],
    ["--account-id", "123"],
    ["--symbol", "BTCUSDT", "--policy", "weakened"],
    ["--symbol", "BTCUSDT", "--permissions", "all"],
    ["--symbol", "BTCUSDT", "--profile", "custom"],
    ["--symbol", "BTCUSDT", "--yes"],
    ["--symbol", "UNKNOWNUSDT"],
  ])
    assert.deepEqual(parseMainnetPreflightArgs(args), { ok: false });
});

test("READY renderer is sanitized and states SUPPORTED is not live proof", async () => {
  const readiness = fixtureReadiness();
  const output: string[] = [];
  const result: MainnetPreflightResult = {
    kind: "assessment",
    readiness,
    requestCounts: { exchangeReads: 58, exchangeWrites: 0 },
  };
  const exitCode = await runMainnetPreflightCli(["--symbol", symbol], {
    output: { write: (text) => output.push(text) },
    run: async () => result,
  });
  const rendered = output.join("");
  assert.equal(exitCode, 0);
  assert.match(rendered, /VERDICT=READY/u);
  assert.match(rendered, /CAPABILITY_STATUS=SUPPORTED/u);
  assert.match(rendered, /LIVE_PROOF=NOT_ESTABLISHED/u);
  assert.match(rendered, /EXCHANGE_READS=58/u);
  assert.match(rendered, /EXCHANGE_WRITES=0/u);
  assert.match(rendered, /WARNING_CODES=API_KEY_IP_UNBOUND/u);
  assert.doesNotMatch(
    rendered,
    /accountIdentityHash|accountEvidenceHash|sha256:|123|synthetic|userID|ips/u,
  );
});

test("post-auth provider diagnostics render alongside required partition BLOCK", async () => {
  const readiness = fixtureReadiness({
    incompleteRequiredReasonCode: "RATE_LIMITED",
  });
  assert.ok(readiness.reasonCodes.includes("REQUIRED_PARTITION_INCOMPLETE"));

  const output: string[] = [];
  const exitCode = await runMainnetPreflightCli(["--symbol", symbol], {
    output: { write: (text) => output.push(text) },
    run: async () => ({
      kind: "assessment",
      readiness,
      requestCounts: { exchangeReads: 71, exchangeWrites: 0 },
    }),
  });

  assert.equal(exitCode, 4);
  assert.match(output.join(""), /VERDICT=BLOCKED/u);
  assert.match(
    output.join(""),
    /REASON_CODES=.*REQUIRED_PARTITION_INCOMPLETE/u,
  );
  assert.match(output.join(""), /PROVIDER_REASON_CODES=RATE_LIMITED/u);
  assert.match(output.join(""), /EXCHANGE_WRITES=0/u);
});

test("invalid CLI input prints usage and performs no composition call", async () => {
  let called = false;
  const output: string[] = [];
  const exitCode = await runMainnetPreflightCli(["--symbol", symbol, "--yes"], {
    output: { write: (text) => output.push(text) },
    run: async () => {
      called = true;
      throw new Error("must not run");
    },
  });
  assert.equal(exitCode, 2);
  assert.equal(called, false);
  assert.match(output.join(""), new RegExp(MAINNET_PREFLIGHT_USAGE));
});

test("credential failure is safe BLOCKED evidence and stops before exchange reads", async () => {
  const result = await runMainnetPreflight(symbol, {
    credentialProvider: {
      load: async () => {
        throw new Error("synthetic-mainnet-secret");
      },
    },
    utcClock: () => Date.parse(evaluatedAt),
    monotonicClock: () => 0,
    runId: "preflight-test",
  });
  assert.equal(result.kind, "assessment");
  if (result.kind !== "assessment") return;
  assert.equal(result.readiness.verdict, "BLOCKED");
  assert.deepEqual(result.readiness.reasonCodes, ["PRE_AUTH_FAILURE"]);
  assert.deepEqual(result.readiness.providerReasonCodes, [
    "CREDENTIALS_UNAVAILABLE",
  ]);
  assert.equal(result.requestCounts.exchangeReads, 0);
  assert.equal(result.requestCounts.exchangeWrites, 0);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-mainnet-secret/u);
});

test("preflight freshness uses provider time after instrument lookup", async () => {
  const requests: string[] = [];
  let keychainLoads = 0;
  const providerTime = Date.parse(evaluatedAt);
  const result = await runMainnetPreflight(symbol, {
    credentialProvider: {
      load: async (environment) => {
        keychainLoads++;
        assert.equal(environment, "mainnet");
        return credentials;
      },
    },
    utcClock: () => providerTime - 30_000,
    monotonicClock: () => 0,
    runId: "preflight-integration-test",
    createAccountReadPort: () => fixtureReadPort(),
    request: async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push(`${init?.method ?? "GET"} ${path}`);
      const result =
        path === "/v5/market/time"
          ? { timeSecond: String(providerTime / 1000) }
          : {
              list: [
                {
                  symbol,
                  status: "Trading",
                  contractType: "LinearPerpetual",
                  quoteCoin: "USDT",
                  settleCoin: "USDT",
                  priceFilter: { tickSize: "0.1" },
                  lotSizeFilter: {
                    qtyStep: "0.001",
                    minOrderQty: "0.001",
                    minNotionalValue: "5",
                  },
                },
              ],
            };
      return new Response(
        JSON.stringify({
          retCode: 0,
          retMsg: "OK",
          time: providerTime,
          result,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  assert.equal(keychainLoads, 1);
  assert.deepEqual(requests, [
    "GET /v5/market/instruments-info",
    "GET /v5/market/time",
  ]);
  assert.equal(result.kind, "assessment");
  if (result.kind !== "assessment") return;
  assert.equal(result.readiness.verdict, "BLOCKED");
  assert.ok(result.readiness.reasonCodes.includes("ACCOUNT_EVIDENCE_FAILED"));
  assert.equal(result.readiness.accountEvidenceAgeMs, 0);
  assert.ok(!result.readiness.reasonCodes.includes("ACCOUNT_EVIDENCE_STALE"));
  assert.equal(result.requestCounts.exchangeReads, 2);
  assert.equal(result.requestCounts.exchangeWrites, 0);
});

test("production collector reaches sanitized READY and checks delayed verdict freshness", async () => {
  const run = async (delayAfterInstrumentMs: number) => {
    const fixture = productionMainnetFetchFixture(delayAfterInstrumentMs);
    const output: string[] = [];
    const exitCode = await runMainnetPreflightCli(["--symbol", symbol], {
      output: { write: (text) => output.push(text) },
      run: (requestedSymbol) =>
        runMainnetPreflight(requestedSymbol, {
          credentialProvider: { load: async () => credentials },
          utcClock: () => Date.parse(evaluatedAt) - 30_000,
          monotonicClock: () => 0,
          runId: "production-preflight-fixture",
          request: fixture.request,
        }),
    });
    return { exitCode, output: output.join(""), fixture };
  };

  const ready = await run(0);
  assert.equal(ready.exitCode, 0, ready.output);
  assert.match(ready.output, /VERDICT=READY/u);
  assert.match(ready.output, /CAPABILITY_STATUS=SUPPORTED/u);
  assert.match(ready.output, /LIVE_PROOF=NOT_ESTABLISHED/u);
  assert.match(ready.output, /EXCHANGE_WRITES=0/u);
  assert.match(
    ready.output,
    new RegExp(`EXCHANGE_READS=${ready.fixture.calls.length}`, "u"),
  );
  assert.ok(ready.fixture.calls.length > 2);
  assert.ok(ready.fixture.calls.every((call) => call.method === "GET"));
  assert.doesNotMatch(
    ready.output,
    /synthetic-mainnet|userID|accountIdentityHash|123|balances|ips/u,
  );

  const stale = await run(61_000);
  assert.equal(stale.exitCode, 4, stale.output);
  assert.match(stale.output, /VERDICT=BLOCKED/u);
  assert.match(stale.output, /ACCOUNT_EVIDENCE_STALE/u);
  assert.match(stale.output, /EXCHANGE_WRITES=0/u);
  assert.ok(stale.fixture.calls.every((call) => call.method === "GET"));
});

test("instrument provider failure remains visible as a sanitized reason code", async () => {
  const providerTime = Date.parse(evaluatedAt);
  const result = await runMainnetPreflight(symbol, {
    credentialProvider: { load: async () => credentials },
    utcClock: () => providerTime,
    monotonicClock: () => 0,
    runId: "instrument-rate-limit-test",
    createAccountReadPort: () => fixtureReadPort(),
    request: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v5/market/instruments-info")
        return new Response("", { status: 429 });
      return new Response(
        JSON.stringify({
          retCode: 0,
          retMsg: "OK",
          time: providerTime,
          result: { timeSecond: String(providerTime / 1000) },
        }),
        { status: 200 },
      );
    },
  });
  assert.equal(result.kind, "assessment");
  if (result.kind !== "assessment") return;
  assert.equal(result.instrumentProviderReasonCode, "RATE_LIMITED");
  assert.ok(result.readiness.reasonCodes.includes("INSTRUMENT_UNAVAILABLE"));

  const output: string[] = [];
  const exitCode = await runMainnetPreflightCli(["--symbol", symbol], {
    output: { write: (text) => output.push(text) },
    run: async () => result,
  });
  assert.equal(exitCode, 4);
  assert.match(output.join(""), /PROVIDER_REASON_CODES=RATE_LIMITED/u);
  assert.equal(result.requestCounts.exchangeWrites, 0);
});

test("Request objects cannot bypass the GET-only preflight guard", async () => {
  let networkCalls = 0;
  const result = await runMainnetPreflight(symbol, {
    credentialProvider: { load: async () => credentials },
    utcClock: () => Date.parse(evaluatedAt),
    monotonicClock: () => 0,
    runId: "request-method-guard-test",
    createAccountReadPort: ({ request }) => ({
      ...fixtureReadPort(),
      readIdentity: async () => {
        await request(
          new Request("https://api.bybit.com/v5/user/query-api", {
            method: "POST",
          }),
        );
        throw new Error("unreachable");
      },
    }),
    request: async () => {
      networkCalls++;
      return new Response("unexpected");
    },
  });
  assert.equal(result.kind, "failure");
  if (result.kind !== "failure") return;
  assert.equal(result.reasonCode, "NON_GET_REQUEST_BLOCKED");
  assert.equal(result.requestCounts.exchangeReads, 0);
  assert.equal(result.requestCounts.exchangeWrites, 1);
  assert.equal(networkCalls, 0);
});

test("unexpected CLI failure does not invent zero exchange counts", async () => {
  const output: string[] = [];
  const exitCode = await runMainnetPreflightCli(["--symbol", symbol], {
    output: { write: (text) => output.push(text) },
    run: async () => {
      throw new Error("unexpected failure after a request");
    },
  });
  assert.equal(exitCode, 1);
  assert.match(output.join(""), /EXCHANGE_READS=UNKNOWN/u);
  assert.match(output.join(""), /EXCHANGE_WRITES=UNKNOWN/u);
});
