import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import {
  createOperatorMainnetQuote,
  createOperatorMainnetTestPlan,
} from "../src/domain/execution/operator-mainnet-test-plan.js";

import { BybitMainnetReadCapabilityFacade } from "../src/adapters/bybit-v5/read-capability-facade.js";
import {
  BybitAccountReadError,
  createBybitAccountReadTransport,
} from "../src/adapters/bybit-v5/account-read-transport.js";

const credentials = {
  apiKey: "synthetic-mainnet-key",
  apiSecret: "synthetic-mainnet-secret",
  accountId: "synthetic-mainnet-account",
};

function instrument(overrides: Record<string, unknown> = {}) {
  return {
    symbol: "DOGEUSDT",
    status: "Trading",
    contractType: "LinearPerpetual",
    quoteCoin: "USDT",
    settleCoin: "USDT",
    priceFilter: {
      tickSize: "0.0001",
      minPrice: "0.0001",
      maxPrice: "1000000",
    },
    lotSizeFilter: {
      qtyStep: "1",
      minOrderQty: "1",
      maxOrderQty: "100000",
      minNotionalValue: "5",
    },
    ...overrides,
  };
}

function facadeFixture(
  options: {
    readonly environment?: "demo" | "mainnet" | "testnet";
    readonly result?: Record<string, unknown>;
    readonly deadlineOffsetMs?: number;
  } = {},
) {
  const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
  const now = performance.now();
  const transport = createBybitAccountReadTransport({
    environment: options.environment ?? "mainnet",
    credentials,
    budget: {
      deadline: now + (options.deadlineOffsetMs ?? 30_000),
      attempts: 0,
      maxAttempts: 4,
      maxResponseBytes: 16_384,
      maxObservedResponseBytes: 0,
    },
    clock: () => Date.parse("2026-10-07T12:00:00.000Z"),
    monotonicClock: () => performance.now(),
    clockOffsetMs: 0,
    request: async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response(
        JSON.stringify({
          retCode: 0,
          retMsg: "OK",
          result: options.result ?? { list: [instrument()] },
          time: Date.parse("2026-10-07T12:00:00.000Z"),
        }),
        { status: 200 },
      );
    },
  });
  return {
    facade: new BybitMainnetReadCapabilityFacade(transport),
    transport,
    calls,
  };
}

function accountReadTransport(environment: "demo" | "mainnet" | "testnet") {
  return createBybitAccountReadTransport({
    environment,
    credentials,
    budget: {
      deadline: performance.now() + 30_000,
      attempts: 0,
      maxAttempts: 4,
      maxResponseBytes: 16_384,
      maxObservedResponseBytes: 0,
    },
    clock: () => Date.parse("2026-10-07T12:00:00.000Z"),
    monotonicClock: () => performance.now(),
    clockOffsetMs: 0,
    request: async () => new Response("{}", { status: 200 }),
  });
}

test("Mainnet facade reads one selected Trading linear USDT perpetual through bounded GET", async () => {
  const fixture = facadeFixture();
  const selected = await fixture.facade.readInstrument("DOGEUSDT");

  assert.equal(selected.symbol, "DOGEUSDT");
  assert.equal(selected.status, "Trading");
  assert.equal(selected.contractType, "LinearPerpetual");
  assert.equal(selected.quoteCoin, "USDT");
  assert.equal(selected.settleCoin, "USDT");
  assert.equal(fixture.calls.length, 1);
  const call = fixture.calls[0]!;
  const url = new URL(call.url);
  assert.equal(url.origin, "https://api.bybit.com");
  assert.equal(url.pathname, "/v5/market/instruments-info");
  assert.equal(url.searchParams.get("category"), "linear");
  assert.equal(url.searchParams.get("symbol"), "DOGEUSDT");
  assert.equal(call.init.method, "GET");
  assert.equal(call.init.redirect, "error");
  assert.equal("post" in fixture.transport, false);
  assert.equal("post" in fixture.facade, false);
});

test("Mainnet facade rejects non-trading, non-linear, and non-USDT instrument evidence", async () => {
  for (const overrides of [
    { status: "PreLaunch" },
    { contractType: "LinearFutures" },
    { quoteCoin: "USDC" },
    { settleCoin: "USDC" },
  ]) {
    const fixture = facadeFixture({
      result: { list: [instrument(overrides)] },
    });
    await assert.rejects(fixture.facade.readInstrument("DOGEUSDT"));
  }
});

