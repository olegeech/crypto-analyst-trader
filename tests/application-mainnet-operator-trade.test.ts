import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { configuredBybitAccountIdentityHash } from "../src/adapters/bybit-v5/account-key-mapper.js";
import {
  openSqlitePersistence,
  type SqlitePersistenceOptions,
} from "../src/adapters/sqlite/sqlite-persistence.js";
import { resolveOperatorMainnetTradeCommand } from "../src/adapters/sqlite/operator-mainnet-test-lookup.js";
import {
  readMainnetOperatorTradeCommandStatus,
  runMainnetOperatorTrade,
} from "../src/application/mainnet-operator-trade.js";
import { createOperatorMainnetCreateRequest } from "../src/application/mainnet-entry-evidence.js";
import type {
  MainnetOperatorTestCompositionInput,
  MainnetOperatorTestOutcome,
} from "../src/application/mainnet-operator-test.js";
import type { MainnetOperatorTestStatusResult } from "../src/application/mainnet-operator-test-status.js";
import {
  hashCanonical,
  type PlanHash,
} from "../src/domain/identity/canonical-serialization.js";
import {
  createOperatorMainnetQuote,
  type OperatorMainnetTestPlan,
} from "../src/domain/execution/operator-mainnet-test-plan.js";
import {
  createOperatorMainnetTradeCommandPlan,
  createOperatorMainnetTradeCommandReceipt,
  type OperatorMainnetTradeCommandBinding,
  type OperatorMainnetTradeCommandPlan,
  type OperatorMainnetTradeCommandReceipt,
} from "../src/domain/execution/operator-mainnet-trade-command.js";
import { createInstrumentConstraints } from "../src/domain/market/instrument-constraints.js";
import { domainError } from "../src/domain/shared/errors.js";
import { fail, ok } from "../src/domain/shared/result.js";
import type { PersistenceScope } from "../src/ports/persistence.js";
import type { UtcTimestamp } from "../src/domain/shared/time.js";

const NOW = "2026-10-31T12:00:00.000Z" as UtcTimestamp;
const runtime = { nodeVersion: "22.22.3", sqliteVersion: "3.51.3" } as const;

function unwrap<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function tradeFlowFixture() {
  const root = mkdtempSync(join(tmpdir(), "operator-trade-flow-"));
  const databasePath = join(root, "mainnet.db");
  const clock = { now: () => NOW };
  const accountIdentityHash = unwrap<PlanHash>(
    configuredBybitAccountIdentityHash("123", "mainnet"),
  );
  const scope: PersistenceScope = {
    exchange: "bybit",
    environment: "mainnet",
    accountId: accountIdentityHash,
    category: "linear",
    positionMode: "one-way",
  };
  const openPersistence = (options: SqlitePersistenceOptions) =>
    openSqlitePersistence({ ...options, databasePath, runtime, clock });
  const prepare = async (input: { readonly tradeCommandReceipt?: unknown }) => {
    if (!input.tradeCommandReceipt)
      throw new Error("direct-command receipt is required");
    const plan = directCommandPlan(
      input.tradeCommandReceipt as OperatorMainnetTradeCommandReceipt,
    );
    const persistence = unwrap(
      openPersistence({ environment: "mainnet", scope }),
    );
    const journal = persistence.operatorMainnetTest;
    assert.ok(journal);
    unwrap(
      journal.persistPreparedPlan(plan as unknown as OperatorMainnetTestPlan),
    );
    persistence.close();
    return ok({
      plan: plan as unknown as OperatorMainnetTestPlan,
      exchangeReads: 4,
      exchangeWrites: 0 as const,
      exchangeStage: "prepare" as const,
      exchangeGetCountsStatus: "available" as const,
      exchangeGetCounts: '{"wallet":4}',
    });
  };
  return {
    root,
    databasePath,
    clock,
    scope,
    accountIdentityHash,
    openPersistence,
    prepare,
  };
}

