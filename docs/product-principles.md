# Product Principles

## Outcome

Improve measured net risk-adjusted return after trading fees, funding and
slippage without exceeding explicit capital, exposure and drawdown limits.
Profit is an objective, not a guarantee.

## Product intent — reviewed 2026-09-05

The primary operator is the product owner, assisted by AI coding and review
assistants. The product should reduce manual exchange work while improving
decision quality and measured trading performance without weakening the minimum
safety gates required for live capital.

The canonical daily product boundary is defined in [README.md](../README.md).
Preparation and execution remain separate as required by
[invariant 16](architecture/invariants.md), and every production exchange
write remains bound to an approved exact plan hash by invariant 2. The bounded
Testnet capability probe is a scoped exception: its explicit invocation
authorizes only the documented Testnet scenarios and necessary probe-owned
cleanup, while each write still receives an exact, expiring plan hash and
final revalidation.

Required decision evidence includes, at minimum:

- versioned market-regime, early-warning-risk, liquidity-stress and trap evidence
  described by the [market-regime research context](analytics/market-regime-context.md)
  and tracked by issue #12;
- OHLCV market history;
- derivatives evidence including funding, open interest and liquidation data,
  with liquidation ownership tracked by
  [issue #45](https://github.com/olegeech/crypto-analyst-trader/issues/45);
- current account, position and order state;
- listing and instrument metadata, including delist or expiry restrictions; and
- completeness, freshness, integrity and provenance checks for required inputs.

Missing, stale or incompatible required evidence blocks exposure according to
invariants 1 and 18. Ordinary uncertainty that does not violate a required gate
should remain visible through confidence and review warnings rather than being
silently converted into fabricated certainty or an unnecessary blocked run.

Averaging is never justified only because price moved against the position. It
is eligible only when current regime and instrument evidence still supports the
original or a newly stated trading thesis, the instrument remains sufficiently
strong relative to available alternatives, and projected post-average exposure
passes the configured risk gate.

AI contributions follow invariant 19: research or model output may contribute
decision evidence, while the TypeScript planner remains authoritative for
exchange-valid order intents.

Discovery provenance: the initial product-owner interview was recorded in
[issue #35](https://github.com/olegeech/crypto-analyst-trader/issues/35).
Review this section when the production-canary scope or autonomy level changes.

## Product-value priorities

Product-value priority, in descending order, is:

1. safely execute approved trades directly on Bybit;
2. materially reduce operator time and manual exchange work;
3. automatically identify stronger instruments and trading opportunities;
4. increase reliability and predictability of the daily decision loop; and
5. improve trading performance beyond the current approach.

This is a user-value ordering, not an implementation queue. It never overrides
release dependencies, GitHub milestone scope, or the ordered active milestone
queue in [issue #33](https://github.com/olegeech/crypto-analyst-trader/issues/33).
Use it as a trade-off lens only where the canonical release gate and queue do not
already force implementation order.

Reliability, deterministic verification, data integrity and capital-safety gates
remain prerequisites for exposing capital even when they are not the primary
source of user value.

### Delivery trade-offs

Prefer the shortest safe path to a useful end-to-end product:

- deliver working Bybit execution with a simple deterministic planner before
  delaying execution for a substantially smarter planner;
- prove a narrow end-to-end instrument scope before scaling the candidate
  universe or simultaneous exposure;
- initially prioritize opening new positions; management of existing positions
  remains part of the target product but should not delay the first useful
  new-entry path unless safety or ownership semantics require it;
- during early operation, balance automation with extra review visibility for
  debugging, then reduce routine operator steps as evidence accumulates; and
- distinguish missing required evidence from ordinary uncertainty: required
  evidence failures still block exposure, while non-critical uncertainty should
  remain explicit through confidence and review warnings.

### First mainnet canary

[Issue #31](https://github.com/olegeech/crypto-analyst-trader/issues/31) owns the
canonical production-canary scope and acceptance criteria. The first canary uses
a dedicated subaccount, one symbol and side, and a strict capital cap. Expanding
to multiple symbols is a later product step and requires the separate issue and
approval required by #31.

Before approval, the operator should see at least:

- instrument;
- proposed entry price and quantity;
- capital allocated;
- grid and take-profit parameters;
- confidence and evidence-quality assessment;
- rationale for the recommendation; and
- when modifying existing state, a clear comparison with the current state.

A strategy recommendation that later proves unprofitable is an acceptable
learning outcome when evidence, risk and execution contracts behaved as
designed. Execution corruption, invalid data authorization, ownership mistakes
or bypassed risk or approval gates are not acceptable strategy errors.

## Success measurement

For the first 1–2 months of usable operation, the primary product outcome metric
is cumulative net PnL after fees, funding and slippage. The target is positive
net PnL over that evaluation window, without treating profit as guaranteed.

Required supporting measures are operator minutes per completed daily run,
drawdown, capital efficiency, end-to-end automation rate and safety incidents.
Any experiment baseline, including buy-and-hold where useful, must define its
period and cost assumptions under the [workflow experiment rules](workflow.md)
rather than creating a second permanent baseline definition here.

Prioritization provenance: these trade-offs were confirmed in the product-owner
prioritization interview following the discovery recorded in issue #35.

## Principles

1. **Decision quality before autonomy.** A deterministic, explainable daily
   plan is valuable before any exchange write exists.
2. **Fail closed.** Missing, stale, mixed-run or contradictory evidence blocks
   exposure increases.
3. **Exact approval.** Production execution requires one immutable plan hash,
   not a strategy name or mutable configuration. The bounded Testnet probe uses
   explicit invocation as its run-scoped authorization and keeps the exact
   plan hash as the write-integrity boundary without retyping it for every
   scenario or cleanup action.
4. **Owned orders only.** Manual and unrelated exchange orders are never
   changed.
5. **Take-profit at entry.** A managed entry is submitted with at least one
   exchange-native take-profit. A stop-loss is optional and must come from an
   explicitly approved strategy policy; the generic path never injects one.
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
