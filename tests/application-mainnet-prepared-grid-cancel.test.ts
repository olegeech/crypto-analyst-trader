import assert from "node:assert/strict";
import test from "node:test";
import { createMainnetPreparedGrid } from "../src/application/mainnet-prepared-grid-boundary.js";
import { cancelMainnetPreparedLeg } from "../src/application/mainnet-prepared-leg-cancel.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";
import { createPreparedLegOrderProof } from "../src/domain/execution/prepared-leg-order-proof.js";
import { createExchangeOrder } from "../src/domain/execution/exchange-order.js";
import { setup, unwrap } from "./fixtures/mainnet-prepared-grid-harness.js";

async function twoFilledSiblings(fullSibling = false) {
  const state = setup();
  const runId = "two-filled-siblings-cancel";
  const initial = unwrap(
    await createMainnetPreparedGrid(
      { approvalHash: state.approval.contentHash, runId },
      state.dependencies,
    ),
  );
  assert.equal(initial.legs.length, 4);
  for (const [index, row] of state.admittedGrid.legs.slice(0, 2).entries()) {
    const order = state.exchange.orders.get(row.execution.clientOrderId)!;
    const quantity = row.execution.leg.intent.quantity.multiply(
      unwrap(DecimalValue.fromString(fullSibling && index === 1 ? "1" : "0.5")),
    );
    order.status = fullSibling && index === 1 ? "filled" : "partially-filled";
    order.filledQuantity = quantity.toString();
    order.fills = [
      {
        executionId: `two-sibling-entry-${index}`,
        exchangeOrderId: order.exchangeOrderId,
        clientOrderId: row.execution.clientOrderId,
        instrument: row.execution.leg.intent.instrument,
        side: "buy",
        quantity,
        price: row.execution.leg.intent.price,
        executedAt: state.currentTime.value,
        source: "bybit-mainnet/execution",
      },
    ];
  }
  const recovery = unwrap(
    await createMainnetPreparedGrid(
      { approvalHash: state.approval.contentHash, runId },
      state.dependencies,
    ),
  );
  assert.equal(
    recovery.legs[0]?.status,
    "PROTECTION_CONFIRMED",
    JSON.stringify(recovery),
  );
  assert.equal(
    recovery.legs[1]?.status,
    "PROTECTION_CONFIRMED",
    JSON.stringify(recovery),
  );
  if (fullSibling)
    assert.deepEqual(
      recovery.legs.map((row) => row.status),
      [
        "PROTECTION_CONFIRMED",
        "PROTECTION_CONFIRMED",
        "CONFIRMED_OPEN",
        "CONFIRMED_OPEN",
      ],
    );
  return { state, runId };
}