function directCommandPlan(
  receipt: OperatorMainnetTradeCommandReceipt,
): OperatorMainnetTradeCommandPlan {
  const quote = unwrap(
    createOperatorMainnetQuote({
      exchange: "bybit",
      environment: "mainnet",
      category: "linear",
      origin: "https://api.bybit.com",
      symbol: "DOGEUSDT",
      observedAt: "2026-10-31T11:59:58.900Z",
      collectionStartedAt: "2026-10-31T11:59:58.890Z",
      collectionCompletedAt: "2026-10-31T11:59:58.910Z",
      bid: "0.07699",
      ask: "0.07700",
      last: "0.07699",
    }),
  );
  const constraints = unwrap(
    createInstrumentConstraints({
      instrument: "DOGEUSDT",
      version: "bybit-v5:public-instrument/v2",
      priceTickSize: "0.00001",
      quantityStep: "1",
      minQuantity: "1",
      minNotional: "5",
      minPrice: "0.00001",
      maxPrice: "10",
      maxLimitQuantity: "1000000",
    }),
  );
  return unwrap(
    createOperatorMainnetTradeCommandPlan({
      receipt,
      quote,
      warningCodes: [],
      constraints,
      // Provider time can trail local command acceptance time.
      preparedAt: "2026-10-31T11:59:59.000Z",
    }),
  );
}

function persistDirectIntent(
  input: MainnetOperatorTestCompositionInput,
  fixture: ReturnType<typeof tradeFlowFixture>,
  recordAcceptedAttempt: boolean,
) {
  if (
    !("authorization" in input) ||
    input.authorization.kind !== "trade-command" ||
    typeof input.runId !== "string"
  )
    throw new Error("direct command authorization is required");
  const plan = input.plan as OperatorMainnetTradeCommandPlan;
  const payload = unwrap(
    createOperatorMainnetCreateRequest(
      plan as unknown as OperatorMainnetTestPlan,
    ),
  );
  const persistence = unwrap(
    fixture.openPersistence({ environment: "mainnet", scope: fixture.scope }),
  );
  const journal = persistence.operatorMainnetTest;
  assert.ok(journal);
  const source = unwrap(
    journal.prepareCreateIntent({
      runId: input.runId,
      plan,
      tradeCommand: {
        receipt: input.authorization
          .receipt as OperatorMainnetTradeCommandReceipt,
        binding: input.authorization
          .binding as OperatorMainnetTradeCommandBinding,
        authorizationAt: NOW,
      },
      payloadJson: payload.payloadJson,
      payloadHash: payload.payloadHash as PlanHash,
      preparedAt: NOW,
    }),
  );
  if (recordAcceptedAttempt)
    unwrap(
      journal.recordAttempt({
        runId: input.runId,
        sourceId: source.source.sourceId,
        attemptId: "attempt-accepted",
        outcome: "accepted",
        exchangeOrderId: "exchange-parent-accepted",
        recordedAt: NOW,
      }),
    );
  persistence.close();
  return {
    sourceId: source.source.sourceId,
    clientOrderId: source.source.clientOrderId,
  };
}

function statusForSavedSource(
  sourceId: string,
  fixture: ReturnType<typeof tradeFlowFixture>,
): MainnetOperatorTestStatusResult {
  const persistence = unwrap(
    fixture.openPersistence({ environment: "mainnet", scope: fixture.scope }),
  );
  const journal = persistence.operatorMainnetTest;
  assert.ok(journal);
  const latestSnapshot = unwrap(
    journal.readOperatorMainnetTestSource(sourceId),
  );
  assert.ok(latestSnapshot);
  const halt = unwrap(persistence.readHalt());
  persistence.close();
  return {
    sourceId,
    lifecycleOutcome: "PARTIAL_EVIDENCE",
    cleanupStatus: "pending",
    exchangeReads: 2,
    journaled: true,
    latestSnapshot,
    halt,
    reasons: [],
    exchangeStage: "status",
    exchangeGetCountsStatus: "available",
    exchangeGetCounts: '{"orders":2}',
  };
}

