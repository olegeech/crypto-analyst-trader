import assert from "node:assert/strict";
import test from "node:test";
import { collectAccountEvidence } from "../src/application/account-evidence-collection.js";
import { BybitAccountReadClient } from "../src/adapters/bybit-v5/account-read-client.js";
import { BybitAccountReadTransport } from "../src/adapters/bybit-v5/account-read-transport.js";
import {
  parseAccountSmokeArgs,
  summarizeAccountEvidence,
  runAccountSmoke,
} from "../scripts/bybit-account-smoke.js";
import {
  createAccountEvidenceBundle,
  createAccountEvidenceCollectionResult,
  accountEvidenceContentHash,
} from "../src/domain/account/account-evidence-bundle.js";
import { fixture } from "./account-evidence-fixture.js";

const args = ["--environment", "demo", "--run-id", "smoke-1"];

test("failed partition descriptors and A/B account-info are allowlisted and distinguish absent facts", () => {
  const source = fixture();
  const value = {
    ...source,
    collectionStatus: "incomplete",
    criticalPasses: Object.fromEntries(
      Object.entries(source.criticalPasses).map(([label, pass]) => [
        label,
        {
          ...pass,
          account: {
            ...pass.account,
            marginMode: { state: "unavailable", reason: "not-returned" },
          },
        },
      ]),
    ),
    coverage: source.coverage.map((entry) =>
      entry.partition.endpoint === "account-info"
        ? { ...entry, status: "failed", reasonCodes: ["INVALID_RESPONSE"] }
        : entry,
    ),
  };
  const result = createAccountEvidenceBundle(value);
  assert.ok(result.ok);
  const summary = summarizeAccountEvidence({
    kind: "account-evidence",
    bundle: result.value,
  });
  assert.ok("failedPartitions" in summary);
  assert.ok(summary.accountInfo);
  assert.equal(summary.failedPartitions.length, 2);
  for (const entry of summary.failedPartitions) {
    assert.deepEqual(Object.keys(entry).sort(), [
      "category",
      "endpoint",
      "pass",
      "reasonCodes",
      "status",
    ]);
    assert.equal(entry.endpoint, "account-info");
    assert.deepEqual(entry.reasonCodes, ["INVALID_RESPONSE"]);
  }
  assert.deepEqual(
    summary.accountInfo.map((entry) => entry.marginModeState),
    ["unavailable", "unavailable"],
  );
  assert.deepEqual(
    summary.accountInfo.map((entry) => entry.status),
    ["failed", "failed"],
  );
  const valid = createAccountEvidenceBundle(source);
  assert.ok(valid.ok);
  const complete = summarizeAccountEvidence({
    kind: "account-evidence",
    bundle: valid.value,
  });
  assert.ok("accountInfo" in complete);
  assert.deepEqual(
    complete.accountInfo.map((entry) => entry.marginMode),
    ["REGULAR_MARGIN", "REGULAR_MARGIN"],
  );
});
test("explicit environment and run identity; strict flags and symbols", () => {
  for (const invalid of [
    [],
    ["--run-id", "x"],
    ["--environment", "mainnet"],
    [...args, "--base-url", "https://example.com"],
    [...args, "--environment", "testnet"],
    [...args, "--symbols", ""],
    [...args, "--symbols", "BTCUSDT,BTCUSDT"],
    ["--environment", "public-mainnet", "--run-id", "x"],
    ["--environment", "demo", "--run-id", " "],
  ])
    assert.throws(() => parseAccountSmokeArgs(invalid));
  assert.deepEqual(parseAccountSmokeArgs(args), {
    environment: "demo",
    runId: "smoke-1",
    configuredM1Symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "DOGEUSDT"],
  });
  for (const environment of ["demo", "testnet", "mainnet"])
    assert.equal(
      parseAccountSmokeArgs([
        "--environment",
        environment,
        "--run-id",
        "x",
        "--symbols",
        "ETHUSDT,BTCUSDT",
      ]).environment,
      environment,
    );
});

test("pre-auth summary has only safe fields and injected collection receives load only", async () => {
  const output: string[] = [];
  const result = await runAccountSmoke(args, {
    credentialLoader: {
      load: async () => ({
        apiKey: "SECRET",
        apiSecret: "SECRET",
        accountId: "PRIVATE",
      }),
    },
    collect: async (options) => {
      assert.deepEqual(Object.keys(options.credentialLoader), ["load"]);
      assert.equal(options.environment, "demo");
      assert.equal(options.runId, "smoke-1");
      const parsed = createAccountEvidenceCollectionResult({
        kind: "pre-auth-failure",
        environment: "demo",
        runId: "PRIVATE",
        policyVersion: "account-evidence-collection-policy/v1",
        startedAt: "2026-10-02T12:00:00.000Z",
        endedAt: "2026-10-02T12:00:02.000Z",
        reasonCodes: ["CREDENTIALS_UNAVAILABLE"],
      });
      assert.ok(parsed.ok);
      return parsed.value;
    },
    write: (line) => output.push(line),
  });
  assert.equal(result, 1);
  assert.deepEqual(
    Object.keys(JSON.parse(output[0]!)).sort(),
    [
      "kind",
      "environment",
      "policyVersion",
      "startedAt",
      "endedAt",
      "reasonCodes",
    ].sort(),
  );
  assert.doesNotMatch(
    output.join(""),
    /PRIVATE|SECRET|hash|balance|provenance/i,
  );
});