test("remainder cancel proves two filled grid siblings and survives SQLite restart without a duplicate POST", async () => {
  const { state, runId } = await twoFilledSiblings(true);
  try {
    const selected = state.admittedGrid.legs[0]!;
    const sibling = state.admittedGrid.legs[1]!;
    assert.notEqual(
      selected.execution.leg.intent.protection?.takeProfit?.toString(),
      sibling.execution.leg.intent.protection?.takeProfit?.toString(),
    );
    state.reopenPersistence();
    const result = unwrap(
      await cancelMainnetPreparedLeg(
        { sourceId: selected.sourceId, runId },
        state.dependencies,
      ),
    );
    assert.equal(result.status, "PROTECTION_CONFIRMED", JSON.stringify(result));
    assert.equal(state.exchange.cancelRequests.length, 1);
    assert.equal(
      state.exchange.cancelRequests[0]?.clientOrderId,
      selected.execution.clientOrderId,
    );
    assert.equal(
      state.exchange.orders.get(sibling.execution.clientOrderId)?.status,
      "filled",
    );
    const saved = unwrap(
      state.persistence.preparedLegExecution!.readPreparedLegSource(
        selected.sourceId,
      ),
    );
    const evidence = saved?.reconciliations.at(-1)?.protectionEvidence;
    assert.equal(evidence?.aggregate?.siblings.length, 3);
    assert.notEqual(
      evidence?.coverage.outstandingQuantity,
      evidence?.position.quantity,
    );
    assert.equal(
      saved?.cancelIntent?.remainderCancelProof?.outstandingQuantity,
      state.exchange.orders.get(selected.execution.clientOrderId)
        ?.filledQuantity,
    );
    assert.equal(evidence?.entries.executionIds.length, 1);
    assert.ok(evidence?.aggregate);
    assert.ok(saved?.lease);
    const {
      sourceId: _sourceId,
      revision: _revision,
      ...inputEvidence
    } = evidence;
    void _sourceId;
    void _revision;
    const parentResult = await state.exchange.observeOrder({
      instrument: selected.execution.leg.intent.instrument,
      clientOrderId: selected.execution.clientOrderId,
    });
    assert.ok(parentResult.ok);
    const parent = unwrap(createPreparedLegOrderProof(parentResult.value));
    for (const tamper of [
      "source",
      "reason",
      "ownership",
      "position",
    ] as const) {
      const siblings = evidence.aggregate.siblings.map((sibling) =>
        sibling.evidence.parent.filledQuantity !== "0"
          ? sibling
          : {
              ...sibling,
              ...(tamper === "ownership"
                ? { sourceId: "foreign-durable-source" }
                : {}),
              evidence: {
                ...sibling.evidence,
                ...(tamper === "source"
                  ? { parent: { ...sibling.evidence.parent, source: "manual" } }
                  : tamper === "reason"
                    ? { reasonCodes: ["UNPROVEN_ZERO_SIBLING"] }
                    : tamper === "position"
                      ? {
                          position: {
                            ...sibling.evidence.position,
                            quantity: "999",
                          },
                        }
                      : {}),
              },
            },
      );
      const rejected =
        state.persistence.preparedLegExecution!.appendPreparedLegReconciliation(
          {
            authority: { ownerRunId: runId, epoch: saved.lease.epoch },
            sourceId: selected.sourceId,
            status: "PROTECTION_CONFIRMED",
            observedAt: state.currentTime.value,
            exchangeOrderId: parent.exchangeOrderId,
            result: {
              orderProof: parent,
              fills: state.exchange.orders
                .get(selected.execution.clientOrderId)!
                .fills.map((fill) => ({
                  executionId: fill.executionId,
                  quantity: fill.quantity.toString(),
                  price: fill.price.toString(),
                  executedAt: fill.executedAt,
                })),
            },
            protectionEvidence: {
              ...inputEvidence,
              aggregate: { ...evidence.aggregate, siblings },
            },
          },
        );
      assert.equal(rejected.ok, false, tamper);
    }

    state.reopenPersistence();
    const recovered = unwrap(
      await cancelMainnetPreparedLeg(
        { sourceId: selected.sourceId, runId },
        state.dependencies,
      ),
    );
    assert.equal(
      recovered.status,
      "PROTECTION_CONFIRMED",
      JSON.stringify(recovered),
    );
    assert.equal(state.exchange.cancelRequests.length, 1);
    assert.equal(unwrap(state.persistence.readHalt()).active, false);
  } finally {
    state.cleanup();
  }
});

