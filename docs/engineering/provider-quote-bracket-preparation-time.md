# Quote-collection timestamps — a missed integration contract

**Source:** [PR #148](https://github.com/olegeech/crypto-analyst-trader/pull/148), supervised direct-v3 INJUSDT preparation. The observed refusal was `STALE_EVIDENCE` before any exchange write ([diagnosis](https://github.com/olegeech/crypto-analyst-trader/pull/148#issuecomment-6558158304)).

## Failure mechanism

The public-market adapter obtains provider times before and after the ticker:

```text
collectionStartedAt <= observedAt <= collectionCompletedAt
```

Preparation originally set `preparedAt = quote.observedAt`, while the plan validator requires `collectionCompletedAt <= preparedAt` and a fresh observation. With real sequential requests, collection completes *after* ticker observation: the plan fails even when the quote itself is recent. Tests had used one frozen timestamp for all three responses, masking this contract violation.

## Correction and regression

Merged v3 composition sets `preparedAt: initialQuote.collectionCompletedAt` while retaining the original ticker `observedAt`. The freshness and ordering constraints remain intact.

- Adapter: `src/adapters/bybit-v5/public-market-client.ts`.
- Composition: `src/application/mainnet-operator-test-preparation-composition.ts`.
- Validator: `src/domain/execution/operator-mainnet-test-plan.ts`.
- Regression: `tests/mainnet-operator-trade-e2e.test.ts`, using different ordered provider times (`T`, `T+100ms`, `T+300ms`) and asserting preparation performs no writes.

## Reuse trigger

When a provider integration combines **time-separated responses** into one admissible decision, test observation age and collection-completion order independently through the production composition. Include at least one advancing-time fixture; frozen clocks alone cannot expose this defect. Do not paper over the failure by relaxing freshness limits, repeating full account scans or adding unconditional retries.

This specific case is already fixed and regression-tested. The corresponding general guidance lives in [Development Workflow](../workflow.md#integration-contract-check); historical attempts remain in [PR #148](https://github.com/olegeech/crypto-analyst-trader/pull/148). No new Mainnet authorization or mandatory live test follows from this case study.
