# PR #148 retrospective — one-instruction Mainnet trade

**Status:** [PR #148](https://github.com/olegeech/crypto-analyst-trader/pull/148) merged into `main` on 2026-11-01; reviewed head `d200aa7`, merge commit `5c95f0f`. [Issue #147](https://github.com/olegeech/crypto-analyst-trader/issues/147) owns the accepted scope. This document records lessons, **not** a second roadmap, a new authorization policy, or evidence of a completed TP lifecycle.

## Outcome

The scoped v3 direct `mainnet:test trade` path delivers one owner-issued instruction bound to an immutable Buy Limit, explicit TP percent or price, a capped one-use CREATE and read-only status. It validates the requested Bybit USDT-linear instrument rather than applying the M1 analytics symbol set. It also includes target-specific leverage configuration and source-aware coexistence of independent symbols while preserving account capacity, incident HALT, target-state, durable intent and no-resend protections. Legacy approval paths retain their own rules.

The final PR had 56 changed files; local release validation reported **1,674 passing tests**, and the exact final head's GitHub CI completed successfully ([run](https://github.com/olegeech/crypto-analyst-trader/actions/runs/41344599525)). Passing tests establish the tested contracts, not a universal production outcome.

A supervised INJUSDT entry was accepted and filled (1.3 INJ), with an attached TP open at the observed status check. That result was **`PARTIAL_EVIDENCE` / `cleanup=pending`**, not `TP_LIFECYCLE_PASS`. The later GET-only follow-up still reported an open position and TP; it did not submit another order. [Recorded status](https://github.com/olegeech/crypto-analyst-trader/pull/148#issuecomment-6563877210). A separate NEARUSDT attempt was blocked **before** the final cross-symbol fix; the amended implementation was verified offline, but this PR does not document a successful subsequent live NEAR CREATE.

## What the attempts taught us

- **M1 research eligibility leaked into direct execution.** A first INJUSDT
  fallback refused after 51 GETs with `READINESS_INVALID_REQUEST`, while
  diagnostics misleadingly named the account. The remedy was to validate the
  direct request against actual current instrument evidence in compact *and*
  fallback paths without changing M1 or legacy eligibility.
  [Diagnosis](https://github.com/olegeech/crypto-analyst-trader/pull/148#issuecomment-6550598329).
- **Duplicate account validation and numeric equality.** A 10-USDT INJ
  attempt made 116 GETs and refused `CRITICAL_STATE_CHANGED` in assets. A
  deposit was plausible, not proven. Reusing one bounded current proof and
  refreshing only required stale facts eliminated this unnecessary class of
  refusal for direct v3.
  [PO decision](https://github.com/olegeech/crypto-analyst-trader/pull/148#issuecomment-6557114246).
- **Frozen fixture timestamps masked a real temporal defect.** A later
  attempt stopped at `STALE_EVIDENCE` after 10 GETs and no writes because
  `preparedAt` preceded quote collection completion. The fix and regression
  are captured in the [quote-bracket learning](provider-quote-bracket-preparation-time.md).
- **A genuine venue minimum deserves a concrete diagnostic.** A 5-USDT NEAR
  preparation failed `NOTIONAL_TOO_SMALL`. The amount was not increased
  automatically; diagnostics were extended with computed notional and venue
  minimum. [Live report](https://github.com/olegeech/crypto-analyst-trader/pull/148#issuecomment-6556922008).
- **Account-wide pending source was too broad for independent symbols.**
  NEAR was refused after 21 GETs while INJ had an active TP. Final `d200aa7`
  scopes same-symbol checks both in the application and the atomic SQLite
  guard. Other-symbol sources are eligible only with a known accepted CREATE
  strictly older than current account-capacity evidence; ambiguous or newer
  attempts still block.
  [Fix](https://github.com/olegeech/crypto-analyst-trader/pull/148#issuecomment-6563217821).

A synthetic production-path comparison measured **63 pre-CREATE GETs** after evidence reuse versus **116** in an earlier duplicated path. The successful attended INJ command reported **40 GETs / 1 CREATE** including its immediate status, or **58 GETs** with a separate follow-up status. These are different scopes and environments, **not** a before/after production speed benchmark or a guaranteed count. [Performance evidence](https://github.com/olegeech/crypto-analyst-trader/pull/148#issuecomment-6557673140).

## Engineering lessons and where they live

1. **Settle execution intent versus inherited implementation policy early.** A research list, default TP, old approval flow or global pending-source veto is not automatically a venue or capital-safety requirement. For a new operator path, record its specific positive/negative acceptance examples and explicit legacy exceptions in the **canonical GitHub issue** before widening the implementation. The current authority and safety rules remain in [Product Principles](../product-principles.md), [ADR-0007](../adr/0007-bounded-operator-command-authorization.md) and [System Invariants](../architecture/invariants.md).
2. **Exercise the real composition, including fallback and advancing evidence time.** Tests of individually correct validators missed their combination. Cover an eligible end-to-end path and meaningful failure cases through actual provider mappers, application and persistence boundaries. The actionable technique and source references are in the [quote-bracket learning](provider-quote-bracket-preparation-time.md); a narrow reminder is included in [Development Workflow](../workflow.md#integration-contract-check).
3. **Treat freshness and affordability as current proofs, not exact equality with a previous observation.** Reuse compatible facts for a synchronous command; refresh missing/stale facts only where they can re-prove the required obligations. Never infer available margin from wallet total or ignore unknown borrowings and commitments. Preserve distinct legacy and separately approved flows.
4. **Scope conflicts to their real ownership boundary.** A known accepted INJ source with TP pending is not by itself an incident HALT or proof of a NEAR conflict. Same-symbol conflicts, ambiguous writes and newer cross-symbol CREATEs without sufficiently recent account-capacity evidence remain distinct blockers. Do not add account-wide lifecycle locks merely for future hypothetical concurrency.
5. **Make refusal diagnostics actionable.** Distinguish venue size restrictions, insufficient proven margin, stale quote, account-evidence uncertainty, unresolved same-symbol source and genuine incident HALT. Report safe source/reason/next action without raw credentials or private account evidence. Do not broaden a fix into a new bureaucracy or extra preflight.

## Follow-up discipline

This retrospective does **not** authorize another trade or require Mainnet smoke on each documentation/code commit. Use the existing [risk-based validation](../workflow.md#risk-based-validation) and explicit owner permission for exchange writes.

Open a **new GitHub issue only for an observed, still-unfixed failure** (for example, a diagnostic that remains opaque on the current code) with a reproducer, operator consequence and minimal acceptance criteria. Do not create speculative issues for already fixed M1 eligibility, timestamp ordering, repeated account scans or cross-symbol admission. Keep future priorities in [roadmap #33](https://github.com/olegeech/crypto-analyst-trader/issues/33), not in this historical document.

**Evidence limit:** the live-account state described above is the last recorded state on 2026-11-01, not a fresh exchange check. No conclusion about later TP execution, current available balance or multi-symbol Mainnet behavior follows from this retrospective.
