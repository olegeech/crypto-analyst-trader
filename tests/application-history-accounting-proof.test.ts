import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openSqliteConnection } from "../src/adapters/sqlite/connection.js";
import { createSqliteHistoryAccountingWalletAnchorStore } from "../src/adapters/sqlite/history-accounting-anchor-store.js";
import { createSqliteHistoryStore } from "../src/adapters/sqlite/history-store.js";
import { reconcileHistoryAccounting } from "../src/application/history-accounting-composition.js";
import {
  validateHistoryAccountingProof as validateProof,
  type HistoryAccountingProofRequestV2,
} from "../src/application/history-accounting-proof.js";
import { createHistorySourceFact } from "../src/domain/accounting/history-source-fact.js";
import { domainError } from "../src/domain/shared/errors.js";
import { OPERATOR_MAINNET_TEST_POLICY_VERSION } from "../src/domain/execution/operator-mainnet-test-plan.js";
import {
  canonicalSerialize,
  hashCanonical,
} from "../src/domain/identity/canonical-serialization.js";
import type { UtcTimestamp } from "../src/domain/shared/time.js";
import { HISTORY_READ_SOURCES } from "../src/ports/history-read.js";
import type { HistoryReadSource } from "../src/ports/history-read.js";
import {
  HISTORY_ACCOUNTING_TEST_AUTH_KEY,
  capturedWalletAnchorForStoreTest,
} from "./history-accounting-fixtures.js";
import {
  closingBoundary,
  historyAccountingScope,
  openingBoundary,
  walletAnchor,
} from "./history-accounting-fixtures.js";
import { resolveHistoryAccountingScope } from "../src/application/history-accounting-scope.js";
import { PROVISIONAL_M1_POLICY_VERSION } from "../src/application/policies/provisional-m1.js";

const runtime = { nodeVersion: "22.22.3", sqliteVersion: "3.51.3" } as const;
const currentTime = "2026-11-01T10:00:00.000Z" as UtcTimestamp;
const anchorKeyProvider = {
  async read() {
    return { ok: true as const, value: HISTORY_ACCOUNTING_TEST_AUTH_KEY };
  },
};

function validateHistoryAccountingProof(
  request: Parameters<typeof validateProof>[0],
  dependencies: { readonly openConnection?: typeof openSqliteConnection } = {},
) {
  return validateProof(request, { ...dependencies, anchorKeyProvider });
}

function transferFact(
  transactionId: string,
  providerEventTime: string,
  currency = "USDT",
  cashBalance = "100",
) {
  const fact = createHistorySourceFact({
    factKind: "transaction",
    source: "transaction-log",
    transactionId,
    category: null,
    symbol: null,
    side: null,
    currency,
    type: "TRANSFER_IN",
    transSubType: "MANUAL",
    qty: null,
    size: null,
    tradePrice: null,
    cashFlow: "0",
    funding: "0",
    fee: "0",
    feeRate: null,
    change: "0",
    bonusChange: "0",
    cashBalance,
    tradeId: null,
    orderId: null,
    orderLinkId: null,
    displayType: null,
    extraFees: null,
    providerEventTime: providerEventTime as UtcTimestamp,
    providerRevisionTime: null,
    collectedAt: currentTime,
  });
  assert.equal(fact.ok, true, fact.ok ? "" : fact.error.message);
  if (!fact.ok) throw new Error("transaction fixture could not be created");
  return fact.value;
}

