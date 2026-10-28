import {
  createAccountAssetEvidence,
  createAccountBinding,
  createAccountCredentialPosture,
  createAccountCriticalPass,
  type AccountAssetEvidence,
  type AccountTotalsEvidence,
} from "../../domain/account/account-evidence-bundle.js";
import { deepFreeze } from "../../domain/shared/deep-freeze.js";
import { domainError } from "../../domain/shared/errors.js";
import { fail, ok, type Result } from "../../domain/shared/result.js";
import { hashCanonical } from "../../domain/identity/canonical-serialization.js";
import {
  parseUtcTimestamp,
  type UtcTimestamp,
} from "../../domain/shared/time.js";
import {
  requireHash,
  requireIdentifier,
} from "../../domain/shared/validation.js";
import type { SqliteConnection } from "./connection.js";
import {
  isEnvironment,
  storedHash,
  storedString,
  trustedNow,
  type SqliteRow,
} from "./sqlite-helpers.js";
import { runInTransaction, sqliteError } from "./transaction.js";
import type {
  HistoryAccountingWalletAnchor,
  HistoryAccountingWalletAnchorStorePort,
} from "../../ports/history-accounting-anchor-store.js";
import {
  isAuthenticatedWalletAnchorCapture,
  authenticateWalletAnchorCapture,
  walletAnchorCaptureMac,
} from "../../ports/history-accounting-anchor-capture-provenance.js";
import { verifyHistoryAccountingAnchorMac } from "../../application/history-accounting-anchor-authentication.js";
import type { HistoryStoreScope } from "../../ports/history-store.js";

type AnchorInput = Omit<
  HistoryAccountingWalletAnchor,
  "contentHash" | "recordedAt"
>;
type StoredAnchorInput = Omit<HistoryAccountingWalletAnchor, "contentHash">;
type RecordValue = Record<string, unknown>;

const ANCHOR_KEYS = [
  "schemaVersion",
  "anchorId",
  "kind",
  "scope",
  "accountBinding",
  "credentialPosture",
  "capture",
  "totals",
  "assets",
] as const;
const STORED_ANCHOR_KEYS = [...ANCHOR_KEYS, "recordedAt"] as const;
const SCOPE_KEYS = ["exchange", "environment", "accountId"] as const;
const CAPTURE_KEYS = [
  "identityEndpoint",
  "walletEndpoint",
  "accountType",
  "identityObservedAt",
  "collectionStartedAt",
  "collectionEndedAt",
  "providerTimeBefore",
  "providerResponseTime",
  "providerTimeAfter",
] as const;
function invalidAnchor(): Result<never> {
  return fail(
    domainError("INVALID_EVIDENCE", "wallet anchor evidence is invalid"),
  );
}

function integrityFailure(): Result<never> {
  return fail(
    domainError(
      "PERSISTENCE_INTEGRITY",
      "stored wallet anchor evidence failed validation",
    ),
  );
}

function isPlainRecord(value: unknown): value is RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) =>
      Object.hasOwn(descriptor, "value"),
    )
  );
}

function hasExactKeys(value: RecordValue, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.length &&
    ownKeys.every((key) => typeof key === "string" && keys.includes(key))
  );
}

function parseScope(value: unknown): Result<HistoryStoreScope> {
  if (!isPlainRecord(value) || !hasExactKeys(value, SCOPE_KEYS))
    return invalidAnchor();
  const exchange = requireIdentifier(value.exchange, "exchange");
  const accountId = requireHash(value.accountId, "accountId");
  if (!exchange.ok || !accountId.ok) return invalidAnchor();
  if (exchange.value !== "bybit" || !isEnvironment(value.environment))
    return invalidAnchor();
  return ok({
    exchange: exchange.value,
    environment: value.environment,
    accountId: accountId.value,
  });
}

function validateConnectionScope(
  connection: SqliteConnection,
  value: unknown,
): Result<HistoryStoreScope> {
  const scope = parseScope(value);
  if (!scope.ok) return scope;
  if (scope.value.environment !== connection.environment) {
    return fail(
      domainError(
        "PERSISTENCE_ENVIRONMENT",
        "wallet anchor scope does not match the open SQLite journal",
      ),
    );
  }
  return scope;
}

function parseTimestamp(value: unknown): Result<UtcTimestamp> {
  const timestamp = parseUtcTimestamp(value);
  return timestamp.ok ? timestamp : invalidAnchor();
}

