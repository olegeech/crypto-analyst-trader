import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createSqliteHistoryAccountingWalletAnchorStore } from "../src/adapters/sqlite/history-accounting-anchor-store.js";
import { hashCanonical } from "../src/domain/identity/canonical-serialization.js";
import {
  openSqliteConnection,
  type SqliteConnection,
} from "../src/adapters/sqlite/connection.js";
import { applyMigrations } from "../src/adapters/sqlite/migrations.js";
import { registerTrustedClock } from "../src/adapters/sqlite/sqlite-helpers.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";
import type {
  AccountAssetEvidence,
  AccountEvidenceFact,
  AccountTotalsEvidence,
} from "../src/domain/account/account-evidence-bundle.js";
import type { UtcTimestamp } from "../src/domain/shared/time.js";
import type { HistoryStoreScope } from "../src/ports/history-store.js";
import type { HistoryAccountingWalletAnchor } from "../src/ports/history-accounting-anchor-store.js";
import {
  HISTORY_ACCOUNTING_TEST_AUTH_KEY,
  capturedWalletAnchorForStoreTest,
} from "./history-accounting-fixtures.js";

const runtime = { nodeVersion: "22.22.3", sqliteVersion: "3.51.3" } as const;
const at = (value: string) => value as UtcTimestamp;
const hashA = "sha256:" + "a".repeat(64);
const hashB = "sha256:" + "b".repeat(64);

function decimal(value: string): DecimalValue {
  const parsed = DecimalValue.fromString(value);
  if (!parsed.ok) throw new Error("invalid test decimal");
  return parsed.value;
}

function fact<const Unit extends "coin" | "USD" | "rate">(
  value: string,
  unit: Unit,
): AccountEvidenceFact<DecimalValue> & { readonly unit: Unit } {
  return { state: "known", value: decimal(value), unit };
}

const scope: HistoryStoreScope = {
  exchange: "bybit",
  environment: "demo",
  accountId: hashA,
};

const accountBinding = {
  exchange: "bybit",
  environment: "demo",
  origin: "https://api-demo.bybit.com",
  accountIdentityHash: hashA,
  authenticatedAt: at("2026-10-28T09:00:00.000Z"),
  identityVerified: true,
} as const;

const credentialPosture = {
  readOnly: true,
  permissions: {
    contractOrder: false,
    contractPosition: false,
    spotTrade: false,
    walletTransfer: false,
    withdraw: false,
  },
  ipBound: true,
  expiresAt: null,
  warnings: [],
} as const;

function asset(coin = "USDT"): AccountAssetEvidence {
  return {
    coin,
    walletBalance: fact("100", "coin"),
    equity: fact("100", "coin"),
    usdValue: fact("100", "USD"),
    usdEquity: fact("100", "USD"),
    locked: fact("0", "coin"),
    bonus: fact("0", "coin"),
    borrowAmount: fact("0", "coin"),
    spotBorrow: fact("0", "coin"),
    accruedInterest: fact("0", "coin"),
    totalOrderIM: fact("0", "USD"),
    totalPositionIM: fact("0", "USD"),
    totalPositionMM: fact("0", "USD"),
    unrealisedPnl: fact("0", "coin"),
    collateralEligible: { state: "known", value: true },
    collateralSwitch: { state: "known", value: true },
    restricted: { state: "known", value: "unrestricted" },
  };
}

const totals: AccountTotalsEvidence = {
  totalEquity: fact("100", "USD"),
  totalWalletBalance: fact("100", "USD"),
  totalMarginBalance: fact("100", "USD"),
  totalPerpUPL: fact("0", "USD"),
  totalAvailableBalance: fact("100", "USD"),
  totalInitialMargin: fact("0", "USD"),
  totalMaintenanceMargin: fact("0", "USD"),
  accountIMRate: fact("0", "rate"),
  accountMMRate: fact("0", "rate"),
  equityBasis: "unestablished",
};

type AnchorInput = Omit<
  HistoryAccountingWalletAnchor,
  "contentHash" | "recordedAt"
>;

function anchor(overrides: Partial<AnchorInput> = {}): AnchorInput {
  return {
    schemaVersion: "history-accounting-wallet-anchor/v1",
    anchorId: "wallet-opening-1",
    kind: "opening",
    scope,
    accountBinding,
    credentialPosture,
    capture: {
      identityEndpoint: "/v5/user/query-api",
      walletEndpoint: "/v5/account/wallet-balance",
      accountType: "UNIFIED",
      identityObservedAt: at("2026-10-28T09:01:10.000Z"),
      collectionStartedAt: at("2026-10-28T09:00:59.000Z"),
      collectionEndedAt: at("2026-10-28T09:02:00.000Z"),
      providerTimeBefore: at("2026-10-28T09:00:59.000Z"),
      providerResponseTime: at("2026-10-28T09:01:30.000Z"),
      providerTimeAfter: at("2026-10-28T09:02:01.000Z"),
    },
    totals,
    assets: [asset()],
    ...overrides,
  };
}

