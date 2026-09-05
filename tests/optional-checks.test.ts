import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runTestnetSmoke, testnetConfig } from "../scripts/testnet-smoke.js";

test("Testnet configuration rejects mainnet before making a request", () => {
  assert.throws(
    () =>
      testnetConfig({
        TRADER_ENV: "mainnet",
        BYBIT_API_BASE_URL: "https://api.bybit.com",
      }),
    /TRADER_ENV must be testnet/,
  );
});

test("Testnet smoke performs only the read-only time request", async () => {
  const requests: URL[] = [];
  await runTestnetSmoke({
    environment: {
      TRADER_ENV: "testnet",
      BYBIT_API_BASE_URL: "https://api-testnet.bybit.com",
    },
    request: async (url) => {
      requests.push(
        new URL(typeof url === "string" || url instanceof URL ? url : url.url),
      );
      return new Response(JSON.stringify({ retCode: 0 }), { status: 200 });
    },
  });
  assert.deepEqual(
    requests.map((url) => `${url.origin}${url.pathname}`),
    ["https://api-testnet.bybit.com/v5/market/time"],
  );
});

test("Testnet smoke rejects an unsafe base URL before requesting it", async () => {
  let requested = false;
  await assert.rejects(
    runTestnetSmoke({
      environment: {
        TRADER_ENV: "testnet",
        BYBIT_API_BASE_URL: "https://api.bybit.com",
      },
      request: async () => {
        requested = true;
        return new Response();
      },
    }),
    /BYBIT_API_BASE_URL must be the Bybit Testnet base URL/,
  );
  assert.equal(requested, false);
});

test("audit workflow is manual or scheduled and remains separate from blocking CI", async () => {
  const workflow = await readFile(".github/workflows/security-audit.yml", "utf8");
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /continue-on-error: true/);
  assert.doesNotMatch(
    workflow,
    /BYBIT_API_|secrets\.|placeOrder|create-order/i,
  );
});
