import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openSqliteConnection } from "../src/adapters/sqlite/connection.js";
import { createSqliteHistoryAccountingWalletAnchorStore } from "../src/adapters/sqlite/history-accounting-anchor-store.js";
import { createSqliteHistoryStore } from "../src/adapters/sqlite/history-store.js";
import { reconcileHistoryAccounting } from "../src/application/history-accounting-composition.js";
import { validateHistoryAccountingProof as validateProof } from "../src/application/history-accounting-proof.js";
import { createHistorySourceFact } from "../src/domain/accounting/history-source-fact.js";
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

function transferFact(transactionId: string, providerEventTime: string) {
  const fact = createHistorySourceFact({
    factKind: "transaction",
    source: "transaction-log",
    transactionId,
    category: null,
    symbol: null,
    side: null,
    currency: "USDT",
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
    cashBalance: "100",
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

async function setup() {
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
  const openingAnchor = capturedWalletAnchorForStoreTest({
    ...walletAnchor("opening", openingBoundary),
    anchorId: "proof-opening",
  });
  const closingAnchor = capturedWalletAnchorForStoreTest({
    ...walletAnchor("closing", closingBoundary),
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

  const report = reconcileHistoryAccounting(
    {
      environment: "demo",
      databasePath,
      openingAnchorId: opening.value.anchorId,
      closingAnchorId: closing.value.anchorId,
    },
    { openConnection: open, anchorKeyProvider },
  );
  const reconciled = await report;
  assert.equal(
    reconciled.ok,
    true,
    reconciled.ok ? "" : reconciled.error.message,
  );
  if (!reconciled.ok) throw new Error("test report could not be reconciled");
  assert.equal(reconciled.value.status, "ACCOUNTING_READY");
  const request = {
    environment: "demo" as const,
    databasePath,
    reportId: reconciled.value.reportId,
    expectedScope: historyAccountingScope,
    openingAnchorId: opening.value.anchorId,
    closingAnchorId: closing.value.anchorId,
    dependencyHash: reconciled.value.dependencyHash,
  };
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
