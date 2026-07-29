# Agent Context

## Purpose

Build a Bybit-first, risk-gated daily trading system. Optimize measured net
risk-adjusted outcomes, never gross profit in isolation and never guaranteed
profit.

## Load only the context needed

For normal work, read:

1. the assigned GitHub issue and its direct blockers;
2. `docs/architecture/invariants.md`;
3. only ADRs and source files linked by the issue.

Do not load every issue, closed history or every ADR. GitHub Issues own active
scope and acceptance criteria; code and tests own actual behavior.

## Non-negotiable safety rules

- Fail closed on stale, incomplete or contradictory state.
- Never submit an exchange write without an approved, unexpired exact plan hash.
- Only mutate orders proven to be owned by this system.
- Never blind-retry a write after an ambiguous timeout; reconcile first.
- Never create a managed entry without exchange-native protective exits.
- Keep prepare and execute as separate use cases.
- Store no secrets, signed headers or raw credentials in files, logs or SQLite.
- CI must never receive exchange credentials or reach a write endpoint.
- Treat money, price and quantity as exact decimal values, not binary floats.

## Delivery

- One issue per non-trivial branch.
- Keep changes inside issue scope; open a follow-up issue for adjacent work.
- Add negative and restart/idempotency tests for risk or execution changes.
- PRs use `Closes #...` and report verification evidence and residual risk.
- Do not add a second backlog source or duplicate issue bodies in docs.
