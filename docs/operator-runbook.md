# Daily Rebalance Operator Runbook

## Purpose

This is the canonical operator procedure for one bounded daily trading run:

```text
prepare -> review -> approve -> execute -> reconcile -> report
```

It applies to direct Bybit execution. Product boundaries live in `README.md`,
and mandatory safety rules live in `docs/architecture/invariants.md`. If this
runbook conflicts with an invariant, the invariant wins.

CLI names in this document describe application use cases. Invoke only commands
implemented by the current `package.json` and released for the selected
environment. A missing capability is `CAPABILITY_NOT_RELEASED`; do not replace
it with an ad hoc API call.

## Operating modes

| Mode              | Exchange writes    | Required authorization                                                     |
| ----------------- | ------------------ | -------------------------------------------------------------------------- |
| `PREPARE_ONLY`    | None               | Default for a daily rebalance request                                      |
| `TESTNET_EXECUTE` | Bybit Testnet only | Explicit Testnet request plus approval of the exact plan hash              |
| `MAINNET_EXECUTE` | Bybit mainnet      | Explicit mainnet request after reviewing and approving the exact plan hash |

Preparation and execution are separate. Words such as "full", "daily",
"rebalance", "refresh", or a supplied capital limit do not authorize exchange
writes. Approval cannot be given before the final plan hash exists.

`MAINNET_EXECUTE` is unavailable until the production-canary milestone permits
it. It also requires explicit mainnet configuration, a dedicated bounded
account scope, an unexpired approval, and every release and preflight gate to
pass. No mode may override a `BLOCK` or `HALT`.

## Market window

The normal full rebalance window is once per United States cash-market session:

- target time: `09:45 America/New_York`, after the first 15 minutes of the cash
  session;
- use IANA time zones, not a fixed UTC offset; this is normally `15:45` in
  `Europe/Berlin`, with temporary differences around daylight-saving changes;
- if a scheduled high-impact release occurs at or after the target time, defer
  until at least 15 minutes after the latest relevant release and refresh all
  time-sensitive evidence;
- on weekends or United States cash-market holidays, skip the routine
  exposure-increasing run unless a versioned policy explicitly permits a
  prepare-only assessment;
- an emergency reconciliation or `HALT` action may run at any time.

Use an authoritative cash-market calendar. Never infer holidays from weekday
alone.

## Required inputs

The run may prepare exposure only when all required inputs are present and
coherent for one run:

- exact environment, account and position mode;
- versioned strategy, risk and cost policies;
- explicit capital allocation or a versioned policy allocation;
- instrument status and constraints, including listing state, expiry or
  delivery risk, price and quantity steps, price bands and minimum order value;
- fresh market, liquidity, volatility, funding and derivatives evidence;
- fresh Unified Trading Account balances, collateral state, liabilities,
  positions, orders and fills;
- durable ownership mapping for every order eligible for cancellation;
- the current persisted `HALT` state and previous-run reconciliation status.

Missing allocation is not replaced with an invented default. A user-supplied
limit is a ceiling only when the released command contract supports and hashes
that override.

## Daily procedure

### 1. Establish the release and runtime boundary

1. Record the exact commit, environment, account scope and run ID.
2. Inspect `package.json` for released commands. Do not claim or simulate an
   unavailable phase.
3. Require release-check evidence for the exact commit. Reuse a durable
   attestation when available; otherwise run `npm run test:release`.
4. Confirm no earlier run owns the account lock and no unresolved
   `PARTIAL`, `FAILED` or ambiguous execution remains.
5. Confirm credentials are available through the approved secret boundary
   without printing or copying them into artifacts.

Any uncertainty about environment, account, release state or credentials stops
before private writes.

### 2. Refresh evidence

Refresh independent sources even when another source fails, but never replace a
required failed refresh with stale data.

1. Capture public instrument metadata and reject unavailable, restricted,
   expiring or delisting instruments.
2. Capture market and derivatives evidence with explicit `asOf`, collection
   window and provenance.
3. Capture a sanitized private account snapshot and reconcile balances,
   liabilities, positions, open orders and recent fills.
4. Verify that required evidence falls inside policy freshness and
   cross-source skew limits.
5. If bounded candidate discovery is released, rank only its eligible universe
   and retain the top 3-5 explainable candidates. Otherwise use only the
   configured strategy universe.

A discovered candidate is evidence, not permission to trade. It still passes
planning, economic, risk and approval gates.

### 3. Prepare the immutable plan

The planner must be deterministic for the same snapshots and policies.

1. Classify the market regime and record reason codes and uncertainty.
2. Select fewer high-quality candidates when evidence or capital is limited.
   `NO_TRADE` is a valid result.
3. Build a static daily entry grid. Every entry has one exchange-attached
   take-profit and one catastrophic stop; the collection of entries forms the
   plan-level exit ladder.
4. Normalize price and quantity only through instrument constraints. Reject an
   economically infeasible order rather than silently changing strategy risk.
5. Derive usable allocation as the lower of policy limits and conservative
   fresh account capacity after liabilities, collateral haircuts, locked
   funds, existing margin and reserve.
6. Evaluate current and projected notional, leverage, margin, liquidation
   distance, drawdown and the temporary peak of the cancel/create sequence.
