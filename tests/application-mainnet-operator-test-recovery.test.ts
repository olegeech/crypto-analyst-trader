import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openSqlitePersistence } from "../src/adapters/sqlite/sqlite-persistence.js";
import {
  resolveOperatorMainnetPlan,
  resolveOperatorMainnetSource,
} from "../src/adapters/sqlite/operator-mainnet-test-lookup.js";
import {
  createOperatorMainnetQuote,
  createOperatorMainnetTestApproval,
  createOperatorMainnetTestPlan,
  deriveOperatorMainnetTestSourceId,
} from "../src/domain/execution/operator-mainnet-test-plan.js";
import {
  persistManualOperatorRecoveryAttestation,
  recoverMainnetOperatorTest,
} from "../src/application/mainnet-operator-test-recovery.js";
import { createOperatorMainnetCreateRequest } from "../src/application/mainnet-entry-evidence.js";
import { createInstrumentConstraints } from "../src/domain/market/instrument-constraints.js";
import {
  parseUtcTimestamp,
  type UtcTimestamp,
} from "../src/domain/shared/time.js";
import type { Result } from "../src/domain/shared/result.js";
import type { PlanHash } from "../src/domain/identity/canonical-serialization.js";
import type { PersistenceScope } from "../src/ports/persistence.js";

