import assert from "node:assert/strict";
import test from "node:test";

import { ReadOnlyOperatorStatusExchange } from "../src/application/mainnet-operator-test-status-composition.js";
import {
  createMainnetGetCounts,
  mainnetGetCountsStatus,
} from "../src/application/mainnet-composition-helpers.js";
import type { OperatorMainnetTestPlan } from "../src/domain/execution/operator-mainnet-test-plan.js";
import type { ExchangeCredentials } from "../src/ports/credential-provider.js";

const observedAt = Date.parse("2026-10-30T12:00:00.000Z");
const credentials: Readonly<ExchangeCredentials> = {
  apiKey: "synthetic-key",
  apiSecret: "synthetic-secret",
  accountId: "synthetic-account",
};
const plan = {
  symbol: "DOGEUSDT",
  clientOrderId: "synthetic-client-order",
} as OperatorMainnetTestPlan;

function groupForPath(path: string): string {
  const groups: Readonly<Record<string, string>> = {
    "/v5/market/time": "time",
    "/v5/user/query-api": "identity",
    "/v5/position/list": "positions",
    "/v5/order/realtime": "open-orders",
    "/v5/order/history": "order-history",
    "/v5/execution/list": "executions",
  };
  return groups[path] ?? "other";
}

test("status identity, nested pages, and rejected GET retries reconcile to physical fetch attempts", async () => {
  const counts = createMainnetGetCounts();
  const attempts: Array<{
    readonly path: string;
    readonly cursorPage: boolean;
    readonly retry: boolean;
    outcome: "ok" | "rejected";
  }> = [];
  let parentHistoryPaged = false;
  let executionAttempts = 0;
  const request: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    assert.equal(method, "GET");
    counts.record(input, init);
    const attempt: (typeof attempts)[number] = {
      path: url.pathname,
      cursorPage: url.searchParams.has("cursor"),
      retry: url.pathname === "/v5/execution/list" && executionAttempts > 0,
      outcome: "ok" as const,
    };
    attempts.push(attempt);
    if (url.pathname === "/v5/execution/list" && ++executionAttempts === 1) {
      attempt.outcome = "rejected";
      throw new Error("synthetic private transport failure");
    }

    let result: Record<string, unknown>;
    if (url.pathname === "/v5/market/time") {
      result = {
        timeSecond: String(observedAt / 1000),
        timeNano: String(BigInt(observedAt) * 1_000_000n),
      };
    } else if (url.pathname === "/v5/user/query-api") {
      result = { userID: "123", readOnly: 1, permissions: {} };
    } else if (url.pathname === "/v5/order/history") {
      const hasIdentityFilter =
        url.searchParams.get("orderLinkId") === plan.clientOrderId;
      const hasCursor = url.searchParams.has("cursor");
      const nextPageCursor =
        hasIdentityFilter && !hasCursor && !parentHistoryPaged
          ? ((parentHistoryPaged = true), "synthetic-private-cursor")
          : "";
      result = {
        category: "linear",
        list: [],
        nextPageCursor,
      };
    } else if (
      url.pathname === "/v5/order/realtime" ||
      url.pathname === "/v5/execution/list"
    ) {
      result = { category: "linear", list: [], nextPageCursor: "" };
    } else if (url.pathname === "/v5/position/list") {
      result = {
        category: "linear",
        list: [
          {
            symbol: plan.symbol,
            positionIdx: 0,
            side: "",
            size: "0",
            leverage: "1",
          },
        ],
      };
    } else {
      throw new Error(`unmatched synthetic fetch path: ${url.pathname}`);
    }

    return new Response(
      JSON.stringify({
        retCode: 0,
        retMsg: "OK",
        time: observedAt,
        result,
      }),
      { status: 200 },
    );
  };

  // The identity stage uses the same physical request boundary as the nested exchange.
  const stageStarted = performance.now();
  await request("https://api.bybit.com/v5/market/time", { method: "GET" });
  await request("https://api.bybit.com/v5/user/query-api", { method: "GET" });
  const identityReads = attempts.length;
  const exchange = new ReadOnlyOperatorStatusExchange(
    credentials,
    () => 100,
    () => observedAt,
    request,
    60_100,
    identityReads,
  );
  const observed = await exchange.observe(plan);
  const stageElapsedMs = performance.now() - stageStarted;

  assert.equal(observed.ok, true, JSON.stringify({ observed, attempts }));
  if (!observed.ok) return;
  const oracle: Record<string, number> = {};
  for (const attempt of attempts) {
    const group = groupForPath(attempt.path);
    oracle[group] = (oracle[group] ?? 0) + 1;
  }
  const grouped = Object.fromEntries(
    Object.entries(oracle).sort(([left], [right]) => left.localeCompare(right)),
  );
  assert.equal(observed.value.exchangeReads, attempts.length);
  assert.deepEqual(JSON.parse(counts.summary()), grouped);
  assert.equal(
    mainnetGetCountsStatus(counts.summary(), observed.value.exchangeReads),
    "available",
  );
  assert.equal(
    attempts.filter((attempt) => attempt.path === "/v5/execution/list").length,
    2,
  );
  assert.equal(attempts.filter((attempt) => attempt.retry).length, 1);
  assert.equal(attempts.filter((attempt) => attempt.cursorPage).length, 1);
  assert.equal(grouped.other ?? 0, 0);
  assert.equal(
    Object.values(grouped).reduce((sum, count) => sum + count, 0),
    attempts.length,
  );
  assert.doesNotMatch(
    counts.summary(),
    /synthetic-private-cursor|synthetic-account/u,
  );
  console.log(
    `U2_STATUS_PROFILE ${JSON.stringify({
      baselineSha: "f107f0fc4b5ef5f0af9874fea68e754ac1fa0b20",
      fixture:
        "synthetic-empty-status-reads-with-bounded-retry-and-one-history-cursor-page",
      stage: "status",
      stageTimingModel:
        "observed local duration with immediate stub responses; not provider latency",
      stageElapsedMs,
      physicalGetAttempts: observed.value.exchangeReads,
      groups: { ...grouped, other: grouped.other ?? 0 },
      independentAttemptLogEntries: attempts.length,
      retryAttempts: attempts.filter((attempt) => attempt.retry).length,
      cursorPages: attempts.filter((attempt) => attempt.cursorPage).length,
      exchangeWrites: 0,
      evidencePath: "none",
      fallbackPredicate: null,
    })}`,
  );
});
