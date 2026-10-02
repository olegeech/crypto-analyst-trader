import assert from "node:assert/strict";
import test from "node:test";
import { classifyQualityEvidence } from "../src/domain/quality/quality-validation.js";
import { admitQualitySource } from "../src/domain/quality/quality-inputs.js";
import { createQualityProfile } from "../src/domain/quality/quality-profile.js";
import { parseUtcTimestamp } from "../src/domain/shared/time.js";
import {
  marketFixture,
  liquidationFixture,
  liquidationFixtureRef,
  analyticsFixture,
  externalEvidenceFixture,
  fixtureCanonicalHash,
  DATA_QUALITY_FIXTURE_CUTOFF,
} from "./fixtures/data-quality-fixtures.js";

function time(value = DATA_QUALITY_FIXTURE_CUTOFF) {
  const result = parseUtcTimestamp(value);
  assert.ok(result.ok);
  return result.value;
}
function profile(required = false, maxAgeMs = 86_400_000) {
  const result = createQualityProfile({
    schemaVersion: "quality-profile/v1",
    profileVersion: "u3-test-v1",
    roles: [
      "market",
      "liquidation",
      "analytics",
      "analytics:btc-hourly-return",
      "external:market-regime-score",
    ].map((id) => ({ id, required, maxAgeMs })),
    metadataSkewMs: 1000,
    trust: [],
    penalties: [],
  });
  assert.ok(result.ok);
  return result.value;
}
test("optional market incompleteness is preserved without assigning confidence groups", () => {
  const record = admitQualitySource({ role: "market", value: marketFixture() });
  assert.deepEqual(
    classifyQualityEvidence([record], profile(), time(), time()),
    [{ role: "market", reasonCode: "INCOMPLETE_EVIDENCE", blocking: false }],
  );
});
test("admission integrity failures block optional evidence; absence belongs to host", () => {
  assert.deepEqual(classifyQualityEvidence([], profile(), time(), time()), []);
  assert.deepEqual(
    classifyQualityEvidence(
      [{ role: "market", failures: ["HASH_MISMATCH"] }],
      profile(),
      time(),
      time(),
    ),
    [{ role: "market", reasonCode: "HASH_MISMATCH", blocking: true }],
  );
});
test("expiry and profile age boundaries are inclusive", () => {
  const record = admitQualitySource({ role: "market", value: marketFixture() });
  for (const required of [false, true]) {
    assert.ok(
      classifyQualityEvidence(
        [record],
        profile(required, 1000),
        time(),
        time("2026-09-24T14:00:01.000Z"),
      ).some(
        (f) => f.reasonCode === "STALE_EVIDENCE" && f.blocking === required,
      ),
    );
  }
});
test("supplied liquidation lineage conflicts block even optional roles", () => {
  const market = marketFixture();
  const liquidation = liquidationFixture(marketFixture({ runId: "other-run" }));
  const records = [
    admitQualitySource({ role: "market", value: market }),
    admitQualitySource({
      role: "liquidation",
      value: liquidation,
      evidenceRef: liquidationFixtureRef(liquidation),
    }),
  ];
  assert.ok(
    classifyQualityEvidence(records, profile(), time(), time()).some(
      (f) => f.reasonCode === "LINEAGE_MISMATCH" && f.blocking,
    ),
  );
});
test("liquidation proofs remain separate and classification does not mutate rows", () => {
  const value = liquidationFixture();
  const before = JSON.stringify(value);
  const record = admitQualitySource({
    role: "liquidation",
    value,
    evidenceRef: liquidationFixtureRef(value),
  });
  const findings = classifyQualityEvidence([record], profile(), time(), time());
  for (const reason of [
    "INCOMPLETE_LIQUIDATION_COVERAGE",
    "INCOMPLETE_LIQUIDATION_HISTORY",
  ])
    assert.ok(findings.some((f) => f.reasonCode === reason && !f.blocking));
  assert.equal(JSON.stringify(value), before);
});
test("analytics uses existing market full-bundle and content links", () => {
  const original = marketFixture();
  const analytics = analyticsFixture(original);
  const changed = marketFixture({ runId: "changed-run" });
  const records = [
    admitQualitySource({ role: "market", value: changed }),
    admitQualitySource({ role: "analytics", value: analytics }),
  ];
  assert.ok(
    classifyQualityEvidence(records, profile(), time(), time()).some(
      (f) => f.role === "analytics" && f.reasonCode === "LINEAGE_MISMATCH",
    ),
  );
  assert.deepEqual(
    classifyQualityEvidence(records, profile(), time(), time()),
    classifyQualityEvidence([...records].reverse(), profile(), time(), time()),
  );
});

