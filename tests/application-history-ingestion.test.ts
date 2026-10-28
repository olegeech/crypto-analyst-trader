import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { runHistoryIngestion } from "../src/application/history-ingestion.js";
import { createSqliteHistoryStore } from "../src/adapters/sqlite/history-store.js";
import { applyMigrations } from "../src/adapters/sqlite/migrations.js";
import { registerTrustedClock } from "../src/adapters/sqlite/sqlite-helpers.js";
import type { SqliteConnection } from "../src/adapters/sqlite/connection.js";
import type {
  HistoryReadPage,
  HistoryReadPort,
} from "../src/ports/history-read.js";
import { HISTORY_READ_SOURCES } from "../src/ports/history-read.js";
import type { HistoryStoreScope } from "../src/ports/history-store.js";
import type {
  HistorySyncBudget,
  HistorySyncSelection,
} from "../src/application/history-ingestion.js";
import type { Result } from "../src/domain/shared/result.js";
import type { UtcTimestamp } from "../src/domain/shared/time.js";

const upper = Date.parse("2026-10-28T12:00:00.000Z");
const from = upper - 3 * 24 * 60 * 60 * 1_000;
const to = upper - 2 * 24 * 60 * 60 * 1_000;
const scope: HistoryStoreScope = {
  exchange: "bybit",
  environment: "demo",
  accountId: `sha256:${"a".repeat(64)}`,
};

function memoryStore() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const clock = { now: () => "2026-10-28T12:00:00.000Z" as UtcTimestamp };
  const migrated = applyMigrations(db);
  assert.equal(migrated.ok, true);
  registerTrustedClock(db, clock);
  const connection: SqliteConnection = {
    db,
    path: ":memory:",
    environment: "demo",
    runtime: { nodeVersion: "22.22.3", sqliteVersion: "3.51.3" },
    clock,
    close: () => db.close(),
  };
  return { db, connection, store: createSqliteHistoryStore(connection) };
}

function input(
  selection: HistorySyncSelection = {
    kind: "explicit-range",
    fromMs: from,
    toMs: to,
    replayId: "history-test-replay",
  },
  budget?: HistorySyncBudget,
) {
  return {
    scope,
    selection,
    frozenUpperBoundMs: upper,
    ...(budget === undefined ? {} : { budget }),
  };
}

function emptyPage(
  request: Parameters<HistoryReadPort["readPage"]>[0],
): HistoryReadPage {
  return {
    source: request.source,
    window: request.window,
    cursor: request.cursor ?? null,
    nextCursor: null,
    receivedRowCount: 0,
    facts: [],
  };
}

function success<T>(value: T): Result<T> {
  return { ok: true, value };
}

test("one shared GET budget produces partial progress and resume finishes it", async () => {
  const fixture = memoryStore();
  try {
    const first = await runHistoryIngestion(
      input(undefined, { maxGetAttempts: 1 }),
      {
        store: fixture.store,
        reader: {
          async readPage(request) {
            return emptyPage(request);
          },
        },
        monotonicClock: (() => {
          let now = 0;
          return () => ++now;
        })(),
      },
    );
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.value.status, "PARTIAL");
    assert.equal(first.value.getAttempts, 1);
    assert.equal(
      first.value.sources.find((row) => row.source === "executions")
        ?.nextResumeWindow?.fromMs,
      from,
    );

    const resumed = await runHistoryIngestion(input({ kind: "resume" }), {
      store: fixture.store,
      reader: {
        async readPage(request) {
          return emptyPage(request);
        },
      },
      monotonicClock: (() => {
        let now = 0;
        return () => ++now;
      })(),
    });
    assert.equal(resumed.ok, true);
    if (!resumed.ok) return;
    assert.equal(resumed.value.status, "COMPLETE");
    assert.equal(resumed.value.getAttempts, 7);
    assert.ok(resumed.value.sources.every((row) => row.status === "traversed"));
  } finally {
    fixture.connection.close();
  }
});

