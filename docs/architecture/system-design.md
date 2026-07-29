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
- `OrderIntent`
- `ExecutionPlan`
- `RiskDecision`
- `Approval`
- `ExecutionAttempt`
- `ExchangeOrder`
- `Fill`
- `LedgerEntry`
- `ReconciliationResult`

Money, price, quantity and fee values cross boundaries as validated decimal
strings. Floating-point arithmetic is not authoritative for orders or
accounting.

## Plan lifecycle

```text
DRAFT
  -> VALIDATED
  -> BLOCKED | READY_FOR_APPROVAL
  -> APPROVED
  -> EXECUTING
  -> RECONCILED | PARTIAL | FAILED | EXPIRED
```

Unsupported transitions fail. Any relevant configuration, snapshot, risk result
or desired/current diff change produces a new hash and invalidates approval.

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
- immutable plans and order intents;
- approvals;
- system ownership and exchange order mapping;
- execution attempts and responses after sanitization;
- fills and transaction checkpoints;
- ledger entries and reconciliation results;
- persisted halt state.

Audit records are append-only. A unique account/client-order key prevents
duplicate placement. CSV, JSON and Markdown are exports, not canonical runtime
state.

## Daily execution sequence

1. Acquire an account-scoped run lock.
2. Confirm data, account snapshot and approval freshness.
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

## Evolution

Additional automation or an exchange adapter is allowed only after:

- reliable execution and reconciliation evidence;
- net accounting reconciliation;
- incident-free canary runs;
- bounded drawdown and exposure results;
- an accepted ADR defining the new capabilities and failure modes.