function parseCapture(value: unknown): Result<AnchorInput["capture"]> {
  if (!isPlainRecord(value) || !hasExactKeys(value, CAPTURE_KEYS))
    return invalidAnchor();
  if (
    value.identityEndpoint !== "/v5/user/query-api" ||
    value.walletEndpoint !== "/v5/account/wallet-balance" ||
    value.accountType !== "UNIFIED"
  )
    return invalidAnchor();
  const identityObservedAt = parseTimestamp(value.identityObservedAt);
  const collectionStartedAt = parseTimestamp(value.collectionStartedAt);
  const collectionEndedAt = parseTimestamp(value.collectionEndedAt);
  const providerTimeBefore = parseTimestamp(value.providerTimeBefore);
  const providerResponseTime = parseTimestamp(value.providerResponseTime);
  const providerTimeAfter = parseTimestamp(value.providerTimeAfter);
  if (
    !identityObservedAt.ok ||
    !collectionStartedAt.ok ||
    !collectionEndedAt.ok ||
    !providerTimeBefore.ok ||
    !providerResponseTime.ok ||
    !providerTimeAfter.ok
  )
    return invalidAnchor();
  if (
    Date.parse(providerTimeBefore.value) >
      Date.parse(collectionStartedAt.value) ||
    Date.parse(collectionStartedAt.value) >
      Date.parse(identityObservedAt.value) ||
    Date.parse(identityObservedAt.value) >
      Date.parse(providerResponseTime.value) ||
    Date.parse(providerResponseTime.value) >
      Date.parse(collectionEndedAt.value) ||
    Date.parse(collectionEndedAt.value) > Date.parse(providerTimeAfter.value) ||
    Date.parse(providerTimeBefore.value) >
      Date.parse(providerResponseTime.value) ||
    Date.parse(providerResponseTime.value) > Date.parse(providerTimeAfter.value)
  )
    return invalidAnchor();
  return ok({
    identityEndpoint: "/v5/user/query-api",
    walletEndpoint: "/v5/account/wallet-balance",
    accountType: "UNIFIED",
    identityObservedAt: identityObservedAt.value,
    collectionStartedAt: collectionStartedAt.value,
    collectionEndedAt: collectionEndedAt.value,
    providerTimeBefore: providerTimeBefore.value,
    providerResponseTime: providerResponseTime.value,
    providerTimeAfter: providerTimeAfter.value,
  });
}

function parseAssets(value: unknown): Result<readonly AccountAssetEvidence[]> {
  if (
    !Array.isArray(value) ||
    value.length > 10_000 ||
    Object.keys(value).length !== value.length ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some(
      (descriptor) => !Object.hasOwn(descriptor, "value"),
    )
  )
    return invalidAnchor();
  const assets: AccountAssetEvidence[] = [];
  const seenCoins = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!isPlainRecord(item) || typeof item.coin !== "string")
      return invalidAnchor();
    if (seenCoins.has(item.coin)) return invalidAnchor();
    seenCoins.add(item.coin);
    const parsed = createAccountAssetEvidence(item);
    if (!parsed.ok) return invalidAnchor();
    assets.push(parsed.value);
  }
  return ok(assets);
}

function parseTotalsAndAssets(
  totalsValue: unknown,
  assetsValue: unknown,
): Result<{
  readonly totals: AccountTotalsEvidence;
  readonly assets: readonly AccountAssetEvidence[];
}> {
  const assets = parseAssets(assetsValue);
  if (!assets.ok) return assets;
  // The domain's public critical-pass parser is the single schema authority
  // for the complete totals object and each mapped wallet-asset shape.
  const unavailable = { state: "unavailable", reason: "not-returned" };
  const validated = createAccountCriticalPass({
    account: {
      utaStatus: unavailable,
      marginMode: unavailable,
      spotHedging: unavailable,
    },
    totals: totalsValue,
    assets: assets.value,
    collateral: [],
    positions: [],
    orders: [],
    modeProbes: [],
    observations: [],
  });
  if (!validated.ok) return invalidAnchor();
  return ok({ totals: validated.value.totals, assets: assets.value });
}

