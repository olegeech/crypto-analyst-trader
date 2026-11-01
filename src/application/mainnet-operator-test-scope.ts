import type { PersistenceScope } from "../ports/persistence.js";

export function mainnetOperatorTestPersistenceScope(
  accountId: string,
): PersistenceScope {
  return {
    exchange: "bybit",
    environment: "mainnet",
    accountId,
    category: "linear",
    positionMode: "one-way",
  };
}
