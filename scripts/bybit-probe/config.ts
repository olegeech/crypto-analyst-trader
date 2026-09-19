import process from "node:process";

import { testnetConfig } from "../testnet-smoke.js";

export const DEFAULT_PROBE_SYMBOL = "DOGEUSDT";
export type ProbeEnvironment = "testnet" | "demo";

export const probeEnvironmentPolicy = {
  testnet: {
    label: "Testnet",
    canonicalOrigin: "https://api-testnet.bybit.com",
    fundingGuidance: "using the Bybit Testnet faucet",
  },
  demo: {
    label: "Demo",
    canonicalOrigin: "https://api-demo.bybit.com",
    fundingGuidance: "through the Bybit Demo UI",
  },
} as const satisfies Record<
  ProbeEnvironment,
  { label: string; canonicalOrigin: string; fundingGuidance: string }
>;

export interface ProbeConfig {
  readonly environment: ProbeEnvironment;
  readonly baseUrl: URL;
  readonly symbol: string;
  readonly label: string;
  readonly fundingGuidance: string;
}

/**
 * Probe-only configuration. The Testnet origin and environment check are
 * intentionally delegated to the existing smoke-test lock so the diagnostic
 * path cannot drift into a second environment policy.
 */
export function resolveProbeConfig(
  environment: Record<string, string | undefined> = process.env,
  commandEnvironment?: ProbeEnvironment,
): ProbeConfig {
  const declaredEnvironment = environment.TRADER_ENV;
  if (
    commandEnvironment !== undefined &&
    declaredEnvironment !== undefined &&
    declaredEnvironment !== commandEnvironment
  ) {
    throw new Error(
      `probe command requires ${commandEnvironment} but TRADER_ENV is ${declaredEnvironment}`,
    );
  }
  const selectedEnvironment = commandEnvironment ?? declaredEnvironment;
  if (selectedEnvironment !== "testnet" && selectedEnvironment !== "demo") {
    throw new Error("TRADER_ENV must be testnet or demo");
  }
  const policy = probeEnvironmentPolicy[selectedEnvironment];
  const rawBaseUrl = environment.BYBIT_API_BASE_URL ?? policy.canonicalOrigin;
  let baseUrl: URL;
  try {
    baseUrl = new URL(rawBaseUrl);
  } catch {
    throw new Error(
      `BYBIT_API_BASE_URL must be the Bybit ${policy.label} base URL`,
    );
  }
  if (
    baseUrl.origin !== policy.canonicalOrigin ||
    baseUrl.pathname !== "/" ||
    baseUrl.search !== "" ||
    baseUrl.hash !== "" ||
    baseUrl.username !== "" ||
    baseUrl.password !== ""
  ) {
    throw new Error(
      `BYBIT_API_BASE_URL must be the Bybit ${policy.label} base URL`,
    );
  }
  if (selectedEnvironment === "testnet") {
    // Keep the existing Testnet validator as the canonical smoke-test policy.
    baseUrl = testnetConfig({
      ...environment,
      TRADER_ENV: "testnet",
      BYBIT_API_BASE_URL: rawBaseUrl,
    });
  }
  const symbol = environment.BYBIT_PROBE_SYMBOL ?? DEFAULT_PROBE_SYMBOL;
  if (!/^[A-Z0-9]+$/.test(symbol)) {
    throw new Error(
      "BYBIT_PROBE_SYMBOL must contain only uppercase letters and digits",
    );
  }

  return {
    environment: selectedEnvironment,
    baseUrl,
    symbol,
    label: policy.label,
    fundingGuidance: policy.fundingGuidance,
  };
}
