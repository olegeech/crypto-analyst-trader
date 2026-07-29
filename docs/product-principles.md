# Product Principles

## Outcome

Improve measured net risk-adjusted return after trading fees, funding and
slippage without exceeding explicit capital, exposure and drawdown limits.
Profit is an objective, not a guarantee.

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
