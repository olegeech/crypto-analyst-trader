# Release Gates

GitHub Issues are the active backlog. This document defines only stable release
outcomes and intentionally does not duplicate issue bodies or implementation
order.

## M0 — Foundation

- deterministic repository checks;
- verified Bybit Testnet capability assumptions;
- accepted domain, storage and execution-boundary decisions;
- clean analytics migration allowlist.

## M1 — Decision-Only Daily Planner

- run-consistent market and account evidence;
- migrated pure analytics with characterization tests;
- cost-aware research evidence;
- deterministic desired/current order diff;
- immutable review and human approval;
- no reachable exchange write command.

## M2 — Bybit Testnet Execution

- owned-order-only cancel and create;
- attached protective exits;
- no blind retries;
- partial-result handling and crash recovery;
- bounded REST reconciliation;
- scoped halt controls.

## M3 — Production Canary

- reconciled fills, fees, funding and net ledger;
- deterministic failure-injection suite;
- dedicated subaccount and strict capital/symbol scope;
- manual approval for every run;
- documented emergency and manual fallback.

## M4 — Measured Autonomy

- decision-to-outcome feedback and promotion gates;
- policy-bounded scheduling only after stable canary evidence;
- explicit capability contract for any future exchange;
- no unsupported capability fallback.
