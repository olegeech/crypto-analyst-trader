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
- Use repository skills for daily operation, exact-PR review and roadmap
  delivery instead of reconstructing those workflows from chat history.
