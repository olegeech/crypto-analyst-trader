# Mainnet quote-bracket preparation time: a PR #148 integration learning

**Classification:** solved integration defect · Bybit V5 Mainnet direct v3 trade · 2026-11-01 · [PR #148](https://github.com/olegeech/crypto-analyst-trader/pull/148).

## Problem

The one-instruction Mainnet trade preparation path initially refused a supervised INJUSDT command with `STALE_EVIDENCE` *before* collecting its account-wide proof or attempting CREATE, despite a normal recent ticker. The plan's preparation timestamp had been anchored to ticker observation rather than completion of the provider-time bracket around that ticker.

The affected live run made **10 GETs, 0 exchange writes**, then persisted `PRE_INTENT_REFUSED`. The earlier full local release suite passed **1,663 tests**, but the synthetic ticker and both provider time reads all used the same fixed timestamp. These are different evidence types: a passing suite did not prove the real-world inter-request ordering contract.

[Live refusal](https://github.com/olegeech/crypto-analyst-trader/pull/148#issuecomment-6557825476) · [Source-level diagnosis](https://github.com/olegeech/crypto-analyst-trader/pull/148#issuecomment-6558158304).

## Root cause and failed assumption

The provider client gathers an operator quote as three ordered events:

1. `collectionStartedAt` — provider time before the ticker request.
2. `observedAt` — time attached to the ticker response.
3. `collectionCompletedAt` — provider time after the ticker request.

Their expected relationship is:

~~~text
collectionStartedAt <= observedAt <= collectionCompletedAt
~~~

The original direct-v3 call set `preparedAt = quote.observedAt`. The canonical plan validator separately requires:

~~~text
0 <= preparedAt - observedAt <= quote freshness limit
collectionCompletedAt <= preparedAt
~~~

Any real positive gap between ticker observation and quote-collection completion therefore failed the second condition, **even when the quote was fresh**. Equal synthetic timestamps made the invalid mapping appear valid.

Increasing the freshness window, requesting another full account scan or relaxing the ordering requirement would have addressed the wrong failure mode.

## Verified correction

The merged preparation composition retains the original ticker observation time but anchors the plan to the end of the quote collection:

~~~ts
const initialQuote = await publicMarkets.readOperatorQuote(input.symbol, {
  directTrade: true,
});
const plan = makePlan({
  accountIdentityHash: identity.accountBinding.accountIdentityHash,
  quote: initialQuote,
  warningCodes: identity.credentialPosture.warnings,
  constraints: initialInstrument.constraints,
  preparedAt: initialQuote.collectionCompletedAt,
});
~~~

Defining files on merged `main`:

- `src/adapters/bybit-v5/public-market-client.ts` — before/ticker/after reads inside `readOperatorQuote`.
- `src/application/mainnet-operator-test-preparation-composition.ts` — v3 `makePlan` call with `collectionCompletedAt`.
- `src/domain/execution/operator-mainnet-test-plan.ts` — freshness and completion-before-preparation validation.
- `tests/mainnet-operator-trade-e2e.test.ts` — advancing-time production-path regression.

The regression uses coherent but unequal times: `T` before ticker, `T+100ms` for ticker, `T+300ms` after ticker. It asserts that the quote keeps the original bracket, that `plan.preparedAt >= plan.quote.collectionCompletedAt`, and that preparation alone performs **zero writes**. The correction and regression shipped in [PR #148](https://github.com/olegeech/crypto-analyst-trader/pull/148). [Fix report](https://github.com/olegeech/crypto-analyst-trader/pull/148#issuecomment-6558448829).

## Prevention for similar provider integrations

- When a feature depends on **multiple time-separated provider responses**, include at least one production-path fixture with advancing, unequal, ordered timestamps. Keep frozen clocks for isolated deterministic tests where event ordering is not the subject.
- Validate **observation age** and **completion order** independently; a quote can be fresh but not yet fully collected at the claimed preparation time.
- Cover incorrect or future provider timestamps and actual quote expiry as separate negatives. Do not silently turn evidence obtained later into an earlier observation.
- Assert through actual adapters/application composition, not only a domain validator fed hand-built compatible values.
- Keep diagnostics source-specific: distinguish the quote that was genuinely old from an incorrectly ordered time bracket when doing so is safely possible.
- A green CI run followed by a failed attended flow is evidence to reproduce the real request sequence before adding new retries, global guards or broad scans.

The general engineering instruction is linked from [Development Workflow](../workflow.md#integration-contract-check); the [PR retrospective](pr-148-retrospective.md) keeps the broader product and operator context. This learning is a technical case study, **not** an additional trading authorization, requirement for routine live tests, or claim of TP lifecycle completion.
