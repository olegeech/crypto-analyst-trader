import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { configuredBybitAccountIdentityHash } from "../src/adapters/bybit-v5/account-key-mapper.js";
import {
  openSqlitePersistence,
  type SqlitePersistenceOptions,
} from "../src/adapters/sqlite/sqlite-persistence.js";
import { resolveOperatorMainnetTradeCommand } from "../src/adapters/sqlite/operator-mainnet-test-lookup.js";
import {
  readMainnetOperatorTradeCommandStatus,
  runMainnetOperatorTrade,
} from "../src/application/mainnet-operator-trade.js";
import { createOperatorMainnetCreateRequest } from "../src/application/mainnet-entry-evidence.js";
import type {
  MainnetOperatorTestCompositionInput,
  MainnetOperatorTestOutcome,
} from "../src/application/mainnet-operator-test.js";
import type { MainnetOperatorTestStatusResult } from "../src/application/mainnet-operator-test-status.js";
import {
  hashCanonical,
  type PlanHash,
} from "../src/domain/identity/canonical-serialization.js";
import {
  createOperatorMainnetQuote,
  type OperatorMainnetTestPlan,
} from "../src/domain/execution/operator-mainnet-test-plan.js";
import {
  createOperatorMainnetTradeCommandPlan,
  createOperatorMainnetTradeCommandReceipt,
  type OperatorMainnetTradeCommandBinding,
  type OperatorMainnetTradeCommandPlan,
  type OperatorMainnetTradeCommandReceipt,
} from "../src/domain/execution/operator-mainnet-trade-command.js";
import { createInstrumentConstraints } from "../src/domain/market/instrument-constraints.js";
import { domainError } from "../src/domain/shared/errors.js";
import { fail, ok } from "../src/domain/shared/result.js";
import type { PersistenceScope } from "../src/ports/persistence.js";
import type { UtcTimestamp } from "../src/domain/shared/time.js";

const NOW = "2026-10-31T12:00:00.000Z" as UtcTimestamp;
const runtime = { nodeVersion: "22.22.3", sqliteVersion: "3.51.3" } as const;

