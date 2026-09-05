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
