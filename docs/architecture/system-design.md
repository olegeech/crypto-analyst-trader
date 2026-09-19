# System Design

## Target shape

Crypto Analyst Trader is a modular TypeScript monolith. Domain logic remains
pure and exchange-neutral; adapters own transport and persistence details.

```text
src/
  domain/
    market/
    analytics/
    planning/
    risk/
    execution/
    accounting/
  application/
  ports/
  adapters/
    bybit-v5/
    sqlite/
  cli/
```

## Core use cases

- `daily prepare`: refresh evidence, snapshot the account, build a desired
  order plan, evaluate risk and cost, and write review artifacts.
- `plan approve`: record actor, note, expiry and exact immutable plan hash.
- `daily execute --plan`: validate the approved hash, apply only the owned-order
  diff and persist each attempt before the exchange call.
- `run reconcile`: resolve asynchronous or ambiguous results using open orders,
  history, fills and positions.
- `daily report`: combine decision evidence, execution, protection coverage,
  fills, costs and PnL for the same run.

Preparation and execution are separate commands. A scheduler may prepare a plan
automatically; mainnet execution is not implicitly triggered.

## Domain contracts

The foundational domain includes:

- `StrategyConfig`
- `MarketSnapshot`
- `AccountSnapshot`
- `EvidenceRef`
- `OrderIntent`
- `ExecutionPlan`
- `RiskDecision`
- `Approval`
- `ExecutionAttempt`
- `ExchangeOrder`
- `Fill`
- `LedgerEntry`
- `ReconciliationResult`

`EvidenceRef` is producer-neutral and identifies evidence by kind, schema and
producer version, source/input snapshot identity, `asOf`, freshness semantics
and canonical content hash. It does not expose research-runtime implementation
details to the planner.

## Deterministic values and identity

Money, price, quantity and fee values cross boundaries as validated decimal
strings and use exact-decimal arithmetic whenever they can affect orders, risk
or accounting. Binary floating point is not authoritative for those decisions.

Exchange normalization applies explicit tick-size, quantity-step, minimum and
rounding-direction policy. Rounding is part of domain behavior rather than a
formatting side effect.

Plans, policies, snapshots and evidence that participate in immutable identity
use one versioned canonical serialization contract before hashing. Canonical
serialization defines field ordering, decimal normalization, absent-versus-null
handling, timestamps, text encoding and schema version so equivalent logical
inputs produce the same identity across supported runtimes.

## Runtime boundaries

Exchange payloads, environment values, persisted artifacts and cross-process
files are untrusted until runtime validation succeeds. Boundary parsers and
adapters normalize validated payloads into domain contracts; TypeScript casts do
not establish runtime validity.

## Exchange-neutral domain contracts

The `src/domain` surface is the exchange-neutral contract boundary for the M0
daily batch. It is pure with respect to exchange adapters and persistence, and
its constructors return immutable values or typed domain failures:

- market and account snapshots carry exact decimal values and evidence refs;
- capability observations are tri-state and scoped by exchange, environment,
  category and position mode, so Demo evidence cannot authorize Testnet or
  mainnet behavior;
- each order-bearing plan declares the same execution scope, and risk rejects
  capability requirements that do not match that target scope;
- market and account snapshots carry the exchange, environment, category and
  position-mode scope that risk compares with the planned execution scope;
- semantic `OrderIntentId` values are separate from execution client-order IDs;
  the latter belong to an execution attempt and do not perturb equivalent plan
  identity;
- risk accepts the candidate projection, computes its input hash before the
  final immutable execution plan hash is created, and avoids a risk-to-plan
  identity cycle;
- risk evaluates every semantic intent against strategy protection and notional
  limits, and carries the full intent identity set into the decision;
- canonical material identity normalizes decimals, UTC timestamps and NFC text,
  while presentation metadata is excluded from the plan hash;
- adapters may map neutral contracts to Bybit V5 field names and wire encoding,
  but may not re-round or mutate approved price, quantity or protection values;
- M0 accounting exposes signed economic ledger events. Balanced posting sets,
  journal transactions and durable recovery remain persistence/accounting work
  outside this contract boundary.
- lifecycle state derives its evidence references from the approved plan and
  refuses execution after evidence freshness expires; reconciliation binds the
  attempt to that plan and a known exchange order, then verifies observed
  instrument, side and quantity against the approved intent.

External payload parsers validate required known fields and tolerate additive
unknown fields. Domain-owned artifacts remain versioned and exact so their
canonical identities cannot drift silently.

