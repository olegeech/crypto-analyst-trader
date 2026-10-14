import { createPreparedLegGridExecution } from "../domain/execution/prepared-leg-execution.js";
import type { PreparedLegGridExecution } from "../domain/execution/prepared-leg-execution.js";
import { hashCanonical } from "../domain/identity/canonical-serialization.js";
import { closedRecord } from "../domain/planning/planning-validation.js";
import { deepFreeze } from "../domain/shared/deep-freeze.js";
import { domainError } from "../domain/shared/errors.js";
import { fail, ok, type Result } from "../domain/shared/result.js";
import { parseUtcTimestamp } from "../domain/shared/time.js";
import { requireHash, requireIdentifier } from "../domain/shared/validation.js";
import type {
  PreparedLegRunSnapshot,
  PreparedLegReconciliationStatus,
} from "../ports/persistence.js";
import {
  acquireOrReuseMainnetLease,
  createMainnetPreparedLegForGrid,
  matchesScope,
  recoverMainnetPreparedLegSourceForGrid,
  type MainnetPreparedLegDependencies,
  type MainnetPreparedGridReconciliationContext,
} from "./mainnet-prepared-leg-boundary.js";

export const MAINNET_PREPARED_GRID_REPORT_VERSION =
  "prepared-grid-execution-report/v1" as const;

export type MainnetPreparedGridLegStatus =
  PreparedLegReconciliationStatus | "BLOCKED" | "NOT_ATTEMPTED";

export interface MainnetPreparedGridLegReport {
  readonly index: number;
  readonly legId: string;
  readonly clientOrderId: string;
  readonly sourceId: string;
  readonly status: MainnetPreparedGridLegStatus;
  readonly reasonCodes: readonly string[];
}

export interface MainnetPreparedGridReport {
  readonly schemaVersion: typeof MAINNET_PREPARED_GRID_REPORT_VERSION;
  readonly outcome: "completed" | "stopped" | "recovery-only";
  readonly approvalHash: string;
  readonly preparedHash: string;
  readonly reasonCodes: readonly string[];
  readonly legs: readonly MainnetPreparedGridLegReport[];
  readonly contentHash: string;
}

export type MainnetPreparedGridDependencies = MainnetPreparedLegDependencies;

function invalid(message: string) {
  return fail(domainError("INVALID_APPROVAL", message));
}

function fullLegRows(
  grid: PreparedLegGridExecution,
  statuses: ReadonlyMap<number, MainnetPreparedGridLegReport>,
): readonly MainnetPreparedGridLegReport[] {
  return grid.legs.map(
    (row) =>
      statuses.get(row.execution.leg.index) ??
      legReport(grid, row.execution.leg.index, "NOT_ATTEMPTED"),
  );
}

function createReport(input: {
  readonly outcome: MainnetPreparedGridReport["outcome"];
  readonly grid: PreparedLegGridExecution;
  readonly statuses: ReadonlyMap<number, MainnetPreparedGridLegReport>;
  readonly reasonCodes?: readonly string[];
}): Result<MainnetPreparedGridReport> {
  const payload = {
    schemaVersion: MAINNET_PREPARED_GRID_REPORT_VERSION,
    outcome: input.outcome,
    approvalHash: input.grid.approvalHash,
    preparedHash: input.grid.preparedHash,
    reasonCodes: [...new Set(input.reasonCodes ?? [])].sort(),
    legs: fullLegRows(input.grid, input.statuses),
  } as const;
  const contentHash = hashCanonical(payload);
  return contentHash.ok
    ? ok(deepFreeze({ ...payload, contentHash: contentHash.value }))
    : contentHash;
}

function legReport(
  grid: PreparedLegGridExecution,
  index: number,
  status: MainnetPreparedGridLegStatus,
  reasonCodes: readonly string[] = [],
): MainnetPreparedGridLegReport {
  const row = grid.legs[index]!;
  return Object.freeze({
    index: row.execution.leg.index,
    legId: row.execution.leg.legId,
    clientOrderId: row.execution.clientOrderId,
    sourceId: row.sourceId,
    status,
    reasonCodes: [...new Set(reasonCodes)].sort(),
  });
}

function releaseLease(
  dependencies: MainnetPreparedGridDependencies,
  authority: { readonly ownerRunId: string; readonly epoch: number },
): string | undefined {
  const released = dependencies.persistence.releaseLease(authority);
  return released.ok ? undefined : released.error.code;
}

