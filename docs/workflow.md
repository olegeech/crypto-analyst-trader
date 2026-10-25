# Development Workflow

## Canonical sources

- active scope and acceptance criteria: GitHub Issue;
- release outcome and grouping: GitHub milestone;
- active milestone queue: roadmap Issue;
- current product boundary: `README.md`;
- product priorities and trade-offs: `docs/product-principles.md`;
- current technical structure: `docs/architecture/system-design.md`;
- current mandatory safety rules: `docs/architecture/invariants.md`;
- implementation evidence: pull request and tests;
- architectural rationale and decision history: accepted ADR;
- actual behavior: code and tests;
- credential and incident containment: `SECURITY.md`.

Closed issues and merged pull requests are the work archive. Do not create a
second backlog, roadmap or done archive in Markdown.

## Classification

Every delivery issue leaving `status:needs-triage` has a milestone and exactly
one label from each required group:

- `type:epic`, `type:story`, `type:bug`, `type:tech-debt`, `type:spike` or
  `type:experiment`;
- `priority:P0`, `priority:P1` or `priority:P2`;
- `status:queued`, `status:ready`, `status:in-progress` or `status:blocked`;
- one `area:*`.

The unassigned cross-milestone roadmap tracker is the only milestone exception
and does not count toward developer WIP.

Closing an issue means Done; there is no done label. Status labels are removed
automatically on close.

Status:

- `queued`: valid scoped work waiting in roadmap order; planned dependencies
  may still be open and the item is outside Ready WIP;
- `ready`: satisfies the Definition of Ready and may be claimed now;
- `in-progress`: actively owned implementation;
- `blocked`: work expected to proceed is stopped by a concrete unexpected
  dependency or decision. State the blocker, owner and action needed.

Do not use `blocked` merely because a later milestone has not started.

Priority:

- P0: blocks the active release gate, or is an urgent capital-safety,
  security or accounting-integrity incident;
- P1: belongs to the next release gate;
- P2: belongs to a later gate or is optional future work.

Safety severity and delivery priority are separate. A future safety-critical
story keeps its safety labels but is promoted to P0 only when its release gate
becomes active. Re-triage priorities when a milestone opens or closes.

Keep no more than eight delivery items Ready and no more than one In Progress
per developer. Epics and the roadmap tracker do not count toward WIP. If almost
every issue is P1, triage has failed.

## Triage decision lens

When implementation order is not already forced by a release gate, prefer the
smallest slice that best improves:

1. capital safety or accounting and data integrity;
2. usable daily decision or execution capability;
3. evidence about net return, drawdown or capital efficiency;
4. operator effort and failure recovery;
5. implementation, recurring API, storage and agent-context cost.

Avoid labels for these dimensions unless they drive automation. Record the
trade-off in the issue's "Why now" section instead.

For operator-facing work, follow the proportionate-safeguards and diagnostics
guidance in [Product Principles](product-principles.md#product-intent--reviewed-2026-10-05)
and [Contributing](../CONTRIBUTING.md#operator-safeguards-and-diagnostics).
Discuss uncertain operator needs with the owner in a short interview before
adding a new workflow or mandatory step. Evaluate the operator effort and
diagnostic usefulness against the concrete risk addressed.

## Definition of Ready

- one measurable outcome;
- human product owner interview;
- three to seven acceptance criteria;
- explicit non-goals;
- all dependencies closed or a time-boxed spike identified;
- verification and failure behavior described;
- size small enough for one focused pull request;
- required live, capital, data-integrity or security labels applied.

## Integration contract check

For external API or money-affecting changes, include these checks in the
existing planning, implementation and acceptance work. Internal refactoring
that preserves those contracts does not need this step.

1. **Check assumptions early.** Before a large implementation, identify
   unverified provider facts, distinguish product decisions from mandatory
   technical protections, and choose a concrete test that proves success.
   Settle the execution mode and release boundary with the owner in the
   existing issue or plan; no separate document or agent is required.
2. **Test the provider contract.** Inspect existing production mappers and
   current official API documentation. Use a representative sanitized provider
   response fixture, preserving meaningful empty, optional and extra fields,
   plus negative cases for critical fields. Record fixture provenance without
   secrets or private account data. Test through the production mapper rather
   than constructing only the domain object the validator expects. Use the
   existing Node test runner; no new mocking or record/replay platform.
3. **Prove the operator path incrementally.** For execution work, cover
   `prepare → execute admission → status`, from provider responses through
   application results to CLI diagnostics, including the happy path and known
   blockers. Complete relevant production-path tests and available read-only
   checks before a separately approved live canary. A failed stage calls for a
   focused contract-boundary fix, not more guards across the whole flow.
   Existing safety gates and exact-plan authorization still apply.

For the next two or three integration PRs, add a few lines to the existing PR
retrospective: provider contract defects first found in manual operation,
defect fixes after the first full green CI, and operator retries caused by
program defects. Separate product-scope changes and expected safety blocks
from defects. This trial needs no metrics system, additional agents, blanket
cross-model review or Mainnet smoke on every commit.

## Named issue delivery

The repository-local `issue-delivery` skill is temporarily paused; see its
deprecation notice in
[`.agents/skills/issue-delivery/SKILL.md`](../.agents/skills/issue-delivery/SKILL.md).
Do not invoke it or present it as an available path until its owner removes the
pause. Use an explicitly requested maintained workflow only when it covers the
task. If no permitted workflow applies, stop and report the limitation and the
owner action needed to refresh the paused workflow.

## Definition of Done

- acceptance criteria have test or artifact evidence;
- release checks pass;
- risk and execution changes cover negative, duplicate, partial-failure and
  restart paths;
- live changes include deterministic fault-test evidence, explicit read-only
  Mainnet readiness checks, disable/rollback and reconciliation; Testnet or an
  earlier Mainnet write is not a release prerequisite;
- the single supervised execution-contract experiment in [issue #31](https://github.com/olegeech/crypto-analyst-trader/issues/31)
  is an **optional pre-merge happy-path acceptance test** on an exact reviewed
  PR-branch commit with same-SHA green release tests/CI; no merge into `main`,
  tag or publication is needed before it. It still needs fresh read-only
  Mainnet preflight, all mandatory runtime safety gates and separate explicit
  attended order approval. Its actual CREATE/status/TP/cleanup evidence
  informs the merge-versus-rework decision; incomplete AC7 stays explicitly
  open. This does not promote daily-strategy readiness or bypass #30 for
  normal daily strategy;
- contracts or operator behavior are documented;
- no secret or private account artifact is committed;
- the pull request closes the issue when all acceptance criteria are complete;
  implementation-only pull requests keep separately gated live criteria open;
- residual work is a separate issue.

## Context budget

- Issue bodies should usually stay below 800 words.
- Link at most five directly relevant documents or source files.
- A pull request describes only the delta, evidence and residual risk; it does
  not repeat the issue.
- Agent work loads the issue, direct blockers and linked ADRs, not the whole
  backlog.
- Comments record decisions or evidence, not daily status narration.
- Daily reports link durable artifacts and summarize changed decisions instead
  of pasting repeated raw snapshots.

## Experiments

A trading-logic experiment must define:

- hypothesis and baseline;
- data period and holdout;
- fees, funding and slippage assumptions;
- primary metric and success threshold;
- drawdown and exposure guardrails;
- outcome: adopt, reject or retest.

Positive gross PnL alone is never a success criterion.
