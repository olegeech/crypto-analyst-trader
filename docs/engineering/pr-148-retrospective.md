# PR #148 — retained engineering lessons

[PR #148](https://github.com/olegeech/crypto-analyst-trader/pull/148) and [issue #147](https://github.com/olegeech/crypto-analyst-trader/issues/147) remain the evidence and decision history. This note captures only lessons useful when changing another execution path; it is not a backlog, specification or new authorization rule.

## 1. Keep research and execution eligibility separate

**Observed:** the new direct INJUSDT trade path inherited an M1 research-symbol restriction. The compact and fallback paths did not initially agree on which symbols could be executed. A later unrelated NEAR trade was also blocked by an account-wide pending-source rule designed for a different workflow.

**Apply when:** extending or adding execution modes. In the canonical issue, identify which checks are actual venue, capital or safety obligations and which belong only to a prior research, approval or source-ownership flow. Test the positive path and the relevant fallback; do not bypass existing safety invariants.

## 2. Prove current capacity and scope conflicts to their owner

**Observed:** repeated account validation and strict numerical wallet comparisons produced a false `CRITICAL_STATE_CHANGED` refusal. Separately, an accepted INJ source with TP pending unnecessarily prevented a NEAR instruction.

**Apply when:** modifying admission and source coexistence. Reuse bounded, trustworthy account evidence, refresh stale obligations selectively, and measure capacity from the current relevant balance and commitments. Preserve same-symbol protection, incident HALT and fail-closed behavior for ambiguous CREATE outcomes. Other-symbol coexistence needs capacity evidence newer than prior accepted writes, not an unconditional account lock.

## 3. Test production composition, not only its isolated validators

**Observed:** frozen provider-time fixtures let a quote-bracket ordering defect pass the suite; the attended flow failed with `STALE_EVIDENCE`. See the [specific root cause and regression](provider-quote-bracket-preparation-time.md).

**Apply when:** an integration combines multiple provider responses, fallbacks or state transitions. Exercise one successful path through real composition with representative changing evidence and critical failures. Prefer an actionable refusal code over adding blanket rechecks or speculative guards.

## Shadow Market Intelligence (#116)

- Provider-contract defects first found in manual operation: none observed. This slice changes no provider mapper, and no live source reads were performed.
- Defect fixes after the first full green CI: none as of PR submission; exact-head CI is the remaining check.
- Operator retries caused by program defects: none observed in the deterministic offline tests, including fresh-process review. Missing native liquidation evidence remains an expected source gap and does not relax the existing core requirement.

## Where these lessons belong

The actionable reminders are incorporated in [Development Workflow](../workflow.md#integration-contract-check). Product decisions and acceptance criteria belong in the relevant GitHub issue; safety rules remain in [System Invariants](../architecture/invariants.md); code and tests define actual behavior. The detailed attempts, GET counts, live evidence and diagnostic chronology stay in [PR #148](https://github.com/olegeech/crypto-analyst-trader/pull/148).

**Evidence limit:** an INJ entry was observed filled with an attached TP still open; the TP lifecycle was not proven complete. No successful live NEAR CREATE after the final cross-symbol fix was established. This note neither authorizes a trade nor requires routine Mainnet smoke tests.
