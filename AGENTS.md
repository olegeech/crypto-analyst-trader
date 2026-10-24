# Agent Context

## Purpose

Build the Bybit-first, risk-gated daily system according to
`docs/product-principles.md`.

## Load only the context needed

For normal work, read:

1. the assigned GitHub issue and its direct blockers;
2. for product behavior or trade-offs, `docs/product-principles.md`;
3. for data, analytics, planning, risk, execution, accounting or adapter
   changes, `docs/architecture/invariants.md`;
4. for credentials, private account artifacts or incident handling,
   `SECURITY.md`;
5. for a daily operator run, `docs/operator-runbook.md`;
6. only ADRs and source files linked by the issue.

Do not load every issue, closed history or every ADR. GitHub Issues own active
scope and acceptance criteria; code and tests own actual behavior.

## Product-owner complexity budget — 2026-10-24

For the current supervised Mainnet canary (#31), design for **one attending human,
one local application process and one deliberately approved order**, not a
future autonomous or multi-process trading service. The owner will inspect
Bybit manually if a process crashes or an order outcome is uncertain.

- **Earn every additional guard.** Before adding a new blocker, HALT trigger,
  lease/fencing mechanism, retry/recovery state, extra prompt or validation
  layer, show the concrete failure seen in the current workflow (or a
  demonstrably unavoidable immediate failure), its actual consequence, why
  an existing simpler control does not address it, and the smallest fix.
  Hypothetical future concurrency or autonomy is not sufficient justification.
- **#31 owner decision:** Remove the account-scoped run lease as an admission
  prerequisite for this _attended, single-process operator experiment_; do not
  turn an expired/abandoned pre-intent lease into automatic HALT or require
  incident reconciliation when no CREATE could have been submitted. This
  explicitly supersedes older #9/#31 lease-by-default planning **for this
  bounded operator path only**. Defer multi-process fencing to a demonstrated
  need or a separately approved autonomous-execution design.
- **Keep the minimum real-write boundary:** explicit exact-plan consent, the
  operator's capital cap, current account/position/open-order and venue checks,
  unique durable CREATE intent/client order identity, no blind duplicate
  submission after an ambiguous write, attached TP and truthful status.
  After an uncertain submission or crash, give the operator concrete Bybit UI
  inspection/recovery guidance; never infer that an order did not exist.
  Do not automatically clear an existing non-lease incident HALT.
- This is an approved **design simplification**, not permission to bypass
  current code or manually edit SQLite. Update implementation, regression tests
  and #31 acceptance criteria together before any supervised live CREATE.
  Do not broaden this decision to unattended execution.

## Canonical safety context

An issue or pull request cannot restate, weaken or override
`docs/architecture/invariants.md`.

## Delivery

- Keep changes inside issue scope; open a follow-up issue for adjacent work.
- Do not add a second backlog source or duplicate issue bodies in docs.
- Follow `docs/workflow.md` and `CONTRIBUTING.md` for branch, test and pull
  request rules.
- The repository skills `$develop-next-roadmap-story`, `$issue-delivery`,
  `$test-current-feature-pr`, and `$daily-rebalance` are temporarily deprecated
  and must not be invoked until their owners refresh the workflows and remove
  this pause notice. Do not invoke a paused skill or present it as an available
  path; use an explicitly requested maintained workflow when it covers the task.
  If no permitted workflow can handle the request, state the limitation and
  identify the owner action needed to refresh the paused workflow.
- After the pause notice is removed and those workflows are refreshed, use the
  maintained repository skills for daily operation, exact-PR review and roadmap
  delivery instead of reconstructing them from chat history.
- After this pause is removed, use `$issue-delivery #<issue>` for one named
  eligible issue; it stops at `READY_FOR_MERGE` unless the caller explicitly
  adds `merge`. Roadmap selection remains the responsibility of the roadmap
  skill.