function normalizeAnchorPayload(value: unknown): Result<AnchorInput> {
  if (!isPlainRecord(value) || !hasExactKeys(value, ANCHOR_KEYS))
    return invalidAnchor();
  if (value.schemaVersion !== "history-accounting-wallet-anchor/v1")
    return invalidAnchor();
  const anchorId = requireIdentifier(value.anchorId, "anchorId");
  if (!anchorId.ok || (value.kind !== "opening" && value.kind !== "closing"))
    return invalidAnchor();
  const scope = parseScope(value.scope);
  if (!scope.ok) return invalidAnchor();
  const accountBinding = createAccountBinding(value.accountBinding);
  const credentialPosture = createAccountCredentialPosture(
    value.credentialPosture,
  );
  const capture = parseCapture(value.capture);
  if (!accountBinding.ok || !credentialPosture.ok || !capture.ok)
    return invalidAnchor();
  if (
    accountBinding.value.exchange !== scope.value.exchange ||
    accountBinding.value.environment !== scope.value.environment ||
    accountBinding.value.accountIdentityHash !== scope.value.accountId
  )
    return invalidAnchor();
  const totalsAndAssets = parseTotalsAndAssets(value.totals, value.assets);
  if (!totalsAndAssets.ok) return invalidAnchor();
  return ok(
    deepFreeze({
      schemaVersion: "history-accounting-wallet-anchor/v1",
      anchorId: anchorId.value,
      kind: value.kind,
      scope: scope.value,
      accountBinding: accountBinding.value,
      credentialPosture: credentialPosture.value,
      capture: capture.value,
      totals: totalsAndAssets.value.totals,
      assets: totalsAndAssets.value.assets,
    }),
  );
}

function normalizeStoredAnchor(value: unknown): Result<StoredAnchorInput> {
  if (!isPlainRecord(value) || !hasExactKeys(value, STORED_ANCHOR_KEYS))
    return invalidAnchor();
  const payload: RecordValue = {};
  for (const key of ANCHOR_KEYS) payload[key] = value[key];
  const normalized = normalizeAnchorPayload(payload);
  const recordedAt = parseTimestamp(value.recordedAt);
  if (!normalized.ok || !recordedAt.ok) return invalidAnchor();
  return ok(deepFreeze({ ...normalized.value, recordedAt: recordedAt.value }));
}

function exactAnchor(
  value: StoredAnchorInput,
  contentHash: string,
): HistoryAccountingWalletAnchor {
  return deepFreeze({ ...value, contentHash });
}

function parseStoredAnchor(
  row: SqliteRow,
  authenticationKey: Uint8Array,
): Result<HistoryAccountingWalletAnchor> {
  const canonicalJson = storedString(row, "canonical_json");
  const canonicalHash = storedHash(row, "canonical_hash");
  if (!canonicalJson.ok || !canonicalHash.ok) return integrityFailure();
  let decoded: unknown;
  try {
    decoded = JSON.parse(canonicalJson.value) as unknown;
  } catch {
    return integrityFailure();
  }
  const normalized = normalizeStoredAnchor(decoded);
  if (!normalized.ok) return integrityFailure();
  const reserialized = JSON.stringify(normalized.value);
  const recomputed = hashCanonical(normalized.value);
  if (
    !recomputed.ok ||
    reserialized !== canonicalJson.value ||
    recomputed.value !== canonicalHash.value
  )
    return integrityFailure();

  const exchange = storedString(row, "exchange");
  const environment = storedString(row, "environment");
  const accountId = storedString(row, "account_id");
  const anchorId = storedString(row, "anchor_id");
  const kind = storedString(row, "kind");
  const origin = storedString(row, "identity_origin");
  const identityObservedAt = storedString(row, "identity_observed_at");
  const collectionStartedAt = storedString(row, "collection_started_at");
  const collectionEndedAt = storedString(row, "collection_ended_at");
  const providerTimeBefore = storedString(row, "provider_time_before");
  const providerResponseTime = storedString(row, "provider_response_time");
  const providerTimeAfter = storedString(row, "provider_time_after");
  const recordedAt = storedString(row, "recorded_at");
  const captureMac = storedString(row, "capture_mac");
  const anchor = normalized.value;
  if (
    !exchange.ok ||
    !environment.ok ||
    !accountId.ok ||
    !anchorId.ok ||
    !kind.ok ||
    !origin.ok ||
    !identityObservedAt.ok ||
    !collectionStartedAt.ok ||
    !collectionEndedAt.ok ||
    !providerTimeBefore.ok ||
    !providerResponseTime.ok ||
    !providerTimeAfter.ok ||
    !recordedAt.ok ||
    !captureMac.ok ||
    exchange.value !== anchor.scope.exchange ||
    environment.value !== anchor.scope.environment ||
    accountId.value !== anchor.scope.accountId ||
    anchorId.value !== anchor.anchorId ||
    kind.value !== anchor.kind ||
    origin.value !== anchor.accountBinding.origin ||
    identityObservedAt.value !== anchor.capture.identityObservedAt ||
    collectionStartedAt.value !== anchor.capture.collectionStartedAt ||
    collectionEndedAt.value !== anchor.capture.collectionEndedAt ||
    providerTimeBefore.value !== anchor.capture.providerTimeBefore ||
    providerResponseTime.value !== anchor.capture.providerResponseTime ||
    providerTimeAfter.value !== anchor.capture.providerTimeAfter ||
    recordedAt.value !== anchor.recordedAt
  )
    return integrityFailure();
  const { recordedAt: _recordedAt, ...capturePayload } = anchor;
  void _recordedAt;
  if (
    !verifyHistoryAccountingAnchorMac(
      capturePayload,
      captureMac.value,
      authenticationKey,
    )
  )
    return integrityFailure();
  const result = exactAnchor(anchor, canonicalHash.value);
  authenticateWalletAnchorCapture(result, captureMac.value, authenticationKey);
  return ok(result);
}