test("saved cursors resume after restart and a rejected stale cursor falls back to the fixed window", async () => {
  const fixture = memoryStore();
  let targetWindowFrom: number | undefined;
  const seen: { readonly fromMs: number; readonly cursor: string | null }[] =
    [];
  try {
    const first = await runHistoryIngestion(
      input({ kind: "maximum-history" }, { maxGetAttempts: 1 }),
      {
        store: fixture.store,
        reader: {
          async readPage(request) {
            if (request.source === "order-history") {
              targetWindowFrom ??= request.window.fromMs;
              seen.push({
                fromMs: request.window.fromMs,
                cursor: request.cursor ?? null,
              });
            }
            return {
              ...emptyPage(request),
              nextCursor:
                request.source === "order-history" ? "opaque-cursor" : null,
            };
          },
        },
        monotonicClock: (() => {
          let now = 0;
          return () => ++now;
        })(),
      },
    );
    assert.equal(first.ok, true);
    const afterFirst = fixture.store.listCoverage(scope);
    assert.equal(afterFirst.ok, true);
    if (afterFirst.ok)
      assert.equal(
        afterFirst.value.find((row) => row.source === "order-history")?.cursor,
        "opaque-cursor",
      );
    const stale = await runHistoryIngestion(
      input({ kind: "maximum-history" }),
      {
        store: fixture.store,
        reader: {
          async readPage(request) {
            if (request.source === "order-history") {
              if (request.window.fromMs === targetWindowFrom)
                seen.push({
                  fromMs: request.window.fromMs,
                  cursor: request.cursor ?? null,
                });
              if (request.cursor === "opaque-cursor")
                throw Object.assign(new Error("stale cursor"), {
                  code: "UNSUPPORTED_CAPABILITY",
                });
            }
            return emptyPage(request);
          },
        },
        monotonicClock: (() => {
          let now = 0;
          return () => ++now;
        })(),
      },
    );
    assert.equal(stale.ok, true);
    assert.deepEqual(
      seen
        .filter((row) => row.fromMs === targetWindowFrom)
        .map((row) => row.cursor),
      [null, "opaque-cursor"],
    );
    const checkpoints = fixture.store.listCoverage(scope);
    assert.equal(checkpoints.ok, true);
    if (checkpoints.ok) {
      const orders = checkpoints.value.find(
        (row) =>
          row.source === "order-history" &&
          row.window.fromMs === targetWindowFrom,
      );
      assert.equal(orders?.status, "unavailable");
      assert.equal(orders?.cursor, "opaque-cursor");
    }
    const replay = await runHistoryIngestion(
      input({ kind: "maximum-history" }),
      {
        store: fixture.store,
        reader: {
          async readPage(request) {
            if (
              request.source === "order-history" &&
              request.window.fromMs === targetWindowFrom
            )
              seen.push({
                fromMs: request.window.fromMs,
                cursor: request.cursor ?? null,
              });
            return emptyPage(request);
          },
        },
        monotonicClock: (() => {
          let now = 0;
          return () => ++now;
        })(),
      },
    );
    assert.equal(replay.ok, true);
    assert.deepEqual(
      seen
        .filter((row) => row.fromMs === targetWindowFrom)
        .map((row) => row.cursor),
      [null, "opaque-cursor", null],
    );
    const finalCheckpoints = fixture.store.listCoverage(scope);
    assert.equal(finalCheckpoints.ok, true);
    if (finalCheckpoints.ok) {
      const orders = finalCheckpoints.value.find(
        (row) =>
          row.source === "order-history" &&
          row.window.fromMs === targetWindowFrom,
      );
      assert.equal(orders?.status, "traversed");
      assert.equal(orders?.cursor, null);
    }
  } finally {
    fixture.connection.close();
  }
});

test("a low GET budget resumes the current window instead of refetching page one", async () => {
  const fixture = memoryStore();
  let targetWindowFrom: number | undefined;
  const seen: { readonly fromMs: number; readonly cursor: string | null }[] =
    [];
  try {
    const first = await runHistoryIngestion(
      input({ kind: "maximum-history" }, { maxGetAttempts: 1 }),
      {
        store: fixture.store,
        reader: {
          async readPage(request) {
            if (request.source === "order-history") {
              targetWindowFrom ??= request.window.fromMs;
              if (request.window.fromMs === targetWindowFrom)
                seen.push({
                  fromMs: request.window.fromMs,
                  cursor: request.cursor ?? null,
                });
              return {
                ...emptyPage(request),
                nextCursor: request.cursor === undefined ? "page-2" : null,
              };
            }
            return emptyPage(request);
          },
        },
        monotonicClock: (() => {
          let now = 0;
          return () => ++now;
        })(),
      },
    );
    assert.equal(first.ok, true);
    const second = await runHistoryIngestion(
      input({ kind: "maximum-history" }, { maxGetAttempts: 2 }),
      {
        store: fixture.store,
        reader: {
          async readPage(request) {
            if (
              request.source === "order-history" &&
              request.window.fromMs === targetWindowFrom
            )
              seen.push({
                fromMs: request.window.fromMs,
                cursor: request.cursor ?? null,
              });
            return emptyPage(request);
          },
        },
        monotonicClock: (() => {
          let now = 0;
          return () => ++now;
        })(),
      },
    );
    assert.equal(second.ok, true);
    assert.deepEqual(
      seen
        .filter((row) => row.fromMs === targetWindowFrom)
        .map((row) => row.cursor),
      [null, "page-2"],
    );
  } finally {
    fixture.connection.close();
  }
});