## Time model

Business timestamps, freshness and expiry use an injected UTC clock. Elapsed
polling deadlines and timeout measurement use a monotonic clock where
appropriate. Domain and application logic avoid scattered direct wall-clock
reads so lifecycle, expiry and freshness behavior remains deterministic in
tests.

## Plan lifecycle

```text
DRAFT
  -> VALIDATED
  -> BLOCKED | READY_FOR_APPROVAL
  -> APPROVED
  -> EXECUTING
  -> RECONCILED | PARTIAL | FAILED | EXPIRED
```

Unsupported transitions fail. Any relevant configuration, snapshot, evidence,
risk result or desired/current diff change produces a new hash and invalidates
approval.

## Exchange boundary

The write path uses a narrow typed Bybit V5 adapter rather than exposing raw
transport objects to the domain. Ports express required capabilities:

- instrument constraints;
- account and position state;
- order creation and scoped cancellation;
- lookup by exchange order ID and client order ID;
- order history and executions;
- closed PnL and transaction history.

The adapter returns normalized per-item outcomes. An HTTP acknowledgement is not
a terminal order result.

## Durable state

SQLite is required before the first order write. It stores:

- run and input snapshot identity;
- evidence references and hashes used by immutable plans;
- immutable plans and order intents;
- approvals;
- system ownership and exchange order mapping;
- execution attempts and responses after sanitization;
- fills and transaction checkpoints;
- ledger entries and reconciliation results;
- persisted halt state.

Large historical datasets, model binaries and research-runtime artifacts are not
canonical execution state. SQLite records the identities and hashes needed to
prove which evidence influenced a plan; research storage remains independently
replaceable.

Audit records are append-only. A unique account/client-order key prevents
duplicate placement. CSV, JSON and Markdown are exports, not canonical runtime
state.

## Daily execution sequence

1. Acquire an account-scoped run lock.
2. Confirm data, evidence, account snapshot and approval freshness.
3. Persist every intended write before submitting it.
4. Cancel stale owned entry orders; preserve manual and protective orders.
5. Reconcile cancellation results.
6. Place desired entries with attached take-profit and catastrophic stop.
7. Reconcile create results through bounded REST polling and history fallback.
8. Verify every managed position has protective coverage.
9. Persist final state, accounting checkpoints and operator report.

Partial success stops later exposure-increasing phases. There is no attempt to
pretend exchange operations are transactionally rolled back.

## Analytics migration

Migration uses an allowlist:

- pure analytics, market-data normalization, risk calculations and test
  fixtures may be adapted;
- exchange-neutral terminology and contracts are introduced before merge;
- transport clients, UI automation, authentication state, platform payloads
  and platform lifecycle workflows are excluded;
- golden characterization tests preserve intended analytical behavior;
- documentation is rewritten against this architecture rather than copied as
  an archive.

## Research and ML boundary

A future research or ML runtime may use Python or another research-oriented
stack for backtests, feature engineering, training and inference. It is not part
of live execution authority.

Research model artifacts remain internal to the research runtime. The production
boundary is a versioned immutable decision-evidence artifact. Such evidence may
contain candidate rankings, regime classification, expected-return or risk
estimates, uncertainty or recommended parameter ranges, but it cannot directly
submit or authorize exchange orders.

The TypeScript planner remains authoritative for constructing exchange-valid
`OrderIntent` values from current instrument constraints, account state,
strategy configuration, policy and validated evidence. Risk and immutable human
approval remain mandatory after research evidence is incorporated.

Where practical, daily research inference references the same immutable market
snapshot used by the production run. The evidence artifact records that input
identity so stale or mixed-run research cannot silently authorize a plan.

A second runtime is introduced only after a bounded experiment demonstrates
measurable trading or research value over deterministic baselines. Batch/file or
content-addressed artifact exchange is preferred over a new network service
until measured operational need proves otherwise.

## Evolution

Additional automation, a second runtime or an exchange adapter is allowed only
after relevant evidence justifies the added complexity. Execution-side evolution
still requires:

- reliable execution and reconciliation evidence;
- net accounting reconciliation;
- incident-free canary runs;
- bounded drawdown and exposure results;
- an accepted ADR defining the new capabilities and failure modes.

Research/ML evolution is additionally governed by issue #39 and ADR-0005: it
must demonstrate measurable value over simple deterministic baselines and may
not weaken the planner, risk, approval or exchange-write boundaries.