test("Mainnet facade rejects wrong environment and does not bypass expired read budget", async () => {
  assert.throws(
    () => new BybitMainnetReadCapabilityFacade(accountReadTransport("demo")),
    /Mainnet/u,
  );

  const expired = facadeFixture({ deadlineOffsetMs: -1 });
  await assert.rejects(
    expired.facade.readInstrument("DOGEUSDT"),
    (error: unknown) =>
      error instanceof BybitAccountReadError &&
      error.code === "COLLECTION_DEADLINE_EXCEEDED",
  );
  assert.equal(expired.calls.length, 0);
});

test("Mainnet GET facade import graph cannot reach mixed private/write adapters", async () => {
  const forbidden =
    /\/adapters\/bybit-v5\/(?:transport|client|execution-adapter|order-mappers|reconciliation)\.ts$/u;
  const pending = [resolve("src/adapters/bybit-v5/read-capability-facade.ts")];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    assert.doesNotMatch(file, forbidden, file);
    visited.add(file);
    const source = ts.createSourceFile(
      file,
      await readFile(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const imports: string[] = [];
    function visit(node: ts.Node) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        imports.push(node.moduleSpecifier.text);
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require"))
      ) {
        const argument = node.arguments[0];
        assert.ok(
          argument && ts.isStringLiteral(argument),
          "literal imports only",
        );
        imports.push(argument.text);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    for (const specifier of imports) {
      if (specifier.startsWith(".")) {
        pending.push(
          resolve(dirname(file), specifier.replace(/\.js$/u, ".ts")),
        );
      }
    }
  }
  assert.ok(
    visited.has(resolve("src/adapters/bybit-v5/account-read-transport.ts")),
  );
});

test("production instrument read retains venue bounds for operator-test preparation", async () => {
  const fixture = facadeFixture();
  const selected = await fixture.facade.readInstrument("DOGEUSDT");
  const quote = createOperatorMainnetQuote({
    exchange: "bybit",
    environment: "mainnet",
    category: "linear",
    origin: "https://api.bybit.com",
    symbol: "DOGEUSDT",
    observedAt: "2026-10-07T12:00:00.000Z",
    collectionStartedAt: "2026-10-07T11:59:59.900Z",
    collectionCompletedAt: "2026-10-07T12:00:00.100Z",
    bid: "0.0886",
    ask: "0.0887",
    last: "0.0886",
  });
  assert.ok(quote.ok);
  const plan = createOperatorMainnetTestPlan({
    accountIdentityHash: `sha256:${"a".repeat(64)}`,
    symbol: "DOGEUSDT",
    nonce: "read-instrument-regression",
    allocation: "10",
    grossNotionalCap: "10",
    maxDeviationBps: "10",
    quote: quote.value,
    constraints: selected.constraints,
    warningCodes: [],
    preparedAt: "2026-10-07T12:00:00.200Z",
  });
  assert.ok(plan.ok, plan.ok ? undefined : plan.error.message);
  assert.equal(plan.value.entry.quantity.toString(), "112");
  assert.equal(plan.value.entry.takeProfit.triggerPrice.toString(), "0.0888");
  assert.equal(plan.value.constraints.minPrice?.toString(), "0.0001");
  assert.equal(plan.value.constraints.maxPrice?.toString(), "1000000");
  assert.equal(plan.value.constraints.maxLimitQuantity?.toString(), "100000");
  assert.equal(fixture.calls.length, 1);
});

test("production instrument read blocks absent, malformed, nonpositive and contradictory venue bounds", async () => {
  for (const field of ["minPrice", "maxPrice", "maxOrderQty"]) {
    for (const invalid of [undefined, "-1", "0", "invalid"]) {
      const row = instrument();
      const filter: Record<string, unknown> =
        field === "maxOrderQty" ? row.lotSizeFilter : row.priceFilter;
      if (invalid === undefined) delete filter[field];
      else filter[field] = invalid;
      await assert.rejects(
        facadeFixture({ result: { list: [row] } }).facade.readInstrument(
          "DOGEUSDT",
        ),
      );
    }
  }
  for (const overrides of [
    { priceFilter: { tickSize: "0.0001", minPrice: "2", maxPrice: "1" } },
    {
      lotSizeFilter: {
        qtyStep: "1",
        minOrderQty: "2",
        maxOrderQty: "1",
        minNotionalValue: "5",
      },
    },
  ]) {
    await assert.rejects(
      facadeFixture({
        result: { list: [instrument(overrides)] },
      }).facade.readInstrument("DOGEUSDT"),
    );
  }
});