function memoryStore(environment: "demo" | "testnet" | "mainnet" = "demo") {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const migrations = applyMigrations(db);
  assert.equal(migrations.ok, true);
  const now = at("2026-10-28T09:05:00.000Z");
  const clock = { now: () => now };
  registerTrustedClock(db, clock);
  const connection: SqliteConnection = {
    db,
    path: ":memory:",
    environment,
    runtime,
    clock,
    close: () => db.close(),
  };
  return {
    db,
    store: createSqliteHistoryAccountingWalletAnchorStore(
      connection,
      HISTORY_ACCOUNTING_TEST_AUTH_KEY,
    ),
  };
}

test("append is immutable, hash-checked, and can replay after a database reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "history-wallet-anchor-"));
  const path = join(root, "history.db");
  const clock = { now: () => at("2026-10-28T09:05:00.000Z") };
  try {
    const firstConnection = openSqliteConnection({
      environment: "demo",
      databasePath: path,
      runtime,
      clock,
    });
    assert.equal(firstConnection.ok, true);
    if (!firstConnection.ok) return;
    const firstStore = createSqliteHistoryAccountingWalletAnchorStore(
      firstConnection.value,
      HISTORY_ACCOUNTING_TEST_AUTH_KEY,
    );
    const first = firstStore.append({
      anchor: capturedWalletAnchorForStoreTest(anchor()),
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.match(first.value.contentHash, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(first.value.recordedAt, at("2026-10-28T09:05:00.000Z"));
    const firstJson = JSON.stringify(first.value);
    firstConnection.value.close();

    const reopened = openSqliteConnection({
      environment: "demo",
      databasePath: path,
      runtime,
      clock,
    });
    assert.equal(reopened.ok, true);
    if (!reopened.ok) return;
    const reopenedStore = createSqliteHistoryAccountingWalletAnchorStore(
      reopened.value,
      HISTORY_ACCOUNTING_TEST_AUTH_KEY,
    );
    const replay = reopenedStore.append({
      anchor: capturedWalletAnchorForStoreTest(anchor()),
    });
    assert.equal(replay.ok, true);
    assert.equal(replay.ok && JSON.stringify(replay.value), firstJson);
    const byId = reopenedStore.readById("wallet-opening-1");
    assert.equal(byId.ok, true);
    assert.equal(byId.ok && byId.value?.scope.accountId, hashA);
    const read = reopenedStore.read(scope, "wallet-opening-1");
    assert.equal(read.ok, true);
    assert.equal(read.ok && JSON.stringify(read.value), firstJson);
    const listed = reopenedStore.list(scope);
    assert.equal(listed.ok, true);
    assert.equal(listed.ok && listed.value.length, 1);
    assert.equal(listed.ok && JSON.stringify(listed.value[0]), firstJson);
    reopened.value.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same anchor identity cannot be reused with changed evidence or another scope", () => {
  const { db, store } = memoryStore();
  assert.equal(
    store.append({ anchor: capturedWalletAnchorForStoreTest(anchor()) }).ok,
    true,
  );
  assert.equal(
    store.append({
      anchor: capturedWalletAnchorForStoreTest(
        anchor({
          totals: { ...totals, totalEquity: fact("101", "USD") },
        }),
      ),
    }).ok,
    false,
  );
  assert.equal(
    store.append({
      anchor: capturedWalletAnchorForStoreTest(
        anchor({
          scope: { ...scope, accountId: hashB },
          accountBinding: { ...accountBinding, accountIdentityHash: hashB },
        }),
      ),
    }).ok,
    false,
  );
  const original = store.readById("wallet-opening-1");
  assert.equal(original.ok, true);
  assert.equal(original.ok && original.value?.scope.accountId, hashA);
  db.close();
});

test("scope, verified account binding, environment, and provider origin must agree", () => {
  const { db, store } = memoryStore();
  assert.equal(
    store.append({
      anchor: anchor({
        scope: { ...scope, accountId: hashB },
      }),
    }).ok,
    false,
  );
  assert.equal(
    store.append({
      anchor: anchor({
        scope: { ...scope, environment: "testnet" },
        accountBinding: {
          ...accountBinding,
          environment: "testnet",
          origin: "https://api-demo.bybit.com",
        },
      }),
    }).ok,
    false,
  );
  assert.equal(
    store.read({ ...scope, environment: "testnet" }, "missing").ok,
    false,
  );
  assert.equal(store.list({ ...scope, exchange: "other" }).ok, false);
  db.close();
});

test("a caller-built verified-looking anchor cannot claim authenticated capture provenance", () => {
  const { db, store } = memoryStore();
  const appended = store.append({ anchor: anchor() });
  assert.equal(appended.ok, false);
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM history_accounting_wallet_anchors",
      )
      .get()?.count,
    0,
  );
  db.close();
});

test("append rejects invalid chronology, currency, facts, and duplicate asset coins", () => {
  const { db, store } = memoryStore();
  const good = anchor();
  assert.equal(
    store.append({
      anchor: anchor({
        capture: {
          ...good.capture,
          collectionEndedAt: at("2026-10-28T09:00:30.000Z"),
        },
      }),
    }).ok,
    false,
  );
  assert.equal(
    store.append({
      anchor: anchor({ assets: [asset("USDT$")] }),
    }).ok,
    false,
  );
  assert.equal(
    store.append({
      anchor: anchor({ assets: [asset(), asset()] }),
    }).ok,
    false,
  );
  assert.equal(
    store.append({
      anchor: anchor({
        totals: {
          ...totals,
          totalEquity: { ...fact("100", "USD"), unit: "coin" },
        } as unknown as AccountTotalsEvidence,
      }),
    }).ok,
    false,
  );
  assert.equal(
    store.append({
      anchor: anchor({
        capture: {
          ...good.capture,
          providerResponseTime: at("2026-10-28T09:00:58.000Z"),
        },
      }),
    }).ok,
    false,
  );
  db.close();
});

test("append rejects caller-supplied hashes, credentials, and raw provider payloads", () => {
  const { db, store } = memoryStore();
  const withPrivateFields = {
    ...anchor(),
    apiKey: "must-not-be-stored",
    rawProviderResponse: { secret: "must-not-be-stored" },
    contentHash: hashA,
    recordedAt: at("2026-10-28T09:03:00.000Z"),
  };
  assert.equal(store.append({ anchor: withPrivateFields as never }).ok, false);
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM history_accounting_wallet_anchors",
      )
      .get()?.count,
    0,
  );
  db.close();
});

