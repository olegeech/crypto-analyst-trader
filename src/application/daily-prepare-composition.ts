import { randomUUID } from "node:crypto";
import { BybitPublicMarketClient } from "../adapters/bybit-v5/public-market-client.js";
import { createBybitPublicTransport } from "../adapters/bybit-v5/public-transport.js";
import { createBybitRiskEvidenceReader } from "../adapters/bybit-v5/risk-evidence-reader.js";
import { CoinalyzeClient } from "../adapters/coinalyze/coinalyze-client.js";
import { CoinalyzeTransport } from "../adapters/coinalyze/coinalyze-transport.js";
import { createMacOSKeychainProvider } from "../adapters/macos-keychain.js";
import { createMacOSKeychainSecretProvider } from "../adapters/macos-keychain-secret-provider.js";
import { openSqlitePreparedArtifactStore } from "../adapters/sqlite/prepared-artifact-store.js";
import { systemClock } from "../domain/shared/time.js";
import { collectAccountEvidence } from "./account-evidence-collection.js";
import { collectMarketEvidence } from "./market-evidence-collection.js";
import { collectLiquidationEvidence } from "./liquidation-evidence-collection.js";
import { createDailyPrepareBoundary } from "./daily-prepare.js";

/** Released GET-only composition. No modules, policies or fixtures from CLI. */
export function createDailyPrepareComposition() {
  const reader = new BybitPublicMarketClient({
    transport: createBybitPublicTransport(),
  });
  const marketData = new CoinalyzeClient({
    transport: new CoinalyzeTransport(),
  });
  const secrets = createMacOSKeychainSecretProvider();
  return createDailyPrepareBoundary({
    collectMarket: (runId) =>
      collectMarketEvidence({ runId }, { reader, clock: systemClock }),
    collectLiquidation: (marketEvidence) =>
      collectLiquidationEvidence(
        { marketEvidence },
        { marketData, secrets, clock: systemClock },
      ),
    collectAccount: collectAccountEvidence,
    credentialLoader: createMacOSKeychainProvider(),
    createRiskReader: createBybitRiskEvidenceReader,
    storeForEnvironment: (environment) =>
      openSqlitePreparedArtifactStore({ environment }),
    clock: systemClock,
    newRunId: () => `daily-${randomUUID()}`,
  });
}