test("a fully TP-exited selected leg can cancel its entry remainder while a sibling remains exposed", async () => {
  const { state, runId } = await twoFilledSiblings(true);
  try {
    const selected = state.admittedGrid.legs[0]!;
    const sibling = state.admittedGrid.legs[1]!;
    state.exchange.protectionBehaviorByParent.set(
      selected.execution.clientOrderId,
      "complete-exit",
    );
    state.reopenPersistence();
    const result = unwrap(
      await cancelMainnetPreparedLeg(
        { sourceId: selected.sourceId, runId },
        state.dependencies,
      ),
    );
    assert.equal(result.status, "VERIFIED_CLOSED", JSON.stringify(result));
    assert.equal(state.exchange.cancelRequests.length, 1);
    assert.equal(
      state.exchange.cancelRequests[0]?.clientOrderId,
      selected.execution.clientOrderId,
    );
    assert.equal(
      state.exchange.orders.get(sibling.execution.clientOrderId)?.status,
      "filled",
    );
    const saved = unwrap(
      state.persistence.preparedLegExecution!.readPreparedLegSource(
        selected.sourceId,
      ),
    );
    const evidence = saved?.reconciliations.at(-1)?.protectionEvidence;
    assert.equal(evidence?.coverage.outstandingQuantity, "0");
    assert.equal(evidence?.position.side, "long");
    assert.equal(
      evidence?.position.quantity,
      state.exchange.orders.get(sibling.execution.clientOrderId)
        ?.filledQuantity,
    );
    assert.equal(
      saved?.cancelIntent?.remainderCancelProof?.outstandingQuantity,
      "0",
    );
    assert.ok(saved?.cancelIntent?.remainderCancelProof?.unfilledRemainder);
    const siblingEvidence = evidence?.aggregate?.siblings.find(
      (row) => row.sourceId === sibling.sourceId,
    )?.evidence;
    assert.equal(siblingEvidence?.status, "PROTECTION_CONFIRMED");
    assert.equal(
      siblingEvidence?.coverage.outstandingQuantity,
      evidence?.position.quantity,
    );
    state.reopenPersistence();
    const recovered = unwrap(
      await cancelMainnetPreparedLeg(
        { sourceId: selected.sourceId, runId },
        state.dependencies,
      ),
    );
    assert.equal(
      recovered.status,
      "VERIFIED_CLOSED",
      JSON.stringify(recovered),
    );
    assert.equal(state.exchange.cancelRequests.length, 1);
    assert.equal(unwrap(state.persistence.readHalt()).active, false);
  } finally {
    state.cleanup();
  }
});

test("aggregate mismatch, unknown order and unavailable sibling proof block remainder cancel", async (t) => {
  for (const fault of [
    "aggregate-position",
    "foreign-order",
    "sibling-proof",
  ] as const)
    await t.test(fault, async () => {
      const { state, runId } = await twoFilledSiblings();
      try {
        const selected = state.admittedGrid.legs[0]!;
        if (fault === "aggregate-position") {
          const read = state.exchange.readState.bind(state.exchange);
          state.exchange.readState = async (request) => {
            const result = await read(request);
            return result.ok
              ? {
                  ok: true,
                  value: {
                    ...result.value,
                    position: {
                      ...result.value.position,
                      quantity: result.value.position.quantity.add(
                        unwrap(DecimalValue.fromString("0.1")),
                      ),
                    },
                  },
                }
              : result;
          };
        } else if (fault === "foreign-order") {
          const row = state.exchange.orders.get(
            selected.execution.clientOrderId,
          )!;
          const observedResult = await state.exchange.observeOrder({
            instrument: row.request.intent.instrument,
            clientOrderId: row.request.clientOrderId,
          });
          assert.ok(observedResult.ok);
          const observed = observedResult.value;
          state.exchange.additionalOpenOrders.push(
            unwrap(
              createExchangeOrder({
                ...observed,
                exchangeOrderId: "manual-entry",
                clientOrderId: "manual-entry",
                requestedQuantity: observed.requestedQuantity.toString(),
                filledQuantity: observed.filledQuantity.toString(),
                price: observed.price!.toString(),
                takeProfit: observed.takeProfit?.toString(),
                stopLoss: null,
              }),
            ),
          );
        } else {
          const observe = state.exchange.observeOrder.bind(state.exchange);
          state.exchange.observeOrder = async (request) => {
            if (
              request.clientOrderId ===
              state.admittedGrid.legs[1]!.execution.clientOrderId
            )
              throw new Error("sibling unavailable");
            return observe(request);
          };
        }
        const blocked = unwrap(
          await cancelMainnetPreparedLeg(
            { sourceId: selected.sourceId, runId },
            state.dependencies,
          ),
        );
        assert.equal(blocked.status, "PROTECTION_PENDING");
        assert.equal(state.exchange.cancelRequests.length, 0);
        state.reopenPersistence();
        assert.equal(unwrap(state.persistence.readHalt()).active, true);
        const source = unwrap(
          state.persistence.preparedLegExecution!.readPreparedLegSource(
            selected.sourceId,
          ),
        );
        assert.equal(
          source?.reconciliations.at(-1)?.status,
          "PROTECTION_PENDING",
        );
      } finally {
        state.cleanup();
      }
    });
});