test("read rejects altered stored JSON and altered canonical hash", () => {
  for (const column of ["canonical_json", "canonical_hash"] as const) {
    const { db, store } = memoryStore();
    assert.equal(
      store.append({ anchor: capturedWalletAnchorForStoreTest(anchor()) }).ok,
      true,
    );
    db.exec("DROP TRIGGER history_accounting_wallet_anchors_no_update");
    if (column === "canonical_json") {
      db.prepare(
        "UPDATE history_accounting_wallet_anchors SET canonical_json = '{}'",
      ).run();
    } else {
      db.prepare(
        "UPDATE history_accounting_wallet_anchors SET canonical_hash = ?",
      ).run("sha256:" + "f".repeat(64));
    }
    const result = store.readById("wallet-opening-1");
    assert.equal(result.ok, false);
    db.close();
  }
});

test("a self-hashed forged anchor is rejected without its Keychain capture MAC", () => {
  const { db, store } = memoryStore();
  assert.equal(
    store.append({ anchor: capturedWalletAnchorForStoreTest(anchor()) }).ok,
    true,
  );
  const row = db
    .prepare(
      "SELECT canonical_json FROM history_accounting_wallet_anchors WHERE anchor_id = ?",
    )
    .get("wallet-opening-1") as { canonical_json?: unknown } | undefined;
  assert.equal(typeof row?.canonical_json, "string");
  const forged = JSON.parse(String(row?.canonical_json)) as Record<
    string,
    unknown
  >;
  forged.kind = "closing";
  const selfConsistentHash = hashCanonical(forged);
  assert.equal(selfConsistentHash.ok, true);
  if (!selfConsistentHash.ok) return;
  db.exec("DROP TRIGGER history_accounting_wallet_anchors_no_update");
  db.prepare(
    "UPDATE history_accounting_wallet_anchors SET kind = ?, canonical_hash = ?, canonical_json = ? WHERE anchor_id = ?",
  ).run(
    "closing",
    selfConsistentHash.value,
    JSON.stringify(forged),
    "wallet-opening-1",
  );

  const result = store.readById("wallet-opening-1");
  assert.equal(result.ok, false);
  db.close();
});

test("the SQLite anchor rows cannot be updated or deleted", () => {
  const { db, store } = memoryStore();
  assert.equal(
    store.append({ anchor: capturedWalletAnchorForStoreTest(anchor()) }).ok,
    true,
  );
  assert.throws(
    () =>
      db
        .prepare(
          "UPDATE history_accounting_wallet_anchors SET kind = 'closing'",
        )
        .run(),
    /append-only/u,
  );
  assert.throws(
    () => db.prepare("DELETE FROM history_accounting_wallet_anchors").run(),
    /append-only/u,
  );
  db.close();
});
