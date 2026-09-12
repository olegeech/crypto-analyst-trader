import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  stat,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  EXIT_CODES,
  ProbeStore,
  type StoredIntentInput,
} from "../scripts/bybit-probe/store.js";
import {
  buildProbePlan,
  hashProbePlan,
} from "../scripts/bybit-probe/probe-plan.js";

function plan(expiresAt = 20_000) {
  return buildProbePlan({
    environment: "testnet",
    accountId: "private-account-id",
    scenario: "long-entry",
    expiresAt,
    method: "POST",
    endpoint: "/v5/order/create",
    params: {
      category: "linear",
      symbol: "DOGEUSDT",
      side: "Buy",
      orderLinkId: "run-1-long",
      price: "0.1",
      qty: "51",
      takeProfit: "0.102",
      stopLoss: "0.098",
      positionIdx: 0,
    },
  });
}

function intent(runId = "run-1", value = plan()): StoredIntentInput {
  return {
    runId,
    attemptId: "attempt-1",
    scenario: value.scenario,
    plan: value,
    planDigest: hashProbePlan(value),
    approvedAt: 1_000,
    approvalExpiresAt: 10_000,
    createdAt: 1_000,
    exchangeOrderId: undefined,
    orderLinkId: value.params.orderLinkId,
    baselineSignedQty: undefined,
  };
}

async function tempStore() {
  const root = await mkdtemp(join(tmpdir(), "bybit-probe-store-"));
  const store = new ProbeStore({
    rootDir: root,
    clock: () => 1_000,
    processId: 12_345,
    isProcessAlive: () => false,
  });
  return { root, store };
}

test("intent is fully present before dispatch and contains no secret-shaped data", async () => {
  const { root, store } = await tempStore();
  try {
    await store.acquireLock("run-1");
    const record = await store.writeIntent(intent());
    const serialized = await readFile(record.path, "utf8");
    assert.equal(JSON.parse(serialized).plan.accountIdHash.length, 12);
    assert.doesNotMatch(
      serialized,
      /private-account-id|sentinel-secret|signature|X-BAPI/,
    );
    assert.equal((await stat(record.path)).mode & 0o777, 0o600);
    assert.equal(
      (await readdir(join(root, "run-1"))).some((name) =>
        name.endsWith(".tmp"),
      ),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a live lock blocks a second run while a dead lock is reclaimed", async () => {
  const { root, store } = await tempStore();
  try {
    await store.acquireLock("run-1");
    const live = new ProbeStore({
      rootDir: root,
      processId: 99,
      isProcessAlive: () => true,
    });
    await assert.rejects(
      live.acquireLock("run-2"),
      /another probe run is active/,
    );
    await store.releaseLock("run-1");
    await live.acquireLock("run-2");
    await live.releaseLock("run-2");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unresolved and aged prior runs are preconditions, and verdicts map to exit codes", async () => {
  const { root } = await tempStore();
  const store = new ProbeStore({
    rootDir: root,
    clock: () => 1_000 + 8 * 24 * 60 * 60 * 1_000,
    processId: 12_345,
    isProcessAlive: () => false,
  });
  try {
    await store.writeIntent(intent("old-run"));
    await assert.rejects(
      store.assertNoBlockingPriorRuns("new-run"),
      /older than seven days|unresolved/,
    );
    const handoff = {
      runId: "new-run",
      lastConfirmedState: "no dispatch",
      uncertainty: "approval was lost",
      nextAction: "reconcile through the exchange UI",
    };
    const verdict = await store.writeVerdict("new-run", "UNRESOLVED", handoff);
    assert.equal(verdict.exitCode, EXIT_CODES.UNRESOLVED);
    assert.match(await readFile(verdict.path, "utf8"), /SECURITY\.md/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a precondition failure with durable intent evidence still blocks new runs", async () => {
  const { root, store } = await tempStore();
  try {
    await store.writeIntent(intent("failed-run-1"));
    await store.writeVerdict("failed-run-1", "PRECONDITION_FAILED");
    await store.writeIntent(intent("failed-run-2"));
    await store.writeVerdict("failed-run-2", "PRECONDITION_FAILED");
    await assert.rejects(
      store.assertNoBlockingPriorRuns("new-run"),
      /multiple unresolved prior probe runs require manual recovery/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run records remain readable after a simulated interrupted dispatch", async () => {
  const { root, store } = await tempStore();
  try {
    await store.writeIntent(intent());
    const runs = await store.listSavedRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.intents.length, 1);
    assert.equal(runs[0]?.verdict, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("corrupt persisted intent shapes fail closed during recovery discovery", async () => {
  const { root, store } = await tempStore();
  try {
    const record = await store.writeIntent(intent());
    const parsed = JSON.parse(await readFile(record.path, "utf8")) as Record<
      string,
      unknown
    >;
    const persistedPlan = parsed.plan as Record<string, unknown>;
    persistedPlan.params = { category: "linear", symbol: "DOGEUSDT" };
    await writeFile(record.path, `${JSON.stringify(parsed)}\n`, "utf8");
    await assert.rejects(
      store.listSavedRuns(),
      /stored side is invalid|stored order parameters are invalid/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persisted intent identities cannot diverge from the approved plan", async () => {
  const { root, store } = await tempStore();
  try {
    const record = await store.writeIntent(intent());
    const parsed = JSON.parse(await readFile(record.path, "utf8")) as Record<
      string,
      unknown
    >;
    parsed.orderLinkId = "other-run-order";
    await writeFile(record.path, `${JSON.stringify(parsed)}\n`, "utf8");
    await assert.rejects(
      store.listSavedRuns(),
      /orderLinkId does not match its plan/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
