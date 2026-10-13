import assert from "node:assert/strict";
import test from "node:test";

import { createMainnetPreparedGrid } from "../src/application/mainnet-prepared-grid-boundary.js";
import { createMainnetPreparedLegForGrid } from "../src/application/mainnet-prepared-leg-boundary.js";
import { createExchangeOrder } from "../src/domain/execution/exchange-order.js";
import { domainError } from "../src/domain/shared/errors.js";
import { fail } from "../src/domain/shared/result.js";
import {
  accountWithAvailableBalance,
  setup,
  timestamp,
  unwrap,
} from "./fixtures/mainnet-prepared-grid-harness.js";

test("executes all four exact approved legs in order under one renewed lease", async () => {
  const state = setup();
  try {
    const result = await createMainnetPreparedGrid(
      { approvalHash: state.approval.contentHash, runId: "grid-run-success" },
      state.dependencies,
    );
    assert.equal(result.ok, true, result.ok ? "" : result.error.message);
    if (!result.ok) return;
    assert.equal(result.value.outcome, "completed");
    assert.deepEqual(
      result.value.legs.map((row) => row.status),
      ["CONFIRMED_OPEN", "CONFIRMED_OPEN", "CONFIRMED_OPEN", "CONFIRMED_OPEN"],
    );
    assert.deepEqual(
      state.exchange.createRequests.map((request) => request.clientOrderId),
      state.admittedGrid.legs.map((row) => row.execution.clientOrderId),
    );
    assert.ok(result.value.contentHash.startsWith("sha256:"));
    assert.deepEqual(
      result.value.legs.map((row) => row.index),
      [0, 1, 2, 3],
    );
    const leaseReads = state.leaseObservations;
    assert.ok(leaseReads.length >= 4);
    assert.equal(new Set(leaseReads.map((row) => row.epoch)).size, 1);
    assert.ok(
      Date.parse(leaseReads.at(-1)!.expiresAt) >
        Date.parse(leaseReads[0]!.expiresAt),
      "the same lease epoch must be renewed before a subsequent read",
    );
    assert.equal(
      unwrap(state.persistence.readScopeSnapshot()).lease,
      undefined,
    );
    assert.equal(unwrap(state.persistence.readHalt()).active, false);
  } finally {
    state.cleanup();
  }
});

test("exact attached TP child does not conflict with its approved open parent", async () => {
  const state = setup();
  try {
    const prefix = state.admittedGrid.legs[0]!.execution;
    state.exchange.afterCreate = (_request, index) => {
      if (index !== 0) return;
      state.exchange.additionalOpenOrders.push(
        unwrap(
          createExchangeOrder({
            exchangeOrderId: "grid-tp-child-0",
            clientOrderId: prefix.clientOrderId,
            parentOrderLinkId: prefix.clientOrderId,
            instrument: prefix.leg.intent.instrument,
            category: "linear",
            protectionType: "take-profit",
            side: "sell",
            requestedQuantity: prefix.leg.intent.quantity.toString(),
            filledQuantity: "0",
            status: "open",
            orderType: "market",
            triggerPrice: prefix.leg.intent.protection!.takeProfit!.toString(),
            reduceOnly: true,
            positionIdx: 0,
            observedAt: state.currentTime.value,
            source: "bybit-mainnet/realtime",
          }),
        ),
      );
    };
    const result = await createMainnetPreparedGrid(
      {
        approvalHash: state.approval.contentHash,
        runId: "grid-run-attached-tp",
      },
      state.dependencies,
    );
    assert.equal(result.ok, true, result.ok ? "" : result.error.message);
    if (!result.ok) return;
    assert.equal(result.value.outcome, "stopped");
    assert.deepEqual(
      result.value.legs.map((row) => row.status),
      ["CONFIRMED_OPEN", "BLOCKED", "NOT_ATTEMPTED", "NOT_ATTEMPTED"],
    );
    assert.ok(
      !result.value.legs[0]!.reasonCodes.includes(
        "ATTACHED_PROTECTION_CONTRADICTS_APPROVAL",
      ),
    );
    assert.equal(state.exchange.createRequests.length, 1);
  } finally {
    state.cleanup();
  }
});

