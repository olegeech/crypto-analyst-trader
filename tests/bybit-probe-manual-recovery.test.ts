import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  runCapabilityProbe,
  runManualRecovery as runProbeManualRecovery,
} from "../scripts/bybit-capability-probe.js";
import { runManualRecovery } from "../scripts/bybit-probe/manual-recovery.js";
import {
  buildProbePlan,
  hashProbePlan,
} from "../scripts/bybit-probe/probe-plan.js";
import {
  accountHash,
  MANUAL_RECOVERY_STATUS,
  ProbeStore,
} from "../scripts/bybit-probe/store.js";
import type { BybitResponse } from "../scripts/bybit-probe/transport.js";

function response(result: Record<string, unknown>): BybitResponse {
  return { retCode: 0, retMsg: "OK", result };
}

function plan(environment: "testnet" | "demo" = "testnet") {
  return buildProbePlan({
    environment,
    accountId: "manual-account",
    scenario: "timeout-after-accept",
    expiresAt: 100_000,
    method: "POST",
    endpoint: "/v5/order/create",
    params: {
      category: "linear",
      symbol: "DOGEUSDT",
      side: "Buy",
      orderLinkId: "probe-manual-long",
      price: "0.1",
      qty: "51",
      takeProfit: "0.102",
      stopLoss: "0.098",
      orderType: "Limit",
      timeInForce: "PostOnly",
      reduceOnly: false,
      positionIdx: 0,
    },
  });
}

async function unresolvedRun(
  exchangeOrderId?: string,
  environment: "testnet" | "demo" = "testnet",
) {
  const root = await mkdtemp(join(tmpdir(), "bybit-probe-manual-recovery-"));
  const store = new ProbeStore({
    rootDir: root,
    environment,
    clock: () => 2_000,
    processId: 501,
    isProcessAlive: () => false,
  });
  const savedPlan = plan(environment);
  await store.writeIntent({
    runId: "probe-manual",
    attemptId: "attempt-1",
    scenario: savedPlan.scenario,
    plan: savedPlan,
    planDigest: hashProbePlan(savedPlan),
    approvedAt: 1_000,
    approvalExpiresAt: 100_000,
    createdAt: 1_000,
    orderLinkId: savedPlan.params.orderLinkId,
    exchangeOrderId,
    baselineSignedQty: "0",
  });
  await store.writeVerdict("probe-manual", "UNRESOLVED", {
    runId: "probe-manual",
    lastConfirmedState: "create outcome was ambiguous",
    uncertainty: "the order was not visible after dispatch",
    nextAction: "use the manual recovery flow",
  });
  return { root, store };
}

