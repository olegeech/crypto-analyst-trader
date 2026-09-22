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