test("bounded resumes interleave page continuations across sources", async () => {
  const fixture = memoryStore();
  const pageCount = new Map(HISTORY_READ_SOURCES.map((source) => [source, 0]));
  const observed: string[] = [];
  try {
    for (let invocation = 0; invocation < 2; invocation++) {
      const result = await runHistoryIngestion(
        input(undefined, { maxGetAttempts: 8 }),
        {
          store: fixture.store,
          reader: {
            async readPage(request) {
              observed.push(request.source);
              const expectedCursor =
                pageCount.get(request.source)! === 0
                  ? undefined
                  : `page-${pageCount.get(request.source)}`;
              assert.equal(request.cursor, expectedCursor);
              const nextPage = pageCount.get(request.source)! + 1;
              pageCount.set(request.source, nextPage);
              return {
                ...emptyPage(request),
                nextCursor: nextPage < 3 ? `page-${nextPage}` : null,
              };
            },
          },
          monotonicClock: (() => {
            let now = 0;
            return () => ++now;
          })(),
        },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(
        result.value.status,
        invocation === 0 ? "PARTIAL" : "COMPLETE",
      );
      const expectedRequests =
        invocation === 0
          ? [...HISTORY_READ_SOURCES, ...HISTORY_READ_SOURCES]
          : [...HISTORY_READ_SOURCES];
      assert.equal(result.value.getAttempts, expectedRequests.length);
      assert.deepEqual(
        observed.slice(invocation === 0 ? 0 : 8),
        expectedRequests,
      );
    }
    assert.ok(
      HISTORY_READ_SOURCES.every((source) => pageCount.get(source) === 3),
    );
  } finally {
    fixture.connection.close();
  }
});

test("provider budget errors preserve cursor progress and give resumable guidance", async () => {
  const fixture = memoryStore();
  try {
    const first = await runHistoryIngestion(
      input(undefined, { maxGetAttempts: 1 }),
      {
        store: fixture.store,
        reader: {
          async readPage(request) {
            return { ...emptyPage(request), nextCursor: "page-2" };
          },
        },
      },
    );
    assert.equal(first.ok, true);

    const interrupted = await runHistoryIngestion(input(undefined), {
      store: fixture.store,
      reader: {
        async readPage() {
          throw Object.assign(new Error("bounded transport"), {
            code: "COLLECTION_DEADLINE_EXCEEDED",
          });
        },
      },
    });
    assert.equal(interrupted.ok, true);
    if (!interrupted.ok) return;
    assert.match(interrupted.value.nextAction, /saved provider cursor/u);
    assert.doesNotMatch(interrupted.value.nextAction, /replay from its start/u);
    const checkpoints = fixture.store.listCoverage(scope);
    assert.equal(checkpoints.ok, true);
    if (checkpoints.ok)
      assert.equal(
        checkpoints.value.find((row) => row.source === "order-history")?.cursor,
        "page-2",
      );
  } finally {
    fixture.connection.close();
  }
});

test("repeated cursors stop the source and keep the window visible for resume", async () => {
  const fixture = memoryStore();
  try {
    const result = await runHistoryIngestion(input(), {
      store: fixture.store,
      reader: {
        async readPage(request) {
          return { ...emptyPage(request), nextCursor: "repeat" };
        },
      },
      monotonicClock: (() => {
        let now = 0;
        return () => ++now;
      })(),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const source = result.value.sources.find(
      (row) => row.source === "order-history",
    );
    assert.equal(source?.reasonCodes.includes("INVALID_RESPONSE"), true);
    assert.equal(source?.nextResumeWindow?.fromMs, from);
    assert.equal(source?.diagnostic?.stage, "history-page-validation");
    assert.equal(source?.diagnostic?.source, "order-history");
    assert.equal(source?.diagnostic?.outcome, "INVALID_RESPONSE");
  } finally {
    fixture.connection.close();
  }
});

test("a per-window page limit remains partial without hiding its resume window", async () => {
  const fixture = memoryStore();
  try {
    const result = await runHistoryIngestion(
      input(undefined, { maxPagesPerWindow: 1 }),
      {
        store: fixture.store,
        reader: {
          async readPage(request) {
            return { ...emptyPage(request), nextCursor: "more" };
          },
        },
        monotonicClock: (() => {
          let now = 0;
          return () => ++now;
        })(),
      },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.status, "PARTIAL");
    assert.equal(
      result.value.sources[0]?.reasonCodes.includes("PAGE_BUDGET_EXCEEDED"),
      true,
    );
    assert.equal(result.value.sources[0]?.nextResumeWindow?.fromMs, from);
  } finally {
    fixture.connection.close();
  }
});

test("unavailable provider windows expose their actual resume boundary", async () => {
  const fixture = memoryStore();
  try {
    const result = await runHistoryIngestion(input(), {
      store: fixture.store,
      reader: {
        async readPage(request) {
          if (request.source === "order-history")
            throw Object.assign(new Error("private provider body"), {
              code: "UNSUPPORTED_CAPABILITY",
              retCode: 110001,
              httpStatus: 200,
            });
          return emptyPage(request);
        },
      },
      monotonicClock: (() => {
        let now = 0;
        return () => ++now;
      })(),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const source = result.value.sources.find(
      (row) => row.source === "order-history",
    );
    assert.equal(source?.status, "unavailable");
    assert.equal(source?.nextResumeWindow?.fromMs, from);
    assert.equal(source?.diagnostic?.providerRetCode, 110001);
    assert.equal(source?.diagnostic?.httpStatus, 200);
    assert.doesNotMatch(JSON.stringify(result.value), /private provider body/u);
  } finally {
    fixture.connection.close();
  }
});

test("malformed provider pages remain unavailable and never advance the window", async () => {
  const fixture = memoryStore();
  try {
    const result = await runHistoryIngestion(input(), {
      store: fixture.store,
      reader: {
        async readPage(request) {
          return {
            source: request.source,
            window: request.window,
          } as unknown as HistoryReadPage;
        },
      },
      monotonicClock: (() => {
        let now = 0;
        return () => ++now;
      })(),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const checkpoint = fixture.store.listCoverage(scope);
    assert.equal(checkpoint.ok, true);
    if (checkpoint.ok) {
      assert.equal(checkpoint.value[0]?.status, "unavailable");
      assert.equal(checkpoint.value[0]?.reasonCode, "INVALID_RESPONSE");
    }
    assert.equal(result.value.sources[0]?.inserted, 0);
    assert.equal(result.value.sources[0]?.getAttempts, 1);
  } finally {
    fixture.connection.close();
  }
});

test("invalid budgets are rejected before reading or writing the store", async () => {
  let touched = false;
  const badStore = {
    listCoverage() {
      touched = true;
      return success([]);
    },
    readCheckpoint() {
      touched = true;
      return success(undefined);
    },
    commitPage() {
      touched = true;
      return success({} as never);
    },
    markCoverage() {
      touched = true;
      return success({} as never);
    },
    readFacts() {
      touched = true;
      return success([]);
    },
    readConflicts() {
      touched = true;
      return success([]);
    },
  };
  const result = await runHistoryIngestion(
    input(undefined, { maxRows: 10_001 }),
    {
      store: badStore,
      reader: {
        async readPage(request) {
          return emptyPage(request);
        },
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(touched, false);
});

test("time and raw-row exhaustion leave the current window resumable without committing an incomplete page", async () => {
  const fixture = memoryStore();
  try {
    let timedRead = false;
    let tick = 0;
    const timed = await runHistoryIngestion(
      input(undefined, { maxDurationMs: 1 }),
      {
        store: fixture.store,
        reader: {
          async readPage(request) {
            timedRead = true;
            return emptyPage(request);
          },
        },
        monotonicClock: () => tick++,
      },
    );
    assert.equal(timed.ok, true);
    if (!timed.ok) return;
    assert.equal(timedRead, false);
    assert.equal(timed.value.status, "PARTIAL");
    assert.equal(
      timed.value.sources[0]?.reasonCodes.includes(
        "COLLECTION_DEADLINE_EXCEEDED",
      ),
      true,
    );

    const rowLimited = await runHistoryIngestion(
      input(undefined, { maxRows: 1 }),
      {
        store: fixture.store,
        reader: {
          async readPage(request) {
            return { ...emptyPage(request), receivedRowCount: 2 };
          },
        },
        monotonicClock: (() => {
          let now = 0;
          return () => ++now;
        })(),
      },
    );
    assert.equal(rowLimited.ok, true);
    if (!rowLimited.ok) return;
    assert.equal(rowLimited.value.status, "PARTIAL");
    assert.equal(rowLimited.value.rowsReceived, 2);
    assert.equal(
      rowLimited.value.sources[0]?.reasonCodes.includes("ROW_BUDGET_EXCEEDED"),
      true,
    );
    const facts = fixture.store.readFacts(scope);
    assert.equal(facts.ok, true);
    if (facts.ok) assert.equal(facts.value.length, 0);
    const checkpoints = fixture.store.listCoverage(scope);
    assert.equal(checkpoints.ok, true);
    if (checkpoints.ok)
      assert.ok(
        checkpoints.value.every(
          (checkpoint) => checkpoint.status !== "traversed",
        ),
      );
  } finally {
    fixture.connection.close();
  }
});