function tradeTargetStateRequestFixture(
  options: {
    readonly symbol?: string;
    readonly leverage?: string;
    readonly positionSide?: "flat" | "long" | "short";
    readonly positionQuantity?: string;
    readonly activeOrder?: boolean;
    readonly missingPosition?: boolean;
    readonly missingOrders?: boolean;
    readonly missingProviderTime?: boolean;
    readonly contradictoryPosition?: boolean;
    readonly wrongPositionSymbol?: boolean;
    readonly wrongOrderSymbol?: boolean;
    readonly failPositionReadAfter?: number;
    readonly setBehavior?:
      | "success"
      | "reject"
      | "timeout"
      | "timeout-applied"
      | "invalid-response"
      | "unclassified"
      | "success-stale-readback";
  } = {},
) {
  const symbol = options.symbol ?? "DOGEUSDT";
  let leverage = options.leverage ?? "1";
  let positionReads = 0;
  let orderReads = 0;
  const calls: Array<{
    readonly method: string;
    readonly path: string;
    readonly url: URL;
    readonly body?: Record<string, unknown>;
  }> = [];
  const response = (result: Record<string, unknown>, retCode = 0): Response =>
    new Response(
      JSON.stringify({
        retCode,
        retMsg: retCode === 0 ? "OK" : "rejected",
        result,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const request: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input instanceof Request
            ? input.url
            : String(input),
    );
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    let body: Record<string, unknown> | undefined;
    if (typeof init?.body === "string")
      body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ method, path: url.pathname, url, ...(body ? { body } : {}) });
    if (url.pathname === "/v5/market/time")
      return response({
        ...(options.missingProviderTime
          ? {}
          : {
              timeSecond: String(Math.floor(Date.parse(NOW) / 1000)),
              timeNano: String(BigInt(Date.parse(NOW)) * 1_000_000n),
            }),
      });
    if (url.pathname === "/v5/position/list") {
      positionReads += 1;
      if (
        options.missingPosition ||
        (options.failPositionReadAfter !== undefined &&
          positionReads > options.failPositionReadAfter)
      )
        return response({}, 110001);
      return response({
        category: url.searchParams.get("category"),
        list: [
          {
            symbol: options.wrongPositionSymbol ? "BTCUSDT" : symbol,
            positionIdx: 0,
            side: options.contradictoryPosition
              ? "Buy"
              : options.positionSide === "long"
                ? "Buy"
                : options.positionSide === "short"
                  ? "Sell"
                  : "",
            size:
              (options.contradictoryPosition
                ? "0"
                : options.positionQuantity) ??
              (options.positionSide && options.positionSide !== "flat"
                ? "1"
                : "0"),
            leverage:
              options.setBehavior === "success-stale-readback" &&
              positionReads >= 3
                ? (options.leverage ?? "2")
                : leverage,
          },
        ],
      });
    }
    if (url.pathname === "/v5/order/realtime") {
      orderReads += 1;
      if (options.missingOrders) return response({}, 110001);
      return response({
        category: url.searchParams.get("category"),
        list: options.activeOrder
          ? [
              {
                orderId: "target-active-order",
                orderLinkId: "target-active-link",
                symbol: options.wrongOrderSymbol ? "BTCUSDT" : symbol,
                side: "Buy",
                orderType: "Limit",
                qty: "10",
                cumExecQty: "0",
                orderStatus: "New",
                reduceOnly: false,
                positionIdx: 0,
              },
            ]
          : [],
        nextPageCursor: "",
      });
    }
    if (url.pathname === "/v5/position/set-leverage") {
      if (options.setBehavior === "reject") return response({}, 10001);
      if (options.setBehavior === "unclassified") return response({}, 110043);
      if (options.setBehavior === "invalid-response")
        return new Response(JSON.stringify({ retCode: 0, retMsg: "OK" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (
        options.setBehavior === "success" ||
        options.setBehavior === "timeout-applied" ||
        options.setBehavior === "success-stale-readback"
      )
        leverage = String(body?.buyLeverage ?? "");
      if (
        options.setBehavior === "timeout" ||
        options.setBehavior === "timeout-applied"
      )
        throw new Error("synthetic write response timeout");
      return response({});
    }
    throw new Error(`unexpected target-state endpoint ${url.pathname}`);
  };
  return {
    request,
    calls,
    symbol,
    get positionReads() {
      return positionReads;
    },
    get orderReads() {
      return orderReads;
    },
  };
}

function unwrap<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function tradeFlowFixture(
  targetOptions: Parameters<typeof tradeTargetStateRequestFixture>[0] = {},
) {
  const root = mkdtempSync(join(tmpdir(), "operator-trade-flow-"));
  const databasePath = join(root, "mainnet.db");
  const clock = { now: () => NOW };
  const accountIdentityHash = unwrap<PlanHash>(
    configuredBybitAccountIdentityHash("123", "mainnet"),
  );
  const scope: PersistenceScope = {
    exchange: "bybit",
    environment: "mainnet",
    accountId: accountIdentityHash,
    category: "linear",
    positionMode: "one-way",
  };
  const openPersistence = (options: SqlitePersistenceOptions) =>
    openSqlitePersistence({ ...options, databasePath, runtime, clock });
  const target = tradeTargetStateRequestFixture(targetOptions);
  const prepare = async (input: { readonly tradeCommandReceipt?: unknown }) => {
    if (!input.tradeCommandReceipt)
      throw new Error("direct-command receipt is required");
    const plan = directCommandPlan(
      input.tradeCommandReceipt as OperatorMainnetTradeCommandReceipt,
    );
    const persistence = unwrap(
      openPersistence({ environment: "mainnet", scope }),
    );
    const journal = persistence.operatorMainnetTest;
    assert.ok(journal);
    unwrap(
      journal.persistPreparedPlan(plan as unknown as OperatorMainnetTestPlan),
    );
    persistence.close();
    return ok({
      plan: plan as unknown as OperatorMainnetTestPlan,
      exchangeReads: 4,
      exchangeWrites: 0 as const,
      exchangeStage: "prepare" as const,
      exchangeGetCountsStatus: "available" as const,
      exchangeGetCounts: '{"wallet":4}',
    });
  };
  return {
    root,
    databasePath,
    clock,
    scope,
    accountIdentityHash,
    openPersistence,
    request: target.request,
    target,
    prepare,
  };
}

function directCommandPlan(
  receipt: OperatorMainnetTradeCommandReceipt,
): OperatorMainnetTradeCommandPlan {
  const quote = unwrap(
    createOperatorMainnetQuote({
      exchange: "bybit",
      environment: "mainnet",
      category: "linear",
      origin: "https://api.bybit.com",
      symbol: "DOGEUSDT",
      observedAt: "2026-10-31T11:59:58.900Z",
      collectionStartedAt: "2026-10-31T11:59:58.890Z",
      collectionCompletedAt: "2026-10-31T11:59:58.910Z",
      bid: "0.07699",
      ask: "0.07700",
      last: "0.07699",
    }),
  );
  const constraints = unwrap(
    createInstrumentConstraints({
      instrument: "DOGEUSDT",
      version: "bybit-v5:public-instrument/v2",
      priceTickSize: "0.00001",
      quantityStep: "1",
      minQuantity: "1",
      minNotional: "5",
      minPrice: "0.00001",
      maxPrice: "10",
      maxLimitQuantity: "1000000",
    }),
  );
  return unwrap(
    createOperatorMainnetTradeCommandPlan({
      receipt,
      quote,
      warningCodes: [],
      constraints,
      // Provider time can trail local command acceptance time.
      preparedAt: "2026-10-31T11:59:59.000Z",
    }),
  );
}

function persistDirectIntent(
  input: MainnetOperatorTestCompositionInput,
  fixture: ReturnType<typeof tradeFlowFixture>,
  recordAcceptedAttempt: boolean,
) {
  if (
    !("authorization" in input) ||
    input.authorization.kind !== "trade-command" ||
    typeof input.runId !== "string"
  )
    throw new Error("direct command authorization is required");
  const plan = input.plan as OperatorMainnetTradeCommandPlan;
  const payload = unwrap(
    createOperatorMainnetCreateRequest(
      plan as unknown as OperatorMainnetTestPlan,
    ),
  );
  const persistence = unwrap(
    fixture.openPersistence({ environment: "mainnet", scope: fixture.scope }),
  );
  const journal = persistence.operatorMainnetTest;
  assert.ok(journal);
  const source = unwrap(
    journal.prepareCreateIntent({
      runId: input.runId,
      plan,
      tradeCommand: {
        receipt: input.authorization
          .receipt as OperatorMainnetTradeCommandReceipt,
        binding: input.authorization
          .binding as OperatorMainnetTradeCommandBinding,
        authorizationAt: NOW,
      },
      payloadJson: payload.payloadJson,
      payloadHash: payload.payloadHash as PlanHash,
      preparedAt: NOW,
    }),
  );
  if (recordAcceptedAttempt)
    unwrap(
      journal.recordAttempt({
        runId: input.runId,
        sourceId: source.source.sourceId,
        attemptId: "attempt-accepted",
        outcome: "accepted",
        exchangeOrderId: "exchange-parent-accepted",
        recordedAt: NOW,
      }),
    );
  persistence.close();
  return {
    sourceId: source.source.sourceId,
    clientOrderId: source.source.clientOrderId,
  };
}

function statusForSavedSource(
  sourceId: string,
  fixture: ReturnType<typeof tradeFlowFixture>,
): MainnetOperatorTestStatusResult {
  const persistence = unwrap(
    fixture.openPersistence({ environment: "mainnet", scope: fixture.scope }),
  );
  const journal = persistence.operatorMainnetTest;
  assert.ok(journal);
  const latestSnapshot = unwrap(
    journal.readOperatorMainnetTestSource(sourceId),
  );
  assert.ok(latestSnapshot);
  const halt = unwrap(persistence.readHalt());
  persistence.close();
  return {
    sourceId,
    lifecycleOutcome: "PARTIAL_EVIDENCE",
    cleanupStatus: "pending",
    exchangeReads: 2,
    journaled: true,
    latestSnapshot,
    halt,
    reasons: [],
    exchangeStage: "status",
    exchangeGetCountsStatus: "available",
    exchangeGetCounts: '{"orders":2}',
  };
}

test("direct trade accepts provider-shaped USDT symbols without broadening the M1 list", async (t) => {
  const fixture = tradeFlowFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  let credentialLoads = 0;
  let preparationCalls = 0;
  const dependencies = {
    credentialProvider: {
      load: async () => {
        credentialLoads += 1;
        return {
          apiKey: "test-key",
          apiSecret: "test-secret",
          accountId: "123",
        };
      },
    },
    openPersistence: fixture.openPersistence,
    request: tradeTargetStateRequestFixture({ symbol: "INJUSDT" }).request,
    actorIdentityHash: () =>
      hashCanonical({ localOperatorIdentity: "test-owner" }),
    clock: () => Date.parse(NOW),
    monotonicClock: () => 100,
    prepare: async (input: { readonly symbol: unknown }) => {
      preparationCalls += 1;
      assert.equal(input.symbol, "INJUSDT");
      return fail(
        domainError("INVALID_EVIDENCE", "offline symbol check", {
          reasonCode: "SYMBOL_PREFLIGHT_STOP",
        }),
      );
    },
  };
  const supported = await runMainnetOperatorTrade(
    {
      symbol: "INJUSDT",
      allocation: "10",
      grossNotionalCap: "10",
      maxDeviationBps: "10",
      takeProfitMode: "percent",
      takeProfitValue: "0.20",
    },
    dependencies,
  );
  assert.equal(supported.ok, true);
  if (!supported.ok) throw new Error("supported symbol was rejected");
  assert.equal(supported.value.stoppedAt, "preparation");
  assert.equal(supported.value.reasonCode, "SYMBOL_PREFLIGHT_STOP");
  assert.equal(preparationCalls, 1);

  const unsupported = await runMainnetOperatorTrade(
    {
      symbol: "XRPUSDC",
      allocation: "10",
      grossNotionalCap: "10",
      maxDeviationBps: "10",
      takeProfitMode: "percent",
      takeProfitValue: "0.20",
    },
    dependencies,
  );
  assert.equal(unsupported.ok, false);
  if (unsupported.ok) throw new Error("unsupported symbol was accepted");
  assert.equal(
    unsupported.error.details?.reasonCode,
    "INVALID_TRADE_INSTRUCTION",
  );
  assert.equal(credentialLoads, 1);
  assert.equal(preparationCalls, 1);
});

test("target position, active orders and incomplete target evidence block before leverage setting", async (t) => {
  const scenarios = [
    {
      name: "position and active order are both present",
      options: {
        leverage: "1",
        positionSide: "long" as const,
        activeOrder: true,
      },
      reasonCode: "TARGET_SYMBOL_POSITION_AND_ORDERS_PRESENT",
    },
    {
      name: "existing position",
      options: { leverage: "2", positionSide: "long" as const },
      reasonCode: "TARGET_SYMBOL_POSITION_PRESENT",
    },
    {
      name: "existing active order",
      options: { leverage: "2", activeOrder: true },
      reasonCode: "TARGET_SYMBOL_ACTIVE_ORDERS_PRESENT",
    },
    {
      name: "missing position evidence",
      options: { leverage: "2", missingPosition: true },
      reasonCode: "TARGET_POSITION_EVIDENCE_UNPROVEN",
    },
    {
      name: "zero target leverage",
      options: { leverage: "0" },
      reasonCode: "TARGET_POSITION_EVIDENCE_UNPROVEN",
    },
    {
      name: "malformed target leverage",
      options: { leverage: "not-a-number" },
      reasonCode: "TARGET_POSITION_EVIDENCE_UNPROVEN",
    },
    {
      name: "missing active-order evidence",
      options: { leverage: "2", missingOrders: true },
      reasonCode: "TARGET_ORDERS_EVIDENCE_UNPROVEN",
    },
    {
      name: "contradictory flat position evidence",
      options: { leverage: "2", contradictoryPosition: true },
      reasonCode: "TARGET_POSITION_EVIDENCE_UNPROVEN",
    },
    {
      name: "provider time is unavailable",
      options: { leverage: "2", missingProviderTime: true },
      reasonCode: "TARGET_PROVIDER_TIME_UNPROVEN",
    },
    {
      name: "position response for a different symbol",
      options: { leverage: "2", wrongPositionSymbol: true },
      reasonCode: "TARGET_POSITION_EVIDENCE_UNPROVEN",
    },
    {
      name: "order response for a different symbol",
      options: { leverage: "2", activeOrder: true, wrongOrderSymbol: true },
      reasonCode: "TARGET_ORDERS_EVIDENCE_UNPROVEN",
    },
  ] as const;

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (context) => {
      const fixture = tradeFlowFixture(scenario.options);
      context.after(() =>
        rmSync(fixture.root, { recursive: true, force: true }),
      );
      let commandId = "";
      let prepareCalls = 0;
      let executeCalls = 0;
      const result = await runMainnetOperatorTrade(
        {
          symbol: "DOGEUSDT",
          allocation: "10",
          grossNotionalCap: "10",
          maxDeviationBps: "10",
          takeProfitMode: "percent",
          takeProfitValue: "0.50",
        },
        {
          credentialProvider: {
            load: async () => ({
              apiKey: "test-key",
              apiSecret: "test-secret",
              accountId: "123",
            }),
          },
          openPersistence: fixture.openPersistence,
          request: fixture.request,
          actorIdentityHash: () =>
            hashCanonical({ localOperatorIdentity: "test-owner" }),
          clock: () => Date.parse(NOW),
          monotonicClock: () => 100,
          onCommandIdGenerated: (value) => {
            commandId = value;
          },
          prepare: async () => {
            prepareCalls += 1;
            throw new Error("target-state refusal must precede preparation");
          },
          execute: async () => {
            executeCalls += 1;
            throw new Error("target-state refusal must precede CREATE");
          },
        },
      );

      assert.equal(result.ok, true);
      if (!result.ok) throw new Error("trade returned a top-level failure");
      assert.equal(result.value.kind, "blocked");
      assert.equal(result.value.reasonCode, scenario.reasonCode);
      assert.equal(result.value.leverageConfiguration, "not-attempted");
      assert.equal(result.value.stoppedAt, "target-state");
      assert.equal(result.value.exchangeWrites, 0);
      assert.ok(
        (result.value.exchangeReads ?? 0) >=
          ("missingProviderTime" in scenario.options &&
          scenario.options.missingProviderTime
            ? 1
            : 3),
      );
      assert.equal(prepareCalls, 0);
      assert.equal(executeCalls, 0);
      assert.equal(
        fixture.target.calls.filter(
          ({ method, path }) =>
            method === "POST" && path === "/v5/position/set-leverage",
        ).length,
        0,
      );
      assert.equal(
        fixture.target.calls.filter(
          ({ method, path }) =>
            method === "POST" && path === "/v5/order/create",
        ).length,
        0,
      );

      const status = await readMainnetOperatorTradeCommandStatus(commandId, {
        resolveCommand: (id, options) =>
          resolveOperatorMainnetTradeCommand(id, {
            ...options,
            databasePath: fixture.databasePath,
            clock: fixture.clock,
          }),
        status: async () => {
          throw new Error("pre-intent command status must remain local");
        },
      });
      assert.equal(status.ok, true);
      if (!status.ok) throw new Error("local command status failed");
      assert.equal(status.value.kind, "pre-intent-refused");
      assert.equal(status.value.leverageConfiguration, "not-attempted");
      assert.equal(status.value.exchangeReads, 0);
    });
  }
});