test("EvidenceRef expiry applies independently of profile age", () => {
  const value = liquidationFixture();
  const record = admitQualitySource({
    role: "liquidation",
    value,
    evidenceRef: liquidationFixtureRef(value, 1000),
  });
  assert.ok(
    !classifyQualityEvidence(
      [record],
      profile(),
      time(),
      time("2026-09-24T14:00:00.999Z"),
    ).some((f) => f.reasonCode === "STALE_EVIDENCE"),
  );
  assert.ok(
    classifyQualityEvidence(
      [record],
      profile(),
      time(),
      time("2026-09-24T14:00:01.000Z"),
    ).some((f) => f.reasonCode === "STALE_EVIDENCE"),
  );
});
test("future cutoff is invariant and metadata skew has an inclusive bound", () => {
  assert.deepEqual(
    classifyQualityEvidence(
      [],
      profile(),
      time(),
      time("2026-09-24T13:59:59.000Z"),
    ),
    [{ role: "assessment", reasonCode: "FUTURE_INFORMATION", blocking: true }],
  );
  const record = admitQualitySource({ role: "market", value: marketFixture() });
  assert.ok(
    classifyQualityEvidence(
      [record],
      profile(),
      time(),
      time("2026-09-24T13:59:59.000Z"),
    ).some((f) => f.reasonCode === "FUTURE_INFORMATION" && f.blocking),
  );
  for (const [offset, expected] of [
    [1000, false],
    [1001, true],
  ] as const) {
    const value = marketFixture({
      collectionEndedAt: time(
        new Date(Date.parse(time()) + offset).toISOString(),
      ),
    });
    const records = [admitQualitySource({ role: "market", value })];
    assert.equal(
      classifyQualityEvidence(records, profile(), time(), time()).some(
        (f) => f.reasonCode === "METADATA_CLOCK_SKEW",
      ),
      expected,
    );
  }
});
test("output-only policy accepts complete native analytics without supplied market", () => {
  const value = analyticsFixture();
  const onlyOutputs = {
    ...profile(),
    roles: [
      {
        id: "analytics:btc-hourly-return",
        required: false,
        maxAgeMs: 86_400_000,
      },
    ],
  };
  assert.deepEqual(
    classifyQualityEvidence(
      [admitQualitySource({ role: "analytics", value })],
      onlyOutputs,
      time(),
      time(),
    ),
    [],
  );
});
test("optional incompatible liquidation lineage does not manufacture aggregate invalidity", () => {
  const market = marketFixture();
  const liquidation = liquidationFixture(marketFixture({ runId: "other-run" }));
  const value = analyticsFixture(market, { liquidation });
  assert.equal(value.sufficiency.status, "complete");
  const findings = classifyQualityEvidence(
    [admitQualitySource({ role: "analytics", value })],
    profile(),
    time(),
    time(),
  );
  assert.ok(
    findings.some((f) => f.reasonCode === "LINEAGE_MISMATCH" && f.blocking),
  );
  assert.ok(!findings.some((f) => f.reasonCode === "INVALID_EVIDENCE"));
});
test("insufficient analytics maps unavailable outputs through quality requiredness", () => {
  const market = marketFixture();
  const value = analyticsFixture(market, {
    profile: {
      schemaVersion: "analytics-profile/v1",
      features: [
        {
          id: "btc-hourly-return",
          kind: "close-return",
          symbol: "BTCUSDT",
          interval: "1h",
          periods: 10,
          required: true,
        },
      ],
      externalEvidence: [],
    },
  });
  assert.equal(value.sufficiency.status, "insufficient");
  const record = admitQualitySource({ role: "analytics", value });
  for (const required of [false, true]) {
    const findings = classifyQualityEvidence(
      [record],
      profile(required),
      time(),
      time(),
    );
    assert.ok(
      findings.some(
        (f) =>
          f.role === "analytics:btc-hourly-return" &&
          f.reasonCode === "UNAVAILABLE_ANALYTICS" &&
          f.blocking === required,
      ),
    );
    assert.equal(
      findings.some(
        (f) =>
          f.role === "analytics" && f.reasonCode === "UNAVAILABLE_ANALYTICS",
      ),
      false,
    );
  }
});
test("macro-only external evidence permits absent or post-cutoff generation metadata", () => {
  const market = marketFixture();
  for (const generatedAt of [undefined, "2026-09-24T14:00:01.000Z"]) {
    const external = externalEvidenceFixture(
      "market-regime-score",
      market,
      generatedAt === undefined ? {} : { generatedAt },
    );
    const value = analyticsFixture(market, {
      profile: {
        schemaVersion: "analytics-profile/v1",
        features: [],
        externalEvidence: [{ family: "market-regime-score", required: true }],
      },
      externalEvidence: { "market-regime-score": external },
    });
    const records = [admitQualitySource({ role: "analytics", value })];
    assert.deepEqual(
      classifyQualityEvidence(
        records,
        profile(),
        time(),
        time("2026-09-24T14:00:02.000Z"),
      ),
      [],
    );
  }
});
test("external information gets no skew allowance and invalid generation blocks", () => {
  const market = marketFixture();
  const external = externalEvidenceFixture("market-regime-score", market);
  const base = analyticsFixture(market, {
    profile: {
      schemaVersion: "analytics-profile/v1",
      features: [],
      externalEvidence: [{ family: "market-regime-score", required: true }],
    },
    externalEvidence: { "market-regime-score": external },
  });
  for (const [patch, reason] of [
    [{ asOf: time("2026-09-24T14:00:00.001Z") }, "FUTURE_INFORMATION"],
    [
      { generatedAt: time("2026-09-24T13:59:59.999Z") },
      "INVALID_GENERATION_TIME",
    ],
    [
      { generatedAt: time("2026-09-24T14:00:02.001Z") },
      "INVALID_GENERATION_TIME",
    ],
  ] as const) {
    const value = { ...base, externalEvidence: [{ ...external, ...patch }] };
    assert.ok(
      classifyQualityEvidence(
        [{ role: "analytics", value, failures: [] }],
        profile(),
        time(),
        time("2026-09-24T14:00:02.000Z"),
      ).some(
        (f) =>
          f.role === "external:market-regime-score" &&
          f.reasonCode === reason &&
          f.blocking,
      ),
    );
  }
});
test("gaps and duplicate source diagnostics remain stable", () => {
  const market = marketFixture({
    diagnostics: [
      { code: "duplicate-observation", operation: "fetch", endpoint: "ohlcv" },
      { code: "duplicate-observation", operation: "fetch", endpoint: "ohlcv" },
      { code: "missing-required-data", operation: "fetch", endpoint: "ohlcv" },
    ],
  });
  const findings = classifyQualityEvidence(
    [admitQualitySource({ role: "market", value: market })],
    profile(),
    time(),
    time(),
  );
  assert.equal(
    findings.filter((f) => f.reasonCode === "DUPLICATE_OBSERVATION").length,
    1,
  );
  assert.ok(
    findings.some(
      (f) => f.reasonCode === "DUPLICATE_OBSERVATION" && f.blocking,
    ),
  );
  assert.ok(
    findings.some((f) => f.reasonCode === "GAPPED_WINDOW" && !f.blocking),
  );
});
test("classifier independently detects corrupted supplied hashes and aggregate state", () => {
  const market = marketFixture();
  const record = admitQualitySource({ role: "market", value: market });
  assert.ok(
    classifyQualityEvidence(
      [{ ...record, contentHash: fixtureCanonicalHash("wrong") }],
      profile(),
      time(),
      time(),
    ).some((f) => f.reasonCode === "HASH_MISMATCH" && f.blocking),
  );
  const analytics = analyticsFixture(market);
  const changed = {
    ...analytics,
    sufficiency: { ...analytics.sufficiency, status: "insufficient" as const },
  };
  const { contentHash: ignored, ...payload } = changed;
  assert.ok(ignored);
  const value = { ...payload, contentHash: fixtureCanonicalHash(payload) };
  const findings = classifyQualityEvidence(
    [{ role: "analytics", value, failures: [] }],
    profile(),
    time(),
    time(),
  );
  assert.ok(
    findings.some((f) => f.reasonCode === "INVALID_EVIDENCE" && f.blocking),
  );
});
