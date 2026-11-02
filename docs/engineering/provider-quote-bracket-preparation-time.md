# Mainnet quote-bracket preparation time: a PR #148 integration learning

**Classification:** solved integration defect, Bybit V5 Mainnet direct v3 trade, 2026-11-01. [Merged PR #148](https://github.com/olegeech/crypto-analyst-trader/pull/148).

## Problem and observable failure

A supervised INJUSDT one-instruction Mainnet preparation refused with `STALE_EVIDENCE` before account-wide collection and before CREATE, even though the ticker was recent. The attempt made **10 GETs and zero exchange writes**, saving `PRE_INTENT_REFUSED` ([live refusal](https://github.com/olegeech/crypto-analyst-trader/pull/148#issuecomment-6557825476)). The earlier full release suite passed **1,663 tests** because its ticker envelope and both provider-time endpoints used the same artificial timestamp ([root-cause analysis](https://github.com/olegeech/crypto-analyst-trader/pull/148#issuecomment-6558158304)).

## Root cause

An operator quote is bound to three separate events: `collectionStartedAt` is provider time **before** the ticker request, `observedAt` belongs to the ticker response, and `collectionCompletedAt` is provider time **after** the ticker. Their valid ordering is `collectionStartedAt <= observedAt <= collectionCompletedAt`.

The original direct-v3 call used `preparedAt = initialQuote.observedAt`. However, the plan validator requires `collectionCompletedAt <= preparedAt` as well as a nonnegative observation age within its quote-freshness limit. Any normal positive interval between ticker observation and the final time read would thus fail the completion-order requirement, **without the quote actually being old**. Frozen fixture clocks concealed the invalid assignment.

Increasing the freshness window, repeating an entire account scan, or weakening the time ordering would not address that defect.

## Verified correction in merged source

`src/adapters/bybit-v5/public-market-client.ts` gathers the provider-time bracket around the ticker. In `src/application/mainnet-operator-test-preparation-composition.ts`, the v3 `makePlan` call now passes `preparedAt: initialQuote.collectionCompletedAt` while retaining `quote: initialQuote`. The canonical freshness/order check remains in `src/domain/execution/operator-mainnet-test-plan.ts` ([fix report](https://github.com/olegeech/crypto-analyst-trader/pull/148#issuecomment-6558448829)).

`tests/mainnet-operator-trade-e2e.test.ts` now exercises a coherent, advancing bracket: start `T`, ticker `T+100ms`, completion `T+300ms`. It checks that the ticker time is retained, `plan.preparedAt >= plan.quote.collectionCompletedAt`, and preparation alone makes zero exchange writes. These tests and the correction shipped in [PR #148](https://github.com/olegeech/crypto-analyst-trader/pull/148).

## When to apply this learning

For a provider integration whose evidence comes from **multiple time-separated responses**, cover at least one production-path case with unequal ordered timestamps. Frozen clocks remain appropriate for isolated tests where event ordering is irrelevant. Test the real adapters and application composition, not merely a domain validator given compatible synthetic values.

Keep **observation age** distinct from **collection-completion order**. Check negative or future provider times and genuinely expired quotes as separate rejection cases; do not replace a bad ordering with another full scan or permit evidence from the future. Error diagnostics should distinguish an actually old quote from a faulty collection bracket when safely possible.

A passing CI followed by a real refusal is evidence to reproduce the actual provider call sequence before adding retries or more general guards. The applicable integration reminder is linked from [Development Workflow](../workflow.md#integration-contract-check), and the broader product context is in the [PR #148 retrospective](pr-148-retrospective.md).

This learning is historical technical reasoning, not additional trade authority, a mandatory live test on each commit, or evidence that the TP lifecycle completed.