test("leverage setter rejection, timeout and unknown readback never retry or CREATE", async (t) => {
  const scenarios = [
    {
      name: "definitive provider rejection with 2x still visible",
      options: { leverage: "2", setBehavior: "reject" as const },
      expectedStatus: "pre-intent-refused",
      expectedConfiguration: "not-applied",
      expectedReason: "LEVERAGE_CONFIG_NOT_APPLIED",
    },
    {
      name: "timed out setter reconciles 1x but withholds CREATE",
      options: { leverage: "2", setBehavior: "timeout-applied" as const },
      expectedStatus: "leverage-configured-no-create",
      expectedConfiguration: "confirmed-1x",
      expectedReason: "LEVERAGE_CONFIG_WRITE_OUTCOME_UNKNOWN",
    },
    {
      name: "timed out setter with 2x still visible",
      options: { leverage: "2", setBehavior: "timeout" as const },
      expectedStatus: "leverage-config-uncertain",
      expectedConfiguration: "uncertain",
      expectedReason: "LEVERAGE_CONFIG_UNCERTAIN",
    },
    {
      name: "unclassified provider response with 2x still visible",
      options: { leverage: "2", setBehavior: "unclassified" as const },
      expectedStatus: "leverage-config-uncertain",
      expectedConfiguration: "uncertain",
      expectedReason: "LEVERAGE_CONFIG_UNCERTAIN",
    },
    {
      name: "invalid provider response with 2x still visible",
      options: { leverage: "2", setBehavior: "invalid-response" as const },
      expectedStatus: "leverage-config-uncertain",
      expectedConfiguration: "uncertain",
      expectedReason: "LEVERAGE_CONFIG_UNCERTAIN",
    },
    {
      name: "successful POST with unavailable readback",
      options: {
        leverage: "2",
        setBehavior: "success" as const,
        failPositionReadAfter: 2,
      },
      expectedStatus: "leverage-config-uncertain",
      expectedConfiguration: "uncertain",
      expectedReason: "LEVERAGE_CONFIG_UNCERTAIN",
    },
    {
      name: "successful setter response followed by stale 2x target readback",
      options: {
        leverage: "2",
        setBehavior: "success-stale-readback" as const,
      },
      expectedStatus: "leverage-config-uncertain",
      expectedConfiguration: "uncertain",
      expectedReason: "LEVERAGE_CONFIG_READBACK_CONFLICT",
    },
  ] as const;

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (context) => {
      const fixture = tradeFlowFixture(scenario.options);
      context.after(() =>
        rmSync(fixture.root, { recursive: true, force: true }),
      );
      let commandId = "";
      let prepareCalls = 0;
      let executeCalls = 0;
      const result = await runMainnetOperatorTrade(
        {
          symbol: "DOGEUSDT",
          allocation: "10",
          grossNotionalCap: "10",
          maxDeviationBps: "10",
          takeProfitMode: "percent",
          takeProfitValue: "0.50",
        },
        {
          credentialProvider: {
            load: async () => ({
              apiKey: "test-key",
              apiSecret: "test-secret",
              accountId: "123",
            }),
          },
          openPersistence: fixture.openPersistence,
          request: fixture.request,
          actorIdentityHash: () =>
            hashCanonical({ localOperatorIdentity: "test-owner" }),
          clock: () => Date.parse(NOW),
          monotonicClock: () => 100,
          onCommandIdGenerated: (value) => {
            commandId = value;
          },
          prepare: async () => {
            prepareCalls += 1;
            throw new Error("failed leverage confirmation must stop first");
          },
          execute: async () => {
            executeCalls += 1;
            throw new Error("uncertain leverage must never reach CREATE");
          },
        },
      );

      assert.equal(result.ok, true);
      if (!result.ok) throw new Error("trade returned a top-level failure");
      assert.equal(result.value.kind, "blocked");
      assert.equal(
        result.value.reasonCode,
        scenario.expectedReason,
        JSON.stringify({
          reasonCode: result.value.reasonCode,
          diagnostics: result.value.diagnosticDetails,
          calls: fixture.target.calls.map(({ method, path }) => ({
            method,
            path,
          })),
        }),
      );
      assert.equal(
        result.value.leverageConfiguration,
        scenario.expectedConfiguration,
      );
      assert.equal(result.value.stages.leverageConfig?.exchangeWrites, 1);
      assert.equal(result.value.exchangeWrites, 1);
      assert.equal(
        fixture.target.calls.filter(
          ({ method, path }) =>
            method === "POST" && path === "/v5/position/set-leverage",
        ).length,
        1,
      );
      assert.equal(
        fixture.target.calls.filter(
          ({ method, path }) =>
            method === "POST" && path === "/v5/order/create",
        ).length,
        0,
      );
      assert.equal(prepareCalls, 0);
      assert.equal(executeCalls, 0);

      const resolved = resolveOperatorMainnetTradeCommand(commandId, {
        databasePath: fixture.databasePath,
        clock: fixture.clock,
      });
      assert.equal(resolved.ok, true);
      if (!resolved.ok || !resolved.value)
        throw new Error("command evidence did not persist");
      assert.equal(resolved.value.snapshot.source, undefined);
      assert.deepEqual(
        resolved.value.snapshot.outcomes.map(({ code }) => code),
        ["LEVERAGE_CONFIG_ATTEMPTED", scenario.expectedReason],
      );

      const status = await readMainnetOperatorTradeCommandStatus(commandId, {
        resolveCommand: (id, options) =>
          resolveOperatorMainnetTradeCommand(id, {
            ...options,
            databasePath: fixture.databasePath,
            clock: fixture.clock,
          }),
        status: async () => {
          throw new Error("pre-intent command status must stay local");
        },
      });
      assert.equal(status.ok, true);
      if (!status.ok) throw new Error("local status failed");
      assert.equal(status.value.kind, scenario.expectedStatus);
      assert.equal(
        status.value.leverageConfiguration,
        scenario.expectedConfiguration,
      );
      assert.equal(
        status.value.reasonCode,
        scenario.expectedStatus === "leverage-config-uncertain"
          ? "LEVERAGE_CONFIG_UNCERTAIN"
          : scenario.expectedReason,
      );
      assert.equal(status.value.exchangeReads, 0);
    });
  }
});

