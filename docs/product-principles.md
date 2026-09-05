# Product Principles

## Outcome

Improve measured net risk-adjusted return after trading fees, funding and
slippage without exceeding explicit capital, exposure and drawdown limits.
Profit is an objective, not a guarantee.

## Current product intent

The primary operator is the product owner, assisted by AI reviewers/advisers
such as Codex or Claude CLI. The product should minimize manual work while
improving decision quality and measured trading performance without weakening
the minimum safety gates required for live capital.

The target daily loop is:

```text
daily-rebalance
  -> refresh market, derivatives, listing and account evidence
  -> evaluate regime, warnings, traps and instrument strength
  -> produce an explainable proposed portfolio/order-plan diff
  -> review risks and rationale
  -> approve one exact immutable plan
  -> execute only the approved live changes
  -> reconcile and report results
```

AI may recommend opening a new position, increasing or averaging an existing
position, reducing or closing a position, rebuilding grid/TP parameters, or
choosing `NO_TRADE`. In the current product stage, no live-state change occurs
without explicit human approval of the exact immutable plan.

Averaging is never justified only because price moved against the position. It
is eligible only when current regime and instrument evidence still supports the
original or a newly stated trading thesis, the instrument remains sufficiently
strong relative to the available alternatives, and the projected post-average
exposure passes the configured risk gate.

Required decision evidence includes, at minimum:

- versioned `MarketRegimeScore`, `CEWS / EarlyWarningRisk`, `LSI` and trap
  evidence;
- OHLCV market history;
- derivatives evidence including funding, open interest and liquidation data;
- current account, position and order state;
- listing and instrument metadata, including delist/expiry restrictions;
- completeness, freshness, integrity and provenance checks for required inputs.

Missing or stale required evidence produces `NOT_READY`/BLOCK rather than a
best-effort live recommendation.

For the first 1-2 months of usable operation, success means both:

- positive net trading PnL after fees, funding and slippage, with drawdown,
  capital efficiency and decision quality tracked explicitly; and
- materially less operator time spent on manual data gathering, reconciliation
  and order-plan construction.

Trading performance is compared with buy-and-hold of the traded instruments,
while the strategy's own net-profit history is tracked as the primary operating
record. A profitable result alone is insufficient if it depends on excessive
risk or opaque/unexplained actions.

Unattended mainnet execution is a future capability. It may be considered only
after enough operating history demonstrates stable decision quality, reliable
reconciliation and acceptable risk behavior; it requires a separate promotion
and architecture decision.

Discovery provenance: the initial product-owner interview was recorded in
[issue #35](https://github.com/olegeech/crypto-analyst-trader/issues/35).

## Current product priorities

Product-value priority, in descending order, is:

1. safely execute approved trades directly on Bybit;
2. materially reduce operator time and manual exchange work;
3. automatically identify stronger instruments and trading opportunities;
4. increase reliability and predictability of the daily decision loop; and
5. improve trading performance beyond the current approach.

This ordering does not weaken release, integrity or capital-safety gates.
Reliability and deterministic verification remain prerequisites for exposing
capital even when they are not the primary source of user value.

### Delivery trade-offs

Prefer the shortest safe path to a useful end-to-end product:

- deliver working Bybit execution with a simple deterministic planner before
  delaying execution for a substantially smarter planner;
- start with a narrow 1-3 instrument scope that works end to end before scaling
  the candidate universe or simultaneous exposure;
- initially prioritize opening new positions; management of existing positions
  remains part of the target loop but must not delay the first useful new-entry
  path unless safety or ownership semantics require it;
- use a hybrid decision model: AI may propose thesis, candidates, confidence and
  parameters, while deterministic TypeScript domain, risk and exchange-rule
  logic validates and constructs authoritative order intents;
- during early operation, balance automation with extra review visibility for
  debugging; converge toward one-command operation as evidence and confidence
  accumulate;
- distinguish missing required evidence from ordinary uncertainty: required
  evidence that is stale, incomplete or incompatible still blocks exposure,
  while non-critical uncertainty should prefer explicit confidence/review
  warnings over unnecessary `NO_TRADE`/`NOT_READY` results.

### First live scope

The first live product slice should focus on opening new positions for at most
1-3 instruments in one approved run. Before approval, the operator must see at
least:

- instrument;
- proposed entry price and quantity;
- capital allocated;
- grid and take-profit parameters;
- confidence and evidence-quality assessment;
- rationale for the recommendation; and
- when modifying existing state, a clear comparison with the current state.

Testnet validates exchange mechanics and failure behavior, but the product
should move to a tightly bounded, manually approved mainnet canary as soon as
its explicit release and capital-safety gates are satisfied. Mainnet canary
scope must remain small and reversible; it does not require proof that the
strategy already outperforms every benchmark.

A strategy recommendation that later proves unprofitable is an acceptable
learning outcome when the evidence, risk and execution contracts behaved as
designed. Execution corruption, invalid data authorization, ownership mistakes
or bypassed risk/approval gates are not acceptable strategy errors.

The primary weekly product metric is positive net PnL after fees, funding and
slippage. Operator time, end-to-end automation rate, drawdown, capital
efficiency and safety incidents remain required supporting metrics.

Prioritization provenance: these trade-offs were confirmed in the product-owner
prioritization interview following the discovery recorded in issue #35.

## Principles

1. **Decision quality before autonomy.** A deterministic, explainable daily
   plan is valuable before any exchange write exists.
2. **Fail closed.** Missing, stale, mixed-run or contradictory evidence blocks
   exposure increases.
3. **Exact approval.** An operator approves one immutable plan hash, not a
   strategy name or a mutable configuration.
4. **Owned orders only.** Manual and unrelated exchange orders are never
   changed.
5. **Protection at entry.** A managed entry is submitted only with
   exchange-native protective exits.
6. **Reconcile before retry.** An ambiguous write outcome is investigated by
   client and exchange order identifiers before any repeat.
7. **Net economics.** Research and promotion use fees, funding, slippage,
   turnover, exposure and drawdown; gross PnL alone is insufficient.
8. **Evidence-based promotion.** Strategies move from research to shadow,
   Testnet, canary and live only after explicit gates.
9. **Small reversible steps.** Initial live scope uses a dedicated subaccount,
   one symbol/side and a strict capital cap.
10. **Earn complexity.** Realtime state, grid replenishment, extra exchanges and
    unattended execution require measured need and a new architecture decision.
