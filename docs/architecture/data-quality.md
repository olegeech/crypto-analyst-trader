# Data-quality assessment

`createDataQualityBoundary` owns the application trust boundary for issue #13.
Application composition supplies an explicit `quality-profile/v1` policy, its
profile version, a controlled issuer, and optionally a synchronous external
ingestion callback. Neither the issuer nor the callback comes from evidence
JSON. This module performs no provider, credential, persistence or exchange I/O.

The boundary fixes and freezes the selected profile before evaluating supplied
source artifacts. The pure `assessDataQuality` evaluator verifies existing
canonical identities, lineage, time and completeness. It returns an immutable
`data-quality-assessment/v1` artifact with `qualityGate: OK | BLOCK`, findings,
dispositions, profile identity/hash and injected evaluation time.

## Policy and confidence

Policy roles are `market`, `liquidation`, `analytics`,
`analytics:<requestId>` or `external:<family>`. Requested roles explicitly
declare requiredness and maximum age; analytics output policy does not inherit
requiredness from the #12 aggregate sufficiency label.
Each native `analytics:<requestId>` role also enforces its own `maxAgeMs`
against the analytics information cutoff, even without an aggregate analytics
freshness rule. External roles use the artifact's own `asOf` and `validForMs`.

Penalties are explicit decimal strings in policy, keyed by stable reason code
and confidence-impact group. Confidence starts at 100, subtracts the maximum
applicable non-blocking penalty in each group, and clamps at zero. Hard findings
are excluded from scoring. There is no confidence threshold: zero may accompany
OK, and high confidence never overrides BLOCK. Missing penalty policy for a
declared degradation fails closed rather than inventing a penalty. There is no
implicit M1 profile, calibrated penalty set or trusted external producer default.
Application composition must provide the reviewed versioned policy.

## Integrity and trust

Market content identity uses `marketEvidenceContentHash`; the separate full
market bundle identity uses `hashCanonical(market)`. Liquidation identity uses
`hashCanonical(liquidation)` and its existing market content-hash/run/universe/
cutoff link. Analytics retains its own content hash and inputIdentity hashes.
No parallel source-bundle hashing scheme is introduced.

An external artifact needs both a genuine application-issued admission bound
to its exact content hash and an allowlisted issuer/family/producer/schemaVersion/
modelVersion tuple. `provenance.modelName` is descriptive, not model authority.
An ingestion callback must return the same runtime-valid artifact that the
analytics bundle contains. Merely parsing arbitrary JSON or copying an issuer
or admission object never grants trust. Required unadmitted evidence blocks;
optional unadmitted evidence is rejected and penalized. Hashes prove integrity,
not authenticity. M1 uses controlled admission, not signatures or PKI.

Rehydration validates the assessment's canonical hash and payload. Its recorded
admission bindings are historical facts; they cannot issue fresh admission.

## Time and downstream ownership

External `asOf` is the information horizon and cannot exceed bundleCutoff.
Optional generatedAt satisfies `asOf <= generatedAt <= evaluationTime` and may
exceed cutoff. Expiry is inclusive. Metadata skew never relaxes information-time
or cutoff checks. Incomplete liquidation history remains incomplete; omitted
hours are not converted to zeros.

#15 consumes the completed assessment and cannot select or override its policy.
BLOCK means a blocked planning result, not HOLD or an order plan. Planner wiring
remains in #15; the existing Demo operator flow is unchanged.

## Verification

Quality and application tests are offline and credential-free. Canonical
roundtrips, spoofed admission, hash/lineage corruption, expiry boundaries,
degradation and confidence grouping are covered by executable tests. Domain
import-graph tests enforce the absence of application, adapter, credential,
storage and exchange-write dependencies. No live smoke is applicable.
