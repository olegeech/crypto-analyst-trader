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