test("trade records a pre-intent refusal once and command-ID status stays local", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "operator-trade-command-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = join(root, "mainnet.db");
  const clock = { now: () => NOW };
  const accountIdentityHash = unwrap<PlanHash>(
    configuredBybitAccountIdentityHash("123", "mainnet"),
  );
  const scope: PersistenceScope = {
    exchange: "bybit",
    environment: "mainnet",
    accountId: accountIdentityHash,
    category: "linear",
    positionMode: "one-way",
  };
  const openPersistence = (options: SqlitePersistenceOptions) =>
    openSqlitePersistence({
      ...options,
      databasePath,
      runtime,
      clock,
    });
  let commandId: string | undefined;
  let savedReceiptHash: PlanHash | undefined;
  let preparationCalls = 0;
  let executionCalls = 0;
  let statusCalls = 0;

  const result = await runMainnetOperatorTrade(
    {
      symbol: "DOGEUSDT",
      allocation: "10",
      grossNotionalCap: "10",
      maxDeviationBps: "10",
      takeProfitMode: "percent",
      takeProfitValue: "0.20",
    },
    {
      credentialProvider: {
        load: async (environment) => {
          assert.equal(environment, "mainnet");
          return {
            apiKey: "test-key",
            apiSecret: "test-secret",
            accountId: "123",
          };
        },
      },
      openPersistence,
      request: tradeTargetStateRequestFixture().request,
      actorIdentityHash: () =>
        hashCanonical({ localOperatorIdentity: "test-owner" }),
      clock: () => Date.parse(NOW),
      monotonicClock: () => 100,
      onCommandIdGenerated: (id) => {
        commandId = id;
      },
      onReceiptSaved: (receipt) => {
        savedReceiptHash = receipt.contentHash;
      },
      prepare: async (input) => {
        preparationCalls += 1;
        assert.equal(input.symbol, "DOGEUSDT");
        assert.equal(
          (input.tradeCommandReceipt as { readonly commandId: string })
            .commandId,
          commandId,
        );
        return fail(
          domainError("INVALID_EVIDENCE", "capacity is insufficient", {
            reasonCode: "AVAILABLE_MARGIN_OR_FEE_RESERVE_INSUFFICIENT",
            exchangeReads: 17,
            exchangeWrites: 0,
            exchangeGetCounts: '{"wallet":2,"fees":1}',
            availableBalance: "1.25",
            orderNotional: "8",
            entryFeeReserve: "0.0044",
            exitFeeReserve: "0.0045",
            totalReserve: "0.0089",
            requiredAvailableBalance: "8.0089",
            shortfall: "6.7589",
          }),
        );
      },
      execute: async () => {
        executionCalls += 1;
        throw new Error("pre-intent refusal must never reach execute");
      },
    },
  );

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("trade orchestration returned an error");
  assert.equal(commandId, result.value.commandId);
  assert.equal(result.value.receiptSaved, true);
  assert.equal(result.value.kind, "blocked");
  assert.equal(result.value.stoppedAt, "preparation");
  assert.equal(
    result.value.reasonCode,
    "AVAILABLE_MARGIN_OR_FEE_RESERVE_INSUFFICIENT",
  );
  assert.equal(result.value.exchangeReads, 21);
  assert.equal(result.value.stages.leverageConfig?.exchangeReads, 4);
  assert.equal(result.value.stages.leverageConfig?.exchangeWrites, 0);
  assert.equal(result.value.exchangeWrites, 0);
  assert.deepEqual(result.value.diagnosticDetails, {
    availableBalance: "1.25",
    orderNotional: "8",
    entryFeeReserve: "0.0044",
    exitFeeReserve: "0.0045",
    totalReserve: "0.0089",
    requiredAvailableBalance: "8.0089",
    shortfall: "6.7589",
  });
  assert.equal(preparationCalls, 1);
  assert.equal(executionCalls, 0);
  assert.ok(savedReceiptHash);

  const resolved = resolveOperatorMainnetTradeCommand(commandId!, {
    databasePath,
    clock,
  });
  assert.equal(resolved.ok, true);
  if (!resolved.ok || !resolved.value)
    throw new Error("saved command was not resolvable");
  assert.equal(resolved.value.snapshot.receipt.contentHash, savedReceiptHash);
  assert.equal(resolved.value.snapshot.binding, undefined);
  assert.equal(resolved.value.snapshot.source, undefined);
  assert.equal(resolved.value.snapshot.outcomes.length, 2);

  const status = await readMainnetOperatorTradeCommandStatus(commandId, {
    resolveCommand: (id, options) =>
      resolveOperatorMainnetTradeCommand(id, {
        ...options,
        databasePath,
        clock,
      }),
    status: async () => {
      statusCalls += 1;
      throw new Error("pre-intent status must remain local");
    },
  });
  assert.equal(status.ok, true);
  if (!status.ok) throw new Error("local command status failed");
  assert.equal(status.value.kind, "pre-intent-refused");
  assert.equal(status.value.leverageConfiguration, "already-1x");
  assert.equal(
    status.value.reasonCode,
    "AVAILABLE_MARGIN_OR_FEE_RESERVE_INSUFFICIENT",
  );
  assert.deepEqual(status.value.diagnosticDetails, {
    availableBalance: "1.25",
    orderNotional: "8",
    entryFeeReserve: "0.0044",
    exitFeeReserve: "0.0045",
    totalReserve: "0.0089",
    requiredAvailableBalance: "8.0089",
    shortfall: "6.7589",
  });
  assert.equal(status.value.exchangeReads, 0);
  assert.equal(statusCalls, 0);

  const reopened = openPersistence({ environment: "mainnet", scope });
  assert.equal(reopened.ok, true);
  if (!reopened.ok) throw new Error("trade database could not reopen");
  const snapshot =
    reopened.value.operatorMainnetTest!.readOperatorMainnetTradeCommand(
      commandId!,
    );
  assert.equal(snapshot.ok, true);
  if (!snapshot.ok || !snapshot.value)
    throw new Error("trade receipt was not preserved on reopen");
  assert.equal(snapshot.value.receipt.contentHash, savedReceiptHash);
  reopened.value.close();
});

