import assert from "node:assert/strict";
import test from "node:test";

import { createMainnetPreparedGrid } from "../src/application/mainnet-prepared-grid-boundary.js";
import { createMainnetPreparedLeg } from "../src/application/mainnet-prepared-leg-boundary.js";
import { createPreparedPlanApproval } from "../src/domain/review/prepared-plan-approval.js";
import { domainError } from "../src/domain/shared/errors.js";
import { fail } from "../src/domain/shared/result.js";
import {
  symbol,
  setup,
  timestamp,
  unwrap,
} from "./fixtures/mainnet-prepared-grid-harness.js";

test("restart between legs reconciles the prefix and never submits the suffix", async () => {
  const state = setup();
  try {
    const collect = state.dependencies.evidence.collect;
    let calls = 0;
    state.dependencies.evidence.collect = async (requestedSymbol) => {
      calls += 1;
      if (calls === 2) throw new Error("simulated process interruption");
      return collect(requestedSymbol);
    };
    const interrupted = await createMainnetPreparedGrid(
      {
        approvalHash: state.approval.contentHash,
        runId: "grid-run-between-legs",
      },
      state.dependencies,
    );
    assert.equal(
      interrupted.ok,
      true,
      interrupted.ok ? "" : interrupted.error.message,
    );
    if (!interrupted.ok) return;
    assert.deepEqual(
      interrupted.value.legs.map((row) => row.status),
      ["CONFIRMED_OPEN", "BLOCKED", "NOT_ATTEMPTED", "NOT_ATTEMPTED"],
    );
    assert.equal(state.exchange.createRequests.length, 1);

    state.dependencies.evidence.collect = collect;
    const restarted = await createMainnetPreparedGrid(
      {
        approvalHash: state.approval.contentHash,
        runId: "grid-run-after-restart",
      },
      state.dependencies,
    );
    assert.equal(
      restarted.ok,
      true,
      restarted.ok ? "" : restarted.error.message,
    );
    if (!restarted.ok) return;
    assert.equal(restarted.value.outcome, "recovery-only");
    assert.deepEqual(
      restarted.value.legs.map((row) => row.status),
      ["CONFIRMED_OPEN", "NOT_ATTEMPTED", "NOT_ATTEMPTED", "NOT_ATTEMPTED"],
    );
    assert.equal(state.exchange.createRequests.length, 1);
  } finally {
    state.cleanup();
  }
});

