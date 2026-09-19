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

## Testnet capability probe

Issue #7 supplies the operator-only, Testnet-locked capability probe used to
replace unverified Bybit write assumptions before #8 freezes domain contracts.
Run it only from a reserved Testnet account with the approved Keychain
credential:

```text
npm run probe:bybit:testnet
```

The probe records the accepted create-request shape, acknowledgement versus
terminal REST state, client-order-ID reuse and timeout reconciliation as
sanitized findings. Explicit invocation authorizes the documented Testnet
scenarios and necessary probe-owned cleanup. Each write still receives a fresh
exact, expiring probe-plan hash, is revalidated immediately before dispatch,
and has a durable pre-submit intent. The probe does not add a prompt for every
create, cancel or flatten action. A placement followed by cancellation without
an observed fill leaves protection after fill **unverified**; it must never be
reported as proven.

The live conclusion slot is intentionally unverified until an operator runs
the bounded scenarios. `UNRESOLVED` means the saved run must be reconciled
before another scenario; invoke the read-only recovery command in
`SECURITY.md`, and use the exchange-UI fallback only when that command reports
a concrete unresolved decision.
The probe is excluded from release and CI and does not change the normative
#8 execution adapter or decimal contracts.
