# PR #148 retrospective — one-instruction Mainnet trade

**Status:** [PR #148](https://github.com/olegeech/crypto-analyst-trader/pull/148) merged into `main` on 2026-11-01; reviewed head `d200aa7`, merge commit `5c95f0f`. [Issue #147](https://github.com/olegeech/crypto-analyst-trader/issues/147) owns the accepted scope. This document records lessons, not a second roadmap or new trading authorization.

## Outcome and evidence

The scoped v3 direct `mainnet:test trade` path delivers one owner-issued instruction bound to an immutable Buy Limit, explicit TP percent or price, a capped one-use CREATE and read-only status. It validates a requested Bybit USDT-linear instrument rather than applying the M1 research symbol set. Target-specific leverage configuration and source-aware coexistence of independent symbols preserve account capacity, incident HALT, durable intent and no-resend safeguards. Legacy approval paths retain their rules.

The PR changed 56 files; the local release suite reported **1,674 passing tests**, and exact-final-head GitHub CI passed ([run](https://github.com/olegeech/crypto-analyst-trader/actions/runs/41344599525)). These checks establish tested contracts, not a universal production result.

A supervised INJUSDT CREATE was accepted and the 1.3 INJ entry filled, but its attached TP was still open at the last recorded read. Status was `PARTIAL_EVIDENCE` / `cleanup=pending`, **not** `TP_LIFECYCLE_PASS`. The subsequent GET-only status also reported an open position and TP without issuing writes ([status evidence](https://github.com/olegeech/crypto-analyst-trader/pull/148#issuecomment-6563877210)). The earlier NEARUSDT attempt was blocked before the final cross-symbol fix; the corrected behavior has offline tests, but no later successful live NEAR CREATE is claimed.

## What the attempts taught us

### Research eligibility is not execution eligibility

The initial INJUSDT full-readiness fallback made 51 GETs and returned `READINESS_INVALID_REQUEST` while generically labeling the account. Direct execution had inherited an M1 research-symbol restriction. The fix validates the requested direct instrument against current venue evidence in both compact and fallback paths while preserving legacy and M1 scope ([diagnosis](https://github.com/olegeech/crypto-analyst-trader/pull/148#issuecomment-6550598329)).

### Repeated account scans and numerical equality can obstruct a valid one-shot instruction

One 10-USDT INJ attempt performed **116 GETs** and refused with `CRITICAL_STATE_CHANGED` for assets. A deposit was plausible but not proved as the differing field. The v3 path now hands off one bounded account proof and bases fee-aware admission on current trustworthy available capacity, with bounded targeted freshness refresh rather than an unconditional second full scan ([PO decision](https://github.com/olegeech/crypto-analyst-trader/pull/148#issuecomment-6557114246)).

### Frozen fixture clocks masked a temporal integration defect

A later attempt stopped with `STALE_EVIDENCE` after 10 GETs and zero writes. `preparedAt` had incorrectly been set to ticker `observedAt` despite a later end-of-collection provider-time reading. A moving-clock production-path regression and the correction are documented in the [quote-bracket case study](provider-quote-bracket-preparation-time.md).

### Distinguish venue rules from invented application restrictions

A 5-USDT NEAR preparation returned `NOTIONAL_TOO_SMALL`, a legitimate venue constraint. The implementation now reports computed notional and the venue minimum without silently increasing the operator's amount ([report](https://github.com/olegeech/crypto-analyst-trader/pull/148#issuecomment-6556922008)). By contrast, a separate NEAR instruction was blocked after 21 GETs solely because an unrelated INJ source still had an active TP. Final `d200aa7` scopes same-symbol conflicts in application and atomic SQLite admission. Other-symbol sources can coexist only when any prior pending CREATE is known accepted strictly before the current capacity evidence; ambiguous, unconfirmed or newer attempts still block ([fix](https://github.com/olegeech/crypto-analyst-trader/pull/148#issuecomment-6563217821)).

### Read counts need a comparable denominator

Synthetic production-path checks measured **63 pre-CREATE GETs** after evidence reuse versus **116** previously. The successful attended INJ command made **40 GETs / 1 CREATE** including immediate status, or **58 GETs** with a later separate GET-only status. These measurements have different scopes and environments, so they do not establish a production speedup or universal GET count ([evidence](https://github.com/olegeech/crypto-analyst-trader/pull/148#issuecomment-6557673140)).

## Engineering improvements and their home

### Clarify product policy before implementation

A research list, default TP, prior approval flow or account-wide pending-source veto is not inherently a venue or capital-safety requirement. Capture positive and negative examples and deliberate legacy exceptions in the **canonical GitHub issue** before extending an execution path. Normative authority and safety stay in [Product Principles](../product-principles.md), [ADR-0007](../adr/0007-bounded-operator-command-authorization.md) and [System Invariants](../architecture/invariants.md).

### Exercise the complete production composition

Test the eligible happy path and meaningful failures through provider mappers, application and persistence boundaries, including fallback and advancing provider times. The specific timestamp defect is in the [quote-bracket lesson](provider-quote-bracket-preparation-time.md); the narrowly applicable engineering reminder is in [Development Workflow](../workflow.md#integration-contract-check).

### Use current evidence and the correct conflict boundary

A synchronous direct command should reuse trustworthy current facts and refresh only what can re-prove required obligations; it must not infer available margin from wallet total or ignore borrowing and commitments. A known accepted INJ source with TP pending is not itself an account HALT or a NEAR conflict. Same-symbol orders, ambiguous writes and newer cross-symbol CREATEs with unproven capacity remain blockers. Preserve separate legacy and approved strategy semantics.

### Make rejection diagnostics actionable

Distinguish venue minimums, margin or fee insufficiency, genuinely stale quotes, evidence uncertainty, same-symbol conflicts and incident HALT. Report safe cause and next action without exposing credentials or private account data. Do not add global scans, new permissions or extra confirmation steps just to avoid a speculative future problem.

## Follow-up discipline

This case study does **not** authorize a trade or mandate Mainnet smoke on each commit. Apply [risk-based validation](../workflow.md#risk-based-validation) and separate owner authorization for exchange writes. Open a new GitHub issue only for a currently reproducible, unaddressed defect with operator impact and scoped acceptance criteria. Priorities remain in [roadmap #33](https://github.com/olegeech/crypto-analyst-trader/issues/33), not in this historical document.

**Evidence limit:** live state here is the last recorded state on 2026-11-01, not a fresh exchange check. We cannot infer subsequent TP execution, current account capacity or multi-symbol Mainnet behavior from it.
