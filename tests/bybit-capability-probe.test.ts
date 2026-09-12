import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCapabilityProbe } from "../scripts/bybit-capability-probe.js";
import type { ProbeApproval } from "../scripts/bybit-probe/approval.js";
import {
  hashProbePlan,
  type ProbePlan,
} from "../scripts/bybit-probe/probe-plan.js";
import { ProbeStore } from "../scripts/bybit-probe/store.js";
import {
  BybitProbeTransportError,
  type BybitResponse,
} from "../scripts/bybit-probe/transport.js";

function response(result: Record<string, unknown>): BybitResponse {
  return { retCode: 0, retMsg: "OK", result };
}

type ProbeFixtureOptions = {
  readonly pendingOpen?: boolean;
  readonly rejectionCode?: 10014 | 110057;
  readonly invisibleOrders?: boolean;
  readonly lostAcknowledgement?: boolean;
};

function fixtureTransport(options: ProbeFixtureOptions = {}) {
  let createCount = 0;
  let activeOrder:
    | {
        readonly orderId: string;
        readonly orderLinkId: string;
        readonly orderStatus: "New";
        readonly takeProfit: string;
        readonly stopLoss: string;
      }
    | undefined;
  const events: Array<{
    readonly kind: "get" | "post";
    readonly path: string;
    readonly query?: Record<string, string>;
    readonly body?: Record<string, unknown>;
  }> = [];

  const transport = {
    async get(path: string, query?: Record<string, string>) {
      events.push({
        kind: "get",
        path,
        ...(query === undefined ? {} : { query }),
      });
      if (path === "/v5/market/instruments-info") {
        return response({
          list: [
            {
              status: options.pendingOpen ? "PendingOpen" : "Trading",
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
      if (path === "/v5/account/wallet-balance") {
        return response({ list: [{ totalAvailableBalance: "100" }] });
      }
      if (path === "/v5/execution/list") return response({ list: [] });
      if (path === "/v5/order/realtime") {
        if (options.invisibleOrders && query?.openOnly === undefined) {
          return response({ list: [] });
        }
        if (query?.openOnly === "0") {
          return response({
            list: activeOrder === undefined ? [] : [activeOrder],
          });
        }
        if (query?.orderId !== undefined) {
          return response({
            list: activeOrder?.orderId === query.orderId ? [activeOrder] : [],
          });
        }
        return response({
          list: activeOrder === undefined ? [] : [activeOrder],
        });
      }
      if (path === "/v5/order/history") {
        return response({ list: [] });
      }
      throw new Error(`unexpected GET ${path}`);
    },
    async post(path: string, body: Record<string, unknown>) {
      events.push({ kind: "post", path, body });
      if (path === "/v5/order/cancel") {
        activeOrder = undefined;
        return response({ orderId: body.orderId });
      }
      if (path !== "/v5/order/create")
        throw new Error(`unexpected POST ${path}`);
      createCount += 1;
      const rejectionCode = options.rejectionCode ?? 10014;
      if (
        !options.invisibleOrders &&
        (options.rejectionCode === 110057 ||
          (options.rejectionCode === undefined &&
            createCount > 1 &&
            body.orderLinkId === "probe-test-long"))
      ) {
        throw new BybitProbeTransportError(
          "exchange-failure",
          "deterministic Testnet rejection",
          { retCode: rejectionCode },
        );
      }
      const orderId = `exchange-${createCount}`;
      activeOrder = {
        orderId,
        orderLinkId: String(body.orderLinkId),
        orderStatus: "New",
        takeProfit: String(body.takeProfit),
        stopLoss: String(body.stopLoss),
      };
      if (createCount === 1 && options.lostAcknowledgement !== false) {
        throw new Error("request timeout after accept");
      }
      return response({ orderId, orderLinkId: body.orderLinkId });
    },
  };
  return { events, transport };
}

function approved(clock: number): (plan: ProbePlan) => Promise<ProbeApproval> {
  return async (plan: ProbePlan): Promise<ProbeApproval> => ({
    kind: "approved" as const,
    plan,
    digest: hashProbePlan(plan),
    approvedAt: clock,
    expiresAt: plan.expiresAt,
  });
}

async function runFixture(
  options: ProbeFixtureOptions = {},
  approve: (plan: ProbePlan) => Promise<ProbeApproval> = approved(1_000),
) {
  const root = await mkdtemp(join(tmpdir(), "bybit-capability-probe-"));
  const store = new ProbeStore({
    rootDir: root,
    clock: () => 1_000,
    processId: 7_001,
    isProcessAlive: () => false,
  });
  const fixture = fixtureTransport(options);
  const output: string[] = [];
  const result = await runCapabilityProbe({
    environment: { TRADER_ENV: "testnet" },
    accountId: "testnet-account",
    transport: fixture.transport,
    store,
    runId: "probe-test",
    clock: () => 1_000,
    sleep: async () => undefined,
    realtimeAttempts: 2,
    historyAttempts: 0,
    confirmExclusiveUse: async () => true,
    approve,
    output: { write: (message: string) => output.push(message) },
  });
  return { fixture, output: output.join(""), result, root, store };
}

test("orchestrator runs preflight, long, short, lost acknowledgement, duplicate, and cleanup in order", async () => {
  const { fixture, output, result, root } = await runFixture();
  try {
    assert.equal(result.verdict, "CONFIRMED_CLEAN");
    const writes = fixture.events.filter((event) => event.kind === "post");
    assert.deepEqual(
      writes.map((event) => event.path),
      [
        "/v5/order/create",
        "/v5/order/cancel",
        "/v5/order/create",
        "/v5/order/cancel",
        "/v5/order/create",
        "/v5/order/cancel",
        "/v5/order/create",
      ],
    );
    assert.ok(
      writes.some(
        (event) =>
          event.path === "/v5/order/create" &&
          event.body?.orderLinkId === "probe-test-lost-ack",
      ),
    );
    const duplicateIndex = fixture.events.reduce(
      (lastIndex, event, index) =>
        event.kind === "post" &&
        event.path === "/v5/order/create" &&
        event.body?.orderLinkId === "probe-test-long"
          ? index
          : lastIndex,
      -1,
    );
    assert.ok(duplicateIndex > 0);
    assert.ok(
      fixture.events
        .slice(0, duplicateIndex)
        .some(
          (event) =>
            event.kind === "get" &&
            event.path === "/v5/order/realtime" &&
            event.query?.orderLinkId === "probe-test-long",
        ),
    );
    assert.ok(
      fixture.events
        .slice(0, duplicateIndex)
        .some(
          (event) =>
            event.kind === "get" &&
            event.path === "/v5/order/realtime" &&
            event.query?.orderLinkId === "probe-test-lost-ack",
        ),
    );
    const afterDuplicate = fixture.events.slice(duplicateIndex + 1);
    assert.ok(
      afterDuplicate.some(
        (event) =>
          event.kind === "get" &&
          event.path === "/v5/order/realtime" &&
          event.query?.openOnly === "0",
      ),
    );
    assert.ok(
      !afterDuplicate.some(
        (event) =>
          event.kind === "get" &&
          event.path === "/v5/order/realtime" &&
          event.query?.orderLinkId === "probe-test-long",
      ),
    );
    assert.match(output, /duplicate-client-order-id/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("orchestrator stops before writes when preflight is refused or invalid", async () => {
  const refused = await runFixture({}, async () => ({
    kind: "refused" as const,
    reason: "empty-input" as const,
    message: "operator refused",
  }));
  try {
    assert.equal(refused.result.verdict, "REFUSED");
    assert.equal(
      refused.fixture.events.filter((event) => event.kind === "post").length,
      0,
    );
  } finally {
    await rm(refused.root, { recursive: true, force: true });
  }

  const failed = await runFixture({ pendingOpen: true });
  try {
    assert.equal(failed.result.verdict, "PRECONDITION_FAILED");
    assert.equal(
      failed.fixture.events.filter((event) => event.kind === "post").length,
      0,
    );
  } finally {
    await rm(failed.root, { recursive: true, force: true });
  }
});

test("orchestrator preserves unresolved and contradiction verdicts without retrying writes", async () => {
  const unresolved = await runFixture({ invisibleOrders: true });
  try {
    assert.equal(unresolved.result.verdict, "UNRESOLVED");
    assert.equal(
      unresolved.fixture.events.filter(
        (event) => event.kind === "post" && event.path === "/v5/order/create",
      ).length,
      1,
    );
  } finally {
    await rm(unresolved.root, { recursive: true, force: true });
  }

  const contradiction = await runFixture({ rejectionCode: 110057 });
  try {
    assert.equal(contradiction.result.verdict, "CONTRADICTION");
    assert.equal(
      contradiction.fixture.events.filter((event) => event.kind === "post")
        .length,
      1,
    );
  } finally {
    await rm(contradiction.root, { recursive: true, force: true });
  }
});
