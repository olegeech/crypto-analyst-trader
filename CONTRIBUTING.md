# Contributing

## Work from an issue

Every non-trivial change starts from a GitHub Issue with one type, priority,
status, primary area and milestone. The issue owns outcome, scope, acceptance
criteria, dependencies and verification.

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
npm run test:release
```

Execution, accounting, data-quality and risk changes also require tests for
negative paths, partial failures, duplicate input and restart behavior.

## Live-trading changes

A live-write pull request must include:

- Testnet or deterministic contract-test evidence;
- failure and timeout behavior;
- rollback or halt procedure;
- proof that manual and protective orders remain untouched;
- post-write reconciliation behavior;
- residual risk.

Production credentials and unsanitized account artifacts must never be attached
to issues, commits, CI logs or pull requests.