test("direct trade accepts the configured M1 symbols and rejects unsupported pairs", async (t) => {
  const fixture = tradeFlowFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  let credentialLoads = 0;
  let preparationCalls = 0;
  const dependencies = {
    credentialProvider: {
      load: async () => {
        credentialLoads += 1;
        return {
          apiKey: "test-key",
          apiSecret: "test-secret",
          accountId: "123",
        };
      },
    },
    openPersistence: fixture.openPersistence,
    actorIdentityHash: () =>
      hashCanonical({ localOperatorIdentity: "test-owner" }),
    clock: () => Date.parse(NOW),
    monotonicClock: () => 100,
    prepare: async (input: { readonly symbol: unknown }) => {
      preparationCalls += 1;
      assert.equal(input.symbol, "SOLUSDT");
      return fail(
        domainError("INVALID_EVIDENCE", "offline symbol check", {
          reasonCode: "SYMBOL_PREFLIGHT_STOP",
        }),
      );
    },
  };
  const supported = await runMainnetOperatorTrade(
    {
      symbol: "SOLUSDT",
      allocation: "10",
      grossNotionalCap: "10",
      maxDeviationBps: "10",
    },
    dependencies,
  );
  assert.equal(supported.ok, true);
  if (!supported.ok) throw new Error("supported symbol was rejected");
  assert.equal(supported.value.stoppedAt, "preparation");
  assert.equal(supported.value.reasonCode, "SYMBOL_PREFLIGHT_STOP");
  assert.equal(preparationCalls, 1);

  const unsupported = await runMainnetOperatorTrade(
    {
      symbol: "XRPUSDT",
      allocation: "10",
      grossNotionalCap: "10",
      maxDeviationBps: "10",
    },
    dependencies,
  );
  assert.equal(unsupported.ok, false);
  if (unsupported.ok) throw new Error("unsupported symbol was accepted");
  assert.equal(
    unsupported.error.details?.reasonCode,
    "INVALID_TRADE_INSTRUCTION",
  );
  assert.equal(credentialLoads, 1);
  assert.equal(preparationCalls, 1);
});

