---
name: daily-rebalance
description: "Run the complete Crypto Analyst Trader daily rebalance from fresh Bybit market and account evidence through deterministic planning, risk review, exact-plan approval, bounded execution, reconciliation, and reporting. Use when the user invokes $daily-rebalance or asks for a full, routine, or saved-instruction daily rebalance. PREPARE_ONLY is the default; Testnet or mainnet writes require explicit environment authorization and approval of the final exact plan hash."
---

# Daily Rebalance

Follow `docs/operator-runbook.md`; do not duplicate or override its trading,
timing, approval, execution, incident, or reporting rules. Also read
`docs/architecture/invariants.md` and inspect `package.json` for capabilities
implemented at the current commit.

## Resolve the mode

- Default to `PREPARE_ONLY`.
- Use `TESTNET_EXECUTE` only when the user explicitly requests Testnet writes.
- Use `MAINNET_EXECUTE` only when the user explicitly requests mainnet and the
  production-canary gate is complete.
- A write still requires the operator to review and approve the final exact
  plan hash. Prior generic authorization is insufficient.
- Conflicting or ambiguous wording resolves to `PREPARE_ONLY`.

A supplied capital value is a ceiling only if the released command contract
supports and hashes it. Never invent a budget, infer leverage, or reinterpret
account equity as free allocation.

## Operating contract

- Work from the repository root and preserve unrelated worktree changes.
- Do not edit code, documentation, Git state, issues, or pull requests during a
  trading run.
- Invoke only scripts present in `package.json`; report an unavailable phase as
  `CAPABILITY_NOT_RELEASED`.
- Never bypass timing-policy, freshness, evidence-integrity, economic, risk,
  ownership, approval, protection, `HALT`, or reconciliation gates.
- Never print credentials, signed requests, private raw payloads, or secret
  paths.
- Use the repository secret boundary; do not ask the user to paste long-lived
  credentials into chat.

## Run the workflow

1. Record the commit, mode, environment, account scope, active timing-policy
   identity and requested allocation.
2. Confirm release evidence for the exact commit. Run `npm run test:release`
   when no durable passing attestation exists.
3. Refresh instrument, market, derivatives and sanitized account evidence.
   Runtime-validate external payloads and record decision-relevant evidence
   refs/hashes; never substitute stale evidence for a failed required source.
4. Enforce the active versioned timing policy, one coherent run window,
   evidence/input identity compatibility, instrument availability and
   delist/expiry exclusions. Do not invent a fixed market session or holiday
   rule in the skill.
5. Use bounded candidate discovery only when implemented. Otherwise remain
   inside the configured universe; never improvise an unsupported symbol.
6. Run the released prepare use case and require a deterministic immutable plan
   derived from validated evidence or explicit `NO_TRADE`.
7. Review every selected and excluded candidate, evidence identity/hash,
   normalized order, attached exit, expected cost, current -> projected exposure
   and owned-order diff.
8. Stop at `PREPARED` in `PREPARE_ONLY`.
9. For an execution mode, present the final hash, expiry, environment, diff,
   economics, risk and residual risk. Continue only after explicit approval of
   that exact hash.
10. Execute only the approved owned-order diff. Revalidate evidence provenance,
    input identity, integrity and freshness; reconcile cancellations before
    creates, stop after partial or ambiguous results, and never blind-retry.
11. Verify protective coverage, reconcile account state and persist accounting
    checkpoints before declaring success.
12. Produce the operator report and runtime-system assessment required by the
    runbook.

If a command fails, inspect its sanitized artifact and reason codes. Do not
weaken a gate or compose an ad hoc exchange request to finish the run.

## Report

Respond in the user's language. Use compact Markdown tables and include:

- mode, environment, commit, run ID, plan hash and approval state;
- timing-policy identity and permitted window result;
- input freshness, source quality, evidence identities and canonical hashes;
- candidate, selected, excluded, create/cancel/keep and filled counts;
- allocation plus current -> projected exposure and costs;
- every changed field as `old -> new`;
- entry, quantity, notional, take-profit and stop for each intended order;
- tests, gates, execution, reconciliation and protection results;
- artifact paths and hashes, without private payloads;
- net PnL, costs, return on allocated capital and drawdown when available;
- residual risk and the next required operator action;
- one run-scoped system assessment from the runbook.

Do not grade a feature or promise profitability. Use
`$test-current-feature-pr` for feature readiness.