7. Require expected edge to cover fees, funding, slippage and the configured
   buffer.
8. Diff desired entries only against durably owned current entries. Preserve
   manual orders and all protective exits.

Do not average a losing position merely to reduce its displayed entry price.
Additional exposure requires the same current strategy evidence and
post-plan-risk proof as a new entry.

Persist snapshots, policy versions, desired/current diff, decisions and the
canonical plan hash before review.

### 4. Review before approval

Present compact Markdown tables, not raw JSON. At minimum review:

| Review surface | Required evidence                                                        |
| -------------- | ------------------------------------------------------------------------ |
| Inputs         | `asOf`, freshness, provenance and quality status                         |
| Candidates     | selected and excluded symbols with reason codes                          |
| Account        | equity, usable capacity, liabilities, reserve and existing exposure      |
| Plan           | create/cancel/keep counts and every changed field as `old -> new`        |
| Orders         | symbol, side, entry, quantity, notional, take-profit and stop            |
| Economics      | fees, funding, slippage, expected edge and return on allocated capital   |
| Risk           | current -> projected exposure, margin, drawdown and liquidation distance |
| Ownership      | proof that only owned entries can be changed                             |
| Residual risk  | uncertainty, assumptions and operator action still required              |

The operator must be able to identify the environment, run ID, plan hash,
approval expiry and worst credible consequence from this review alone.

### 5. Approve the exact plan

Store the actor, timestamp, note, expiry, environment and exact plan hash.
`REVIEW` items require an explicit note. `BLOCK` items cannot be approved.

Any change to snapshots, policies, constraints, desired/current diff or
normalized orders creates a new hash and invalidates the approval.

### 6. Execute the approved diff

Execution is allowed only in the approved environment.

1. Reacquire the account lock and revalidate approval, evidence and account
   freshness.
2. Persist each intended write before submitting it.
3. Cancel only stale owned entry orders.
4. Reconcile every cancellation before relying on released capacity.
5. Stop before new exposure if cancellation is partial or ambiguous.
6. Submit desired entries with their attached protective exits.
7. Treat acknowledgements as pending and reconcile through bounded polling and
   history fallback.
8. Stop later exposure-increasing phases after any partial result.

Never blind-retry an ambiguous write and never imply transactional rollback
across independent exchange operations.

### 7. Reconcile and verify protection

Reconcile by durable client and exchange order identifiers. Confirm:

- intended, accepted, open, filled, cancelled and rejected quantities;
- every managed position has protective coverage;
- account positions and owned orders match the final journal state;
- fees, funding, fills and transaction checkpoints were persisted once;
- no unresolved result remains hidden behind a successful process exit.

Set `HALT` when protection, ownership, account state or write outcome cannot be
proven. Clear it only through an explicit operator action after reconciliation.

### 8. Report the run

Use one execution verdict:

- `PREPARED`: valid plan produced; no exchange write ran;
- `TESTNET_EXECUTED`: exact approved Testnet plan reconciled;
- `MAINNET_EXECUTED`: exact approved mainnet plan reconciled;
- `NO_TRADE`: fresh evidence produced no economically valid exposure;
- `NOT_READY`: a pre-write requirement failed;
- `HALTED`: execution or reconciliation requires containment.

Report:

1. mode, environment, commit, run ID, plan hash and approval status;
2. input freshness and quality;
3. candidate, selected, excluded and order counts;
4. allocation and current -> projected exposure;
5. the complete changed-field and owned-order diff tables;
6. gate, execution, reconciliation and protection results;
7. artifact paths and hashes, without raw private payloads;
8. net realized and unrealized PnL, fees, funding, return on allocated capital,
   drawdown and exposure when available;
9. residual risk and required operator action.

Win rate is secondary and may be reported only with a stable round-trip trade
definition. It must not replace net return, costs, drawdown or capital
efficiency.

Finish with one runtime-system assessment:

- `READY_FOR_ROUTINE_USE`: the released path completed without workaround;
- `USABLE_WITH_OPERATOR_REVIEW`: the safe path worked with a bounded manual or
  data limitation;
- `NOT_RELIABLE_FOR_THIS_RUN`: a mandatory stage failed or conflicted.

This assessment grades the system behavior observed in this run, not future
profitability or the general quality of a newly developed feature.

## Incident path

Immediately stop new exposure and persist `HALT` when any of these occurs:

- unknown or stale account state;
- an order without provable ownership;
- a managed position without provable protection;
- ambiguous create/cancel outcome;
- unexpected position, fill or balance drift;
- expired approval or plan-hash mismatch;
- newly detected restriction, expiry or delisting;
- repeated reconciliation timeout.

Preserve evidence, reconcile first, and choose a deliberate recovery action.
Never use bulk cancellation or an unplanned market order as a routine shortcut.

## Context and operating cost

- Load this runbook, the invariants and only the artifacts needed for the
  current phase.
- Keep discovery, API pagination, historical windows and report rows bounded.
- Store full machine evidence once and report hashes, reason codes and compact
  summaries.
- Do not paste private snapshots or repeat unchanged strategy configuration in
  chat, issues or pull requests.
- Do not edit product code, documentation or Git state during an operator run.
