# ADR-0003: Daily-Only Execution with Attached Exits

Status: Accepted

Date: 2026-07-29

## Context

The product needs one deliberate daily rebalance, not a 24/7 strategy loop. An
entry may fill long after the daily process finishes and must not wait for a
future process to receive protection.

## Decision

Submit each managed entry with one exchange-attached take-profit and one
catastrophic stop. Use bounded REST polling during execution and history
fallback for reconciliation. Do not replenish filled levels until the next
daily plan.

## Invariants

- no managed entry without attached exits;
- no blind retry after ambiguous acknowledgement;
- no continuous WebSocket dependency in the MVP;
- multi-leg exits, trailing logic and intraday repair are out of scope.

## Consequences

The runtime remains small and predictable. Strategy flexibility is intentionally
limited until execution reliability and net outcomes are measured.

## Rejected alternatives

- creating exits only after a separate fill listener observes execution;
- implementing a continuous grid engine in the first release.
