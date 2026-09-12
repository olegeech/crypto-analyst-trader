import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  reconcileOrder,
  runEntryScenario,
  type ScenarioTransport,
} from "../scripts/bybit-probe/scenarios.js";
import {
  buildProbePlan,
  hashProbePlan,
} from "../scripts/bybit-probe/probe-plan.js";
import { ProbeStore } from "../scripts/bybit-probe/store.js";
import type { BybitResponse } from "../scripts/bybit-probe/transport.js";

function response(result: Record<string, unknown>): BybitResponse {
  return { retCode: 0, retMsg: "OK", result };
}

function entryPlan() {
  return buildProbePlan({
    environment: "testnet",
    accountId: "trading-account",
    scenario: "long-entry",
    expiresAt: 100_000,
    method: "POST",
    endpoint: "/v5/order/create",
    params: {
      category: "linear",
      symbol: "DOGEUSDT",
      side: "Buy",
      orderLinkId: "run-1-long",
      price: "0.1",
      qty: "51",
      takeProfit: "0.102",
      stopLoss: "0.098",
      orderType: "Limit",
      timeInForce: "PostOnly",
      reduceOnly: false,
      positionIdx: 0,
      tpslMode: "Full",
      tpOrderType: "Market",
      slOrderType: "Market",
      tpTriggerBy: "LastPrice",
      slTriggerBy: "LastPrice",
    },
  });
}

test("reconciliation treats acknowledgement as pending and delayed visibility as non-submission", async () => {
  let lookups = 0;
  const transport: ScenarioTransport = {
    async get(path, query) {
      assert.equal(path, "/v5/order/realtime");
      assert.deepEqual(query, {
        category: "linear",
        symbol: "DOGEUSDT",
        orderLinkId: "run-1-long",
      });
      lookups += 1;
      return response({
        list:
          lookups === 1
            ? []
            : [
                {
                  orderId: "exchange-1",
                  orderLinkId: "run-1-long",
                  orderStatus: "New",
                  takeProfit: "0.102",
                  stopLoss: "0.098",
                },
              ],
      });
    },
    async post() {
      throw new Error("not used");
    },
  };
  const result = await reconcileOrder(transport, {
    orderLinkId: "run-1-long",
    category: "linear",
    symbol: "DOGEUSDT",
    clock: () => 1_000,
    sleep: async () => undefined,
    realtimeAttempts: 3,
    historyAttempts: 0,
  });
  assert.equal(result.kind, "resting");
  assert.equal(result.acknowledgement, "pending");
  assert.equal(result.lookupCount, 3);
  assert.equal(result.terminalState, undefined);
});

test("history fallback resolves only after realtime budget is exhausted", async () => {
  const calls: string[] = [];
  const transport: ScenarioTransport = {
    async get(path) {
      calls.push(path);
      return response({
        list:
          path === "/v5/order/history"
            ? [
                {
                  orderId: "exchange-2",
                  orderLinkId: "run-1-long",
                  orderStatus: "Cancelled",
                },
              ]
            : [],
      });
    },
    async post() {
      throw new Error("not used");
    },
  };
  const result = await reconcileOrder(transport, {
    orderLinkId: "run-1-long",
    category: "linear",
    symbol: "DOGEUSDT",
    sleep: async () => undefined,
    realtimeAttempts: 1,
    historyAttempts: 1,
  });
  assert.equal(result.kind, "terminal");
  assert.equal(result.terminalState, "Cancelled");
  assert.deepEqual(calls, ["/v5/order/realtime", "/v5/order/history"]);
});

test("an empty realtime and history budget is unresolved and never authorizes retry", async () => {
  let posts = 0;
  const transport: ScenarioTransport = {
    async get() {
      return response({ list: [] });
    },
    async post() {
      posts += 1;
      return response({ orderId: "should-not-be-retried" });
    },
  };
  const result = await reconcileOrder(transport, {
    orderLinkId: "run-1-long",
    category: "linear",
    symbol: "DOGEUSDT",
    sleep: async () => undefined,
    realtimeAttempts: 2,
    historyAttempts: 1,
  });
  assert.equal(result.kind, "unresolved");
  assert.equal(posts, 0);
});

test("reconciliation carries symbol and category into both lookup phases", async () => {
  const queries: Record<string, string>[] = [];
  const transport: ScenarioTransport = {
    async get(_path, query) {
      queries.push(query as Record<string, string>);
      return response({ list: [] });
    },
    async post() {
      throw new Error("not used");
    },
  };
  await reconcileOrder(transport, {
    orderLinkId: "run-1-long",
    category: "linear",
    symbol: "DOGEUSDT",
    exchangeOrderId: "exchange-1",
    sleep: async () => undefined,
    realtimeAttempts: 1,
    historyAttempts: 1,
  });
  assert.deepEqual(queries, [
    { category: "linear", symbol: "DOGEUSDT", orderId: "exchange-1" },
    { category: "linear", symbol: "DOGEUSDT", orderId: "exchange-1" },
  ]);
});

test("entry dispatch persists the exact approved plan before POST and records attached-exit evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "bybit-probe-scenario-"));
  try {
    const store = new ProbeStore({
      rootDir: root,
      clock: () => 1_000,
      processId: 101,
      isProcessAlive: () => false,
    });
    const calls: string[] = [];
    const transport: ScenarioTransport = {
      async get() {
        return response({
          list: [
            {
              orderId: "exchange-1",
              orderLinkId: "run-1-long",
              orderStatus: "New",
              takeProfit: "0.102",
              stopLoss: "0.098",
            },
          ],
        });
      },
      async post(path, body) {
        calls.push(path);
        assert.equal(path, "/v5/order/create");
        assert.equal(body.takeProfit, "0.102");
        assert.equal(body.stopLoss, "0.098");
        const saved = await store.listSavedRuns();
        assert.equal(saved[0]?.intents.length, 1);
        return response({ orderId: "exchange-1", orderLinkId: "run-1-long" });
      },
    };
    const plan = entryPlan();
    const result = await runEntryScenario({
      runId: "run-1",
      attemptId: "attempt-1",
      plan,
      transport,
      store,
      clock: () => 1_000,
      sleep: async () => undefined,
      approve: async () => ({
        kind: "approved",
        plan,
        digest: hashProbePlan(plan),
        approvedAt: 1_000,
        expiresAt: plan.expiresAt,
      }),
      realtimeAttempts: 2,
      historyAttempts: 0,
    });
    assert.equal(calls.length, 1);
    assert.equal(result.acknowledgement, "pending");
    assert.equal(result.attachedExits, "accepted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
