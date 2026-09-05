---
name: issue-delivery
description: "Deliver one named eligible GitHub issue through PO/Ready, independent review, implementation, CI, exact-head PR review and a READY_FOR_MERGE verdict. Merge is opt-in."
---

# Issue Delivery

Use `$issue-delivery #<issue>` to deliver one named GitHub delivery issue. The
default flow stops at the skill verdict `READY_FOR_MERGE`. Use
`$issue-delivery #<issue> merge` only when the caller explicitly authorizes the
final merge gate.

This skill is self-contained. It does not invoke or require another
repository-local skill. The implementation stage has one required external
capability: the exact `$compound-engineering:lfg #<issue>` flow named by the
issue contract. If that capability is unavailable or its semantics cannot be
validated, stop and report the blocker; do not silently substitute a different
implementation workflow.

## Authority and safety

GitHub Issues own active scope and acceptance criteria. The following repository
sources remain authoritative and cannot be weakened by this skill, a reviewer,
or an implementation helper:

- `docs/workflow.md` for delivery policy and Ready/Done definitions;
- accepted ADRs and `docs/architecture/invariants.md` for technical and safety
  constraints;
- `SECURITY.md` for credentials, private artifacts, and incident handling;
- `CONTRIBUTING.md` for branch, test, pull-request, and merge contracts;
- actual code and tests for behavior.

Never expose secrets or private account artifacts. Never perform an exchange
write as part of this workflow. AI/tool suggestions are advisory and cannot
change issue scope, product decisions, ADRs, invariants, or security policy.

## Input and scope

Accept exactly one issue number or unambiguous issue URL, optionally followed by
the literal word `merge`:

```text
$issue-delivery #52
$issue-delivery #52 merge
$issue-delivery https://github.com/owner/repo/issues/52 merge
```

Reject missing, malformed, cross-repository, closed, duplicate, or ambiguous
issue identity before changing GitHub or repository state. The issue must be a
delivery issue producing code, configuration, or canonical documentation. Do
not use this skill for epics, roadmap trackers, or no-PR housekeeping. If more
than one candidate PR exists, stop and ask for human selection. Resolve this
PR decision before the Ready gate: one unambiguous open PR already belonging
to the issue is an existing implementation handoff and must bypass development;
it proceeds directly to CI and exact-head PR review. Do not require it to
return to `status:ready` or invoke LFG again. A closed/merged PR without a new
eligible handoff is a human decision, not a reason to create a duplicate PR.
Otherwise the development stage must create exactly one focused PR.

The issue is the only active scope source. Do not create a second backlog,
roadmap, or done archive in Markdown. Scope expansion, a second issue, or a
request that needs multiple PRs stops this run for issue splitting.

## Run receipt

Keep a structured receipt throughout the run. It may be transient during local
work, but the final PR evidence must preserve the material fields:

```json
{
  "issue": 52,
  "issue_url": "https://github.com/owner/repo/issues/52",
  "scope_digest": "<sha256-of-fetched-issue-body-and-scope-fields>",
  "issue_review": { "attempts": 1, "outcome": "PASS", "blockers": [] },
  "development": { "pr": 0, "head_sha": "" },
  "ci": { "release_checks": "GREEN", "evidence": "" },
  "pr_review": {
    "attempts": 1,
    "reviewed_head_sha": "",
    "outcome": "PASS",
    "blockers": []
  },
  "final": "READY_FOR_MERGE",
  "human_action": null
}
```

Every stop must set `human_action` to the concrete decision or evidence needed.
Do not report `READY_FOR_MERGE` unless the receipt contains the reviewed PR
number, its exact full head SHA, green mandatory checks, and a passing PR review
for that same SHA.

## Flow

### 1. Load and classify the issue

Read the issue from GitHub and record its number, URL, title, state, labels,
body, milestone, dependencies, acceptance criteria, non-goals, safety/failure
behavior, and verification instructions. Confirm the issue is eligible and
that the repository and issue identity agree. Read only direct blockers and
the canonical documents required by the issue; do not bulk-load backlog
history.

### 2. PO clarification and Definition of Ready

The issue may skip a new interview only when its body contains an explicit
`Product-owner interview` or `Product-owner decisions` section. Otherwise stop
with `NEEDS_PO_INTERVIEW` and ask the PO to resolve the missing product
decisions. PO clarification is not a retry-counted loop: continue after
concrete human progress and re-read the issue; stop when the next action is
ambiguous or needs another human decision.

Before development, verify the Definition of Ready from `docs/workflow.md`:

