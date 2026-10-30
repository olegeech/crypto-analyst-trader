import assert from "node:assert/strict";
import test from "node:test";
import {
  createMainnetGetCounts,
  safeMainnetGetCounts,
  withExchangeCounts,
} from "../src/application/mainnet-composition-helpers.js";
import { domainError } from "../src/domain/shared/errors.js";
import { fail } from "../src/domain/shared/result.js";

test("GET counts include repeated attempts, exclude writes, and retain no request secrets", () => {
  const counts = createMainnetGetCounts();
  counts.record(
    "https://api.bybit.com/v5/account/wallet-balance?accountId=private",
    { method: "GET", headers: { authorization: "secret" } },
  );
  counts.record(
    new Request("https://api.bybit.com/v5/account/wallet-balance?coin=USDT"),
  );
  counts.record("https://api.bybit.com/v5/order/create", { method: "POST" });
  counts.record("https://api.bybit.com/private-account-id");
  assert.deepEqual(JSON.parse(counts.summary()), { other: 1, wallet: 2 });
  assert.doesNotMatch(counts.summary(), /private|secret|accountId|USDT/u);
  const failure = withExchangeCounts(
    fail(domainError("INVALID_EVIDENCE", "blocked")),
    3,
    0,
    counts.summary(),
  );
  assert.equal(failure.ok, false);
  if (!failure.ok)
    assert.equal(failure.error.details?.exchangeGetCounts, counts.summary());
});

test("physical fetch attempts independently reconcile retries, pages, rejection, and writes", async () => {
  const counts = createMainnetGetCounts();
  const attempts: { readonly path: string; readonly method: string }[] = [];
  let feeAttempts = 0;
  const request = async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    counts.record(url, init);
    attempts.push({ path: new URL(url).pathname, method });
    if (url.includes("/v5/account/fee-rate") && ++feeAttempts === 1)
      throw new Error("private response text");
    return new Response("{}", { status: 200 });
  };

  await assert.rejects(() =>
    request("https://api.bybit.com/v5/account/fee-rate?secret=value"),
  );
  await request("https://api.bybit.com/v5/account/fee-rate?secret=value");
  await request("https://api.bybit.com/v5/order/history?cursor=private");
  await request("https://api.bybit.com/v5/order/history?cursor=next-private");
  await request("https://api.bybit.com/v5/order/create", { method: "POST" });

  const oracle: Record<string, number> = {};
  for (const attempt of attempts) {
    if (attempt.method !== "GET") continue;
    const group =
      attempt.path === "/v5/account/fee-rate"
        ? "fees"
        : attempt.path === "/v5/order/history"
          ? "order-history"
          : "other";
    oracle[group] = (oracle[group] ?? 0) + 1;
  }
  assert.deepEqual(JSON.parse(counts.summary()), oracle);
  assert.equal(attempts.length, 5);
  assert.equal(
    Object.values(oracle).reduce((sum, count) => sum + count, 0),
    4,
  );
  assert.doesNotMatch(counts.summary(), /secret|private|cursor|value/u);
});

test("metric formatting rejects unknown groups and unsafe values without echoing them", () => {
  assert.equal(
    safeMainnetGetCounts('{"wallet":2,"positions":1}'),
    '{"positions":1,"wallet":2}',
  );
  for (const value of [
    '{"private-account":1}',
    '{"wallet":"secret"}',
    '{"wallet":-1}',
    "[]",
    "not-json",
  ])
    assert.equal(safeMainnetGetCounts(value), undefined);
});
