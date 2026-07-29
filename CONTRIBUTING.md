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
npm run test:release
```

For execution, accounting, data-quality, risk or security changes, follow the
[Definition of Done](docs/workflow.md#definition-of-done),
[system invariants](docs/architecture/invariants.md) and
[security policy](SECURITY.md). Complete the relevant safety section in the pull
request template instead of copying its checklist into documentation.
