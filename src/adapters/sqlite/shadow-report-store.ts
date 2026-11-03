import {
  canonicalizeArtifactPayload,
  encodeCanonicalArtifact,
  rehydrateArtifact,
} from "../../domain/identity/canonical-artifact.js";
import type { ShadowMarketReport } from "../../domain/review/shadow-market-report.js";
import { domainError } from "../../domain/shared/errors.js";
import { fail, ok, type Result } from "../../domain/shared/result.js";
import { parseUtcTimestamp } from "../../domain/shared/time.js";
import { isRecord, requireHash } from "../../domain/shared/validation.js";
import type { ShadowReportStore } from "../../ports/shadow-report-store.js";
import {
  openSqliteConnection,
  type SqliteConnectionOptions,
} from "./connection.js";

interface ShadowReportRow {
  readonly content_hash?: unknown;
  readonly environment?: unknown;
  readonly canonical_json?: unknown;
  readonly canonical_hash?: unknown;
}

function persistenceFailure(message: string): Result<never> {
  return fail(domainError("PERSISTENCE_INTEGRITY", message));
}

/** Environment-bound public report store with append-only SQLite records. */
export function openSqliteShadowReportStore(
  options: SqliteConnectionOptions,
): Result<ShadowReportStore> {
  const opened = openSqliteConnection(options);
  if (!opened.ok) return opened;
  const connection = opened.value;

  function loadShadowReport(
    contentHash: string,
  ): Result<ShadowMarketReport | undefined> {
    const parsedHash = requireHash(contentHash, "shadowReportHash");
    if (!parsedHash.ok)
      return persistenceFailure("shadow report lookup hash is invalid");
    try {
      const row = connection.db
        .prepare(
          "SELECT content_hash, environment, canonical_json, canonical_hash FROM shadow_market_reports WHERE content_hash = ?",
        )
        .get(parsedHash.value) as ShadowReportRow | undefined;
      if (row === undefined) return ok(undefined);
      if (
        row.content_hash !== parsedHash.value ||
        row.environment !== connection.environment
      )
        return fail(
          domainError(
            "PERSISTENCE_ENVIRONMENT",
            "shadow report environment does not match the opened database",
          ),
        );
      if (
        typeof row.canonical_json !== "string" ||
        typeof row.canonical_hash !== "string" ||
        !requireHash(row.canonical_hash, "canonicalHash").ok
      )
        return persistenceFailure("stored shadow report envelope is invalid");
      const report = rehydrateArtifact("shadow-market-report", {
        artifactKind: "shadow-market-report",
        schemaVersion: "artifact/v1",
        canonicalJson: row.canonical_json,
        canonicalHash: row.canonical_hash,
      });
      if (!report.ok) {
        if (report.error.code === "UNSUPPORTED_CONTRACT") {
          let decoded: unknown;
          try {
            decoded = JSON.parse(row.canonical_json) as unknown;
          } catch {
            return persistenceFailure("stored shadow report is not valid JSON");
          }
          if (
            !isRecord(decoded) ||
            decoded.contentHash !== parsedHash.value ||
            decoded.environment !== connection.environment
          )
            return persistenceFailure("stored shadow report failed replay");
          const canonical = canonicalizeArtifactPayload(
            "shadow-market-report",
            decoded,
          );
          if (!canonical.ok || canonical.value !== row.canonical_json)
            return persistenceFailure("stored shadow report is not canonical");
          return report;
        }
        return persistenceFailure("stored shadow report failed replay");
      }
      if (
        report.value.contentHash !== parsedHash.value ||
        report.value.environment !== connection.environment
      )
        return persistenceFailure("stored shadow report failed replay");
      return report;
    } catch {
      return persistenceFailure("stored shadow report could not be read");
    }
  }

  function saveShadowReport(input: ShadowMarketReport): Result<void> {
    if (input.environment !== connection.environment)
      return fail(
        domainError(
          "PERSISTENCE_ENVIRONMENT",
          "shadow report environment does not match the opened database",
        ),
      );
    // The canonical registry replays the complete source graph before bytes
    // can enter the append-only table.
    const envelope = encodeCanonicalArtifact("shadow-market-report", input);
    if (!envelope.ok) return fail(envelope.error);
    const createdAt = parseUtcTimestamp(connection.clock.now());
    if (!createdAt.ok) return fail(createdAt.error);
    try {
      connection.db
        .prepare(
          `INSERT OR IGNORE INTO shadow_market_reports
           (content_hash, environment, canonical_json, canonical_hash, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.contentHash,
          input.environment,
          envelope.value.canonicalJson,
          envelope.value.canonicalHash,
          createdAt.value,
        );
      const stored = connection.db
        .prepare(
          "SELECT environment, canonical_json, canonical_hash FROM shadow_market_reports WHERE content_hash = ?",
        )
        .get(input.contentHash) as ShadowReportRow | undefined;
      if (
        stored === undefined ||
        stored.environment !== connection.environment ||
        stored.canonical_json !== envelope.value.canonicalJson ||
        stored.canonical_hash !== envelope.value.canonicalHash
      )
        return persistenceFailure("shadow report persistence did not verify");
      return ok(undefined);
    } catch {
      return persistenceFailure("shadow report could not be saved");
    }
  }

  return ok(
    Object.freeze({
      saveShadowReport,
      loadShadowReport,
      close: () => connection.close(),
    }),
  );
}
