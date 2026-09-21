import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertSanitizedOutput,
  renderSanitizedFindings,
  truncateExchangeOrderId,
} from "../scripts/bybit-probe/findings.js";
import { accountHash, ProbeStore } from "../scripts/bybit-probe/store.js";

test("findings use an account hash prefix and never print a full exchange ID", () => {
  const output = renderSanitizedFindings({
    runId: "run-1",
    environment: "testnet",
    verdict: "CONFIRMED_CLEAN",
    accountId: "private-account-id",
    scenarios: [
      {
        name: "long-entry",
        requestAccepted: true,
        acknowledgement: "pending",
        terminalState: "Cancelled",
        exchangeOrderId: "1234567890abcdef",
        orderLinkId: "run-1-long",
        attachedExits: "accepted",
        protectionAfterFill: "unverified",
        dispatchError: {
          classification: "exchange-rejection",
          transportKind: "exchange-failure",
          retCode: 12345,
          explanation: "Bybit returned an unclassified failure code (12345).",
        },
      },
    ],
  });
  assert.match(output, new RegExp(accountHash("private-account-id")));
  assert.doesNotMatch(output, /private-account-id/);
  assert.doesNotMatch(output, /1234567890abcdef/);
  assert.match(output, new RegExp(truncateExchangeOrderId("1234567890abcdef")));
  assert.match(output, /protection after fill: unverified/);
  assert.match(
    output,
    /dispatch error: exchange-rejection; transport kind: exchange-failure; retCode: 12345/,
  );
});

test("Demo findings identify the observed environment and transfer boundary", () => {
  const output = renderSanitizedFindings({
    runId: "demo-run",
    environment: "demo",
    verdict: "UNRESOLVED",
    accountId: "demo-uid-private",
    scenarios: [],
  });

  assert.match(output, /Bybit Demo capability probe findings/);
  assert.match(output, /environment: demo/);
  assert.match(output, /Demo-observed, Testnet\/mainnet unverified/);
  assert.doesNotMatch(output, /demo-uid-private/);
});

test("sanitized-output enforcement rejects a credential-shaped value", () => {
  assert.throws(
    () =>
      assertSanitizedOutput("signature: sentinel-secret\n", [
        "sentinel-secret",
      ]),
    /credential or signature/,
  );
});

test("sentinel credentials never reach a persisted verdict artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "bybit-probe-redaction-"));
  try {
    const store = new ProbeStore({
      rootDir: root,
      clock: () => 1_000,
      processId: 401,
      isProcessAlive: () => false,
    });
    await store.writeVerdict("run-1", "UNRESOLVED", {
      runId: "run-1",
      lastConfirmedState: "no dispatch",
      uncertainty: "interactive approval was lost",
      nextAction: "use SECURITY.md manual fallback",
    });
    const files = await readdir(join(root, "run-1"));
    const contents = await Promise.all(
      files.map((file) => readFile(join(root, "run-1", file), "utf8")),
    );
    assert.equal(
      contents.some((content) =>
        /sentinel-secret|sentinel-signature|X-BAPI-API-KEY/.test(content),
      ),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("documentation records the probe as an operator-only, unverified capability check", async () => {
  const [historicalAdr, currentAdr, runbook] = await Promise.all([
    readFile("docs/adr/0003-daily-only-attached-exits.md", "utf8"),
    readFile("docs/adr/0006-managed-entry-take-profit.md", "utf8"),
    readFile("docs/operator-runbook.md", "utf8"),
  ]);
  assert.match(historicalAdr, /Testnet capability probe/);
  assert.match(historicalAdr, /unverified/i);
  assert.match(currentAdr, /TP-only managed entries are valid/);
  assert.match(currentAdr, /stop-only managed entries block/);
  assert.match(runbook, /npm run probe:bybit:testnet/);
  assert.match(runbook, /npm run probe:bybit:demo/);
  assert.match(
    runbook,
    /npm run probe:bybit:recover -- --environment <testnet\|demo> <saved-run-id>/,
  );
  assert.match(runbook, /exchange UI fallback/i);
  assert.match(
    runbook,
    /reconciliation reads stop the run before the first write/i,
  );
  assert.match(runbook, /UNRESOLVED/);
  assert.match(runbook, /SECURITY\.md/);
});
