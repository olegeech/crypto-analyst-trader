import process from "node:process";
import { pathToFileURL } from "node:url";

const TESTNET_BASE_URL = "https://api-testnet.bybit.com";
const TIME_PATH = "/v5/market/time";

export function testnetConfig(environment: Record<string, string | undefined>) {
  if (environment.TRADER_ENV !== "testnet") {
    throw new Error("TRADER_ENV must be testnet");
  }

  const baseUrl = environment.BYBIT_API_BASE_URL ?? TESTNET_BASE_URL;
  const parsedUrl = new URL(baseUrl);
  if (parsedUrl.origin !== TESTNET_BASE_URL || parsedUrl.pathname !== "/") {
    throw new Error("BYBIT_API_BASE_URL must be the Bybit Testnet base URL");
  }

  return parsedUrl;
}

export async function runTestnetSmoke({
  environment = process.env,
  request = fetch,
}: {
  environment?: Record<string, string | undefined>;
  request?: typeof fetch;
} = {}) {
  const baseUrl = testnetConfig(environment);
  const response = await request(new URL(TIME_PATH, baseUrl), {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Testnet endpoint returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (payload?.retCode !== 0) {
    throw new Error("Testnet endpoint returned an unsuccessful response");
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    await runTestnetSmoke();
    console.log("Bybit Testnet read-only smoke passed.");
  } catch (error) {
    console.error(
      `Testnet smoke failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  }
}
