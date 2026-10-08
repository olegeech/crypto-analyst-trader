/** Canonical exchange origins shared without importing either transport. */
export const BYBIT_CANONICAL_ORIGINS = Object.freeze({
  demo: "https://api-demo.bybit.com",
  testnet: "https://api-testnet.bybit.com",
  mainnet: "https://api.bybit.com",
} as const);

export const BYBIT_DEMO_ORIGIN = BYBIT_CANONICAL_ORIGINS.demo;
export const BYBIT_MAINNET_ORIGIN = BYBIT_CANONICAL_ORIGINS.mainnet;
