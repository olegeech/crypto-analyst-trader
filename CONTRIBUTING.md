# Contributing

The canonical process, classification, readiness and completion rules live in
[Development Workflow](docs/workflow.md).

## Work from an issue

Every non-trivial change starts from an issue that satisfies the
[Definition of Ready](docs/workflow.md#definition-of-ready).

Branch names should include the issue number, for example:

```text
feature/issue-42-owned-order-diff
fix/issue-57-reconciliation-timeout
```

Use a short-lived branch and a focused pull request. Link the issue with
`Closes #42`.

## Verification

Run:

```bash
npm ci && npm run test:release
```

This is the single pre-PR verification command. Testnet smoke and dependency
audit are separate opt-in checks and are not part of the blocking release path.

## Operator safeguards and diagnostics

Follow the proportionate-safeguards principle in
[Product Principles](docs/product-principles.md#product-intent--reviewed-2026-10-05).
Prefer automatic validation, ownership checks and reconciliation over repeated
operator prompts. A new confirmation, required field or manual recovery step
needs a named failure mode that cannot reasonably be handled automatically.

Operator-facing errors should show the current stage and attempted action, a
sanitized provider code and explanation, safe actual/expected values where
available, whether the result is known or ambiguous, and the next safe action.
Preserve the original cause; never expose secrets or raw private account facts.

Examples based on the [PR #73 balance-precondition feedback](https://github.com/olegeech/crypto-analyst-trader/pull/73#issuecomment-5648679799)
and [operator KISS feedback](https://github.com/olegeech/crypto-analyst-trader/pull/73#issuecomment-5655333480):

- Balance precondition — replace `PRECONDITION_FAILED: Available Testnet USDT is
below five times the planned probe notional.` with `Available Testnet USDT is
1.25; at least 25.449 USDT is required (five times the planned probe notional).
Add at least 24.199 USDT using the Bybit Testnet faucet, then rerun the
Testnet capability probe only if its documented bounded write scenarios and
probe-owned cleanup are intended.`
- Explicit exchange rejection — preserve `retCode: 10024` and its compliance
  explanation. Do not turn it into generic “order not found” language or
  suggest retrying an explicitly rejected request.
- Exact-plan consent — replace repeated full-digest retyping for each scenario
  with one explicit `yes` to the displayed exact immutable plan hash. Any future
  execution must independently perform required fresh revalidation before a
  write.

An explicit rejection and an ambiguous dispatch outcome are different facts:
retain the rejection code when known, and reconcile an ambiguous write before
retrying it.

## Merge a reviewed pull request

After the PR has been reviewed and its checks are green, run the repository
wrapper from a clean checkout of the PR branch:

```bash
./scripts/merge-pr.sh <PR-number> <reviewed-head-SHA>
```

The full SHA is the review evidence supplied by the maintainer; it must still
match the PR head when the command runs. The wrapper also requires an open,
non-draft PR targeting `main`, a mergeable state, no requested changes, and a
successful `release-checks` result before asking GitHub to squash-merge it. It
then switches to local `main` and updates it with `git pull --ff-only`.

Tracked working-tree changes must be committed or stashed first. Untracked
scratch files are ignored by the preflight because they cannot enter the
server-side squash merge.

For execution, accounting, data-quality, risk or security changes, follow the
[Definition of Done](docs/workflow.md#definition-of-done),
[system invariants](docs/architecture/invariants.md) and
[security policy](SECURITY.md). Complete the relevant safety section in the pull
request template instead of copying its checklist into documentation.