test("refreshes capacity before each leg and stops after a later capacity block", async () => {
  const state = setup();
  try {
    state.accountsByOpenPrefixCount.set(
      1,
      accountWithAvailableBalance(state.account, "1"),
    );
    const result = await createMainnetPreparedGrid(
      { approvalHash: state.approval.contentHash, runId: "grid-run-capacity" },
      state.dependencies,
    );
    assert.equal(result.ok, true, result.ok ? "" : result.error.message);
    if (!result.ok) return;
    assert.equal(result.value.outcome, "stopped");
    assert.deepEqual(
      result.value.legs.map((row) => row.status),
      ["CONFIRMED_OPEN", "BLOCKED", "NOT_ATTEMPTED", "NOT_ATTEMPTED"],
    );
    assert.ok(result.value.legs[1]!.reasonCodes.includes("CAPACITY_EXCEEDED"));
    assert.equal(state.exchange.createRequests.length, 1);
  } finally {
    state.cleanup();
  }
});

test("uncertain durable-source read after a failed leg retains the lease", async () => {
  const state = setup();
  try {
    const store = state.dependencies.preparedLegs;
    const read = store.readPreparedLegSource.bind(store);
    let reads = 0;
    store.readPreparedLegSource = (sourceId) => {
      reads += 1;
      if (reads === 6)
        return fail(domainError("PERSISTENCE_INTEGRITY", "read unavailable"));
      return read(sourceId);
    };
    state.dependencies.evidence.collect = async () => {
      throw new Error("simulated evidence failure");
    };
    const result = await createMainnetPreparedGrid(
      {
        approvalHash: state.approval.contentHash,
        runId: "grid-run-read-failure",
      },
      state.dependencies,
    );
    assert.equal(result.ok, true, result.ok ? "" : result.error.message);
    if (!result.ok) return;
    assert.equal(result.value.legs[0]!.status, "UNRESOLVED");
    assert.equal(state.exchange.createRequests.length, 0);
    assert.equal(
      unwrap(state.persistence.readScopeSnapshot()).lease?.ownerRunId,
      "grid-run-read-failure",
    );
  } finally {
    state.cleanup();
  }
});

test("rejected second leg stops the suffix and reports every not-attempted leg", async () => {
  const state = setup();
  try {
    state.exchange.behaviorForDispatch = (index) =>
      index === 1 ? "rejected" : "open";
    const result = await createMainnetPreparedGrid(
      { approvalHash: state.approval.contentHash, runId: "grid-run-reject" },
      state.dependencies,
    );
    assert.equal(result.ok, true, result.ok ? "" : result.error.message);
    if (!result.ok) return;
    assert.equal(result.value.outcome, "stopped");
    assert.deepEqual(
      result.value.legs.map((row) => row.status),
      ["CONFIRMED_OPEN", "REJECTED", "NOT_ATTEMPTED", "NOT_ATTEMPTED"],
    );
    assert.equal(state.exchange.createRequests.length, 2);
    assert.equal(unwrap(state.persistence.readHalt()).active, false);
    assert.equal(result.value.reasonCodes.includes("RUN_LEASE_LOST"), false);
    assert.equal(
      unwrap(state.persistence.readScopeSnapshot()).lease,
      undefined,
    );

    const restarted = await createMainnetPreparedGrid(
      {
        approvalHash: state.approval.contentHash,
        runId: "grid-run-after-rejection",
      },
      state.dependencies,
    );
    assert.equal(
      restarted.ok,
      true,
      restarted.ok ? "" : restarted.error.message,
    );
    if (restarted.ok) {
      assert.equal(restarted.value.outcome, "recovery-only");
      assert.deepEqual(
        restarted.value.legs.map((row) => row.status),
        ["CONFIRMED_OPEN", "REJECTED", "NOT_ATTEMPTED", "NOT_ATTEMPTED"],
      );
    }
    assert.equal(state.exchange.createRequests.length, 2);
  } finally {
    state.cleanup();
  }
});