test("authenticated summary uses canonical hash, counts and proofs only", () => {
  const parsed = createAccountEvidenceBundle(fixture());
  assert.ok(parsed.ok);
  const summary = summarizeAccountEvidence({
    kind: "account-evidence",
    bundle: parsed.value,
  });
  const hash = accountEvidenceContentHash(parsed.value);
  assert.ok(hash.ok);
  assert.equal("canonicalHash" in summary && summary.canonicalHash, hash.value);
  assert.ok("recordCounts" in summary);
  assert.equal(summary.recordCounts.A.assets, 2);
  assert.equal(summary.recordCounts.executions, 0);
  assert.ok(summary.partitionCounts);
  assert.equal(
    summary.partitionCounts.expected,
    parsed.value.expectedPartitions.length,
  );
  assert.equal(summary.durationMs, 2000);
  assert.equal(summary.tierProof, "verified");
  assert.deepEqual(summary.modeProof.positions, [
    { symbol: "BTCUSDT", mode: "one-way" },
  ]);
  assert.doesNotMatch(
    JSON.stringify(summary),
    /accountIdentityHash|credentialPosture|walletBalance|accountBinding|apiKey|orderId|execId|feeRate|origin|run-16/,
  );
});

test("Demo missing tiers stay unverified, incomplete runs fail, complete runs pass", async () => {
  const input = fixture();
  const complete = createAccountEvidenceBundle(input);
  assert.ok(complete.ok);
  input.auxiliary.tiers = [];
  input.collectionStatus = "incomplete";
  for (const entry of input.coverage)
    if (entry.partition.endpoint === "tiers") {
      entry.status = "failed";
      entry.rows = 0;
    }
  const incomplete = createAccountEvidenceBundle(input);
  assert.ok(incomplete.ok);
  const summary = summarizeAccountEvidence({
    kind: "account-evidence",
    bundle: incomplete.value,
  });
  assert.ok("tierProof" in summary);
  assert.equal(summary.tierProof, "unverified");
  for (const [bundle, expected] of [
    [complete.value, 0],
    [incomplete.value, 1],
  ] as const) {
    assert.equal(
      await runAccountSmoke(args, {
        credentialLoader: {
          load: async () => {
            throw new Error("must not load in fake collector");
          },
        },
        collect: async () => ({ kind: "account-evidence", bundle }),
        write: () => {},
      }),
      expected,
    );
  }
});

test("invalid arguments never collect; unexpected failures never echo private errors", async () => {
  const output: string[] = [];
  let calls = 0;
  const dependencies = {
    credentialLoader: {
      load: async () => {
        throw new Error("PRIVATE");
      },
    },
    collect: async () => {
      calls++;
      throw new Error("SECRET UID IP");
    },
    write: (line: string) => output.push(line),
  };
  assert.equal(await runAccountSmoke([], dependencies), 1);
  assert.equal(calls, 0);
  assert.equal(await runAccountSmoke(args, dependencies), 1);
  assert.equal(calls, 1);
  assert.doesNotMatch(output.join(""), /SECRET|UID|PRIVATE|IP/);
});
test("real collector/transport smoke dispatches only GET and never prints private payloads", async () => {
  const at = Date.parse("2026-10-03T12:00:00Z"),
    methods: string[] = [],
    lines: string[] = [];
  const code = await runAccountSmoke(
    ["--environment", "demo", "--run-id", "offline-spy"],
    {
      credentialLoader: {
        load: async () => ({
          apiKey: "synthetic-key",
          apiSecret: "synthetic-secret",
          accountId: "123",
        }),
      },
      write: (line) => lines.push(line),
      collect: (options) =>
        collectAccountEvidence({
          ...options,
          utcClock: () => at,
          monotonicClock: () => 0,
          createReadPort: (context) =>
            new BybitAccountReadClient({
              utcClock: () => at,
              transport: new BybitAccountReadTransport({
                environment: context.environment,
                credentials: context.credentials,
                budget: context.budget,
                clock: () => at,
                monotonicClock: () => 0,
                clockOffsetMs: 0,
                request: async (url, init) => {
                  methods.push(init?.method ?? "GET");
                  const path = new URL(String(url)).pathname;
                  const result =
                    path === "/v5/user/query-api"
                      ? {
                          userID: 123,
                          readOnly: 1,
                          permissions: {
                            ContractTrade: [],
                            Spot: [],
                            Wallet: [],
                          },
                          ips: [],
                          expiredAt: "",
                          apiKey: "synthetic-key",
                        }
                      : path === "/v5/market/time"
                        ? { timeNano: String(BigInt(at) * 1000000n) }
                        : {};
                  return new Response(
                    JSON.stringify({
                      retCode:
                        path === "/v5/user/query-api" ||
                        path === "/v5/market/time"
                          ? 0
                          : 10005,
                      retMsg: "private-payload-sentinel",
                      result,
                      time: at,
                    }),
                  );
                },
              }),
            }),
        }),
    },
  );
  assert.equal(code, 1);
  assert.ok(methods.length > 2);
  assert.deepEqual(new Set(methods), new Set(["GET"]));
  assert.doesNotMatch(
    lines.join("\n"),
    /synthetic-key|synthetic-secret|private-payload-sentinel|accountIdentityHash|userID/u,
  );
  assert.equal(JSON.parse(lines[0]!).kind, "account-evidence");
});
