---
name: develop-next-roadmap-story
description: "Select and deliver the next ready Crypto Analyst Trader work item from GitHub roadmap issue #33. Use when the user invokes $develop-next-roadmap-story or asks to take the next roadmap story through implementation, verification, push, and pull request. Resume an unambiguous owned in-progress branch when present; otherwise choose the earliest ready story, bug, or technical-debt item. Never select queued, blocked, needs-triage, epic, or already-owned work."
---

# Develop Next Roadmap Story

Deliver exactly one issue in one branch and one pull request.

## Select safely

1. Confirm the repository, cleanly isolate unrelated work, and fetch the remote
   default branch with pruning.
2. Read roadmap issue `#33`, then load only metadata for referenced open items.
3. Resume one unambiguous `status:in-progress` item owned by the current actor
   when its issue, branch and pull request agree.
4. Otherwise choose the earliest roadmap item that is:
   - `type:story`, `type:bug` or `type:tech-debt`;
   - `status:ready`;
   - fully classified with one priority, one primary area and a milestone;
   - dependency-ready, small enough for one pull request and not already owned.
5. Do not select `status:queued`, `status:blocked`,
   `status:needs-triage`, an epic or a roadmap tracker.
6. When nothing is ready, report the first concrete dependency or triage action
   instead of inventing work.

Roadmap order wins. Priority breaks only an explicitly unordered tie.

## Claim and design

- Revalidate the issue and remote immediately before claiming it.
- Branch from the fetched default SHA with the issue number in the name.
- Preserve all non-status labels and replace `status:ready` with
  `status:in-progress`.
- Read the full selected issue, its direct dependencies, linked ADRs,
  `AGENTS.md`, and the smallest relevant code/test surface.
- Map every acceptance criterion to an implementation change and verification.
- Keep adjacent improvements out of scope; search for an existing Issue before
  proposing a focused follow-up.

If claim state, branch ownership or an existing pull request is ambiguous, stop
without deleting or rewriting anything.

## Implement and verify

- Follow existing module boundaries and
  `docs/architecture/invariants.md`.
- Add deterministic acceptance and regression tests. Risk, execution,
  accounting and data-quality work also covers negative, duplicate, partial,
  timeout and restart paths.
- Update the owning documentation when contracts or operator behavior change.
- Never commit secrets, signed requests, private account artifacts or generated
  operator evidence.
- Mainnet writes are never part of feature development. Use Testnet mutation
  only when the issue explicitly requires it and the user authorizes it.
- Run focused checks while iterating and `npm run test:release` before
  publication.

Do not claim a skipped or unavailable check passed.

## Publish

1. Audit status, untracked files, the complete diff and `git diff --check`.
2. Stage only selected-issue files and inspect the staged diff.
3. Commit in English with a focused Conventional Commit.
4. Fetch again. If the default branch advanced, rebase deliberately, re-audit
   and rerun mandatory checks.
5. Push the issue branch and verify the remote SHA equals the tested SHA.
6. Open a focused pull request using the repository template and
   `Closes #<issue>`.
7. Include exact tested head/base SHAs, evidence, safety impact,
   documentation and residual risk.
8. Keep the issue `status:in-progress` until merge. Do not merge the pull
   request.

## Report

Respond in the user's language with:

- selected or resumed issue and why it was next;
- skipped predecessors or queue drift;
- branch and tested head/base SHAs;
- implementation and documentation summary;
- tests and explicit skips;
- deferred follow-ups;
- pull request URL, readiness and residual risk.
