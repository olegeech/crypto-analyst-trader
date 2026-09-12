import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  deriveOwnedExposure,
  cleanupOwnedEntry,
  flattenOwnedExposure,
  isOwnedEntry,
  type CleanupTransport,
  type OwnedExecution,
  type OwnershipState,
} from "../scripts/bybit-probe/cleanup.js";
import { buildProbePlan, hashProbePlan } from "../scripts/bybit-probe/probe-plan.js";
import { ProbeStore } from "../scripts/bybit-probe/store.js";
import type { BybitResponse } from "../scripts/bybit-probe/transport.js";

function response(result: Record<string, unknown>): BybitResponse {
  return { retCode: 0, retMsg: "OK", result };
}

function storeFixture() {
  return mkdtemp(join(tmpdir(), "bybit-probe-cleanup-")).then((root) => ({
    root,
    store: new ProbeStore({ rootDir: root, clock: () => 1_000, processId: 201, isProcessAlive: () => false }),
  }));
}

test("ownership requires the current run prefix and exact entry identity", () => {
  const context = {
    runId: "run-1",
    entryOrderIds: new Set(["entry-1"]),
    protectiveExitOrderIds: new Set(["exit-1"]),
  };
  assert.equal(isOwnedEntry({ orderId: "entry-1", orderLinkId: "run-1-long" }, context), true);
  assert.equal(isOwnedEntry({ orderId: "entry-2", orderLinkId: "run-1-long" }, context), false);
  assert.equal(isOwnedEntry({ orderId: "entry-1", orderLinkId: "run-2-long" }, context), false);
  assert.equal(isOwnedEntry({ orderId: "exit-1", orderLinkId: "run-1-long" }, context), false);
});

test("net exposure is proven by baseline plus owned executions, not size similarity", () => {
  const entries: OwnedExecution[] = [
    { executionId: "exec-entry", orderId: "entry-1", orderLinkId: "run-1-long", side: "Buy", qty: "5" },
    { executionId: "exec-exit", orderId: "exit-1", orderLinkId: "run-1-long", side: "Sell", qty: "2" },
  ];
  const result = deriveOwnedExposure({ baselineSignedQty: "0", currentSignedQty: "3", executions: entries });
  assert.equal(result.kind, "owned");
  if (result.kind === "owned") {
    assert.equal(result.remainingSignedQty, "3");
    assert.equal(result.flattenSide, "Sell");
    assert.equal(result.flattenQty, "3");
  }
  assert.equal(deriveOwnedExposure({ baselineSignedQty: "0", currentSignedQty: "4", executions: entries }).kind, "unresolved");
});

test("cleanup cancels only a proven-owned resting entry and proves clean state", async () => {
  const { root, store } = await storeFixture();
  try {
    const calls: string[] = [];
    let stateReads = 0;
    const transport: CleanupTransport = {
      async get(path) {
        calls.push(`GET ${path}`);
        if (path === "/v5/order/realtime") return response({ list: stateReads++ === 0 ? [] : [] });
        if (path === "/v5/position/list") return response({ list: [{ size: "0", side: "", positionIdx: 0 }] });
        return response({ list: [] });
      },
      async post(path, body) {
        calls.push(`POST ${path}`);
        assert.equal(body.orderId, "entry-1");
        return response({ orderId: "entry-1" });
      },
    };
    const result = await cleanupOwnedEntry({
      runId: "run-1",
      attemptId: "cancel-1",
      accountId: "trading-account",
      category: "linear",
      symbol: "DOGEUSDT",
      order: { orderId: "entry-1", orderLinkId: "run-1-long", side: "Buy", orderStatus: "New" },
      entryOrderIds: new Set(["entry-1"]),
      protectiveExitOrderIds: new Set(["exit-1"]),
      store,
      transport,
      clock: () => 1_000,
      approve: async (plan) => ({ kind: "approved", plan, digest: hashProbePlan(plan), approvedAt: 1_000, expiresAt: plan.expiresAt }),
      readOwnership: async () => true,
      sleep: async () => undefined,
    });
    assert.equal(result.kind, "confirmed-clean");
    assert.deepEqual(calls.filter((call) => call.startsWith("POST")), ["POST /v5/order/cancel"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("protective exits and foreign runs are never routine-cancelled", async () => {
  const { root, store } = await storeFixture();
  try {
    const transport: CleanupTransport = {
      async get() { return response({ list: [] }); },
      async post() { throw new Error("must not write"); },
    };
    for (const order of [
      { orderId: "exit-1", orderLinkId: "run-1-long", side: "Sell" as const, orderStatus: "New" },
      { orderId: "entry-2", orderLinkId: "run-2-long", side: "Buy" as const, orderStatus: "New" },
    ]) {
      const result = await cleanupOwnedEntry({
        runId: "run-1",
        attemptId: "cancel-1",
        accountId: "trading-account",
        category: "linear",
        symbol: "DOGEUSDT",
        order,
        entryOrderIds: new Set(["entry-1", "entry-2", "exit-1"]),
        protectiveExitOrderIds: new Set(["exit-1"]),
        store,
        transport,
        clock: () => 1_000,
        approve: async () => { throw new Error("must not approve"); },
      });
      assert.equal(result.kind, "unresolved");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("flatten uses a fresh approved reduce-only order and no attached exits", async () => {
  const { root, store } = await storeFixture();
  try {
    let posts = 0;
    const transport: CleanupTransport = {
      async get(path) {
        if (path === "/v5/order/realtime") return response({ list: [] });
        return response({ list: [{ size: "0", side: "", positionIdx: 0 }] });
      },
      async post(path, body) {
        posts += 1;
        assert.equal(path, "/v5/order/create");
        assert.equal(body.reduceOnly, true);
        assert.equal(body.qty, "3");
        assert.equal(body.takeProfit, undefined);
        assert.equal(body.stopLoss, undefined);
        return response({ orderId: "flatten-1" });
      },
    };
    const state: OwnershipState = { currentSignedQty: "3", ownedOrderIds: ["entry-1"], protectiveExitOrderIds: [] };
    const result = await flattenOwnedExposure({
      runId: "run-1",
      attemptId: "flatten-1",
      accountId: "trading-account",
      category: "linear",
      symbol: "DOGEUSDT",
      baselineSignedQty: "0",
      currentState: state,
      executions: [{ executionId: "exec-entry", orderId: "entry-1", orderLinkId: "run-1-long", side: "Buy", qty: "3" }],
      store,
      transport,
      clock: () => 1_000,
      approve: async (plan) => ({ kind: "approved", plan, digest: hashProbePlan(plan), approvedAt: 1_000, expiresAt: plan.expiresAt }),
      readOwnership: async () => state,
      sleep: async () => undefined,
    });
    assert.equal(result.kind, "confirmed-clean");
    assert.equal(posts, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