function safeFailureCodes(error: {
  readonly code: string;
  readonly message: string;
}): string[] {
  const prefix = "GRID_CAPACITY_BLOCKED:";
  if (error.message.startsWith(prefix)) {
    const reasons = error.message
      .slice(prefix.length)
      .split(",")
      .filter((code) => /^[A-Z0-9_]+$/u.test(code));
    return ["GRID_CAPACITY_BLOCKED", ...reasons];
  }
  return /^[A-Z0-9_]+$/u.test(error.message) ? [error.message] : [error.code];
}

/**
 * Executes the entire exact approved grid in order. This is an application
 * coordinator, not a released CLI or a production authorization issuer.
 */
export async function createMainnetPreparedGrid(
  input: unknown,
  dependencies: MainnetPreparedGridDependencies,
): Promise<Result<MainnetPreparedGridReport>> {
  if (
    !closedRecord(input, ["approvalHash", "runId"]) ||
    Reflect.ownKeys(input).length !== 2
  )
    return invalid("grid create requires exact approvalHash and runId");
  const approvalHash = requireHash(input.approvalHash, "approvalHash");
  const runId = requireIdentifier(input.runId, "runId");
  if (!approvalHash.ok || !runId.ok)
    return invalid("grid create identity is invalid");
  const loaded = dependencies.artifacts.loadApproval(approvalHash.value);
  if (!loaded.ok) return loaded;
  if (!loaded.value)
    return fail(
      domainError("INVALID_APPROVAL", "exact approved artifact was not found"),
    );

  // approvedAt validates the immutable shape without using a machine clock as
  // exchange time. Each individual dispatch revalidates expiry against Bybit.
  const gridResult = createPreparedLegGridExecution({
    approval: loaded.value,
    approvalHash: approvalHash.value,
    now: loaded.value.approvedAt,
  });
  if (!gridResult.ok) return gridResult;
  const grid = gridResult.value;
  const firstLeg = grid.legs[0]?.execution;
  if (
    firstLeg === undefined ||
    !matchesScope(dependencies.persistence, firstLeg)
  )
    return invalid("approved grid does not match the selected Mainnet journal");

  const localNow = parseUtcTimestamp(dependencies.localClock.now());
  if (!localNow.ok) return localNow;
  const lease = acquireOrReuseMainnetLease(
    dependencies.persistence,
    runId.value,
    localNow.value,
  );
  if (!lease.ok) return lease;

  // Inspect every derived source before creating the first intent. Any durable
  // source forces the whole invocation into recovery-only mode.
  const existingSources = new Map<number, PreparedLegRunSnapshot>();
  for (const row of grid.legs) {
    const source = dependencies.preparedLegs.readPreparedLegSource(
      row.sourceId,
    );
    if (!source.ok) {
      const releaseFailure = releaseLease(dependencies, lease.value);
      return releaseFailure
        ? fail(
            domainError(
              source.error.code,
              `${source.error.message}; lease release failed: ${releaseFailure}`,
            ),
          )
        : source;
    }
    if (source.value)
      existingSources.set(row.execution.leg.index, source.value);
  }
  const existingIndexes = [...existingSources.keys()];
  if (existingIndexes.length > 0) {
    const statuses = new Map<number, MainnetPreparedGridLegReport>();
    const reasons: string[] = [];
    for (const index of existingIndexes) {
      const row = grid.legs[index]!;
      const otherActiveIndexes = existingIndexes.filter((candidate) => {
        if (candidate === index) return false;
        const previous =
          statuses.get(candidate)?.status ??
          existingSources.get(candidate)?.reconciliations.at(-1)?.status;
        return previous !== "CANCELLED" && previous !== "REJECTED";
      });
      const context = {
        grid,
        allowedLegIndexes: [...otherActiveIndexes, index].sort(
          (left, right) => left - right,
        ),
        currentLegIndex: index,
      } satisfies MainnetPreparedGridReconciliationContext;
      const recovered = await recoverMainnetPreparedLegSourceForGrid(
        { sourceId: row.sourceId, runId: runId.value },
        dependencies,
        context,
      );
      if (recovered.ok) {
        statuses.set(
          index,
          legReport(
            grid,
            index,
            recovered.value.status,
            recovered.value.reasonCodes,
          ),
        );
      } else {
        reasons.push(recovered.error.code);
        statuses.set(
          index,
          legReport(grid, index, "UNRESOLVED", [recovered.error.code]),
        );
      }
    }
    for (let index = 0; index < grid.legs.length; index += 1) {
      if (!statuses.has(index))
        statuses.set(
          index,
          legReport(grid, index, "NOT_ATTEMPTED", ["GRID_RECOVERY_ONLY"]),
        );
    }
    if (
      ![...statuses.values()].some(
        (row) =>
          row.status === "UNRESOLVED" || row.status === "PROTECTION_PENDING",
      )
    ) {
      const releaseFailure = releaseLease(dependencies, lease.value);
      if (releaseFailure) reasons.push(releaseFailure);
    }
    return createReport({
      outcome: "recovery-only",
      grid,
      statuses,
      reasonCodes: reasons,
    });
  }

  if (lease.value.reconciliationRequired) {
    const statuses = new Map<number, MainnetPreparedGridLegReport>();
    statuses.set(
      0,
      legReport(grid, 0, "BLOCKED", ["LEASE_RECONCILIATION_REQUIRED"]),
    );
    return createReport({
      outcome: "stopped",
      grid,
      statuses,
      reasonCodes: ["LEASE_RECONCILIATION_REQUIRED"],
    });
  }
  const halt = dependencies.persistence.readHalt();
  if (!halt.ok) {
    const releaseFailure = releaseLease(dependencies, lease.value);
    return releaseFailure
      ? fail(
          domainError(
            halt.error.code,
            `${halt.error.message}; lease release failed: ${releaseFailure}`,
          ),
        )
      : halt;
  }
  if (halt.value.active) {
    const statuses = new Map<number, MainnetPreparedGridLegReport>();
    statuses.set(0, legReport(grid, 0, "BLOCKED", ["HALT_ACTIVE"]));
    const releaseFailure = releaseLease(dependencies, lease.value);
    return createReport({
      outcome: "stopped",
      grid,
      statuses,
      reasonCodes: ["HALT_ACTIVE", ...(releaseFailure ? [releaseFailure] : [])],
    });
  }

  const statuses = new Map<number, MainnetPreparedGridLegReport>();
  for (let index = 0; index < grid.legs.length; index += 1) {
    const row = grid.legs[index]!;
    const created = await createMainnetPreparedLegForGrid(
      {
        approvalHash: approvalHash.value,
        legId: row.execution.leg.legId,
        runId: runId.value,
      },
      dependencies,
      { grid, currentLegIndex: index },
    );
    if (!created.ok) {
      const durable = dependencies.preparedLegs.readPreparedLegSource(
        row.sourceId,
      );
      const priorStatus =
        durable.ok && durable.value
          ? durable.value.reconciliations.at(-1)?.status
          : undefined;
      const status: MainnetPreparedGridLegStatus =
        priorStatus ??
        (durable.ok
          ? durable.value
            ? "UNRESOLVED"
            : "BLOCKED"
          : "UNRESOLVED");
      const errorCodes = safeFailureCodes(created.error);
      statuses.set(index, legReport(grid, index, status, errorCodes));
      const uncertain =
        status === "UNRESOLVED" || status === "PROTECTION_PENDING";
      const releaseFailure = uncertain
        ? undefined
        : releaseLease(dependencies, lease.value);
      return createReport({
        outcome: "stopped",
        grid,
        statuses,
        reasonCodes: [
          ...errorCodes,
          ...(releaseFailure ? [releaseFailure] : []),
        ],
      });
    }

    statuses.set(
      index,
      legReport(grid, index, created.value.status, created.value.reasonCodes),
    );
    if (created.value.kind === "recovery") {
      for (let suffix = index + 1; suffix < grid.legs.length; suffix += 1)
        statuses.set(
          suffix,
          legReport(grid, suffix, "NOT_ATTEMPTED", ["GRID_RECOVERY_ONLY"]),
        );
      const uncertain =
        created.value.status === "UNRESOLVED" ||
        created.value.status === "PROTECTION_PENDING";
      const releaseFailure = uncertain
        ? undefined
        : releaseLease(dependencies, lease.value);
      return createReport({
        outcome: "recovery-only",
        grid,
        statuses,
        reasonCodes: [
          "GRID_RECOVERY_ONLY",
          ...created.value.reasonCodes,
          ...(releaseFailure ? [releaseFailure] : []),
        ],
      });
    }
    if (created.value.status !== "CONFIRMED_OPEN") {
      const uncertain =
        created.value.status === "UNRESOLVED" ||
        created.value.status === "PROTECTION_PENDING";
      const releaseFailure = uncertain
        ? undefined
        : releaseLease(dependencies, lease.value);
      return createReport({
        outcome: "stopped",
        grid,
        statuses,
        reasonCodes: [
          ...created.value.reasonCodes,
          ...(releaseFailure ? [releaseFailure] : []),
        ],
      });
    }
  }

  const releaseFailure = releaseLease(dependencies, lease.value);
  return createReport({
    outcome: releaseFailure ? "stopped" : "completed",
    grid,
    statuses,
    reasonCodes: releaseFailure ? [releaseFailure] : [],
  });
}