function scopeMatches(
  left: HistoryStoreScope,
  right: HistoryStoreScope,
): boolean {
  return (
    left.exchange === right.exchange &&
    left.environment === right.environment &&
    left.accountId === right.accountId
  );
}

function invalidId(): Result<never> {
  return fail(domainError("INVALID_IDENTIFIER", "anchor ID is invalid"));
}

class SqliteHistoryAccountingWalletAnchorStore implements HistoryAccountingWalletAnchorStorePort {
  public constructor(
    private readonly connection: SqliteConnection,
    private readonly authenticationKey: Uint8Array,
  ) {}

  public append(
    request: Parameters<HistoryAccountingWalletAnchorStorePort["append"]>[0],
  ): Result<HistoryAccountingWalletAnchor> {
    if (!isPlainRecord(request) || !hasExactKeys(request, ["anchor"]))
      return invalidAnchor();
    const anchorInput = normalizeAnchorPayload(request.anchor);
    if (!anchorInput.ok) return anchorInput;
    const captureMac = walletAnchorCaptureMac(request.anchor);
    if (
      captureMac === undefined ||
      !verifyHistoryAccountingAnchorMac(
        anchorInput.value,
        captureMac,
        this.authenticationKey,
      ) ||
      !isAuthenticatedWalletAnchorCapture(request.anchor)
    )
      return fail(
        domainError(
          "INVALID_EVIDENCE",
          "wallet anchor must come from the authenticated account capture flow",
        ),
      );
    const validatedScope = validateConnectionScope(
      this.connection,
      anchorInput.value.scope,
    );
    if (!validatedScope.ok) return validatedScope;
    const requestJson = JSON.stringify(anchorInput.value);
    if (requestJson === undefined) return invalidAnchor();

    return runInTransaction(
      this.connection.db,
      (database) => {
        const existing = database
          .prepare(
            "SELECT * FROM history_accounting_wallet_anchors WHERE anchor_id = ?",
          )
          .get(anchorInput.value.anchorId) as SqliteRow | undefined;
        if (existing !== undefined) {
          const parsed = parseStoredAnchor(existing, this.authenticationKey);
          if (!parsed.ok) return parsed;
          const {
            contentHash: _contentHash,
            recordedAt: _recordedAt,
            ...storedPayload
          } = parsed.value;
          void _contentHash;
          void _recordedAt;
          if (
            scopeMatches(parsed.value.scope, validatedScope.value) &&
            JSON.stringify(storedPayload) === requestJson
          ) {
            return ok(parsed.value);
          }
          return fail(
            domainError(
              "PERSISTENCE_CONFLICT",
              "wallet anchor ID already identifies different evidence",
            ),
          );
        }
        const recordedAt = trustedNow(database);
        if (!recordedAt.ok) return recordedAt;
        const storedAnchor: StoredAnchorInput = deepFreeze({
          ...anchorInput.value,
          recordedAt: recordedAt.value,
        });
        const contentHash = hashCanonical(storedAnchor);
        if (!contentHash.ok) return contentHash;
        const canonicalJson = JSON.stringify(storedAnchor);
        if (canonicalJson === undefined) return invalidAnchor();
        const result = exactAnchor(storedAnchor, contentHash.value);
        authenticateWalletAnchorCapture(
          result,
          captureMac,
          this.authenticationKey,
        );
        database
          .prepare(
            `INSERT INTO history_accounting_wallet_anchors
             (anchor_id, exchange, environment, account_id, kind, identity_origin,
              identity_observed_at, collection_started_at, collection_ended_at,
              provider_time_before, provider_response_time, provider_time_after,
              recorded_at, canonical_hash, canonical_json, capture_mac)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            result.anchorId,
            result.scope.exchange,
            result.scope.environment,
            result.scope.accountId,
            result.kind,
            result.accountBinding.origin,
            result.capture.identityObservedAt,
            result.capture.collectionStartedAt,
            result.capture.collectionEndedAt,
            result.capture.providerTimeBefore,
            result.capture.providerResponseTime,
            result.capture.providerTimeAfter,
            result.recordedAt,
            result.contentHash,
            canonicalJson,
            captureMac,
          );
        return ok(result);
      },
      "PERSISTENCE_INTEGRITY",
    );
  }

  public read(
    scope: HistoryStoreScope,
    anchorId: string,
  ): Result<HistoryAccountingWalletAnchor | undefined> {
    const validatedScope = validateConnectionScope(this.connection, scope);
    if (!validatedScope.ok) return validatedScope;
    const parsedId = requireIdentifier(anchorId, "anchorId");
    if (!parsedId.ok) return invalidId();
    try {
      const row = this.connection.db
        .prepare(
          `SELECT * FROM history_accounting_wallet_anchors
           WHERE exchange = ? AND environment = ? AND account_id = ? AND anchor_id = ?`,
        )
        .get(
          validatedScope.value.exchange,
          validatedScope.value.environment,
          validatedScope.value.accountId,
          parsedId.value,
        ) as SqliteRow | undefined;
      if (row === undefined) return ok(undefined);
      const parsed = parseStoredAnchor(row, this.authenticationKey);
      return parsed.ok && scopeMatches(parsed.value.scope, validatedScope.value)
        ? parsed
        : parsed.ok
          ? integrityFailure()
          : parsed;
    } catch (error) {
      return fail(sqliteError(error, "PERSISTENCE_INTEGRITY"));
    }
  }

  public readById(
    anchorId: string,
  ): Result<HistoryAccountingWalletAnchor | undefined> {
    const parsedId = requireIdentifier(anchorId, "anchorId");
    if (!parsedId.ok) return invalidId();
    try {
      const row = this.connection.db
        .prepare(
          "SELECT * FROM history_accounting_wallet_anchors WHERE anchor_id = ?",
        )
        .get(parsedId.value) as SqliteRow | undefined;
      if (row === undefined) return ok(undefined);
      const parsed = parseStoredAnchor(row, this.authenticationKey);
      if (!parsed.ok) return parsed;
      return parsed.value.scope.environment === this.connection.environment
        ? parsed
        : integrityFailure();
    } catch (error) {
      return fail(sqliteError(error, "PERSISTENCE_INTEGRITY"));
    }
  }

  public list(
    scope: HistoryStoreScope,
  ): Result<readonly HistoryAccountingWalletAnchor[]> {
    const validatedScope = validateConnectionScope(this.connection, scope);
    if (!validatedScope.ok) return validatedScope;
    try {
      const rows = this.connection.db
        .prepare(
          `SELECT * FROM history_accounting_wallet_anchors
           WHERE exchange = ? AND environment = ? AND account_id = ?
           ORDER BY recorded_at, anchor_id`,
        )
        .all(
          validatedScope.value.exchange,
          validatedScope.value.environment,
          validatedScope.value.accountId,
        ) as SqliteRow[];
      const anchors: HistoryAccountingWalletAnchor[] = [];
      for (const row of rows) {
        const parsed = parseStoredAnchor(row, this.authenticationKey);
        if (!parsed.ok) return parsed;
        if (!scopeMatches(parsed.value.scope, validatedScope.value))
          return integrityFailure();
        anchors.push(parsed.value);
      }
      return ok(deepFreeze(anchors));
    } catch (error) {
      return fail(sqliteError(error, "PERSISTENCE_INTEGRITY"));
    }
  }
}

export function createSqliteHistoryAccountingWalletAnchorStore(
  connection: SqliteConnection,
  authenticationKey: Uint8Array,
): HistoryAccountingWalletAnchorStorePort {
  return new SqliteHistoryAccountingWalletAnchorStore(
    connection,
    authenticationKey,
  );
}