test("full fill on the second leg remains protection-pending and stops the suffix", async () => {
  const state = setup();
  try {
    state.exchange.behaviorForDispatch = (index) =>
      index === 1 ? "filled" : "open";
    const result = await createMainnetPreparedGrid(
      { approvalHash: state.approval.contentHash, runId: "grid-run-filled" },
      state.dependencies,
    );
    assert.equal(result.ok, true, result.ok ? "" : result.error.message);
    if (!result.ok) return;
    assert.equal(result.value.outcome, "stopped");
    assert.deepEqual(
      result.value.legs.map((row) => row.status),
      [
        "CONFIRMED_OPEN",
        "PROTECTION_PENDING",
        "NOT_ATTEMPTED",
        "NOT_ATTEMPTED",
      ],
    );
    assert.equal(state.exchange.createRequests.length, 2);
    assert.equal(unwrap(state.persistence.readHalt()).active, true);
  } finally {
    state.cleanup();
  }
});

test("zero-fill cancellation on the second leg stops without creating the suffix", async () => {
  const state = setup();
  try {
    state.exchange.behaviorForDispatch = (index) =>
      index === 1 ? "cancelled" : "open";
    const result = await createMainnetPreparedGrid(
      {
        approvalHash: state.approval.contentHash,
        runId: "grid-run-cancelled",
      },
      state.dependencies,
    );
    assert.equal(result.ok, true, result.ok ? "" : result.error.message);
    if (!result.ok) return;
    assert.equal(result.value.outcome, "stopped");
    assert.deepEqual(
      result.value.legs.map((row) => row.status),
      ["CONFIRMED_OPEN", "CANCELLED", "NOT_ATTEMPTED", "NOT_ATTEMPTED"],
    );
    assert.equal(state.exchange.createRequests.length, 2);
    assert.equal(unwrap(state.persistence.readHalt()).active, false);
  } finally {
    state.cleanup();
  }
});

test("recovered open leg discovered after the initial scan cannot authorize suffix creates", async () => {
  const state = setup();
  try {
    const first = state.admittedGrid.legs[0]!;
    const runId = "grid-run-concurrent-recovery";
    const created = await createMainnetPreparedLegForGrid(
      {
        approvalHash: state.approval.contentHash,
        legId: first.execution.leg.legId,
        runId,
      },
      state.dependencies,
      { grid: state.admittedGrid, currentLegIndex: 0 },
    );
    assert.equal(created.ok, true, created.ok ? "" : created.error.message);
    if (!created.ok) return;
    assert.equal(created.value.kind, "created");
    assert.equal(created.value.status, "CONFIRMED_OPEN");
    assert.equal(state.exchange.createRequests.length, 1);

    const read = state.dependencies.preparedLegs.readPreparedLegSource.bind(
      state.dependencies.preparedLegs,
    );
    let initialScanMissedDurableSource = false;
    state.dependencies.preparedLegs.readPreparedLegSource = (sourceId) => {
      if (sourceId === first.sourceId && !initialScanMissedDurableSource) {
        initialScanMissedDurableSource = true;
        return { ok: true, value: undefined };
      }
      return read(sourceId);
    };

    const recovered = await createMainnetPreparedGrid(
      { approvalHash: state.approval.contentHash, runId },
      state.dependencies,
    );
    assert.equal(
      recovered.ok,
      true,
      recovered.ok ? "" : recovered.error.message,
    );
    if (!recovered.ok) return;
    assert.equal(recovered.value.outcome, "recovery-only");
    assert.deepEqual(
      recovered.value.legs.map((row) => row.status),
      ["CONFIRMED_OPEN", "NOT_ATTEMPTED", "NOT_ATTEMPTED", "NOT_ATTEMPTED"],
    );
    assert.equal(state.exchange.createRequests.length, 1);
  } finally {
    state.cleanup();
  }
});

test("a competing lease blocks the grid before evidence reads or writes", async () => {
  const state = setup();
  try {
    const competing = state.persistence.acquireLease({
      scope: state.persistence.scope,
      ownerRunId: "competing-grid-run",
      now: state.currentTime.value,
      ttlMs: 60_000,
    });
    assert.equal(competing.ok, true);
    const result = await createMainnetPreparedGrid(
      { approvalHash: state.approval.contentHash, runId: "grid-run-contended" },
      state.dependencies,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "RUN_LEASE_HELD");
    assert.equal(state.exchange.createRequests.length, 0);
    assert.equal(state.evidenceCollections, 0);
  } finally {
    state.cleanup();
  }
});

