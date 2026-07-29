# Development Workflow

## Canonical sources

- active scope and acceptance criteria: GitHub Issue;
- release grouping: milestone;
- implementation evidence: pull request and tests;
- architectural rationale: accepted ADR;
- actual behavior: code and tests;
- operator procedure: operations documentation.

Closed issues and merged pull requests are the work archive. Do not create a
second full backlog or done archive in Markdown.

## Classification

Every open work item has exactly one label from each required group:

- type: epic, story, bug, tech debt, spike or experiment;
- priority: P0, P1 or P2;
- status: needs triage, ready, in progress or blocked;
- one primary area.

Closing an issue means Done; there is no done label. Status labels are removed
automatically on close. A blocked item states the blocker and the action needed
to unblock it.

Priority:

- P0: capital safety, security, accounting integrity or release gate;
- P1: important current-milestone value;
- P2: useful future work.

Keep no more than eight items Ready and no more than one In Progress per
developer. If almost every issue is P1, triage has failed.

## Definition of Ready

- one measurable outcome;
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