- one measurable outcome;
- the PO interview/decisions are explicit;
- three to seven acceptance criteria;
- explicit non-goals;
- dependencies closed or a time-boxed spike identified;
- verification and failure behavior described;
- one focused PR is feasible;
- required live, capital, data-integrity, or security labels are present.

Missing Ready evidence stops as `NOT_READY`. Do not infer approval from a
title, a label alone, or a reviewer suggestion.

### 3. Independent issue review (maximum three attempts)

Before implementation, run an independent issue review using the configured
reviewer command below. The reviewer checks scope, acceptance criteria,
dependencies, safety, failure behavior, testability, and contradictions with
the canonical sources. It must not implement code or decide product policy.

The reviewer command is the replaceable default and may be changed only by a
human-maintained update to this skill:

```sh
claude -p "please review issue #<issue>" --model claude-opus-5 --effort high
```

If the reviewer command is unavailable, unauthenticated, or returns no
review-shaped result, stop as `REVIEWER_UNAVAILABLE`. Do not call the same
failed command repeatedly and do not present the orchestrator's own reading
as an independent review. A human may install/authenticate or explicitly
maintain an equivalent reviewer command, after which the attempt starts fresh.

Classify each finding as `BLOCKING`, `MATERIAL`, `NON_BLOCKING`, or
`INFORMATIONAL`. A passing review has no unresolved `BLOCKING` or `MATERIAL`
finding. Resolve valid blocking/material findings in the issue or the planned
implementation, then re-run the review. Count total issue-review attempts,
including the first run, and stop after attempt three with
`ISSUE_REVIEW_CAP_REACHED` if a blocker remains. A cap requires human
resolution; it is never an automatic pass. Non-blocking findings do not force
stylistic churn or automatic follow-up issues.

If the review conflicts with a settled PO decision or canonical source, report
the exact conflict and stop instead of silently changing the decision.

### 4. Ready gate and development handoff

For an existing unambiguous open PR, skip development and require the issue
scope, PR linkage, current head, and PR review gates in sections 5 and 6. Do
not mutate the issue status merely to satisfy the pre-development gate.

For a new implementation, require all of the following before development:

1. the issue is still the same eligible issue;
2. it has exactly one status label and that label is `status:ready`;
3. the independent issue review passed;
4. no unresolved dependency, blocker, or scope-split request exists.

When work is claimed, update the issue status to `status:in-progress` using
the repository's normal GitHub workflow and record the transition. If the
status is missing or changed unexpectedly, stop and report it.

Before invoking the required implementation capability, create a scope
manifest from the freshly fetched issue. It must contain the issue URL and
number, title, acceptance criteria, explicit non-goals, dependencies,
safety/failure behavior, verification requirements, and `scope_digest`. Pass
that manifest to the helper and require it to acknowledge the same issue and
digest before it writes or publishes anything.

Invoke the required implementation capability with the bound scope:

```text
$compound-engineering:lfg #<issue> <issue-url> <scope-digest>
```

The helper must return a pre-publication implementation plan or diff-scope
receipt before its normal shipping steps. Validate that receipt against the
scope manifest, then allow the helper to return implementation evidence and an
unambiguous PR or working-tree handoff. If the helper cannot accept the bound
scope, cannot provide pre-publication scope evidence, its invocation syntax or
semantics changed, or it attempts work outside this issue, stop as
`DEVELOPMENT_HELPER_UNAVAILABLE` or `SCOPE_EXPANSION` before accepting remote
state. After handoff, audit the complete changed-file list and stop on any
scope mismatch; this is a second defense, not a substitute for the
pre-publication check.

### 5. One focused PR and CI

There must be one PR for the named issue, linked with `Closes #<issue>`, and
the diff must remain inside the issue scope. Do not merge, approve, or close
the issue in this stage.

Run the repository release command for code, configuration, or canonical
documentation changes:

```sh
npm run test:release
```

Treat a failed check as a diagnosis task, not a blind retry. Identify the
failing check and its concrete cause, apply the smallest issue-scoped fix, and
re-run the relevant check plus the release command. If the cause or safe fix
is ambiguous, stop as `CI_REPAIR_AMBIGUOUS`. CI repair is not retry-counted,
but it must always have an identified cause and bounded next action.

Initial CI/release checks must be green before PR review. Record check names,
commit SHA, command, result, and relevant output summary without secrets.

### 6. Independent exact-head PR review (maximum three attempts)

After initial checks are green, fetch fresh PR metadata and record the exact
full head SHA. Run an independent PR review against that SHA:

```sh
claude -p "please review PR #<pr> at exact head <reviewed-head-sha>. First verify the PR head equals this full SHA; inspect only that revision and include REVIEWED_HEAD_SHA: <reviewed-head-sha> in the report." --model claude-opus-5 --effort high
```

