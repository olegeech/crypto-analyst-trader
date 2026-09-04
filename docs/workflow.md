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

## Definition of Ready

- one measurable outcome;
- human product owner interview;
- three to seven acceptance criteria;
- explicit non-goals;
- all dependencies closed or a time-boxed spike identified;
- verification and failure behavior described;
- size small enough for one focused pull request;
- required live, capital, data-integrity or security labels applied.

## Definition of Done

- acceptance criteria have test or artifact evidence;
- release checks pass;
- risk and execution changes cover negative, duplicate, partial-failure and
  restart paths;
- live changes include Testnet evidence, disable/rollback and reconciliation;
- contracts or operator behavior are documented;
- no secret or private account artifact is committed;
- the pull request closes the issue;
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