test("trade records a pre-intent refusal once and command-ID status stays local", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "operator-trade-command-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = join(root, "mainnet.db");
  const clock = { now: () => NOW };
  const accountIdentityHash = unwrap<PlanHash>(
    configuredBybitAccountIdentityHash("123", "mainnet"),
  );
  const scope: PersistenceScope = {
    exchange: "bybit",
    environment: "mainnet",
    accountId: accountIdentityHash,
    category: "linear",
    positionMode: "one-way",
  };
  const openPersistence = (options: SqlitePersistenceOptions) =>
    openSqlitePersistence({
      ...options,
      databasePath,
      runtime,
      clock,
    });
  let commandId: string | undefined;
  let savedReceiptHash: PlanHash | undefined;
  let preparationCalls = 0;
  let executionCalls = 0;
  let statusCalls = 0;

  const result = await runMainnetOperatorTrade(
    {
      symbol: "DOGEUSDT",
      allocation: "10",
      grossNotionalCap: "10",
      maxDeviationBps: "10",
    },
    {
      credentialProvider: {
        load: async (environment) => {
          assert.equal(environment, "mainnet");
          return {
            apiKey: "test-key",
            apiSecret: "test-secret",
            accountId: "123",
          };
        },
      },
      openPersistence,
      actorIdentityHash: () =>
        hashCanonical({ localOperatorIdentity: "test-owner" }),
      clock: () => Date.parse(NOW),
      monotonicClock: () => 100,
      onCommandIdGenerated: (id) => {
        commandId = id;
      },
      onReceiptSaved: (receipt) => {
        savedReceiptHash = receipt.contentHash;
      },
      prepare: async (input) => {
        preparationCalls += 1;
        assert.equal(input.symbol, "DOGEUSDT");
        assert.equal(
          (input.tradeCommandReceipt as { readonly commandId: string })
            .commandId,
          commandId,
        );
        return fail(
          domainError("INVALID_EVIDENCE", "capacity is insufficient", {
            reasonCode: "AVAILABLE_MARGIN_OR_FEE_RESERVE_INSUFFICIENT",
            exchangeReads: 17,
            exchangeWrites: 0,
            exchangeGetCounts: '{"wallet":2,"fees":1}',
            availableBalance: "1.25",
            orderNotional: "8",
            entryFeeReserve: "0.0044",
            exitFeeReserve: "0.0045",
            totalReserve: "0.0089",
            requiredAvailableBalance: "8.0089",
            shortfall: "6.7589",
          }),
        );
      },
      execute: async () => {
        executionCalls += 1;
        throw new Error("pre-intent refusal must never reach execute");
      },
    },
  );

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("trade orchestration returned an error");
  assert.equal(commandId, result.value.commandId);
  assert.equal(result.value.receiptSaved, true);
  assert.equal(result.value.kind, "blocked");
  assert.equal(result.value.stoppedAt, "preparation");
  assert.equal(
    result.value.reasonCode,
    "AVAILABLE_MARGIN_OR_FEE_RESERVE_INSUFFICIENT",
  );
  assert.equal(result.value.exchangeReads, 17);
  assert.equal(result.value.exchangeWrites, 0);
  assert.deepEqual(result.value.diagnosticDetails, {
    availableBalance: "1.25",
    orderNotional: "8",
    entryFeeReserve: "0.0044",
    exitFeeReserve: "0.0045",
    totalReserve: "0.0089",
    requiredAvailableBalance: "8.0089",
    shortfall: "6.7589",
  });
  assert.equal(preparationCalls, 1);
  assert.equal(executionCalls, 0);
  assert.ok(savedReceiptHash);

  const resolved = resolveOperatorMainnetTradeCommand(commandId!, {
    databasePath,
    clock,
  });
  assert.equal(resolved.ok, true);
  if (!resolved.ok || !resolved.value)
    throw new Error("saved command was not resolvable");
  assert.equal(resolved.value.snapshot.receipt.contentHash, savedReceiptHash);
  assert.equal(resolved.value.snapshot.binding, undefined);
  assert.equal(resolved.value.snapshot.source, undefined);
  assert.equal(resolved.value.snapshot.outcomes.length, 1);

  const status = await readMainnetOperatorTradeCommandStatus(commandId, {
    resolveCommand: (id, options) =>
      resolveOperatorMainnetTradeCommand(id, {
        ...options,
        databasePath,
        clock,
      }),
    status: async () => {
      statusCalls += 1;
      throw new Error("pre-intent status must remain local");
    },
  });
  assert.equal(status.ok, true);
  if (!status.ok) throw new Error("local command status failed");
  assert.equal(status.value.kind, "pre-intent-refused");
  assert.equal(
    status.value.reasonCode,
    "AVAILABLE_MARGIN_OR_FEE_RESERVE_INSUFFICIENT",
  );
  assert.deepEqual(status.value.diagnosticDetails, {
    availableBalance: "1.25",
    orderNotional: "8",
    entryFeeReserve: "0.0044",
    exitFeeReserve: "0.0045",
    totalReserve: "0.0089",
    requiredAvailableBalance: "8.0089",
    shortfall: "6.7589",
  });
  assert.equal(status.value.exchangeReads, 0);
  assert.equal(statusCalls, 0);

  const reopened = openPersistence({ environment: "mainnet", scope });
  assert.equal(reopened.ok, true);
  if (!reopened.ok) throw new Error("trade database could not reopen");
  const snapshot =
    reopened.value.operatorMainnetTest!.readOperatorMainnetTradeCommand(
      commandId!,
    );
  assert.equal(snapshot.ok, true);
  if (!snapshot.ok || !snapshot.value)
    throw new Error("trade receipt was not preserved on reopen");
  assert.equal(snapshot.value.receipt.contentHash, savedReceiptHash);
  reopened.value.close();
});