test("takeover lease requiring reconciliation blocks before reads or writes", async () => {
  const state = setup();
  try {
    const acquiredAt = state.currentTime.value;
    unwrap(
      state.persistence.acquireLease({
        scope: state.persistence.scope,
        ownerRunId: "stale-grid-run",
        now: acquiredAt,
        ttlMs: 1_000,
      }),
    );
    state.currentTime.value = timestamp(
      new Date(Date.parse(acquiredAt) + 5_000).toISOString(),
    );
    state.localTime.value = state.currentTime.value;
    const result = await createMainnetPreparedGrid(
      {
        approvalHash: state.approval.contentHash,
        runId: "grid-run-takeover",
      },
      state.dependencies,
    );
    assert.equal(result.ok, true, result.ok ? "" : result.error.message);
    if (!result.ok) return;
    assert.equal(result.value.outcome, "stopped");
    assert.ok(
      result.value.reasonCodes.includes("LEASE_RECONCILIATION_REQUIRED"),
    );
    assert.deepEqual(
      result.value.legs.map((row) => row.status),
      ["BLOCKED", "NOT_ATTEMPTED", "NOT_ATTEMPTED", "NOT_ATTEMPTED"],
    );
    assert.equal(state.evidenceCollections, 0);
    assert.equal(state.exchange.createRequests.length, 0);
  } finally {
    state.cleanup();
  }
});

test("preflight read failures preserve lease-release failures", async () => {
  for (const source of ["journal", "halt"] as const) {
    const state = setup();
    try {
      if (source === "journal") {
        const read = state.dependencies.preparedLegs.readPreparedLegSource.bind(
          state.dependencies.preparedLegs,
        );
        let first = true;
        state.dependencies.preparedLegs.readPreparedLegSource = (sourceId) => {
          if (first) {
            first = false;
            return fail(
              domainError("PERSISTENCE_INTEGRITY", "journal unavailable"),
            );
          }
          return read(sourceId);
        };
      } else {
        state.persistence.readHalt = () =>
          fail(domainError("PERSISTENCE_INTEGRITY", "halt read unavailable"));
      }
      state.persistence.releaseLease = () =>
        fail(domainError("PERSISTENCE_INTEGRITY", "cleanup unavailable"));
      const result = await createMainnetPreparedGrid(
        {
          approvalHash: state.approval.contentHash,
          runId: `grid-run-${source}-cleanup-failure`,
        },
        state.dependencies,
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, "PERSISTENCE_INTEGRITY");
        assert.match(
          result.error.message,
          /journal unavailable|halt read unavailable/,
        );
        assert.match(
          result.error.message,
          /lease release failed: PERSISTENCE_INTEGRITY/,
        );
      }
      assert.equal(state.exchange.createRequests.length, 0);
    } finally {
      state.cleanup();
    }
  }
});

test("lease expiry after durable intent fences dispatch and HALTs", async () => {
  const state = setup();
  try {
    const collect = state.dependencies.evidence.collect;
    state.dependencies.evidence.collect = async (requestedSymbol) => {
      const result = await collect(requestedSymbol);
      state.localTime.value = timestamp(
        new Date(Date.parse(state.localTime.value) + 60_000).toISOString(),
      );
      return result;
    };
    const result = await createMainnetPreparedGrid(
      { approvalHash: state.approval.contentHash, runId: "grid-run-expiry" },
      state.dependencies,
    );
    assert.equal(result.ok, true, result.ok ? "" : result.error.message);
    if (!result.ok) return;
    assert.equal(result.value.outcome, "stopped");
    assert.deepEqual(
      result.value.legs.map((row) => row.status),
      ["UNRESOLVED", "NOT_ATTEMPTED", "NOT_ATTEMPTED", "NOT_ATTEMPTED"],
    );
    assert.equal(state.exchange.createRequests.length, 0);
    const source = unwrap(
      state.persistence.preparedLegExecution!.readPreparedLegSource(
        state.admittedGrid.legs[0]!.sourceId,
      ),
    );
    assert.ok(source?.createIntent);
    assert.equal(source?.createAttempt, undefined);
    assert.equal(unwrap(state.persistence.readHalt()).active, true);
  } finally {
    state.cleanup();
  }
});