test("Demo manual recovery is unavailable and remains read-only", async () => {
  const { root, store } = await unresolvedRun(undefined, "demo");
  try {
    const { transport, events } = cleanTransport();
    const result = await runManualRecovery({
      runId: "probe-manual",
      accountId: "manual-account",
      store,
      transport,
      authorize,
    });
    assert.equal(result.status, "PRECONDITION_FAILED");
    assert.match(result.message, /Demo manual recovery is not supported/);
    assert.deepEqual(events, []);
    const saved = await store.listSavedRuns();
    assert.equal(saved[0]?.verdict, "UNRESOLVED");
    assert.equal(saved[0]?.manualRecovery, undefined);

    const cliResult = await runProbeManualRecovery({
      runId: "probe-manual",
      environment: { TRADER_ENV: "demo" },
      commandEnvironment: "demo",
      credentialProvider: {
        load: async () => {
          throw new Error("Demo recovery must not load credentials");
        },
      },
    });
    assert.equal(cliResult.status, "PRECONDITION_FAILED");
    assert.match(cliResult.message, /Demo manual recovery is not supported/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function cleanTransport() {
  const events: string[] = [];
  return {
    events,
    transport: {
      async get(path: string) {
        events.push(path);
        if (path === "/v5/position/list") {
          return response({ list: [{ size: "0", side: "", positionIdx: 0 }] });
        }
        return response({ list: [] });
      },
      async post() {
        throw new Error("manual clean recovery must not write");
      },
    },
  };
}

function authorize(planToApprove: Parameters<typeof hashProbePlan>[0]) {
  return Promise.resolve({
    kind: "approved" as const,
    plan: planToApprove,
    digest: hashProbePlan(planToApprove),
    approvedAt: 2_000,
    expiresAt: planToApprove.expiresAt,
  });
}

test("manual recovery closes clean read-only state without ceremony", async () => {
  const { root, store } = await unresolvedRun();
  try {
    const output: string[] = [];
    const { transport, events } = cleanTransport();
    const result = await runManualRecovery({
      runId: "probe-manual",
      accountId: "manual-account",
      store,
      transport,
      authorize,
      clock: () => 2_000,
      sleep: async () => undefined,
      realtimeAttempts: 1,
      historyAttempts: 1,
      output: { write: (message) => output.push(message) },
    });
    assert.equal(result.status, MANUAL_RECOVERY_STATUS);
    assert.equal(result.originalVerdict, "UNRESOLVED");
    assert.match(output.join(""), /runId: probe-manual/);
    assert.match(output.join(""), /account: /);
    assert.match(output.join(""), /symbol: DOGEUSDT/);
    assert.match(output.join(""), /orderLinkId: probe-manual-long/);
    assert.equal(
      events.filter((path) => path.startsWith("/v5/order/")).length >= 3,
      true,
    );

    const saved = await store.listSavedRuns();
    assert.equal(saved[0]?.verdict, "UNRESOLVED");
    assert.equal(saved[0]?.manualRecovery?.status, MANUAL_RECOVERY_STATUS);
    assert.equal(
      saved[0]?.manualRecovery?.accountIdHash,
      accountHash("manual-account"),
    );
    assert.deepEqual(saved[0]?.manualRecovery?.checks[0], {
      category: "linear",
      symbol: "DOGEUSDT",
      orderLinkId: "probe-manual-long",
      exchangeOrderId: undefined,
      realtimeOrderMatches: 0,
      historyOrderMatches: 0,
      executionMatches: 0,
      openOrderMatches: 0,
      openOrderCount: 0,
      position: "flat",
    });
    await store.assertNoBlockingPriorRuns("new-run", saved);
    const verdict = JSON.parse(
      await readFile(join(root, "probe-manual", "verdict.json"), "utf8"),
    ) as { verdict: string };
    assert.equal(verdict.verdict, "UNRESOLVED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an automatic clean recovery is the only prior-run status that permits the next preflight", async () => {
  const { root, store } = await unresolvedRun();
  try {
    const { transport } = cleanTransport();
    await runManualRecovery({
      runId: "probe-manual",
      accountId: "manual-account",
      store,
      transport,
      authorize,
      clock: () => 2_000,
      sleep: async () => undefined,
      realtimeAttempts: 1,
      historyAttempts: 1,
    });

    const events: string[] = [];
    const preflightTransport = {
      async get(path: string, query?: Record<string, string>) {
        events.push(`${path}:${query?.openOnly ?? ""}`);
        if (path === "/v5/market/instruments-info") {
          return response({
            list: [
              {
                status: "Trading",
                priceFilter: { tickSize: "0.0001" },
                lotSizeFilter: {
                  qtyStep: "1",
                  minOrderQty: "1",
                  minNotionalValue: "5",
                },
              },
            ],
          });
        }
        if (path === "/v5/market/tickers") {
          return response({
            list: [{ bid1Price: "0.1000", ask1Price: "0.1001" }],
          });
        }
        if (path === "/v5/position/list") {
          return response({ list: [{ size: "0", side: "", positionIdx: 0 }] });
        }
        if (path === "/v5/order/realtime" && query?.openOnly === "0") {
          return response({
            list: [
              {
                orderId: "unrelated",
                orderLinkId: "unrelated",
                orderStatus: "New",
              },
            ],
          });
        }
        if (path === "/v5/account/wallet-balance") {
          return response({ list: [{ totalAvailableBalance: "100" }] });
        }
        return response({ list: [] });
      },
      async post() {
        throw new Error("preflight should stop before a write");
      },
    };
    const result = await runCapabilityProbe({
      environment: { TRADER_ENV: "testnet" },
      accountId: "manual-account",
      transport: preflightTransport,
      store,
      runId: "new-run",
      clock: () => 2_000,
      sleep: async () => undefined,
      realtimeAttempts: 1,
      historyAttempts: 0,
      authorize,
      output: { write: () => undefined },
    });
    assert.equal(result.runId, "new-run");
    assert.equal(result.currentRunId, undefined);
    assert.equal(result.verdict, "PRECONDITION_FAILED");
    assert.ok(events.includes("/v5/order/realtime:0"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("owned state uses the normal approved durable recovery path", async () => {
  const { root, store } = await unresolvedRun("entry-1");
  try {
    let active = true;
    const posts: string[] = [];
    const transport = {
      async get(path: string, query?: Record<string, string>) {
        if (path === "/v5/order/realtime") {
          if (query?.openOnly === "0") {
            return response({
              list: active
                ? [
                    {
                      orderId: "entry-1",
                      orderLinkId: "probe-manual-long",
                      orderStatus: "New",
                    },
                  ]
                : [],
            });
          }
          return response({
            list:
              active && query?.orderId === "entry-1"
                ? [
                    {
                      orderId: "entry-1",
                      orderLinkId: "probe-manual-long",
                      orderStatus: "New",
                    },
                  ]
                : [],
          });
        }
        if (path === "/v5/position/list") {
          return response({ list: [{ size: "0", side: "", positionIdx: 0 }] });
        }
        return response({ list: [] });
      },
      async post(path: string) {
        posts.push(path);
        assert.equal(path, "/v5/order/cancel");
        active = false;
        return response({ orderId: "entry-1" });
      },
    };
    const result = await runManualRecovery({
      runId: "probe-manual",
      accountId: "manual-account",
      store,
      transport,
      authorize,
      clock: () => 2_000,
      sleep: async () => undefined,
      realtimeAttempts: 2,
      historyAttempts: 1,
    });
    assert.equal(result.status, "RECOVERED_CLEAN");
    assert.deepEqual(posts, ["/v5/order/cancel"]);
    const saved = await store.listSavedRuns();
    assert.equal(saved[0]?.verdict, "CONFIRMED_CLEAN");
    assert.equal(saved[0]?.manualRecovery, undefined);
    assert.equal(saved[0]?.intents.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
