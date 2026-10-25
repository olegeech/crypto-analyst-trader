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
