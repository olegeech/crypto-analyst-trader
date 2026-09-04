---
name: test-current-feature-pr
description: "Test and review a Crypto Analyst Trader pull request at its exact head commit in an isolated worktree. Use when the user invokes $test-current-feature-pr or asks to verify a feature, fix, current PR, or release readiness. The default is review-only. Relevant public and authenticated read-only Bybit checks are part of complete validation when available; mainnet writes are never allowed, and Testnet writes require explicit scoped authorization."
---

# Test Current Feature PR

Validate one exact pull request and return an evidence-based readiness verdict.

## Authorization

- `REVIEW_ONLY` is the default: inspect GitHub, code, tests and safe read-only
  exchange evidence without changing tracked files or publishing feedback.
- Edit files, publish a PR comment, manage Issues, commit or push only when the
  user explicitly authorizes that action.
- Never perform a mainnet write during PR review.
- Perform a Testnet write only when explicitly requested, required by the
  issue, bounded to dedicated test scope, and followed by cleanup and
  reconciliation.
- Never expose credentials, signed requests, private payloads or secret paths.

## Verify the exact target

1. Resolve one PR from its number/URL, the current branch, or one unambiguous
   open PR.
2. Record its URL, issue, head/base branches and SHAs, draft state, checks,
   reviews and changed files.
3. Fetch the PR head and require the fetched SHA to equal GitHub's head SHA.
4. Create a clean detached temporary worktree at that exact SHA. Preserve the
   operator worktree and run all review commands in the temporary worktree.
5. When the base is not an ancestor, test a synthetic merge separately and
   report both results.

Stop as `NOT_READY` when the exact revision cannot be proven.

## Build the test matrix

Read the source issue, `docs/architecture/invariants.md`, directly relevant ADRs
and changed modules. Map each acceptance criterion and changed contract to:

- a focused deterministic test;
- the repository release gate;
- negative, duplicate, timeout, partial-result and restart coverage when risk,
  execution, data integrity or accounting can be affected;
- safe operator evidence when tests alone cannot prove integration behavior.

Run `npm run test:release` for code or configuration changes. Relevant public
and authenticated read-only Bybit checks are expected when prerequisites exist.
Classify an unavailable credential or external service separately from a
product defect.

Inspect the diff and artifacts for secrets, private account data, unowned-order
mutation, weakened approval/protection gates, stale evidence acceptance,
floating-point order arithmetic and misleading success states.

## Review behavior

Prioritize confirmed correctness, capital, security, accounting and
data-integrity defects. A passing aggregate suite does not override a reproduced
behavioral defect.

For each finding record severity, file/line, reproduction, actual behavior,
expected behavior, impact and the smallest reasonable fix. Separate findings
from residual risk and optional future improvements.

Use exactly one verdict:

- `READY_TO_USE`: acceptance criteria and mandatory checks pass with no
  actionable defect;
- `USABLE_WITH_CAVEATS`: core behavior is correct with bounded non-blocking
  limitations;
- `NOT_READY`: target identity, acceptance, safety, correctness or a mandatory
  check fails.

## Publish only when authorized

- Before commenting, search existing PR feedback and avoid duplication.
- Put current-PR defects in one concise English PR comment.
- Search open and closed Issues before creating follow-up work. Update a match
  instead of duplicating it.
- Keep independent improvements in Issues and adjust roadmap issue `#33` only
  when order or dependencies materially change.
- Do not approve, merge or close the PR.

## Report

Respond in the user's language with findings first, then:

- PR URL, exact head/base SHAs and worktree mode;
- verdict and concise feature assessment;
- tests and read-only/Testnet checks run or skipped with reasons;
- published feedback or Issue links, when authorized;
- documentation impact;
- residual risk and remaining manual verification.
