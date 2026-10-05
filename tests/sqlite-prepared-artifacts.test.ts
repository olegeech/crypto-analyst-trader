import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openSqlitePreparedArtifactStore } from "../src/adapters/sqlite/prepared-artifact-store.js";
import { preparedPlanFixture } from "./fixtures/prepared-plan-fixtures.js";
import { requireDailyFixture as value } from "./fixtures/daily-planning-evidence-fixtures.js";
import { createPreparedPlanApproval } from "../src/domain/review/prepared-plan-approval.js";
import {
  encodeCanonicalArtifact,
  rehydrateArtifact,
} from "../src/domain/identity/canonical-artifact.js";

test("scoped restart replay and consent use private canonical artifacts only", () => {
  const root = mkdtempSync(join(tmpdir(), "daily-prepared-"));
  const p = preparedPlanFixture("review");
  const environment = p.inputIdentity.environment;
  let store = value(
    openSqlitePreparedArtifactStore({ environment, rootDirectory: root }),
  );
  try {
    assert.equal(store.savePrepared(p).ok, true);
    assert.equal(store.savePrepared(p).ok, true);
    const a = value(
      createPreparedPlanApproval({
        prepared: p,
        preparedHash: p.contentHash,
        actor: "local-operator:fixture",
        consent: true,
        note: "Acknowledged finding",
        approvedAt: "2026-09-24T14:02:00.000Z",
      }),
    );
    assert.equal(store.saveApproval(a).ok, true);
    assert.equal(store.saveApproval(a).ok, true);
    store.close();
    store = value(
      openSqlitePreparedArtifactStore({ environment, rootDirectory: root }),
    );
    assert.equal(
      value(store.loadPrepared(p.contentHash))?.contentHash,
      p.contentHash,
    );
    assert.equal(
      value(store.loadApproval(a.contentHash))?.contentHash,
      a.contentHash,
    );
    assert.equal(
      value(
        rehydrateArtifact(
          "prepared-daily-plan",
          value(encodeCanonicalArtifact("prepared-daily-plan", p)),
        ),
      ).contentHash,
      p.contentHash,
    );
    assert.equal(
      value(
        rehydrateArtifact(
          "prepared-plan-approval",
          value(encodeCanonicalArtifact("prepared-plan-approval", a)),
        ),
      ).contentHash,
      a.contentHash,
    );
    const db = new DatabaseSync(join(root, `${environment}.db`));
    try {
      assert.deepEqual(
        db
          .prepare("SELECT DISTINCT account_id FROM artifacts")
          .all()
          .map((r) => r.account_id),
        [p.inputIdentity.accountIdentityHash],
      );
      for (const table of [
        "execution_lineages",
        "owned_intents",
        "execution_attempts",
        "leases",
        "approvals",
      ])
        assert.equal(
          db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n,
          0,
        );
      assert.equal(
        statSync(join(root, `${environment}.db`)).mode & 0o777,
        0o600,
      );
      db.prepare(
        "UPDATE artifacts SET account_id = 'raw-user-id' WHERE artifact_kind = 'prepared-daily-plan'",
      ).run();
      assert.equal(store.loadPrepared(p.contentHash).ok, false);
    } finally {
      db.close();
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("no orphan consent, wrong environment, unknown hash or tampered artifact", () => {
  const root = mkdtempSync(join(tmpdir(), "daily-prepared-"));
  const p = preparedPlanFixture("review");
  const store = value(
    openSqlitePreparedArtifactStore({
      environment: p.inputIdentity.environment,
      rootDirectory: root,
    }),
  );
  try {
    const a = value(
      createPreparedPlanApproval({
        prepared: p,
        preparedHash: p.contentHash,
        actor: "local-operator:fixture",
        consent: true,
        note: "Acknowledged",
        approvedAt: "2026-09-24T14:02:00.000Z",
      }),
    );
    assert.equal(store.saveApproval(a).ok, false);
    assert.equal(value(store.loadPrepared(p.contentHash)), undefined);
    assert.equal(store.loadPrepared("invalid").ok, false);
    const other = value(
      openSqlitePreparedArtifactStore({
        environment:
          p.inputIdentity.environment === "mainnet" ? "demo" : "mainnet",
        rootDirectory: root,
      }),
    );
    try {
      assert.equal(other.savePrepared(p).ok, false);
    } finally {
      other.close();
    }
    assert.equal(
      store.savePrepared({ ...p, state: "READY_FOR_APPROVAL" }).ok,
      false,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