test("receipt-only command status says interrupted before binding", async (t) => {
  const root = mkdtempSync(
    join(tmpdir(), "operator-trade-command-interrupted-"),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = join(root, "mainnet.db");
  const clock = { now: () => NOW };
  const accountIdentityHash = unwrap(
    configuredBybitAccountIdentityHash("123", "mainnet"),
  );
  const actorIdentityHash = unwrap(
    hashCanonical({ localOperatorIdentity: "test-owner" }),
  );
  const commandId = "trade-interrupted-before-binding";
  const receipt = unwrap(
    createOperatorMainnetTradeCommandReceipt({
      commandId,
      actorIdentityHash,
      accountIdentityHash,
      symbol: "DOGEUSDT",
      allocation: "10",
      grossNotionalCap: "10",
      maxDeviationBps: "10",
      acceptedAt: NOW,
    }),
  );
  const persistence = openSqlitePersistence({
    environment: "mainnet",
    databasePath,
    runtime,
    clock,
    scope: {
      exchange: "bybit",
      environment: "mainnet",
      accountId: accountIdentityHash,
      category: "linear",
      positionMode: "one-way",
    },
  });
  assert.equal(persistence.ok, true);
  if (!persistence.ok) throw new Error("test database failed to open");
  const journal = persistence.value.operatorMainnetTest;
  assert.ok(journal);
  unwrap(
    journal.persistOperatorMainnetTradeCommandReceipt({
      receipt,
      recordedAt: NOW,
    }),
  );
  persistence.value.close();

  const status = await readMainnetOperatorTradeCommandStatus(commandId, {
    resolveCommand: (id, options) =>
      resolveOperatorMainnetTradeCommand(id, {
        ...options,
        databasePath,
        clock,
      }),
    status: async () => {
      throw new Error("receipt-only status must not query Bybit");
    },
  });
  assert.equal(status.ok, true);
  if (!status.ok) throw new Error("command status failed");
  assert.equal(status.value.kind, "interrupted-before-binding");
  assert.equal(status.value.exchangeReads, 0);
});

test("trade preserves unknown provider-read counts after an unexpected preparation throw", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "operator-trade-unknown-counts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let executeCalls = 0;
  const result = await runMainnetOperatorTrade(
    {
      symbol: "DOGEUSDT",
      allocation: "10",
      grossNotionalCap: "10",
      maxDeviationBps: "10",
    },
    {
      credentialProvider: {
        load: async () => ({
          apiKey: "test-key",
          apiSecret: "test-secret",
          accountId: "123",
        }),
      },
      openPersistence: (options) =>
        openSqlitePersistence({
          ...options,
          databasePath: join(root, "mainnet.db"),
          runtime,
          clock: { now: () => NOW },
        }),
      actorIdentityHash: () =>
        hashCanonical({ localOperatorIdentity: "test-owner" }),
      clock: () => Date.parse(NOW),
      monotonicClock: () => 100,
      prepare: async () => {
        throw new Error("fetch failed after an unreported request");
      },
      execute: async () => {
        executeCalls += 1;
        throw new Error("refused preparation must never execute");
      },
    },
  );

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("trade orchestration returned an error");
  assert.equal(result.value.kind, "blocked");
  assert.equal(result.value.stages.prepare?.exchangeReads, undefined);
  assert.equal(result.value.exchangeReads, undefined);
  assert.equal(result.value.stages.prepare?.exchangeWrites, 0);
  assert.equal(result.value.exchangeWrites, 0);
  assert.equal(executeCalls, 0);
});

test("trade persists one command intent and performs one immediate status read", async (t) => {
  const fixture = tradeFlowFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  let commandId: string | undefined;
  let executionCalls = 0;
  let statusCalls = 0;
  let statusSourceId: string | undefined;

  const result = await runMainnetOperatorTrade(
    {
      symbol: "DOGEUSDT",
      allocation: "10",
      grossNotionalCap: "10",
      maxDeviationBps: "10",
    },
    {
      credentialProvider: {
        load: async () => ({
          apiKey: "test-key",
          apiSecret: "test-secret",
          accountId: "123",
        }),
      },
      openPersistence: fixture.openPersistence,
      actorIdentityHash: () =>
        hashCanonical({ localOperatorIdentity: "test-owner" }),
      clock: () => Date.parse(NOW),
      monotonicClock: () => 100,
      onCommandIdGenerated: (value) => {
        commandId = value;
      },
      prepare: fixture.prepare,
      execute: async (input) => {
        executionCalls += 1;
        const source = persistDirectIntent(input, fixture, true);
        const execution: MainnetOperatorTestOutcome = {
          kind: "attempted",
          sourceId: source.sourceId,
          clientOrderId: source.clientOrderId,
          attemptOutcome: "accepted",
          attemptJournaled: true,
          exchangeReads: 7,
          exchangeWrites: 1,
          exchangeStage: "execute",
          exchangeGetCountsStatus: "available",
          exchangeGetCounts: '{"wallet":7}',
        };
        return ok(execution);
      },
      status: async ({ sourceId }) => {
        statusCalls += 1;
        statusSourceId = sourceId as string;
        return ok(statusForSavedSource(statusSourceId, fixture));
      },
    },
  );

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("trade orchestration returned an error");
  assert.equal(result.value.kind, "attempted");
  assert.equal(result.value.exchangeReads, 13);
  assert.equal(result.value.exchangeWrites, 1);
  assert.equal(executionCalls, 1);
  assert.equal(statusCalls, 1);
  assert.equal(statusSourceId, result.value.sourceId);
  assert.equal(
    result.value.immediateStatus?.lifecycleOutcome,
    "PARTIAL_EVIDENCE",
  );
  assert.ok(commandId);

  const resolved = resolveOperatorMainnetTradeCommand(commandId!, {
    databasePath: fixture.databasePath,
    clock: fixture.clock,
  });
  assert.equal(resolved.ok, true);
  if (!resolved.ok || !resolved.value)
    throw new Error("committed trade command was not resolvable");
  assert.equal(
    resolved.value.snapshot.binding?.clientOrderId,
    result.value.clientOrderId,
  );
  assert.equal(resolved.value.snapshot.source?.attempt?.outcome, "accepted");
  assert.equal(
    resolved.value.snapshot.consumption?.sourceId,
    result.value.sourceId,
  );
});

