import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  runCapabilityProbe,
  type CapabilityProbeOptions,
} from "../scripts/bybit-capability-probe.js";
import { hashProbePlan } from "../scripts/bybit-probe/probe-plan.js";
import { ProbeStore } from "../scripts/bybit-probe/store.js";
import {
  BybitProbeTransportError,
  type BybitResponse,
} from "../scripts/bybit-probe/transport.js";
import type { ScenarioTransport } from "../scripts/bybit-probe/scenarios.js";

function response(result: Record<string, unknown>): BybitResponse {
  return { retCode: 0, retMsg: "OK", result };
}

interface OpenOrder {
  readonly orderId: string;
  readonly orderLinkId: string;
  readonly side: "Buy" | "Sell";
  readonly takeProfit: string;
  readonly stopLoss: string;
  readonly orderStatus: "New";
}

class ProbeFixtureTransport implements ScenarioTransport {
  readonly postCalls: Array<{ path: string; body: Record<string, unknown> }> =
    [];
  private readonly orders = new Map<string, OpenOrder>();
  private nextOrderId = 1;

  async get(
    path: string,
    query: Record<string, string> = {},
  ): Promise<BybitResponse> {
    if (path === "/v5/market/instruments-info") {
      return response({
        list: [
          {
            status: "Trading",
            priceFilter: { tickSize: "0.001" },
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
      return response({ list: [{ bid1Price: "0.100", ask1Price: "0.101" }] });
    }
    if (path === "/v5/position/list") {
      return response({ list: [{ size: "0", side: "", positionIdx: 0 }] });
    }
    if (path === "/v5/account/wallet-balance") {
      return response({ list: [{ totalAvailableBalance: "100" }] });
    }
    if (
      path === "/v5/order/realtime" ||
      path === "/v5/order/history"
    ) {
      const candidates = [...this.orders.values()].filter((order) =>
        query.orderId !== undefined
          ? order.orderId === query.orderId
          : query.orderLinkId !== undefined
            ? order.orderLinkId === query.orderLinkId
            : true,
      );
      return response({ list: candidates });
    }
    if (path === "/v5/execution/list") return response({ list: [] });
    throw new Error(`unexpected read path: ${path}`);
  }

  async post(
    path: string,
    body: Record<string, unknown>,
  ): Promise<BybitResponse> {
    this.postCalls.push({ path, body });
    if (path === "/v5/order/create") {
      const orderLinkId = String(body.orderLinkId);
      if ([...this.orders.values()].some((order) => order.orderLinkId === orderLinkId)) {
        throw new BybitProbeTransportError(
          "exchange-failure",
          "duplicate client order ID",
          { retCode: 10014 },
        );
      }
      const orderId = `exchange-${this.nextOrderId++}`;
      const order: OpenOrder = {
        orderId,
        orderLinkId,
        side: body.side as "Buy" | "Sell",
        takeProfit: String(body.takeProfit),
        stopLoss: String(body.stopLoss),
        orderStatus: "New",
      };
      this.orders.set(orderId, order);
      return response({ orderId, orderLinkId });
    }
    if (path === "/v5/order/cancel") {
      this.orders.delete(String(body.orderId));
      return response({ orderId: body.orderId });
    }
    throw new Error(`unexpected write path: ${path}`);
  }
}

async function fixtureOptions(
  root: string,
  transport: ProbeFixtureTransport,
  approve: NonNullable<CapabilityProbeOptions["approve"]>,
): Promise<CapabilityProbeOptions> {
  return {
    environment: { TRADER_ENV: "testnet" },
    accountId: "testnet-account",
    transport,
    store: new ProbeStore({
      rootDir: root,
      clock: () => 1_000,
      processId: 4_201,
      isProcessAlive: () => false,
    }),
    clock: () => 1_000,
    sleep: async () => undefined,
    approve,
    confirmExclusiveUse: () => true,
    runId: "probe-orchestration",
    realtimeAttempts: 2,
    historyAttempts: 0,
    output: { write: () => undefined },
  };
}

test("orchestrator runs long, short and post-cleanup ID reuse without overlap", async () => {
  const root = await mkdtemp(join(tmpdir(), "bybit-probe-orchestrator-"));
  try {
    const transport = new ProbeFixtureTransport();
    const approvals: string[] = [];
    const result = await runCapabilityProbe(
      await fixtureOptions(root, transport, async (plan) => {
        approvals.push(plan.scenario);
        return {
          kind: "approved",
          plan,
          digest: hashProbePlan(plan),
          approvedAt: 1_000,
          expiresAt: plan.expiresAt,
        };
      }),
    );

    assert.equal(result.verdict, "CONFIRMED_CLEAN");
    assert.deepEqual(approvals, [
      "long-entry",
      "cleanup-cancel-entry",
      "short-entry",
      "cleanup-cancel-entry",
      "duplicate-client-order-id",
    ]);
    assert.deepEqual(
      transport.postCalls.map(({ path }) => path),
      [
        "/v5/order/create",
        "/v5/order/cancel",
        "/v5/order/create",
        "/v5/order/cancel",
        "/v5/order/create",
      ],
    );
    const runs = await (
      await fixtureOptions(root, transport, async () => {
        throw new Error("not used");
      })
    ).store!.listSavedRuns();
    assert.equal(runs[0]?.verdict, "CONFIRMED_CLEAN");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("orchestrator refusal stops before the first exchange write", async () => {
  const root = await mkdtemp(join(tmpdir(), "bybit-probe-orchestrator-"));
  try {
    const transport = new ProbeFixtureTransport();
    const result = await runCapabilityProbe(
      await fixtureOptions(root, transport, async () => ({
        kind: "refused",
        reason: "empty-input",
        message: "operator refused the exact plan",
      })),
    );

    assert.equal(result.verdict, "REFUSED");
    assert.equal(transport.postCalls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
