import type { CapabilityScope } from "../../domain/capabilities/capability.js";

export const BYBIT_DEMO_CAPABILITY_PROFILE = Object.freeze({
  version: "bybit-demo-capability-profile/v1",
  adapter: "bybit-demo-adapter/v1",
  scope: Object.freeze({
    exchange: "bybit",
    environment: "demo",
    category: "linear",
    positionMode: "one-way" as const,
  }),
  capabilities: Object.freeze([
    "order-create",
    "attached-protection",
    "reconciliation-reads",
    "set-leverage",
  ] as const),
});

export type BybitDemoCapability =
  (typeof BYBIT_DEMO_CAPABILITY_PROFILE.capabilities)[number];

export function bybitDemoCapabilityScope(): CapabilityScope {
  return { ...BYBIT_DEMO_CAPABILITY_PROFILE.scope };
}

export const BYBIT_MAINNET_CAPABILITY_PROFILE = Object.freeze({
  version: "bybit-mainnet-capability-profile/v1",
  adapter: "bybit-mainnet-adapter/v1",
  scope: Object.freeze({
    exchange: "bybit",
    environment: "mainnet",
    category: "linear",
    positionMode: "one-way" as const,
  }),
  capabilities: Object.freeze([
    "order-create",
    "attached-protection",
    "reconciliation-reads",
    "set-leverage",
    "cancel-order",
  ] as const),
});

export type BybitMainnetCapability =
  (typeof BYBIT_MAINNET_CAPABILITY_PROFILE.capabilities)[number];

export function bybitMainnetCapabilityScope(): CapabilityScope {
  return { ...BYBIT_MAINNET_CAPABILITY_PROFILE.scope };
}
