import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  recoverInterruptedRun,
  type RecoveryTransport,
} from "../scripts/bybit-probe/recovery.js";
import {
  buildProbePlan,
  hashProbePlan,
} from "../scripts/bybit-probe/probe-plan.js";
import { ProbeStore } from "../scripts/bybit-probe/store.js";
import type { BybitResponse } from "../scripts/bybit-probe/transport.js";

function response(result: Record<string, unknown>): BybitResponse {
  return { retCode: 0, retMsg: "OK", result };
}

function fixturePlan() {
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
      qty: "3",
      takeProfit: "0.102",
      stopLoss: "0.098",
      positionIdx: 0,
    },
  });
}

test("interrupted dispatch is reconciled under the original run before a clean verdict", async () => {
  const root = await mkdtemp(join(tmpdir(), "bybit-probe-recovery-"));
  try {
    const store = new ProbeStore({
      rootDir: root,
      clock: () => 1_000,
      processId: 301,
      isProcessAlive: () => false,
    });
    const plan = fixturePlan();
    await store.writeIntent({
      runId: "run-1",
      attemptId: "attempt-1",
      scenario: plan.scenario,
      plan,
      planDigest: hashProbePlan(plan),
      approvedAt: 1_000,
      approvalExpiresAt: 100_000,
      createdAt: 1_000,
      orderLinkId: plan.params.orderLinkId,
      exchangeOrderId: "entry-1",
      baselineSignedQty: "0",
    });
    let realtimeCalls = 0;
    let writes = 0;
    const transport: RecoveryTransport = {
      async get(path) {
        if (path === "/v5/order/realtime") {
          realtimeCalls += 1;
          return response({
            list:
              realtimeCalls <= 3
                ? [
                    {
                      orderId: "entry-1",
                      orderLinkId: "run-1-long",
                      orderStatus: "New",
                    },
                  ]
                : [],
          });
        }
        if (path === "/v5/position/list")
          return response({ list: [{ size: "0", side: "", positionIdx: 0 }] });
        return response({ list: [] });
      },
      async post(path) {
        writes += 1;
        assert.equal(path, "/v5/order/cancel");
        return response({ orderId: "entry-1" });
      },
    };
    const result = await recoverInterruptedRun({
      runId: "run-1",
      accountId: "trading-account",
      store,
      transport,
      clock: () => 1_000,
      sleep: async () => undefined,
      authorize: async (approvedPlan) => ({
        kind: "approved",
        plan: approvedPlan,
        digest: hashProbePlan(approvedPlan),
        approvedAt: 1_000,
        expiresAt: approvedPlan.expiresAt,
      }),
      realtimeAttempts: 2,
      historyAttempts: 0,
    });
    assert.equal(result.verdict, "CONFIRMED_CLEAN");
    assert.equal(writes, 1);
    assert.match(result.message, /original run/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovery refuses account mismatch and never writes unknown ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "bybit-probe-recovery-"));
  try {
    const store = new ProbeStore({
      rootDir: root,
      clock: () => 1_000,
      processId: 302,
      isProcessAlive: () => false,
    });
    const plan = fixturePlan();
    await store.writeIntent({
      runId: "run-1",
      attemptId: "attempt-1",
      scenario: plan.scenario,
      plan,
      planDigest: hashProbePlan(plan),
      approvedAt: 1_000,
      approvalExpiresAt: 100_000,
      createdAt: 1_000,
      orderLinkId: plan.params.orderLinkId,
      exchangeOrderId: "entry-1",
      baselineSignedQty: "0",
    });
    let writes = 0;
    const transport: RecoveryTransport = {
      async get() {
        return response({
          list: [
            {
              orderId: "entry-1",
              orderLinkId: "run-1-long",
              orderStatus: "New",
            },
          ],
        });
      },
      async post() {
        writes += 1;
        return response({});
      },
    };
    const result = await recoverInterruptedRun({
      runId: "run-1",
      accountId: "different-account",
      store,
      transport,
      authorize: async () => {
        throw new Error("must not authorize");
      },
      realtimeAttempts: 1,
      historyAttempts: 0,
    });
    assert.equal(result.verdict, "UNRESOLVED");
    assert.equal(writes, 0);
    assert.match(result.message, /account/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovery refuses a persisted intent whose plan digest was tampered", async () => {
  const root = await mkdtemp(join(tmpdir(), "bybit-probe-recovery-"));
  try {
    const store = new ProbeStore({
      rootDir: root,
      clock: () => 1_000,
      processId: 303,
      isProcessAlive: () => false,
    });
    const plan = fixturePlan();
    const record = await store.writeIntent({
      runId: "run-1",
      attemptId: "attempt-1",
      scenario: plan.scenario,
      plan,
      planDigest: hashProbePlan(plan),
      approvedAt: 1_000,
      approvalExpiresAt: 100_000,
      createdAt: 1_000,
      orderLinkId: plan.params.orderLinkId,
      exchangeOrderId: "entry-1",
      baselineSignedQty: "0",
    });
    const persisted = JSON.parse(await readFile(record.path, "utf8")) as {
      plan: { params: { qty: string } };
    };
    persisted.plan.params.qty = "4";
    await writeFile(record.path, `${JSON.stringify(persisted)}\n`, "utf8");
    let reads = 0;
    const transport: RecoveryTransport = {
      async get() {
        reads += 1;
        return response({ list: [] });
      },
      async post() {
        throw new Error("must not write");
      },
    };
    const result = await recoverInterruptedRun({
      runId: "run-1",
      accountId: "trading-account",
      store,
      transport,
      authorize: async () => {
        throw new Error("must not authorize");
      },
    });
    assert.equal(result.verdict, "UNRESOLVED");
    assert.match(result.message, /digest/);
    assert.equal(reads, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