async function setup(scoped = false, completeCoverage = true) {
  const root = mkdtempSync(join(tmpdir(), "history-accounting-proof-"));
  const databasePath = join(root, "account.db");
  const clock = { now: () => currentTime };
  const open: typeof openSqliteConnection = (options) =>
    openSqliteConnection({
      ...options,
      runtime,
      clock,
    });
  const connection = open({ environment: "demo", databasePath });
  assert.equal(
    connection.ok,
    true,
    connection.ok ? "" : connection.error.message,
  );
  if (!connection.ok) throw new Error("test database could not be opened");
  const anchorStore = createSqliteHistoryAccountingWalletAnchorStore(
    connection.value,
    HISTORY_ACCOUNTING_TEST_AUTH_KEY,
  );
  const openingBase = walletAnchor("opening", openingBoundary);
  const closingBase = walletAnchor("closing", closingBoundary);
  const withTechnicalBalance = <T extends typeof openingBase>(base: T) =>
    scoped
      ? {
          ...base,
          assets: [...base.assets, { ...base.assets[0]!, coin: "MNT" }],
        }
      : base;
  const openingAnchor = capturedWalletAnchorForStoreTest({
    ...withTechnicalBalance(openingBase),
    anchorId: "proof-opening",
  });
  const closingAnchor = capturedWalletAnchorForStoreTest({
    ...withTechnicalBalance(closingBase),
    anchorId: "proof-closing",
  });
  const opening = anchorStore.append({ anchor: openingAnchor });
  const closing = anchorStore.append({ anchor: closingAnchor });
  assert.equal(opening.ok, true, opening.ok ? "" : opening.error.message);
  assert.equal(closing.ok, true, closing.ok ? "" : closing.error.message);
  if (!opening.ok || !closing.ok)
    throw new Error("test anchors could not be recorded");

  const fromMs = Date.parse(openingAnchor.capture.providerTimeBefore);
  const toMs = Date.parse(closingAnchor.capture.providerTimeAfter);
  const historyStore = createSqliteHistoryStore(connection.value);
  for (const source of HISTORY_READ_SOURCES) {
    if (!completeCoverage && source === "order-history") continue;
    const filters = {
      ...(source === "transaction-log"
        ? { accountType: "UNIFIED" }
        : { category: "linear" }),
      purpose: "backfill",
      rangeStartMs: fromMs,
      rangeEndMs: toMs,
    };
    const committed = historyStore.commitPage({
      scope: historyAccountingScope,
      source,
      filters,
      window: { fromMs, toMs },
      expectedRevision: 0,
      cursor: null,
      nextCursor: null,
      facts: [],
    });
    assert.equal(
      committed.ok,
      true,
      committed.ok ? "" : committed.error.message,
    );
  }
  connection.value.close();

  const reconciled = await reconcileHistoryAccounting(
    {
      environment: "demo",
      databasePath,
      openingAnchorId: opening.value.anchorId,
      closingAnchorId: closing.value.anchorId,
      ...(scoped
        ? { accountingPolicyVersion: OPERATOR_MAINNET_TEST_POLICY_VERSION }
        : {}),
    },
    { openConnection: open, anchorKeyProvider },
  );
  assert.equal(
    reconciled.ok,
    true,
    reconciled.ok ? "" : reconciled.error.message,
  );
  if (!reconciled.ok) throw new Error("test report could not be reconciled");
  assert.equal(
    reconciled.value.status,
    completeCoverage ? "ACCOUNTING_READY" : "NOT_READY",
  );
  const requestBase = {
    environment: "demo" as const,
    databasePath,
    reportId: reconciled.value.reportId,
    expectedScope: historyAccountingScope,
    openingAnchorId: opening.value.anchorId,
    closingAnchorId: closing.value.anchorId,
    dependencyHash: reconciled.value.dependencyHash,
  };
  const request = scoped
    ? (() => {
        const accountingScope = resolveHistoryAccountingScope(
          OPERATOR_MAINNET_TEST_POLICY_VERSION,
        );
        assert.equal(accountingScope.ok, true);
        if (!accountingScope.ok)
          throw new Error("approved accounting scope did not resolve");
        return {
          ...requestBase,
          schemaVersion: "history-accounting-proof-request/v2" as const,
          accountingScope: accountingScope.value,
          accountingScopeHash: accountingScope.value.scopeHash,
        };
      })()
    : requestBase;
  return {
    root,
    databasePath,
    open,
    request,
    report: reconciled.value,
    coverageFromMs: fromMs,
    coverageToMs: toMs,
  };
}

function asScopedRequest(
  fixture: Awaited<ReturnType<typeof setup>>,
): HistoryAccountingProofRequestV2 {
  assert.ok("schemaVersion" in fixture.request);
  if (!("schemaVersion" in fixture.request))
    throw new Error("test fixture did not create a scoped proof request");
  return fixture.request as HistoryAccountingProofRequestV2;
}

function appendTransaction(
  fixture: Awaited<ReturnType<typeof setup>>,
  transactionId: string,
  currency: string,
  cashBalance = "100",
) {
  const connection = fixture.open({
    environment: "demo",
    databasePath: fixture.databasePath,
  });
  assert.equal(connection.ok, true);
  if (!connection.ok) throw new Error("test database could not be reopened");
  const store = createSqliteHistoryStore(connection.value);
  const coverage = store.listCoverage(historyAccountingScope);
  assert.equal(coverage.ok, true, coverage.ok ? "" : coverage.error.message);
  if (!coverage.ok) throw new Error("test history coverage is unavailable");
  const checkpoint = coverage.value.find(
    (row) =>
      row.source === "transaction-log" &&
      row.window.fromMs === fixture.coverageFromMs &&
      row.window.toMs === fixture.coverageToMs,
  );
  assert.ok(checkpoint);
  if (!checkpoint) throw new Error("test transaction checkpoint is missing");
  const committed = store.commitPage({
    scope: checkpoint.scope,
    source: checkpoint.source,
    filters: checkpoint.filters,
    window: checkpoint.window,
    expectedRevision: checkpoint.revision,
    cursor: checkpoint.cursor,
    nextCursor: checkpoint.cursor,
    facts: [
      transferFact(
        transactionId,
        new Date(Date.parse(openingBoundary) + 5 * 60_000).toISOString(),
        currency,
        cashBalance,
      ),
    ],
  });
  connection.value.close();
  assert.equal(committed.ok, true, committed.ok ? "" : committed.error.message);
}

