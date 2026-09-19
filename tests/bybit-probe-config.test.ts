import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_PROBE_SYMBOL,
  resolveProbeConfig,
} from "../scripts/bybit-probe/config.js";

test("probe configuration defaults to the canonical Testnet and DOGEUSDT", () => {
  const config = resolveProbeConfig({ TRADER_ENV: "testnet" });

  assert.equal(config.environment, "testnet");
  assert.equal(config.baseUrl.toString(), "https://api-testnet.bybit.com/");
  assert.equal(config.symbol, DEFAULT_PROBE_SYMBOL);
});

test("probe configuration reuses the Testnet lock and rejects unsafe origins", () => {
  assert.throws(
    () =>
      resolveProbeConfig({
        TRADER_ENV: "testnet",
        BYBIT_API_BASE_URL: "https://api.bybit.com",
      }),
    /BYBIT_API_BASE_URL must be the Bybit Testnet base URL/,
  );
  assert.throws(
    () => resolveProbeConfig({ TRADER_ENV: "mainnet" }),
    /TRADER_ENV must be testnet/,
  );
});

test("probe configuration accepts only the exact Demo origin", () => {
  const config = resolveProbeConfig({ TRADER_ENV: "demo" });

  assert.equal(config.environment, "demo");
  assert.equal(config.baseUrl.toString(), "https://api-demo.bybit.com/");
  assert.throws(
    () =>
      resolveProbeConfig({
        TRADER_ENV: "demo",
        BYBIT_API_BASE_URL: "https://api-testnet.bybit.com",
      }),
    /BYBIT_API_BASE_URL must be the Bybit Demo base URL/,
  );
  assert.throws(
    () =>
      resolveProbeConfig({
        TRADER_ENV: "demo",
        BYBIT_API_BASE_URL: "https://api-demo.bybit.com/v5",
      }),
    /BYBIT_API_BASE_URL must be the Bybit Demo base URL/,
  );
});

test("probe command environment rejects conflicting TRADER_ENV before access", () => {
  assert.throws(
    () => resolveProbeConfig({ TRADER_ENV: "testnet" }, "demo"),
    /probe command requires demo but TRADER_ENV is testnet/,
  );
  assert.throws(
    () => resolveProbeConfig({ TRADER_ENV: "mainnet" }, "testnet"),
    /probe command requires testnet but TRADER_ENV is mainnet/,
  );
  assert.throws(
    () => resolveProbeConfig({ TRADER_ENV: "mainnet" }),
    /TRADER_ENV must be testnet or demo/,
  );
});

test("probe configuration accepts only uppercase alphanumeric symbols", () => {
  for (const symbol of ["dogeusdt", "DOGE-USDT", "DOGE/USDT", "DOGE USDT"]) {
    assert.throws(
      () =>
        resolveProbeConfig({
          TRADER_ENV: "testnet",
          BYBIT_PROBE_SYMBOL: symbol,
        }),
      /BYBIT_PROBE_SYMBOL/,
    );
  }

  assert.equal(
    resolveProbeConfig({ TRADER_ENV: "testnet", BYBIT_PROBE_SYMBOL: "BTCUSDT" })
      .symbol,
    "BTCUSDT",
  );
});

test("the write probe remains outside release and every workflow", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.match(
    packageJson.scripts["probe:bybit:testnet"] ?? "",
    /--environment testnet/,
  );
  assert.match(
    packageJson.scripts["probe:bybit:testnet"] ?? "",
    /scripts\/bybit-capability-probe\.ts/,
  );
  assert.doesNotMatch(
    packageJson.scripts["test:release"] ?? "",
    /probe:bybit:testnet/,
  );
  assert.match(
    packageJson.scripts["probe:bybit:demo"] ?? "",
    /--environment demo/,
  );
});