test("dispatch-before-attempt interruption recovers the same identity without suffix writes", async () => {
  const state = setup();
  try {
    const store = state.dependencies.preparedLegs;
    const appendAttempt = store.appendPreparedLegAttempt.bind(store);
    store.appendPreparedLegAttempt = (request) =>
      request.operation === "create"
        ? fail(
            domainError(
              "PERSISTENCE_INTEGRITY",
              "simulated crash after exchange dispatch",
            ),
          )
        : appendAttempt(request);
    const interrupted = await createMainnetPreparedGrid(
      {
        approvalHash: state.approval.contentHash,
        runId: "grid-run-after-post",
      },
      state.dependencies,
    );
    assert.equal(
      interrupted.ok,
      true,
      interrupted.ok ? "" : interrupted.error.message,
    );
    if (!interrupted.ok) return;
    assert.deepEqual(
      interrupted.value.legs.map((row) => row.status),
      ["UNRESOLVED", "NOT_ATTEMPTED", "NOT_ATTEMPTED", "NOT_ATTEMPTED"],
    );
    assert.equal(state.exchange.createRequests.length, 1);
    const sourceId = state.admittedGrid.legs[0]!.sourceId;
    const journal = unwrap(store.readPreparedLegSource(sourceId));
    assert.ok(journal?.createIntent);
    assert.equal(journal.createAttempt, undefined);

    store.appendPreparedLegAttempt = appendAttempt;
    const recovered = await createMainnetPreparedGrid(
      {
        approvalHash: state.approval.contentHash,
        runId: "grid-run-after-post",
      },
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
    const recoveredJournal = unwrap(store.readPreparedLegSource(sourceId));
    assert.ok(recoveredJournal?.createAttempt);
    assert.equal(unwrap(state.persistence.readHalt()).active, true);
  } finally {
    state.cleanup();
  }
});

test("a non-prefix durable source forces recovery-only and cannot fill the gap", async () => {
  const state = setup();
  try {
    const seeded = await createMainnetPreparedLeg(
      {
        approvalHash: state.approval.contentHash,
        legId: state.admittedGrid.legs[2]!.execution.leg.legId,
        runId: "grid-run-non-prefix-seed",
      },
      state.dependencies,
    );
    assert.equal(seeded.ok, true, seeded.ok ? "" : seeded.error.message);
    if (!seeded.ok) return;
    assert.equal(seeded.value.status, "CONFIRMED_OPEN");

    const result = await createMainnetPreparedGrid(
      {
        approvalHash: state.approval.contentHash,
        runId: "grid-run-non-prefix-recovery",
      },
      state.dependencies,
    );
    assert.equal(result.ok, true, result.ok ? "" : result.error.message);
    if (!result.ok) return;
    assert.equal(result.value.outcome, "recovery-only");
    assert.deepEqual(
      result.value.legs.map((row) => row.status),
      ["NOT_ATTEMPTED", "NOT_ATTEMPTED", "CONFIRMED_OPEN", "NOT_ATTEMPTED"],
    );
    assert.equal(state.exchange.createRequests.length, 1);
  } finally {
    state.cleanup();
  }
});

test("any durable source makes a repeated or renewed approval invocation recovery-only", async () => {
  const state = setup();
  try {
    const first = await createMainnetPreparedGrid(
      { approvalHash: state.approval.contentHash, runId: "grid-run-recovery" },
      state.dependencies,
    );
    assert.equal(first.ok, true, first.ok ? "" : first.error.message);
    if (!first.ok) return;
    const renewedApproval = unwrap(
      createPreparedPlanApproval({
        prepared: state.prepared,
        preparedHash: state.prepared.contentHash,
        actor: state.approval.actor,
        consent: true,
        approvedAt: timestamp(
          new Date(Date.parse(state.currentTime.value) + 1_000).toISOString(),
        ),
        note: state.approval.note,
      }),
    );
    assert.notEqual(renewedApproval.contentHash, state.approval.contentHash);
    state.approvalsByHash.set(renewedApproval.contentHash, renewedApproval);
    const second = await createMainnetPreparedGrid(
      {
        approvalHash: renewedApproval.contentHash,
        runId: "grid-run-recovery-second",
      },
      state.dependencies,
    );
    assert.equal(second.ok, true, second.ok ? "" : second.error.message);
    if (!second.ok) return;
    assert.equal(second.value.outcome, "recovery-only");
    assert.equal(second.value.approvalHash, renewedApproval.contentHash);
    assert.equal(state.exchange.createRequests.length, 4);
    assert.deepEqual(
      second.value.legs.map((row) => row.status),
      ["CONFIRMED_OPEN", "CONFIRMED_OPEN", "CONFIRMED_OPEN", "CONFIRMED_OPEN"],
    );
  } finally {
    state.cleanup();
  }
});

test("out-of-band fill after a zero-fill sibling snapshot stays recovery-only and HALTed", async () => {
  const state = setup();
  try {
    const created = await createMainnetPreparedGrid(
      {
        approvalHash: state.approval.contentHash,
        runId: "grid-run-filled-sibling",
      },
      state.dependencies,
    );
    assert.equal(created.ok, true, created.ok ? "" : created.error.message);
    if (!created.ok) return;

    const sibling = state.admittedGrid.legs[1]!;
    const order = state.exchange.orders.get(sibling.execution.clientOrderId)!;
    const quantity = sibling.execution.leg.intent.quantity;
    order.status = "filled";
    order.filledQuantity = quantity.toString();
    order.fills = [
      {
        executionId: "grid-fill-sibling-full",
        exchangeOrderId: order.exchangeOrderId,
        clientOrderId: sibling.execution.clientOrderId,
        instrument: symbol,
        side: "buy",
        quantity,
        price: sibling.execution.leg.intent.price,
        executedAt: state.currentTime.value,
        source: "bybit-mainnet/execution",
      },
    ];

    const firstRecovery = await createMainnetPreparedGrid(
      {
        approvalHash: state.approval.contentHash,
        runId: "grid-run-filled-sibling",
      },
      state.dependencies,
    );
    assert.equal(
      firstRecovery.ok,
      true,
      firstRecovery.ok ? "" : firstRecovery.error.message,
    );
    if (!firstRecovery.ok) return;
    assert.equal(firstRecovery.value.outcome, "recovery-only");
    assert.equal(firstRecovery.value.legs[1]!.status, "PROTECTION_PENDING");
    assert.ok(
      firstRecovery.value.legs.some((row) => row.status === "UNRESOLVED"),
    );
    assert.ok(
      firstRecovery.value.legs[1]!.reasonCodes.includes(
        "GRID_SIBLING_EVIDENCE_INVALID",
      ),
    );
    assert.equal(state.exchange.createRequests.length, 4);

    const retried = await createMainnetPreparedGrid(
      {
        approvalHash: state.approval.contentHash,
        runId: "grid-run-filled-sibling",
      },
      state.dependencies,
    );
    assert.equal(retried.ok, true, retried.ok ? "" : retried.error.message);
    if (!retried.ok) return;
    assert.equal(retried.value.outcome, "recovery-only");
    assert.ok(retried.value.legs.some((row) => row.status === "UNRESOLVED"));
    assert.ok(
      retried.value.legs.some((row) => row.status === "PROTECTION_PENDING"),
    );
    assert.equal(state.exchange.createRequests.length, 4);
    assert.equal(unwrap(state.persistence.readHalt()).active, true);
  } finally {
    state.cleanup();
  }
});

test("delayed Partial TP evidence can confirm on restart but does not clear HALT", async () => {
  const state = setup();
  try {
    const first = state.admittedGrid.legs[0]!.execution;
    state.exchange.behaviorForDispatch = (index) =>
      index === 0 ? "filled" : "open";
    state.exchange.protectionBehaviorByParent.set(
      first.clientOrderId,
      "missing",
    );
    const initial = await createMainnetPreparedGrid(
      {
        approvalHash: state.approval.contentHash,
        runId: "grid-run-delayed-tp",
      },
      state.dependencies,
    );
    assert.equal(initial.ok, true, initial.ok ? "" : initial.error.message);
    if (!initial.ok) return;
    assert.equal(initial.value.legs[0]!.status, "PROTECTION_PENDING");
    assert.equal(state.exchange.createRequests.length, 1);
    assert.equal(unwrap(state.persistence.readHalt()).active, true);

    state.exchange.protectionBehaviorByParent.set(
      first.clientOrderId,
      "normal",
    );
    const recovered = await createMainnetPreparedGrid(
      {
        approvalHash: state.approval.contentHash,
        runId: "grid-run-delayed-tp",
      },
      state.dependencies,
    );
    assert.equal(
      recovered.ok,
      true,
      recovered.ok ? "" : recovered.error.message,
    );
    if (!recovered.ok) return;
    assert.equal(recovered.value.outcome, "recovery-only");
    assert.equal(recovered.value.legs[0]!.status, "PROTECTION_CONFIRMED");
    assert.equal(state.exchange.createRequests.length, 1);
    assert.equal(unwrap(state.persistence.readHalt()).active, true);
  } finally {
    state.cleanup();
  }
});

test("distinct provider child link remains attributable through grid recovery", async () => {
  const state = setup();
  try {
    const first = state.admittedGrid.legs[0]!.execution;
    state.exchange.behaviorForDispatch = (index) =>
      index === 0 ? "filled" : "open";
    state.exchange.protectionBehaviorByParent.set(
      first.clientOrderId,
      "distinct-child-link",
    );

    const initial = await createMainnetPreparedGrid(
      {
        approvalHash: state.approval.contentHash,
        runId: "grid-run-distinct-tp-child-link",
      },
      state.dependencies,
    );
    assert.equal(initial.ok, true, initial.ok ? "" : initial.error.message);
    if (!initial.ok) return;
    assert.equal(initial.value.legs[0]!.status, "PROTECTION_CONFIRMED");
    assert.equal(state.exchange.createRequests.length, 1);

    const recovered = await createMainnetPreparedGrid(
      {
        approvalHash: state.approval.contentHash,
        runId: "grid-run-distinct-tp-child-link",
      },
      state.dependencies,
    );
    assert.equal(
      recovered.ok,
      true,
      recovered.ok ? "" : recovered.error.message,
    );
    if (!recovered.ok) return;
    assert.equal(recovered.value.outcome, "recovery-only");
    assert.equal(recovered.value.legs[0]!.status, "PROTECTION_CONFIRMED");
    assert.equal(state.exchange.createRequests.length, 1);
  } finally {
    state.cleanup();
  }
});

test("restart after a protected second-leg fill never creates the grid suffix", async () => {
  const state = setup();
  try {
    state.exchange.behaviorForDispatch = (index) =>
      index === 1 ? "partial" : "open";
    const initial = await createMainnetPreparedGrid(
      {
        approvalHash: state.approval.contentHash,
        runId: "grid-run-protected-second-leg-restart",
      },
      state.dependencies,
    );
    assert.equal(initial.ok, true, initial.ok ? "" : initial.error.message);
    if (!initial.ok) return;
    assert.deepEqual(
      initial.value.legs.map((row) => row.status),
      [
        "CONFIRMED_OPEN",
        "PROTECTION_CONFIRMED",
        "NOT_ATTEMPTED",
        "NOT_ATTEMPTED",
      ],
    );
    assert.equal(state.exchange.createRequests.length, 2);

    const restarted = await createMainnetPreparedGrid(
      {
        approvalHash: state.approval.contentHash,
        runId: "grid-run-protected-second-leg-restart",
      },
      state.dependencies,
    );
    assert.equal(
      restarted.ok,
      true,
      restarted.ok ? "" : restarted.error.message,
    );
    if (!restarted.ok) return;
    assert.equal(restarted.value.outcome, "recovery-only");
    const restartedStatuses = restarted.value.legs.map((row) => row.status);
    assert.deepEqual(
      restartedStatuses,
      [
        "CONFIRMED_OPEN",
        "PROTECTION_CONFIRMED",
        "NOT_ATTEMPTED",
        "NOT_ATTEMPTED",
      ],
      JSON.stringify(
        restarted.value.legs.map((row) => ({
          status: row.status,
          reasonCodes: row.reasonCodes,
        })),
      ),
    );
    assert.equal(state.exchange.createRequests.length, 2);
    assert.equal(unwrap(state.persistence.readHalt()).active, false);
  } finally {
    state.cleanup();
  }
});

test("missing or contradictory Partial TP attribution remains pending after a fill", async (t) => {
  for (const behavior of [
    "missing-parent",
    "wrong-parent",
    "wrong-trigger",
  ] as const) {
    await t.test(behavior, async () => {
      const state = setup();
      try {
        const first = state.admittedGrid.legs[0]!.execution;
        state.exchange.behaviorForDispatch = (index) =>
          index === 0 ? "filled" : "open";
        state.exchange.protectionBehaviorByParent.set(
          first.clientOrderId,
          behavior,
        );
        const result = await createMainnetPreparedGrid(
          {
            approvalHash: state.approval.contentHash,
            runId: `grid-run-${behavior}`,
          },
          state.dependencies,
        );
        assert.equal(result.ok, true, result.ok ? "" : result.error.message);
        if (!result.ok) return;
        assert.equal(result.value.outcome, "stopped");
        assert.equal(result.value.legs[0]!.status, "PROTECTION_PENDING");
        assert.deepEqual(
          result.value.legs.slice(1).map((row) => row.status),
          ["NOT_ATTEMPTED", "NOT_ATTEMPTED", "NOT_ATTEMPTED"],
        );
        assert.equal(state.exchange.createRequests.length, 1);
        assert.equal(unwrap(state.persistence.readHalt()).active, true);
      } finally {
        state.cleanup();
      }
    });
  }
});

test("wrong attached TP or contradictory order identity stops the grid", async (t) => {
  for (const behavior of ["wrong-tp", "wrong-order"] as const) {
    await t.test(behavior, async () => {
      const state = setup();
      try {
        state.exchange.behaviorForDispatch = (index) =>
          index === 0 ? behavior : "open";
        const result = await createMainnetPreparedGrid(
          {
            approvalHash: state.approval.contentHash,
            runId: `grid-run-${behavior}`,
          },
          state.dependencies,
        );
        assert.equal(result.ok, true, result.ok ? "" : result.error.message);
        if (!result.ok) return;
        assert.equal(result.value.outcome, "stopped");
        assert.equal(result.value.legs[0]!.status, "UNRESOLVED");
        assert.deepEqual(
          result.value.legs.slice(1).map((row) => row.status),
          ["NOT_ATTEMPTED", "NOT_ATTEMPTED", "NOT_ATTEMPTED"],
        );
        assert.equal(state.exchange.createRequests.length, 1);
        assert.equal(unwrap(state.persistence.readHalt()).active, true);
      } finally {
        state.cleanup();
      }
    });
  }
});