const NOW = "2026-10-26T12:00:00.000Z" as UtcTimestamp;
const ACCOUNT = `sha256:${"a".repeat(64)}`;
const runtime = { nodeVersion: "22.22.3", sqliteVersion: "3.51.3" } as const;
const roots: string[] = [];

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function value<T>(result: Result<T>): T {
  if (!result.ok)
    throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function at(ms: number): UtcTimestamp {
  return value(parseUtcTimestamp(new Date(ms).toISOString()));
}

function scope(): PersistenceScope {
  return {
    exchange: "bybit",
    environment: "mainnet",
    accountId: ACCOUNT,
    category: "linear",
    positionMode: "one-way",
  };
}

function plan(nonce: string, recoveryAttestationHash?: PlanHash) {
  const quote = value(
    createOperatorMainnetQuote({
      symbol: "DOGEUSDT",
      exchange: "bybit",
      environment: "mainnet",
      category: "linear",
      origin: "https://api.bybit.com",
      observedAt: at(Date.parse(NOW) - 500),
      collectionStartedAt: at(Date.parse(NOW) - 510),
      collectionCompletedAt: at(Date.parse(NOW) - 490),
      bid: "0.08869",
      ask: "0.08870",
      last: "0.08869",
    }),
  );
  const constraints = value(
    createInstrumentConstraints({
      instrument: "DOGEUSDT",
      version: "bybit-linear-instrument/v1",
      priceTickSize: "0.0001",
      quantityStep: "0.1",
      minQuantity: "1",
      minNotional: "5",
      minPrice: "0.0001",
      maxPrice: "100",
      maxLimitQuantity: "100000",
    }),
  );
  return value(
    createOperatorMainnetTestPlan({
      accountIdentityHash: ACCOUNT,
      symbol: "DOGEUSDT",
      nonce,
      allocation: "10",
      grossNotionalCap: "8",
      maxDeviationBps: "10",
      quote,
      warningCodes: [],
      constraints,
      preparedAt: NOW,
      ...(recoveryAttestationHash === undefined
        ? {}
        : { recoveryAttestationHash }),
    }),
  );
}

test("manual recovery requires an explicit UI observation time", () => {
  let sourceReads = 0;
  const result = persistManualOperatorRecoveryAttestation(
    {
      sourceId: "operator-mainnet-test:prior-source",
      inspection: {
        inspection: {},
        manualActions: ["none"],
        acceptedUncertainty: ["manual-ui-may-be-stale"],
      } as never,
      actor: "operator-test",
      recordedAt: NOW,
    },
    {
      resolveSource: () => {
        sourceReads += 1;
        return {
          ok: false,
          error: new Error("must not resolve source"),
        } as never;
      },
    },
  );

  assert.equal(result.ok, false);
  if (!result.ok)
    assert.equal(
      result.error.details?.reasonCode,
      "INVALID_MANUAL_RECOVERY_INPUT",
    );
  assert.equal(sourceReads, 0);
});

test("manual recovery persists UI provenance and clears only its source-linked HALT without exchange IO", () => {
  const root = mkdtempSync(join(tmpdir(), "operator-mainnet-recovery-app-"));
  roots.push(root);
  const databasePath = join(root, "mainnet.db");
  const clock = { now: () => NOW };
  const opened = openSqlitePersistence({
    environment: "mainnet",
    databasePath,
    scope: scope(),
    runtime,
    clock,
  });
  const persistence = value(opened);
  const journal = persistence.operatorMainnetTest;
  assert.ok(journal);

  const priorPlan = plan("prior-source");
  const priorApproval = value(
    createOperatorMainnetTestApproval({
      plan: priorPlan,
      planHash: priorPlan.contentHash,
      actor: "operator-test",
      consent: true,
      approvedAt: NOW,
    }),
  );
  value(journal.persistPreparedPlan(priorPlan));
  const create = value(createOperatorMainnetCreateRequest(priorPlan));
  const sourceId = value(
    deriveOperatorMainnetTestSourceId(priorPlan.contentHash),
  );
  value(
    journal.prepareCreateIntent({
      runId: "prior-run",
      plan: priorPlan,
      approval: priorApproval,
      payloadJson: create.payloadJson,
      payloadHash: create.payloadHash as PlanHash,
      preparedAt: NOW,
    }),
  );
  value(
    journal.recordAttempt({
      runId: "prior-run",
      sourceId,
      attemptId: "prior-attempt",
      outcome: "accepted",
      exchangeOrderId: "prior-exchange-order",
      recordedAt: NOW,
    }),
  );
  value(journal.raiseHalt(sourceId, "operator status unresolved", NOW));
  const prior = value(journal.readOperatorMainnetTestSource(sourceId));
  assert.ok(prior);

  const lookupOptions = { databasePath, clock };
  const dependencies = {
    resolveSource: (id: unknown) =>
      resolveOperatorMainnetSource(id, lookupOptions),
    resolvePlan: (hash: unknown) =>
      resolveOperatorMainnetPlan(hash, lookupOptions),
    openPersistence: (settings: Parameters<typeof openSqlitePersistence>[0]) =>
      openSqlitePersistence({ ...settings, databasePath, runtime, clock }),
  };
  const inspection = {
    observedAt: NOW,
    inspection: {
      accountOpenOrdersInspected: true,
      accountOpenOrders: [],
      accountPositionsInspected: true,
      accountPositions: [],
      sourceOrderHistoryInspected: true,
      sourceOrders: [
        {
          orderId: "prior-exchange-order",
          clientOrderId: priorPlan.clientOrderId,
          symbol: priorPlan.symbol,
          side: "Buy",
          orderType: "Limit",
          quantity: priorPlan.entry.quantity.toString(),
          price: priorPlan.entry.limitPrice.toString(),
          status: "Cancelled",
        },
      ],
      sourceFillsInspected: true,
      sourceFills: [],
      sourcePositionInspected: true,
      sourcePosition: null,
      targetLeverage: "1",
      sourceTakeProfitInspected: true,
      sourceTakeProfitOrders: [],
    },
    manualActions: ["none"] as const,
    acceptedUncertainty: ["manual-ui-may-be-stale"] as const,
  };
  const attested = persistManualOperatorRecoveryAttestation(
    {
      sourceId,
      inspection,
      actor: "operator-test",
      recordedAt: NOW,
    },
    dependencies,
  );
  const attestation = value(attested).attestation;
  assert.equal(attestation.provenance, "MANUAL_ATTESTED_NOT_API_VERIFIED");
  assert.equal(value(attested).exchangeReads, 0);
  assert.equal(value(attested).exchangeWrites, 0);

  const nextPlan = plan("next-source", attestation.contentHash);
  value(journal.persistPreparedPlan(nextPlan));
  const recovered = value(
    recoverMainnetOperatorTest(
      {
        sourceId,
        planHash: nextPlan.contentHash,
        resolution: "manual-attested",
        actor: "operator-test",
        consent: true,
        issuedAt: NOW,
      },
      dependencies,
    ),
  );

  assert.equal(recovered.grant.planHash, nextPlan.contentHash);
  assert.equal(recovered.grant.resolution.kind, "manual-attested");
  assert.equal(recovered.exchangeReads, 0);
  assert.equal(recovered.exchangeWrites, 0);
  assert.equal(value(persistence.readHalt()).active, false);
  assert.equal(
    value(journal.findPendingOperatorMainnetTestSource())?.sourceId,
    sourceId,
    "the grant alone must not clear the old source's queue obligation",
  );
  const saved = value(
    journal.readOperatorMainnetRecoveryAttestation(attestation.contentHash),
  );
  assert.equal(saved?.contentHash, attestation.contentHash);
  persistence.close();
});
