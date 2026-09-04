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
- `status:ready`, `status:in-progress` or `status:blocked`;
- one `area:*`.

The unassigned cross-milestone roadmap tracker is the only milestone exception
and does not count toward developer WIP.

Closing an issue means Done; there is no done label. Status labels are removed
automatically on close. A blocked item states the blocker and the action needed
to unblock it.

Priority:

- P0: blocks the active release gate, or is an urgent capital-safety,
  security or accounting-integrity incident;
- P1: belongs to the next release gate;
- P2: belongs to a later gate or is optional future work.

Safety severity and delivery priority are separate. A future safety-critical
story keeps its safety labels but is promoted to P0 only when its release gate
becomes active. Re-triage priorities when a milestone opens or closes.

Keep no more than eight items Ready and no more than one In Progress per
developer. If almost every issue is P1, triage has failed.

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

## Experiments

A trading-logic experiment must define:

- hypothesis and baseline;
- data period and holdout;
- fees, funding and slippage assumptions;
- primary metric and success threshold;
- drawdown and exposure guardrails;
- outcome: adopt, reject or retest.

Positive gross PnL alone is never a success criterion.
