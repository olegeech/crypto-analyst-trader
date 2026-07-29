# ADR-0004: SQLite Execution and Accounting Journal

Status: Accepted

Date: 2026-07-29

## Context

Exchange writes are asynchronous and can have ambiguous outcomes. File reports
alone cannot provide atomic ownership, uniqueness, crash recovery or accounting
checkpoints.

## Decision

Use versioned SQLite migrations and WAL mode for plans, approvals, order
ownership, attempts, fills, transactions, ledger entries, reconciliation and
halt state. Export files are derived artifacts.

## Invariants

- an intent is committed before its exchange request;
- account and client order ID are unique;
- audit and accounting events are append-only;
- secrets are never stored;
- cursor checkpoints and overlap windows support safe restart.

## Consequences

The first deployment stays operationally light while gaining durable execution
semantics. A move to PostgreSQL requires an ADR and evidence of multi-process or
scale needs.

## Rejected alternatives

- CSV or JSON as canonical execution state;
- introducing a remote database before a single-host canary.