test("proof validation accepts an exact persisted current report and does not expire historical anchors by default", async () => {
  const fixture = await setup();
  try {
    const accepted = await validateHistoryAccountingProof(fixture.request, {
      openConnection: fixture.open,
    });
    assert.equal(accepted.ok, true, accepted.ok ? "" : accepted.error.message);
    assert.equal(accepted.ok && accepted.value.decision, "ACCEPT");
    assert.equal(accepted.ok && accepted.value.authority, "evidence-only");
    assert.equal(
      accepted.ok && accepted.value.openingBoundary,
      openingBoundary,
    );

    const oldAnchorStillUsable = await validateHistoryAccountingProof(
      {
        ...fixture.request,
        coverageThrough: closingBoundary,
      },
      { openConnection: fixture.open },
    );
    assert.equal(
      oldAnchorStillUsable.ok && oldAnchorStillUsable.value.decision,
      "ACCEPT",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("scoped proof stays valid after an overlapping empty explicit-replay checkpoint", async () => {
  const fixture = await setup(true);
  try {
    const request = asScopedRequest(fixture);
    const connection = fixture.open({
      environment: "demo",
      databasePath: fixture.databasePath,
    });
    assert.equal(connection.ok, true);
    if (!connection.ok) return;
    const replayFrom = fixture.coverageFromMs + 5_000;
    const replayTo = fixture.coverageToMs - 5_000;
    const filters = {
      category: "linear",
      purpose: "explicit-replay",
      rangeStartMs: replayFrom,
      rangeEndMs: replayTo,
      replayId: "proof-overlap-no-new-rows",
    };
    const committed = createSqliteHistoryStore(connection.value).commitPage({
      scope: historyAccountingScope,
      source: "executions",
      filters,
      window: { fromMs: replayFrom, toMs: replayTo },
      expectedRevision: 0,
      cursor: null,
      nextCursor: null,
      facts: [],
    });
    connection.value.close();
    assert.equal(
      committed.ok,
      true,
      committed.ok ? "" : committed.error.message,
    );

    const accepted = await validateHistoryAccountingProof(request, {
      openConnection: fixture.open,
    });
    assert.equal(
      accepted.ok && accepted.value.decision,
      "ACCEPT",
      JSON.stringify(accepted),
    );
    const replay = await reconcileHistoryAccounting(
      {
        environment: "demo",
        databasePath: fixture.databasePath,
        openingAnchorId: request.openingAnchorId,
        closingAnchorId: request.closingAnchorId,
        accountingPolicyVersion: OPERATOR_MAINNET_TEST_POLICY_VERSION,
      },
      { openConnection: fixture.open, anchorKeyProvider },
    );
    assert.equal(replay.ok, true, replay.ok ? "" : replay.error.message);
    assert.deepEqual(
      replay.ok &&
        replay.value.schemaVersion ===
          "history-accounting-reconciliation-report/v2"
        ? replay.value.dependencies
        : undefined,
      fixture.report.schemaVersion ===
        "history-accounting-reconciliation-report/v2"
        ? fixture.report.dependencies
        : undefined,
    );
    assert.equal(replay.ok && replay.value.reportId, fixture.report.reportId);
    assert.equal(
      replay.ok && replay.value.dependencyHash,
      fixture.report.dependencyHash,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("proof validation refuses wrong account, epoch, hash and unmet coverage or freshness", async () => {
  const fixture = await setup();
  try {
    const wrongAccount = await validateHistoryAccountingProof(
      {
        ...fixture.request,
        expectedScope: {
          ...fixture.request.expectedScope,
          accountId: `sha256:${"d".repeat(64)}`,
        },
      },
      { openConnection: fixture.open },
    );
    assert.equal(
      wrongAccount.ok && wrongAccount.value.reasonCodes[0],
      "SCOPE_MISMATCH",
    );

    const wrongEpoch = await validateHistoryAccountingProof(
      {
        ...fixture.request,
        openingAnchorId: "another-opening",
      },
      { openConnection: fixture.open },
    );
    assert.equal(
      wrongEpoch.ok && wrongEpoch.value.reasonCodes[0],
      "EPOCH_MISMATCH",
    );

    const wrongHash = await validateHistoryAccountingProof(
      {
        ...fixture.request,
        dependencyHash: `sha256:${"e".repeat(64)}`,
      },
      { openConnection: fixture.open },
    );
    assert.equal(
      wrongHash.ok && wrongHash.value.reasonCodes[0],
      "DEPENDENCY_MISMATCH",
    );

    const futureCoverage = await validateHistoryAccountingProof(
      {
        ...fixture.request,
        coverageThrough: "2026-10-27T10:11:00.000Z" as UtcTimestamp,
      },
      { openConnection: fixture.open },
    );
    assert.equal(
      futureCoverage.ok && futureCoverage.value.reasonCodes[0],
      "COVERAGE_THROUGH_NOT_MET",
    );

    const staleForExplicitCaller = await validateHistoryAccountingProof(
      {
        ...fixture.request,
        freshness: { now: currentTime, maxAgeMs: 60_000 },
      },
      { openConnection: fixture.open },
    );
    assert.equal(
      staleForExplicitCaller.ok && staleForExplicitCaller.value.reasonCodes[0],
      "FRESHNESS_EXCEEDED",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("proof validation refuses a self-hashed report whose accounting values were altered", async () => {
  const fixture = await setup();
  try {
    const connection = fixture.open({
      environment: "demo",
      databasePath: fixture.databasePath,
    });
    assert.equal(connection.ok, true);
    if (!connection.ok) return;
    const row = connection.value.db
      .prepare(
        "SELECT canonical_json FROM history_accounting_reports WHERE report_id = ?",
      )
      .get(fixture.report.reportId) as { canonical_json?: unknown } | undefined;
    assert.equal(typeof row?.canonical_json, "string");
    const stored = JSON.parse(String(row?.canonical_json)) as Record<
      string,
      unknown
    >;
    const epoch = stored.epoch as Record<string, unknown>;
    const currencies = epoch.currencies as Record<string, unknown>[];
    assert.ok(currencies.length > 0);
    const forgedWithoutHash: Record<string, unknown> = {
      ...stored,
      epoch: {
        ...epoch,
        currencies: [
          { ...currencies[0], transactionChange: "999999" },
          ...currencies.slice(1),
        ],
      },
    };
    delete forgedWithoutHash.contentHash;
    const forgedHash = hashCanonical(forgedWithoutHash);
    assert.equal(forgedHash.ok, true);
    if (!forgedHash.ok) return;
    const forged = { ...forgedWithoutHash, contentHash: forgedHash.value };
    const canonical = canonicalSerialize(forged);
    assert.equal(canonical.ok, true);
    if (!canonical.ok) return;
    connection.value.db.exec(
      "DROP TRIGGER history_accounting_reports_no_update",
    );
    connection.value.db
      .prepare(
        "UPDATE history_accounting_reports SET content_hash = ?, canonical_json = ? WHERE report_id = ?",
      )
      .run(forgedHash.value, canonical.value, fixture.report.reportId);
    connection.value.close();

    const refused = await validateHistoryAccountingProof(fixture.request, {
      openConnection: fixture.open,
    });
    assert.equal(refused.ok && refused.value.decision, "REFUSE");
    assert.ok(
      refused.ok &&
        refused.value.reasonCodes.includes("RELEVANT_EVIDENCE_CHANGED"),
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("scoped proof refuses a self-hashed report whose accounting values were altered", async () => {
  const fixture = await setup(true);
  try {
    const request = asScopedRequest(fixture);
    const connection = fixture.open({
      environment: "demo",
      databasePath: fixture.databasePath,
    });
    assert.equal(connection.ok, true);
    if (!connection.ok) return;
    const row = connection.value.db
      .prepare(
        "SELECT canonical_json FROM history_accounting_reports WHERE report_id = ?",
      )
      .get(request.reportId) as { canonical_json?: unknown } | undefined;
    assert.equal(typeof row?.canonical_json, "string");
    if (typeof row?.canonical_json !== "string") return;
    const stored = JSON.parse(row.canonical_json) as Record<string, unknown>;
    const epoch = stored.epoch as Record<string, unknown>;
    const currencies = epoch.currencies as Record<string, unknown>[];
    assert.ok(currencies.length > 0);
    const forgedWithoutHash: Record<string, unknown> = {
      ...stored,
      epoch: {
        ...epoch,
        currencies: [
          { ...currencies[0], transactionChange: "999999" },
          ...currencies.slice(1),
        ],
      },
    };
    delete forgedWithoutHash.contentHash;
    const forgedHash = hashCanonical(forgedWithoutHash);
    assert.equal(forgedHash.ok, true);
    if (!forgedHash.ok) return;
    const forged = { ...forgedWithoutHash, contentHash: forgedHash.value };
    const canonical = canonicalSerialize(forged);
    assert.equal(canonical.ok, true);
    if (!canonical.ok) return;
    connection.value.db.exec(
      "DROP TRIGGER history_accounting_reports_no_update",
    );
    connection.value.db
      .prepare(
        "UPDATE history_accounting_reports SET content_hash = ?, canonical_json = ? WHERE report_id = ?",
      )
      .run(forgedHash.value, canonical.value, request.reportId);
    connection.value.close();

    const refused = await validateHistoryAccountingProof(request, {
      openConnection: fixture.open,
    });
    assert.equal(refused.ok && refused.value.decision, "REFUSE");
    assert.equal(
      refused.ok && refused.value.reasonCodes[0],
      "RELEVANT_EVIDENCE_CHANGED",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("legacy proof keeps stored-report corruption separate from missing caller anchors", async () => {
  const fixture = await setup();
  try {
    const connection = fixture.open({
      environment: "demo",
      databasePath: fixture.databasePath,
    });
    assert.equal(connection.ok, true);
    if (!connection.ok) return;
    connection.value.db.exec(
      "DROP TRIGGER history_accounting_reports_no_update",
    );
    connection.value.db
      .prepare(
        "UPDATE history_accounting_reports SET canonical_json = ? WHERE report_id = ?",
      )
      .run("{invalid", fixture.report.reportId);
    connection.value.close();

    const refused = await validateHistoryAccountingProof(
      {
        ...fixture.request,
        openingAnchorId: "missing-opening-anchor",
        closingAnchorId: "missing-closing-anchor",
      },
      { openConnection: fixture.open },
    );
    assert.equal(
      refused.ok && refused.value.reasonCodes[0],
      "REPORT_INTEGRITY_INVALID",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("proof validation ignores an out-of-epoch transaction but detects a late in-epoch transaction", async () => {
  const fixture = await setup();
  try {
    const connection = fixture.open({
      environment: "demo",
      databasePath: fixture.databasePath,
    });
    assert.equal(connection.ok, true);
    if (!connection.ok) return;
    const historyStore = createSqliteHistoryStore(connection.value);
    const openingMs = Date.parse(openingBoundary);
    const closingMs = Date.parse(closingBoundary);
    const outOfEpochStart = closingMs + 60_000;
    const outOfEpochEnd = outOfEpochStart + 60_000;
    const outOfEpoch = historyStore.commitPage({
      scope: historyAccountingScope,
      source: "transaction-log",
      filters: {
        accountType: "UNIFIED",
        purpose: "backfill",
        rangeStartMs: outOfEpochStart,
        rangeEndMs: outOfEpochEnd,
      },
      window: { fromMs: outOfEpochStart, toMs: outOfEpochEnd },
      expectedRevision: 0,
      cursor: null,
      nextCursor: null,
      facts: [
        transferFact(
          "transfer-out-of-period",
          new Date(outOfEpochStart + 30_000).toISOString(),
        ),
      ],
    });
    assert.equal(
      outOfEpoch.ok,
      true,
      outOfEpoch.ok ? "" : outOfEpoch.error.message,
    );
    connection.value.close();

    const unchanged = await validateHistoryAccountingProof(fixture.request, {
      openConnection: fixture.open,
    });
    assert.equal(unchanged.ok && unchanged.value.decision, "ACCEPT");

    const relevantConnection = fixture.open({
      environment: "demo",
      databasePath: fixture.databasePath,
    });
    assert.equal(relevantConnection.ok, true);
    if (!relevantConnection.ok) return;
    const relevantStore = createSqliteHistoryStore(relevantConnection.value);
    const inEpoch = relevantStore.commitPage({
      scope: historyAccountingScope,
      source: "transaction-log",
      filters: {
        accountType: "UNIFIED",
        purpose: "backfill",
        rangeStartMs: fixture.coverageFromMs,
        rangeEndMs: fixture.coverageToMs,
      },
      window: {
        fromMs: fixture.coverageFromMs,
        toMs: fixture.coverageToMs,
      },
      expectedRevision: 1,
      cursor: null,
      nextCursor: null,
      facts: [
        transferFact(
          "transfer-late-in-period",
          new Date(openingMs + 5 * 60_000).toISOString(),
        ),
      ],
    });
    assert.equal(inEpoch.ok, true, inEpoch.ok ? "" : inEpoch.error.message);
    relevantConnection.value.close();

    const invalidated = await validateHistoryAccountingProof(fixture.request, {
      openConnection: fixture.open,
    });
    assert.equal(invalidated.ok && invalidated.value.decision, "REFUSE");
    assert.ok(
      invalidated.ok &&
        invalidated.value.reasonCodes.includes("RELEVANT_EVIDENCE_CHANGED"),
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("irrelevant out-of-epoch coverage preserves proof, while relevant coverage changes invalidate it", async () => {
  const fixture = await setup();
  try {
    const connection = fixture.open({
      environment: "demo",
      databasePath: fixture.databasePath,
    });
    assert.equal(connection.ok, true);
    if (!connection.ok) return;
    const historyStore = createSqliteHistoryStore(connection.value);
    const extraFrom = Date.parse(closingBoundary) + 60_000;
    const extraTo = extraFrom + 60_000;
    historyStore.commitPage({
      scope: historyAccountingScope,
      source: "order-history",
      filters: {
        category: "linear",
        purpose: "backfill",
        rangeStartMs: extraFrom,
        rangeEndMs: extraTo,
      },
      window: { fromMs: extraFrom, toMs: extraTo },
      expectedRevision: 0,
      cursor: null,
      nextCursor: null,
      facts: [],
    });
    connection.value.close();

    const stillCurrent = await validateHistoryAccountingProof(fixture.request, {
      openConnection: fixture.open,
    });
    assert.equal(stillCurrent.ok && stillCurrent.value.decision, "ACCEPT");

    const alteredConnection = fixture.open({
      environment: "demo",
      databasePath: fixture.databasePath,
    });
    assert.equal(alteredConnection.ok, true);
    if (!alteredConnection.ok) return;
    const alteredStore = createSqliteHistoryStore(alteredConnection.value);
    const checkpoint = alteredStore.listCoverage(historyAccountingScope);
    assert.equal(checkpoint.ok, true);
    const relevant =
      checkpoint.ok &&
      checkpoint.value.find((row) => row.source === "transaction-log");
    assert.ok(relevant);
    const changed = alteredStore.markCoverage({
      scope: historyAccountingScope,
      source: relevant!.source as HistoryReadSource,
      filters: relevant!.filters,
      window: relevant!.window,
      expectedRevision: relevant!.revision,
      status: "partial",
      reasonCode: "TEST_GAP",
    });
    assert.equal(changed.ok, true);
    alteredConnection.value.close();

    const invalidated = await validateHistoryAccountingProof(fixture.request, {
      openConnection: fixture.open,
    });
    assert.equal(
      invalidated.ok && invalidated.value.reasonCodes[0],
      "RELEVANT_EVIDENCE_CHANGED",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("scoped v2 proof accepts only the exact policy descriptor and reports its scope", async () => {
  const fixture = await setup(true);
  try {
    const request = asScopedRequest(fixture);
    const accepted = await validateHistoryAccountingProof(request, {
      openConnection: fixture.open,
    });
    assert.equal(accepted.ok, true, accepted.ok ? "" : accepted.error.message);
    assert.equal(accepted.ok && accepted.value.decision, "ACCEPT");
    assert.equal(accepted.ok && accepted.value.authority, "evidence-only");
    assert.ok(accepted.ok && "schemaVersion" in accepted.value);
    assert.deepEqual(
      accepted.ok && "accountingScope" in accepted.value
        ? accepted.value.accountingScope?.nativeCurrencies
        : undefined,
      ["USDT"],
    );
    assert.equal(
      accepted.ok && "accountingScopeHash" in accepted.value
        ? accepted.value.accountingScopeHash
        : undefined,
      request.accountingScopeHash,
    );

    const wrongAccount = await validateHistoryAccountingProof(
      {
        ...request,
        expectedScope: {
          ...request.expectedScope,
          accountId: `sha256:${"b".repeat(64)}`,
        },
      },
      { openConnection: fixture.open },
    );
    assert.equal(
      wrongAccount.ok && wrongAccount.value.reasonCodes[0],
      "SCOPE_MISMATCH",
    );
    const wrongEpoch = await validateHistoryAccountingProof(
      { ...request, closingAnchorId: "different-closing-anchor" },
      { openConnection: fixture.open },
    );
    assert.equal(
      wrongEpoch.ok && wrongEpoch.value.reasonCodes[0],
      "EPOCH_MISMATCH",
    );
    const requestedCoverageAndFreshness = await validateHistoryAccountingProof(
      {
        ...request,
        coverageThrough: closingBoundary,
        freshness: { now: currentTime, maxAgeMs: 5 * 24 * 60 * 60 * 1_000 },
      },
      { openConnection: fixture.open },
    );
    assert.equal(
      requestedCoverageAndFreshness.ok &&
        requestedCoverageAndFreshness.value.decision,
      "ACCEPT",
    );
    const stale = await validateHistoryAccountingProof(
      {
        ...request,
        freshness: { now: currentTime, maxAgeMs: 0 },
      },
      { openConnection: fixture.open },
    );
    assert.equal(stale.ok && stale.value.reasonCodes[0], "FRESHNESS_EXCEEDED");

    const otherPolicy = resolveHistoryAccountingScope(
      PROVISIONAL_M1_POLICY_VERSION,
    );
    assert.equal(otherPolicy.ok, true);
    if (!otherPolicy.ok) return;
    const wrongPolicy = await validateHistoryAccountingProof(
      {
        ...request,
        accountingScope: otherPolicy.value,
        accountingScopeHash: otherPolicy.value.scopeHash,
      },
      { openConnection: fixture.open },
    );
    assert.equal(
      wrongPolicy.ok && wrongPolicy.value.reasonCodes[0],
      "ACCOUNTING_SCOPE_MISMATCH",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("scoped proof refuses when anchor authentication is unavailable or invalid", async () => {
  const fixture = await setup(true);
  try {
    const request = asScopedRequest(fixture);
    const unavailable = await validateProof(request, {
      openConnection: fixture.open,
      anchorKeyProvider: {
        async read() {
          return {
            ok: false as const,
            error: domainError("INVALID_VALUE", "anchor key unavailable"),
          };
        },
      },
    });
    assert.equal(
      unavailable.ok && unavailable.value.reasonCodes[0],
      "ANCHOR_INTEGRITY_INVALID",
    );

    const invalidAuthenticator = await validateProof(request, {
      openConnection: fixture.open,
      anchorKeyProvider: {
        async read() {
          return {
            ok: true as const,
            value: new Uint8Array(32).fill(0x41),
          };
        },
      },
    });
    assert.equal(
      invalidAuthenticator.ok && invalidAuthenticator.value.reasonCodes[0],
      "ANCHOR_INTEGRITY_INVALID",
    );

    const connection = fixture.open({
      environment: "demo",
      databasePath: fixture.databasePath,
    });
    assert.equal(connection.ok, true);
    if (!connection.ok) return;
    connection.value.db.exec(
      "DROP TRIGGER history_accounting_wallet_anchors_no_delete",
    );
    connection.value.db.exec("PRAGMA foreign_keys = OFF");
    connection.value.db
      .prepare(
        "DELETE FROM history_accounting_wallet_anchors WHERE anchor_id = ?",
      )
      .run(request.openingAnchorId);
    connection.value.close();
    const missingAnchor = await validateHistoryAccountingProof(request, {
      openConnection: fixture.open,
    });
    assert.equal(
      missingAnchor.ok && missingAnchor.value.reasonCodes[0],
      "ANCHOR_NOT_FOUND",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("proof replay refuses a v2 report with mixed nested epoch versions", async () => {
  const fixture = await setup(true);
  try {
    const request = asScopedRequest(fixture);
    const connection = fixture.open({
      environment: "demo",
      databasePath: fixture.databasePath,
    });
    assert.equal(connection.ok, true);
    if (!connection.ok) return;
    const row = connection.value.db
      .prepare(
        "SELECT canonical_json FROM history_accounting_reports WHERE report_id = ?",
      )
      .get(request.reportId) as { canonical_json?: unknown } | undefined;
    assert.equal(typeof row?.canonical_json, "string");
    if (typeof row?.canonical_json !== "string") return;
    const corrupted = JSON.parse(row.canonical_json) as Record<string, unknown>;
    const epoch = corrupted.epoch as Record<string, unknown>;
    corrupted.epoch = {
      ...epoch,
      schemaVersion: "history-accounting-epoch-projection/v1",
    };
    delete corrupted.contentHash;
    const contentHash = hashCanonical(corrupted);
    assert.equal(contentHash.ok, true);
    if (!contentHash.ok) return;
    corrupted.contentHash = contentHash.value;
    const canonical = canonicalSerialize(corrupted);
    assert.equal(canonical.ok, true);
    if (!canonical.ok) return;
    connection.value.db.exec(
      "DROP TRIGGER history_accounting_reports_no_update",
    );
    connection.value.db
      .prepare(
        "UPDATE history_accounting_reports SET content_hash = ?, canonical_json = ? WHERE report_id = ?",
      )
      .run(contentHash.value, canonical.value, request.reportId);
    connection.value.close();

    const refused = await validateHistoryAccountingProof(request, {
      openConnection: fixture.open,
    });
    assert.equal(
      refused.ok && refused.value.reasonCodes[0],
      "REPORT_INTEGRITY_INVALID",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("legacy and scoped proof requests cannot promote reports across versions", async () => {
  const scopedFixture = await setup(true);
  try {
    const scoped = asScopedRequest(scopedFixture);
    const legacyRequest = {
      environment: scoped.environment,
      databasePath: scoped.databasePath,
      reportId: scoped.reportId,
      expectedScope: scoped.expectedScope,
      openingAnchorId: scoped.openingAnchorId,
      closingAnchorId: scoped.closingAnchorId,
      dependencyHash: scoped.dependencyHash,
      ...(scoped.coverageThrough === undefined
        ? {}
        : { coverageThrough: scoped.coverageThrough }),
      ...(scoped.freshness === undefined
        ? {}
        : { freshness: scoped.freshness }),
    };
    const legacyAgainstScoped = await validateHistoryAccountingProof(
      legacyRequest,
      { openConnection: scopedFixture.open },
    );
    assert.equal(
      legacyAgainstScoped.ok && legacyAgainstScoped.value.reasonCodes[0],
      "REPORT_VERSION_MISMATCH",
    );
  } finally {
    rmSync(scopedFixture.root, { recursive: true, force: true });
  }

  const legacyFixture = await setup();
  try {
    const accountingScope = resolveHistoryAccountingScope(
      OPERATOR_MAINNET_TEST_POLICY_VERSION,
    );
    assert.equal(accountingScope.ok, true);
    if (!accountingScope.ok) return;
    const scopedAgainstLegacy = await validateHistoryAccountingProof(
      {
        ...legacyFixture.request,
        schemaVersion: "history-accounting-proof-request/v2",
        accountingScope: accountingScope.value,
        accountingScopeHash: accountingScope.value.scopeHash,
      },
      { openConnection: legacyFixture.open },
    );
    assert.equal(
      scopedAgainstLegacy.ok && scopedAgainstLegacy.value.reasonCodes[0],
      "REPORT_VERSION_MISMATCH",
    );
  } finally {
    rmSync(legacyFixture.root, { recursive: true, force: true });
  }
});

test("scoped proof rejects forged capabilities, unknown versions and NOT_READY reports", async () => {
  const fixture = await setup(true);
  try {
    const request = asScopedRequest(fixture);
    const forgedPayload = {
      schemaVersion: request.accountingScope.schemaVersion,
      policyIdentity: request.accountingScope.policyIdentity,
      policyVersion: request.accountingScope.policyVersion,
      productKind: request.accountingScope.productKind,
      accountingContractVersion:
        request.accountingScope.accountingContractVersion,
      nativeCurrencies: ["USDC", "USDT"],
    };
    const forgedHash = hashCanonical(forgedPayload);
    assert.equal(forgedHash.ok, true);
    if (!forgedHash.ok) return;
    const forgedScope = {
      ...forgedPayload,
      scopeHash: forgedHash.value,
    };
    const forged = await validateHistoryAccountingProof(
      {
        ...request,
        accountingScope: forgedScope,
        accountingScopeHash: forgedScope.scopeHash,
      },
      { openConnection: fixture.open },
    );
    assert.equal(
      forged.ok && forged.value.reasonCodes[0],
      "ACCOUNTING_SCOPE_INVALID",
    );

    const unsupported = await validateHistoryAccountingProof(
      {
        ...request,
        schemaVersion: "history-accounting-proof-request/v99",
      } as unknown as HistoryAccountingProofRequestV2,
      { openConnection: fixture.open },
    );
    assert.equal(
      unsupported.ok && unsupported.value.reasonCodes[0],
      "UNSUPPORTED_PROOF_VERSION",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }

  const incompleteFixture = await setup(true, false);
  try {
    const notReady = await validateHistoryAccountingProof(
      asScopedRequest(incompleteFixture),
      { openConnection: incompleteFixture.open },
    );
    assert.equal(
      notReady.ok && notReady.value.reasonCodes[0],
      "REPORT_NOT_READY",
    );
  } finally {
    rmSync(incompleteFixture.root, { recursive: true, force: true });
  }
});

test("scoped proof ignores an independent MNT transfer but invalidates for new USDT evidence", async () => {
  const fixture = await setup(true);
  try {
    const request = asScopedRequest(fixture);
    appendTransaction(fixture, "technical-mnt-transfer", "MNT");
    const afterTechnicalArrival = await validateHistoryAccountingProof(
      request,
      { openConnection: fixture.open },
    );
    assert.equal(
      afterTechnicalArrival.ok && afterTechnicalArrival.value.decision,
      "ACCEPT",
      JSON.stringify(afterTechnicalArrival),
    );

    appendTransaction(fixture, "technical-mnt-transfer", "MNT", "101");
    const conflictConnection = fixture.open({
      environment: "demo",
      databasePath: fixture.databasePath,
    });
    assert.equal(conflictConnection.ok, true);
    if (!conflictConnection.ok) return;
    const conflictStore = createSqliteHistoryStore(conflictConnection.value);
    const conflictCheckpoint = conflictStore.listCoverage(
      historyAccountingScope,
      "transaction-log",
    );
    assert.equal(conflictCheckpoint.ok, true);
    if (!conflictCheckpoint.ok) return;
    const transactionCheckpoint = conflictCheckpoint.value.find(
      (checkpoint) =>
        checkpoint.window.fromMs === fixture.coverageFromMs &&
        checkpoint.window.toMs === fixture.coverageToMs,
    );
    assert.ok(transactionCheckpoint);
    if (!transactionCheckpoint) return;
    assert.equal(transactionCheckpoint.status, "traversed");
    assert.equal(transactionCheckpoint.reasonCode, "SOURCE_CONFLICT");
    // This is the terminal partial state recorded by runHistoryIngestion
    // after a conflicted page whose provider cursor is null.
    const markedPartial = conflictStore.markCoverage({
      scope: transactionCheckpoint.scope,
      source: transactionCheckpoint.source,
      filters: transactionCheckpoint.filters,
      window: transactionCheckpoint.window,
      expectedRevision: transactionCheckpoint.revision,
      status: "partial",
      reasonCode: "SOURCE_CONFLICT",
      cursor: null,
    });
    conflictConnection.value.close();
    assert.equal(
      markedPartial.ok,
      true,
      markedPartial.ok ? "" : markedPartial.error.message,
    );

    const replay = await reconcileHistoryAccounting(
      {
        environment: "demo",
        databasePath: fixture.databasePath,
        openingAnchorId: request.openingAnchorId,
        closingAnchorId: request.closingAnchorId,
        accountingPolicyVersion: OPERATOR_MAINNET_TEST_POLICY_VERSION,
      },
      { openConnection: fixture.open, anchorKeyProvider },
    );
    assert.equal(replay.ok, true, replay.ok ? "" : replay.error.message);
    assert.equal(replay.ok && replay.value.status, "ACCOUNTING_READY");
    assert.deepEqual(
      replay.ok &&
        replay.value.schemaVersion ===
          "history-accounting-reconciliation-report/v2"
        ? replay.value.dependencies
        : undefined,
      fixture.report.schemaVersion ===
        "history-accounting-reconciliation-report/v2"
        ? fixture.report.dependencies
        : undefined,
    );
    assert.equal(replay.ok && replay.value.reportId, fixture.report.reportId);
    assert.equal(
      replay.ok && replay.value.dependencyHash,
      fixture.report.dependencyHash,
    );
    assert.equal(
      replay.ok && replay.value.contentHash,
      fixture.report.contentHash,
    );
    const afterTechnicalRevision = await validateHistoryAccountingProof(
      request,
      { openConnection: fixture.open },
    );
    assert.equal(
      afterTechnicalRevision.ok && afterTechnicalRevision.value.decision,
      "ACCEPT",
      JSON.stringify(afterTechnicalRevision),
    );

    appendTransaction(fixture, "late-usdt-transfer", "USDT");
    const afterRelevantArrival = await validateHistoryAccountingProof(request, {
      openConnection: fixture.open,
    });
    assert.equal(
      afterRelevantArrival.ok && afterRelevantArrival.value.reasonCodes[0],
      "RELEVANT_EVIDENCE_CHANGED",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