If the reviewer cannot prove the reported `REVIEWED_HEAD_SHA` equals the
freshly captured full SHA, treat the review as invalid and stop. If the
reviewer command is unavailable, unauthenticated, or returns no review-shaped
result, stop as `REVIEWER_UNAVAILABLE`; do not silently downgrade to a
same-agent review.

The review must examine the exact diff, issue acceptance evidence, tests,
release checks, security/invariant impact, and scope. A review for any other
SHA is invalid. Classify findings using the same severity terms as issue
review. Resolve blocking/material findings and re-run CI before the next PR
review attempt. Count total PR-review attempts, including the first, and stop
after attempt three with `PR_REVIEW_CAP_REACHED` if a blocker remains.

Non-blocking findings are recorded as residual risk or optional follow-up and
do not force stylistic churn. A moved head, new failing check, requested
changes, or unresolved material finding invalidates readiness.

### 7. Final gate and merge policy

Immediately before the verdict, re-read the issue and PR and reconfirm:

- issue identity, eligibility, scope, and Definition of Done evidence;
- one focused PR linked to the issue and targeting `main`;
- PR is open and non-draft;
- current head SHA equals the independently reviewed full SHA;
- every mandatory check is green, including `release-checks`;
- no unresolved blocking/material review finding remains;
- no canonical product, ADR, invariant, or security decision was silently
  changed.

Without the literal `merge` input, stop and report exactly:

```text
READY_FOR_MERGE
PR: #<pr>
REVIEWED_HEAD_SHA: <full-sha>
```

This is a skill verdict only. It is not a GitHub status and is not part of the
trading-plan lifecycle.

With explicit `merge`, run the repository-native final gate only after all
reconfirmations pass:

```sh
./scripts/merge-pr.sh <PR-number> <reviewed-head-SHA>
```

Pass the exact full SHA from the passing PR review. The wrapper's
`--match-head-commit` check is authoritative. If the head moved, a mandatory
check failed, mergeability is unknown/conflicting, or the wrapper fails, stop
and report the concrete recovery action; re-review the new SHA when required.
Never replace the wrapper with an AI-only or implicit merge.

## Failure states

Use one of these stable stop labels in the receipt and final report:

- `INVALID_ISSUE_IDENTITY`
- `INELIGIBLE_ISSUE`
- `NEEDS_PO_INTERVIEW`
- `NOT_READY`
- `ISSUE_REVIEW_BLOCKED`
- `ISSUE_REVIEW_CAP_REACHED`
- `DEVELOPMENT_HELPER_UNAVAILABLE`
- `REVIEWER_UNAVAILABLE`
- `SCOPE_EXPANSION`
- `CI_REPAIR_AMBIGUOUS`
- `MANDATORY_CHECK_FAILED`
- `PR_REVIEW_BLOCKED`
- `PR_REVIEW_CAP_REACHED`
- `REVIEWED_HEAD_MOVED`
- `MERGE_GUARD_FAILED`

Each state stops before the next irreversible step. A human may resolve the
stated blocker, after which the flow must revalidate the affected gate.

## Required structured dry-run evidence

The implementation PR for this skill must include a concise table or JSON
receipt demonstrating these deterministic cases and expected outcomes:

| Case ID                          | Expected outcome                            |
| -------------------------------- | ------------------------------------------- |
| `missing-po-interview`           | `NEEDS_PO_INTERVIEW`, no development        |
| `not-ready`                      | `NOT_READY`, no development                 |
| `issue-review-pass`              | proceed to Ready gate                       |
| `issue-review-block`             | resolve/review again, no development yet    |
| `issue-review-cap`               | `ISSUE_REVIEW_CAP_REACHED`, human action    |
| `scope-split`                    | `SCOPE_EXPANSION`, split before development |
| `development-helper-unavailable` | stop without substitute workflow            |
| `reviewer-unavailable`           | stop without same-agent review              |
| `ci-identified-failure`          | targeted repair then re-run evidence        |
| `ci-ambiguous-failure`           | `CI_REPAIR_AMBIGUOUS`, human action         |
| `pr-review-pass`                 | proceed to final gate                       |
| `pr-review-cap`                  | `PR_REVIEW_CAP_REACHED`, no readiness       |
| `moved-reviewed-head`            | invalidate review, revalidate/review        |
| `default-ready-for-merge`        | report `READY_FOR_MERGE`, no merge          |
| `explicit-merge`                 | invoke wrapper with exact reviewed SHA      |

The evidence must include a green `npm run test:release` result and must not
claim live exchange or private-account evidence.
