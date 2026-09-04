# ADR-0005: Deterministic Values and Evidence Boundaries

Status: Accepted

Date: 2026-09-04

## Context

The system approves and executes immutable plans derived from exchange data,
configuration, policy and analytical evidence. Those inputs may eventually be
produced by more than one runtime, including an offline Python research/ML
module. TypeScript compile-time types alone do not validate exchange, file or
cross-process payloads, and ordinary floating-point arithmetic or
implementation-dependent JSON serialization can break reproducibility.

## Decision

Keep planning, risk, approval, execution, reconciliation and accounting
canonical in the TypeScript core. Define deterministic domain and evidence
boundaries as follows.

### Exact numeric values

Price, quantity, money and fee values cross boundaries as validated decimal
strings and use an exact-decimal representation for authoritative arithmetic.
JavaScript `number` and binary floating point may be used only for
non-authoritative presentation or exploratory calculations that cannot affect
orders, risk or accounting.

Exchange normalization uses explicit policy for tick size, quantity step,
minimums and rounding direction. Rounding is never an implicit side effect of
formatting.

### Canonical serialization and hashing

Objects that participate in identity, approval or evidence integrity use one
versioned canonical serialization contract before hashing. The contract defines
field ordering, decimal normalization, absent-versus-null handling, timestamps,
Unicode/text encoding and schema version. Logically identical values therefore
produce the same bytes and hash across supported runtimes.

### Runtime validation

Exchange responses, environment input, persisted artifacts and cross-process
files are untrusted data until runtime validation succeeds. Adapters or boundary
parsers convert validated payloads into domain contracts; unchecked casts do not
establish domain validity.

### Evidence identity

Planning may consume evidence through a minimal `EvidenceRef` containing at
least:

- evidence kind and schema version;
- producer/version identity;
- `asOf` and production timestamp;
- input or source snapshot identity;
- freshness or expiry semantics where applicable;
- canonical content hash.

Evidence compatibility and freshness are evaluated before it can contribute to
a live-ready plan. Relevant evidence hashes become part of immutable plan
identity.

### Time

Business timestamps and expiry/freshness checks use an injected UTC clock.
Timeout and deadline measurement uses a monotonic clock where elapsed time is
the concern. Domain and application logic do not scatter direct wall-clock reads
when deterministic tests need to control time.

### Future research and ML

A future research/ML runtime may train models, run backtests or produce daily
decision evidence offline. Model artifacts remain internal to that research
runtime. The production boundary is a versioned decision-evidence artifact, not
a Python object, pickle or executable model dependency.

Research evidence may contain rankings, regime classification, expected-return
or risk estimates, confidence/uncertainty and recommended parameter ranges. It
is evidence only. The TypeScript planner remains responsible for deriving
exchange-valid `OrderIntent` values from current instrument constraints,
account state, strategy configuration and policy. Research code receives no
exchange-write authority.

When possible, daily inference references the same immutable market snapshot
used by the production run so evidence provenance and run coherence can be
verified.

## Consequences

- Plan approval and evidence integrity remain reproducible across processes and
  future languages.
- Runtime validation becomes an explicit boundary responsibility rather than a
  TypeScript assertion convention.
- A future Python research stack can evolve independently without becoming a
  production execution dependency.
- Adding exact-decimal and canonical-serialization libraries requires careful
  selection and characterization tests.
- A second runtime is still additional complexity and is introduced only when
  measured research value justifies it.

## Rejected alternatives

- using JavaScript `number` as the authoritative money/order representation;
- hashing ordinary implementation-dependent JSON directly;
- trusting TypeScript casts for network or file payloads;
- loading Python model objects directly in the production execution process;
- allowing research output to bypass planning, risk or immutable approval;
- introducing a Python network service before a batch artifact boundary proves
  insufficient.

## Follow-up

Issue #40 applies these contracts to the architecture and foundational stories.
Issue #39 evaluates whether a Python research/ML module earns the cost of a
second runtime and dependency stack.