test("HALT and a lost lease epoch both stop before exchange writes", async () => {
  const halted = setup();
  try {
    const lease = unwrap(
      halted.persistence.acquireLease({
        scope: halted.persistence.scope,
        ownerRunId: "grid-run-halted",
        now: halted.currentTime.value,
        ttlMs: 60_000,
      }),
    );
    unwrap(
      halted.persistence.raiseHalt(
        { ownerRunId: lease.ownerRunId, epoch: lease.epoch },
        "fixture halt",
        halted.currentTime.value,
      ),
    );
    const result = await createMainnetPreparedGrid(
      { approvalHash: halted.approval.contentHash, runId: "grid-run-halted" },
      halted.dependencies,
    );
    assert.equal(result.ok, true, result.ok ? "" : result.error.message);
    if (result.ok) {
      assert.equal(result.value.outcome, "stopped");
      assert.equal(
        result.value.legs[0]!.reasonCodes.includes("HALT_ACTIVE"),
        true,
      );
    }
    assert.equal(halted.exchange.createRequests.length, 0);
  } finally {
    halted.cleanup();
  }

  const fenced = setup();
  try {
    fenced.authorization.onAuthorize = (binding) => {
      unwrap(
        fenced.persistence.releaseLease({
          ownerRunId: binding.leaseOwnerRunId,
          epoch: binding.leaseEpoch,
        }),
      );
      unwrap(
        fenced.persistence.acquireLease({
          scope: fenced.persistence.scope,
          ownerRunId: "competing-epoch-run",
          now: timestamp(fenced.localTime.value),
          ttlMs: 60_000,
        }),
      );
    };
    const result = await createMainnetPreparedGrid(
      { approvalHash: fenced.approval.contentHash, runId: "grid-run-fenced" },
      fenced.dependencies,
    );
    assert.equal(result.ok, true, result.ok ? "" : result.error.message);
    if (result.ok) {
      assert.equal(result.value.outcome, "stopped");
      assert.equal(result.value.legs[0]!.status, "BLOCKED");
    }
    assert.equal(fenced.exchange.createRequests.length, 0);
    assert.equal(
      unwrap(fenced.persistence.readScopeSnapshot()).lease?.ownerRunId,
      "competing-epoch-run",
    );
  } finally {
    fenced.cleanup();
  }
});

test("an invisible timeout on the second leg becomes unresolved and HALTs without suffix writes", async () => {
  const state = setup();
  try {
    state.exchange.behaviorForDispatch = (index) =>
      index === 1 ? "invisible-timeout" : "open";
    const result = await createMainnetPreparedGrid(
      { approvalHash: state.approval.contentHash, runId: "grid-run-timeout" },
      state.dependencies,
    );
    assert.equal(result.ok, true, result.ok ? "" : result.error.message);
    if (!result.ok) return;
    assert.equal(result.value.outcome, "stopped");
    assert.deepEqual(
      result.value.legs.map((row) => row.status),
      ["CONFIRMED_OPEN", "UNRESOLVED", "NOT_ATTEMPTED", "NOT_ATTEMPTED"],
    );
    assert.equal(state.exchange.createRequests.length, 2);
    assert.equal(unwrap(state.persistence.readHalt()).active, true);
    assert.ok(result.value.legs[1]!.reasonCodes.length > 0);
  } finally {
    state.cleanup();
  }
});

test("a partial fill on the second leg is protection-pending and prevents later creates", async () => {
  const state = setup();
  try {
    state.exchange.behaviorForDispatch = (index) =>
      index === 1 ? "partial" : "open";
    const result = await createMainnetPreparedGrid(
      { approvalHash: state.approval.contentHash, runId: "grid-run-partial" },
      state.dependencies,
    );
    assert.equal(result.ok, true, result.ok ? "" : result.error.message);
    if (!result.ok) return;
    assert.equal(result.value.outcome, "stopped");
    assert.deepEqual(
      result.value.legs.map((row) => row.status),
      [
        "CONFIRMED_OPEN",
        "PROTECTION_PENDING",
        "NOT_ATTEMPTED",
        "NOT_ATTEMPTED",
      ],
    );
    assert.equal(state.exchange.createRequests.length, 2);
    assert.equal(unwrap(state.persistence.readHalt()).active, true);
    const facts = unwrap(state.persistence.readFacts());
    assert.equal(facts.filter((fact) => fact.factKind === "fill").length, 1);
  } finally {
    state.cleanup();
  }
});