test("receipt-only command status says interrupted before binding", async (t) => {
  const root = mkdtempSync(
    join(tmpdir(), "operator-trade-command-interrupted-"),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = join(root, "mainnet.db");
  const clock = { now: () => NOW };
  const accountIdentityHash = unwrap(
    configuredBybitAccountIdentityHash("123", "mainnet"),
  );
  const actorIdentityHash = unwrap(
    hashCanonical({ localOperatorIdentity: "test-owner" }),
  );
  const commandId = "trade-interrupted-before-binding";
  const receipt = unwrap(
    createOperatorMainnetTradeCommandReceipt({
      commandId,
      actorIdentityHash,
      accountIdentityHash,
      symbol: "DOGEUSDT",
      allocation: "10",
      grossNotionalCap: "10",
      maxDeviationBps: "10",
      takeProfitMode: "percent",
      takeProfitValue: "0.20",
      acceptedAt: NOW,
    }),
  );
  const persistence = openSqlitePersistence({
    environment: "mainnet",
    databasePath,
    runtime,
    clock,
    scope: {
      exchange: "bybit",
      environment: "mainnet",
      accountId: accountIdentityHash,
      category: "linear",
      positionMode: "one-way",
    },
  });
  assert.equal(persistence.ok, true);
  if (!persistence.ok) throw new Error("test database failed to open");
  const journal = persistence.value.operatorMainnetTest;
  assert.ok(journal);
  unwrap(
    journal.persistOperatorMainnetTradeCommandReceipt({
      receipt,
      recordedAt: NOW,
    }),
  );
  persistence.value.close();

  const status = await readMainnetOperatorTradeCommandStatus(commandId, {
    resolveCommand: (id, options) =>
      resolveOperatorMainnetTradeCommand(id, {
        ...options,
        databasePath,
        clock,
      }),
    status: async () => {
      throw new Error("receipt-only status must not query Bybit");
    },
  });
  assert.equal(status.ok, true);
  if (!status.ok) throw new Error("command status failed");
  assert.equal(status.value.kind, "interrupted-before-binding");
  assert.equal(status.value.exchangeReads, 0);
});

test("command status reports interrupted leverage configuration as uncertain without Bybit reads", async (t) => {
  const root = mkdtempSync(
    join(tmpdir(), "operator-trade-leverage-interrupted-"),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = join(root, "mainnet.db");
  const clock = { now: () => NOW };
  const accountIdentityHash = unwrap(
    configuredBybitAccountIdentityHash("123", "mainnet"),
  );
  const actorIdentityHash = unwrap(
    hashCanonical({ localOperatorIdentity: "test-owner" }),
  );
  const commandId = "trade-interrupted-leverage-config";
  const receipt = unwrap(
    createOperatorMainnetTradeCommandReceipt({
      commandId,
      actorIdentityHash,
      accountIdentityHash,
      symbol: "DOGEUSDT",
      allocation: "10",
      grossNotionalCap: "10",
      maxDeviationBps: "10",
      takeProfitMode: "percent",
      takeProfitValue: "0.20",
      acceptedAt: NOW,
    }),
  );
  const persistence = openSqlitePersistence({
    environment: "mainnet",
    databasePath,
    runtime,
    clock,
    scope: {
      exchange: "bybit",
      environment: "mainnet",
      accountId: accountIdentityHash,
      category: "linear",
      positionMode: "one-way",
    },
  });
  assert.equal(persistence.ok, true);
  if (!persistence.ok) throw new Error("test database failed to open");
  const journal = persistence.value.operatorMainnetTest;
  assert.ok(journal);
  unwrap(
    journal.persistOperatorMainnetTradeCommandReceipt({
      receipt,
      recordedAt: NOW,
    }),
  );
  unwrap(
    journal.appendOperatorMainnetTradeCommandOutcome({
      commandId,
      outcomeId: "leverage-attempt-before-interruption",
      stage: "precheck",
      code: "LEVERAGE_CONFIG_ATTEMPTED",
      diagnosticDetails: {
        symbol: "DOGEUSDT",
        positionPresent: false,
        activeOrderCount: 0,
        activeOrdersPresent: false,
        leverageConfiguration: "uncertain",
        leverageConfigOutcome: "attempted",
      },
      occurredAt: NOW,
    }),
  );
  persistence.value.close();

  let statusCalls = 0;
  const status = await readMainnetOperatorTradeCommandStatus(commandId, {
    resolveCommand: (id, options) =>
      resolveOperatorMainnetTradeCommand(id, {
        ...options,
        databasePath,
        clock,
      }),
    status: async () => {
      statusCalls += 1;
      throw new Error("interrupted config status must remain local");
    },
  });
  assert.equal(status.ok, true);
  if (!status.ok) throw new Error("command status failed");
  assert.equal(status.value.kind, "leverage-config-uncertain");
  assert.equal(status.value.leverageConfiguration, "uncertain");
  assert.equal(status.value.exchangeReads, 0);
  assert.equal(statusCalls, 0);
});

test("trade preserves unknown provider-read counts after an unexpected preparation throw", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "operator-trade-unknown-counts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let executeCalls = 0;
  const result = await runMainnetOperatorTrade(
    {
      symbol: "DOGEUSDT",
      allocation: "10",
      grossNotionalCap: "10",
      maxDeviationBps: "10",
      takeProfitMode: "percent",
      takeProfitValue: "0.20",
    },
    {
      credentialProvider: {
        load: async () => ({
          apiKey: "test-key",
          apiSecret: "test-secret",
          accountId: "123",
        }),
      },
      openPersistence: (options) =>
        openSqlitePersistence({
          ...options,
          databasePath: join(root, "mainnet.db"),
          runtime,
          clock: { now: () => NOW },
        }),
      request: tradeTargetStateRequestFixture().request,
      actorIdentityHash: () =>
        hashCanonical({ localOperatorIdentity: "test-owner" }),
      clock: () => Date.parse(NOW),
      monotonicClock: () => 100,
      prepare: async () => {
        throw new Error("fetch failed after an unreported request");
      },
      execute: async () => {
        executeCalls += 1;
        throw new Error("refused preparation must never execute");
      },
    },
  );

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("trade orchestration returned an error");
  assert.equal(result.value.kind, "blocked");
  assert.equal(result.value.stages.prepare?.exchangeReads, undefined);
  assert.equal(result.value.exchangeReads, undefined);
  assert.equal(result.value.stages.prepare?.exchangeWrites, 0);
  assert.equal(result.value.exchangeWrites, 0);
  assert.equal(executeCalls, 0);
});

test("trade persists one command intent and performs one immediate status read", async (t) => {
  const fixture = tradeFlowFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  let commandId: string | undefined;
  let executionCalls = 0;
  let statusCalls = 0;
  let statusSourceId: string | undefined;

  const result = await runMainnetOperatorTrade(
    {
      symbol: "DOGEUSDT",
      allocation: "10",
      grossNotionalCap: "10",
      maxDeviationBps: "10",
      takeProfitMode: "percent",
      takeProfitValue: "0.20",
    },
    {
      credentialProvider: {
        load: async () => ({
          apiKey: "test-key",
          apiSecret: "test-secret",
          accountId: "123",
        }),
      },
      openPersistence: fixture.openPersistence,
      request: fixture.request,
      actorIdentityHash: () =>
        hashCanonical({ localOperatorIdentity: "test-owner" }),
      clock: () => Date.parse(NOW),
      monotonicClock: () => 100,
      onCommandIdGenerated: (value) => {
        commandId = value;
      },
      prepare: fixture.prepare,
      execute: async (input) => {
        executionCalls += 1;
        const source = persistDirectIntent(input, fixture, true);
        const execution: MainnetOperatorTestOutcome = {
          kind: "attempted",
          sourceId: source.sourceId,
          clientOrderId: source.clientOrderId,
          attemptOutcome: "accepted",
          attemptJournaled: true,
          exchangeReads: 7,
          exchangeWrites: 1,
          exchangeStage: "execute",
          exchangeGetCountsStatus: "available",
          exchangeGetCounts: '{"wallet":7}',
        };
        return ok(execution);
      },
      status: async ({ sourceId }) => {
        statusCalls += 1;
        statusSourceId = sourceId as string;
        return ok(statusForSavedSource(statusSourceId, fixture));
      },
    },
  );

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("trade orchestration returned an error");
  assert.equal(result.value.kind, "attempted");
  assert.equal(result.value.exchangeReads, 17);
  assert.equal(result.value.exchangeWrites, 1);
  assert.equal(executionCalls, 1);
  assert.equal(statusCalls, 1);
  assert.equal(statusSourceId, result.value.sourceId);
  assert.equal(
    result.value.immediateStatus?.lifecycleOutcome,
    "PARTIAL_EVIDENCE",
  );
  assert.ok(commandId);

  const resolved = resolveOperatorMainnetTradeCommand(commandId!, {
    databasePath: fixture.databasePath,
    clock: fixture.clock,
  });
  assert.equal(resolved.ok, true);
  if (!resolved.ok || !resolved.value)
    throw new Error("committed trade command was not resolvable");
  assert.equal(
    resolved.value.snapshot.binding?.clientOrderId,
    result.value.clientOrderId,
  );
  assert.equal(resolved.value.snapshot.source?.attempt?.outcome, "accepted");
  assert.equal(
    resolved.value.snapshot.consumption?.sourceId,
    result.value.sourceId,
  );
});

test("execution uncertainty after committed intent keeps identities and status never resends", async (t) => {
  const fixture = tradeFlowFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  let commandId: string | undefined;
  let executionCalls = 0;
  let statusCalls = 0;

  const result = await runMainnetOperatorTrade(
    {
      symbol: "DOGEUSDT",
      allocation: "10",
      grossNotionalCap: "10",
      maxDeviationBps: "10",
      takeProfitMode: "percent",
      takeProfitValue: "0.20",
    },
    {
      credentialProvider: {
        load: async () => ({
          apiKey: "test-key",
          apiSecret: "test-secret",
          accountId: "123",
        }),
      },
      openPersistence: fixture.openPersistence,
      request: fixture.request,
      actorIdentityHash: () =>
        hashCanonical({ localOperatorIdentity: "test-owner" }),
      clock: () => Date.parse(NOW),
      monotonicClock: () => 100,
      onCommandIdGenerated: (value) => {
        commandId = value;
      },
      prepare: fixture.prepare,
      execute: async (input) => {
        executionCalls += 1;
        persistDirectIntent(input, fixture, false);
        throw new Error("simulated lost result after durable intent");
      },
      status: async () => {
        statusCalls += 1;
        return fail(
          domainError("UNRESOLVED_RECONCILIATION", "status unavailable", {
            reasonCode: "READ_FAILED",
            exchangeReads: 3,
            exchangeWrites: 0,
          }),
        );
      },
    },
  );

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("trade orchestration returned an error");
  assert.equal(result.value.kind, "unknown");
  assert.equal(result.value.reasonCode, undefined);
  assert.equal(
    result.value.executionStatusFailureCode,
    "EXECUTION_RESULT_UNKNOWN",
  );
  assert.equal(result.value.immediateStatusFailureCode, "READ_FAILED");
  assert.ok(result.value.sourceId);
  assert.ok(result.value.clientOrderId);
  assert.equal(result.value.exchangeWrites, undefined);
  assert.equal(executionCalls, 1);
  assert.equal(statusCalls, 1);
  assert.ok(commandId);

  const resolved = resolveOperatorMainnetTradeCommand(commandId!, {
    databasePath: fixture.databasePath,
    clock: fixture.clock,
  });
  assert.equal(resolved.ok, true);
  if (!resolved.ok || !resolved.value)
    throw new Error("durable intent was not resolvable");
  assert.ok(resolved.value.snapshot.consumption);
  assert.equal(resolved.value.snapshot.source?.attempt, undefined);
  assert.equal(resolved.value.snapshot.outcomes.length, 1);
  assert.equal(
    resolved.value.snapshot.outcomes[0]?.code,
    "LEVERAGE_CONFIG_ALREADY_1X",
  );

  const recovered = await readMainnetOperatorTradeCommandStatus(commandId, {
    resolveCommand: (id, options) =>
      resolveOperatorMainnetTradeCommand(id, {
        ...options,
        databasePath: fixture.databasePath,
        clock: fixture.clock,
      }),
    status: async ({ sourceId }) => {
      statusCalls += 1;
      assert.equal(sourceId, result.value.sourceId);
      return fail(
        domainError("UNRESOLVED_RECONCILIATION", "status unavailable", {
          reasonCode: "READ_FAILED",
          exchangeReads: 3,
          exchangeWrites: 0,
        }),
      );
    },
  });
  assert.equal(recovered.ok, true);
  if (!recovered.ok) throw new Error("local command recovery failed");
  assert.equal(recovered.value.kind, "intent-present");
  assert.equal(recovered.value.clientOrderId, result.value.clientOrderId);
  assert.equal(recovered.value.statusFailureCode, "READ_FAILED");
  assert.equal(recovered.value.exchangeReads, 3);
  assert.equal(statusCalls, 2);
  assert.equal(executionCalls, 1);
});