test("execution uncertainty after committed intent keeps identities and status never resends", async (t) => {
  const fixture = tradeFlowFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  let commandId: string | undefined;
  let executionCalls = 0;
  let statusCalls = 0;

  const result = await runMainnetOperatorTrade(
    {
      symbol: "DOGEUSDT",
      allocation: "10",
      grossNotionalCap: "10",
      maxDeviationBps: "10",
    },
    {
      credentialProvider: {
        load: async () => ({
          apiKey: "test-key",
          apiSecret: "test-secret",
          accountId: "123",
        }),
      },
      openPersistence: fixture.openPersistence,
      actorIdentityHash: () =>
        hashCanonical({ localOperatorIdentity: "test-owner" }),
      clock: () => Date.parse(NOW),
      monotonicClock: () => 100,
      onCommandIdGenerated: (value) => {
        commandId = value;
      },
      prepare: fixture.prepare,
      execute: async (input) => {
        executionCalls += 1;
        persistDirectIntent(input, fixture, false);
        throw new Error("simulated lost result after durable intent");
      },
      status: async () => {
        statusCalls += 1;
        return fail(
          domainError("UNRESOLVED_RECONCILIATION", "status unavailable", {
            reasonCode: "READ_FAILED",
            exchangeReads: 3,
            exchangeWrites: 0,
          }),
        );
      },
    },
  );

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("trade orchestration returned an error");
  assert.equal(result.value.kind, "unknown");
  assert.equal(result.value.reasonCode, undefined);
  assert.equal(
    result.value.executionStatusFailureCode,
    "EXECUTION_RESULT_UNKNOWN",
  );
  assert.equal(result.value.immediateStatusFailureCode, "READ_FAILED");
  assert.ok(result.value.sourceId);
  assert.ok(result.value.clientOrderId);
  assert.equal(result.value.exchangeWrites, undefined);
  assert.equal(executionCalls, 1);
  assert.equal(statusCalls, 1);
  assert.ok(commandId);

  const resolved = resolveOperatorMainnetTradeCommand(commandId!, {
    databasePath: fixture.databasePath,
    clock: fixture.clock,
  });
  assert.equal(resolved.ok, true);
  if (!resolved.ok || !resolved.value)
    throw new Error("durable intent was not resolvable");
  assert.ok(resolved.value.snapshot.consumption);
  assert.equal(resolved.value.snapshot.source?.attempt, undefined);
  assert.equal(resolved.value.snapshot.outcomes.length, 0);

  const recovered = await readMainnetOperatorTradeCommandStatus(commandId, {
    resolveCommand: (id, options) =>
      resolveOperatorMainnetTradeCommand(id, {
        ...options,
        databasePath: fixture.databasePath,
        clock: fixture.clock,
      }),
    status: async ({ sourceId }) => {
      statusCalls += 1;
      assert.equal(sourceId, result.value.sourceId);
      return fail(
        domainError("UNRESOLVED_RECONCILIATION", "status unavailable", {
          reasonCode: "READ_FAILED",
          exchangeReads: 3,
          exchangeWrites: 0,
        }),
      );
    },
  });
  assert.equal(recovered.ok, true);
  if (!recovered.ok) throw new Error("local command recovery failed");
  assert.equal(recovered.value.kind, "intent-present");
  assert.equal(recovered.value.clientOrderId, result.value.clientOrderId);
  assert.equal(recovered.value.statusFailureCode, "READ_FAILED");
  assert.equal(recovered.value.exchangeReads, 3);
  assert.equal(statusCalls, 2);
  assert.equal(executionCalls, 1);
});
