import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCapabilityProbe } from "../scripts/bybit-capability-probe.js";
import type { ProbeApproval } from "../scripts/bybit-probe/approval.js";
import {
  buildProbePlan,
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
  readonly recoveryOrder?: boolean;
  readonly rejectionCode?: 10014 | 10024 | 110057 | 12345;
  readonly invisibleOrders?: boolean;
  readonly lostAcknowledgement?: boolean;
  readonly acceptDuplicate?: boolean;
  readonly throwAfterWrite?: boolean;
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
    | undefined = options.recoveryOrder
    ? {
        orderId: "prior-order",
        orderLinkId: "prior-run-long",
        orderStatus: "New",
        takeProfit: "0.102",
        stopLoss: "0.098",
      }
    : undefined;
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
      if (
        options.throwAfterWrite &&
        createCount > 0 &&
        path === "/v5/order/realtime" &&
        query?.orderLinkId !== undefined
      ) {
        throw new Error("post-write reconciliation read failed");
      }
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
        (options.rejectionCode !== undefined ||
          (options.rejectionCode === undefined &&
            !options.acceptDuplicate &&
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
  authorize: (plan: ProbePlan) => Promise<ProbeApproval> = approved(1_000),
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
    authorize,
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

test("orchestrator records an accepted duplicate client-order-ID outcome", async () => {
  const { output, result, root } = await runFixture({ acceptDuplicate: true });
  try {
    assert.equal(result.verdict, "CONFIRMED_CLEAN");
    assert.match(output, /duplicate client-order-ID outcome: accepted/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("orchestrator stops before writes when preflight is refused or invalid", async () => {
  const refused = await runFixture({}, async () => ({
    kind: "refused" as const,
    reason: "expired" as const,
    message: "probe plan authorization expired",
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
    const findings = JSON.parse(
      await readFile(
        join(unresolved.root, "probe-test", "findings.json"),
        "utf8",
      ),
    ) as { verdict: string; content: string };
    assert.equal(findings.verdict, "UNRESOLVED");
    assert.match(findings.content, /long-entry/);
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

test("a post-write reconciliation failure becomes an unresolved handoff", async () => {
  const { result, output, root, store } = await runFixture({
    throwAfterWrite: true,
  });
  try {
    assert.equal(result.verdict, "UNRESOLVED");
    assert.match(output, /verdict: UNRESOLVED/);
    const saved = await store.listSavedRuns();
    assert.equal(
      saved.find((run) => run.runId === "probe-test")?.verdict,
      "UNRESOLVED",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unknown dispatch retCodes are persisted as sanitized diagnostics", async () => {
  const { result, output, root } = await runFixture({ rejectionCode: 12345 });
  try {
    assert.equal(result.verdict, "UNRESOLVED");
    assert.match(
      output,
      /dispatch error: exchange-rejection; transport kind: exchange-failure; retCode: 12345/,
    );
    const findings = JSON.parse(
      await readFile(join(root, "probe-test", "findings.json"), "utf8"),
    ) as { content: string };
    assert.match(findings.content, /retCode: 12345/);
    assert.doesNotMatch(findings.content, /deterministic Testnet rejection/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit 10024 rejection remains visible with its actionable cause", async () => {
  const { result, output, root } = await runFixture({ rejectionCode: 10024 });
  try {
    assert.equal(result.verdict, "CONFIRMED_CLEAN");
    assert.match(output, /retCode: 10024/);
    assert.match(output, /compliance rules/i);
    assert.doesNotMatch(output, /order was not visible; not-found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unresolved verdict and recovery handoff survive findings persistence failure", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "bybit-capability-probe-findings-failure-"),
  );
  try {
    const store = new (class extends ProbeStore {
      override async writeFindings(): Promise<never> {
        throw new Error("findings persistence failed");
      }
    })({
      rootDir: root,
      clock: () => 1_000,
      processId: 7_004,
      isProcessAlive: () => false,
    });
    const fixture = fixtureTransport({ throwAfterWrite: true });
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
      authorize: approved(1_000),
      output: { write: () => undefined },
    });

    assert.equal(result.verdict, "UNRESOLVED");
    const savedVerdict = JSON.parse(
      await readFile(join(root, "probe-test", "verdict.json"), "utf8"),
    ) as {
      verdict: string;
      recoveryHandoff?: {
        runId: string;
        lastConfirmedState: string;
        uncertainty: string;
        nextAction: string;
        reference: string;
      };
    };
    assert.equal(savedVerdict.verdict, "UNRESOLVED");
    assert.deepEqual(savedVerdict.recoveryHandoff, {
      runId: "probe-test",
      lastConfirmedState: "post-write reconciliation read failed",
      uncertainty: "post-write reconciliation read failed",
      nextAction:
        "Reconcile this saved run with the manual fallback in SECURITY.md before any new write.",
      reference: "SECURITY.md",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed recovery preserves the prior run ID and reports the current run separately", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "bybit-capability-probe-recovery-"),
  );
  try {
    const store = new ProbeStore({
      rootDir: root,
      clock: () => 1_000,
      processId: 7_002,
      isProcessAlive: () => false,
    });
    const priorPlan = buildProbePlan({
      environment: "testnet",
      accountId: "prior-account",
      scenario: "long-entry",
      expiresAt: 100_000,
      method: "POST",
      endpoint: "/v5/order/create",
      params: {
        category: "linear",
        symbol: "DOGEUSDT",
        side: "Buy",
        orderLinkId: "prior-run-long",
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
    await store.writeIntent({
      runId: "prior-run",
      attemptId: "attempt-1",
      scenario: priorPlan.scenario,
      plan: priorPlan,
      planDigest: hashProbePlan(priorPlan),
      approvedAt: 1_000,
      approvalExpiresAt: 100_000,
      createdAt: 1_000,
      orderLinkId: priorPlan.params.orderLinkId,
      exchangeOrderId: "prior-order",
      baselineSignedQty: "0",
    });
    const fixture = fixtureTransport();
    const output: string[] = [];
    const result = await runCapabilityProbe({
      environment: { TRADER_ENV: "testnet" },
      accountId: "testnet-account",
      transport: fixture.transport,
      store,
      runId: "current-run",
      clock: () => 1_000,
      sleep: async () => undefined,
      authorize: approved(1_000),
      output: { write: (message: string) => output.push(message) },
    });
    assert.equal(result.verdict, "UNRESOLVED");
    assert.equal(result.runId, "prior-run");
    assert.equal(result.currentRunId, "current-run");
    assert.match(output.join(""), /next action: reconcile the saved run/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovery writes do not make a current preflight failure unresolved", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "bybit-capability-probe-recovery-preflight-"),
  );
  try {
    const store = new ProbeStore({
      rootDir: root,
      clock: () => 1_000,
      processId: 7_003,
      isProcessAlive: () => false,
    });
    const priorPlan = buildProbePlan({
      environment: "testnet",
      accountId: "testnet-account",
      scenario: "long-entry",
      expiresAt: 100_000,
      method: "POST",
      endpoint: "/v5/order/create",
      params: {
        category: "linear",
        symbol: "DOGEUSDT",
        side: "Buy",
        orderLinkId: "prior-run-long",
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
    await store.writeIntent({
      runId: "prior-run",
      attemptId: "attempt-1",
      scenario: priorPlan.scenario,
      plan: priorPlan,
      planDigest: hashProbePlan(priorPlan),
      approvedAt: 1_000,
      approvalExpiresAt: 100_000,
      createdAt: 1_000,
      orderLinkId: priorPlan.params.orderLinkId,
      exchangeOrderId: "prior-order",
      baselineSignedQty: "0",
    });
    const fixture = fixtureTransport({
      pendingOpen: true,
      recoveryOrder: true,
    });
    const result = await runCapabilityProbe({
      environment: { TRADER_ENV: "testnet" },
      accountId: "testnet-account",
      transport: fixture.transport,
      store,
      runId: "current-run",
      clock: () => 1_000,
      sleep: async () => undefined,
      realtimeAttempts: 2,
      historyAttempts: 0,
      authorize: approved(1_000),
      output: { write: () => undefined },
    });
    assert.equal(result.verdict, "PRECONDITION_FAILED");
    assert.equal(result.runId, "current-run");
    assert.deepEqual(
      fixture.events
        .filter((event) => event.kind === "post")
        .map((event) => event.path),
      ["/v5/order/cancel"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
