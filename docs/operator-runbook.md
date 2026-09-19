# Daily Rebalance Operator Runbook

## Purpose

This is the canonical operator procedure for one bounded daily trading run:

```text
prepare -> review -> approve -> execute -> reconcile -> report
```

It applies to direct Bybit execution. Product boundaries live in `README.md`,
and mandatory safety rules live in `docs/architecture/invariants.md`. If this
runbook conflicts with an invariant, the invariant wins.

## Bybit Testnet capability probe (issue #7)

Before #8 freezes daily-order contracts, the bounded live capability check is
operator-executed only:

```text
TRADER_ENV=testnet npm run probe:bybit:testnet
```

The command is opt-in and absent from `test:release`, default tests and CI.
It is locked to the canonical Bybit Testnet origin and the Testnet Keychain
credential. Explicit invocation authorizes the documented scenarios and
necessary probe-owned cleanup for this dedicated Testnet account. The probe
still constructs an exact, expiring plan hash and revalidates it immediately
before every write; there are no repeated create/cancel/cleanup prompts, full
digest retyping or exclusive-use confirmation prompts. Dirty account or symbol
state remains a read-only precondition failure.

Only sanitized, runtime-validated fields belong in PR or issue evidence:
account hash prefix, run-scoped `orderLinkId`, truncated exchange order IDs,
acknowledgement, terminal REST state and attached-exit read-back. Protection
after a fill remains **unverified** unless an execution was actually
observed. `CONFIRMED_CLEAN` is the only clean completion verdict; `REFUSED`,
`PRECONDITION_FAILED` and `CONTRADICTION` stop new scenarios, while
`UNRESOLVED` requires recovery of the saved run before any new write. Follow
the handoff and the exchange-UI manual fallback in `SECURITY.md`; never
cancel all orders or flatten unowned exposure.

For a saved run whose read-only checks show no matching order, open orders,
executions or position, use the same-environment recovery flow:

```text
npm run probe:bybit:recover -- --environment <testnet|demo> <saved-run-id>
```

It automatically records `RECOVERED_CLEAN` with a timestamp and sanitized
read-only evidence while preserving the original `UNRESOLVED` result as
unverified. Owned state is routed through the normal exact-plan recovery path;
ambiguous state stops and requires the documented exchange-UI fallback.

## Bybit Demo capability probe (issue #75)

The Demo probe is an explicit, operator-only capability check against the
separate Bybit Demo Trading environment. It is never a production or Testnet
write and is excluded from default tests, release checks and CI:

```text
TRADER_ENV=demo npm run probe:bybit:demo
```

The command accepts only `https://api-demo.bybit.com`, loads only the dedicated
Demo Keychain service, uses the Demo UID only for sanitized ownership hashing,
and records evidence as `Demo-observed, Testnet/mainnet unverified`. Demo
credentials are created with `npm run credentials:setup:demo`; Agent Connect is
not supported for Demo. If the preflight needs funds, add the exact reported
shortfall through the Bybit Demo UI. The probe never calls a funding endpoint
or auto-funds the account.

Before any Demo write, the read-only preflight validates the reconciliation
reads needed for ambiguous acknowledgements and cleanup. Unsupported or
invalid reconciliation reads stop the run before the first write. A subsequent
Demo probe invocation automatically re-reconciles an unresolved Demo run. If
that cannot prove clean state, use the same-environment read-only recovery
command above; it never switches the run to Testnet or mainnet. If ownership
or clean state remains ambiguous, stop and use the exchange UI fallback rather
than retrying an ambiguous write blindly.

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

Routine rebalance timing is defined by the active versioned strategy or
operating policy. This runbook does not invent a fixed cash-market session,
clock time, weekend rule or holiday calendar.

- record the active timing-policy identity and version with the run;
- use IANA time zones rather than fixed UTC offsets when a policy defines a
  local-time window;
- when a policy references an external market session, holiday calendar or
  scheduled macro event, use an authoritative source for that dependency;
- after a policy-defined event delay, refresh every time-sensitive evidence
  input before preparing or executing a plan;
- outside the policy-permitted exposure window, do not increase exposure;
  follow the released policy for `PREPARE_ONLY`, `NO_TRADE` or `NOT_READY`;
- emergency reconciliation or `HALT` containment may run at any time.

A proposed timing rule from research, historical analysis or operator judgment
is evidence, not production policy. Adopt or change a routine market window only
through a versioned policy or an explicit architecture/product decision with
measured evidence.

## Required inputs

The run may prepare exposure only when all required inputs are present and
coherent for one run:

- exact environment, account and position mode;
- versioned strategy, risk, cost and timing policies;
- explicit capital allocation or a versioned policy allocation;
- instrument status and constraints, including listing state, expiry or
  delivery risk, price and quantity steps, price bands and minimum order value;
- fresh market, liquidity, volatility, funding and derivatives evidence;
- validated evidence references with schema/producer identity, `asOf`, source
  or input snapshot identity, freshness semantics and canonical content hash;
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
4. Runtime-validate external, persisted and cross-process payloads before they
   become domain evidence. Record each decision-relevant `EvidenceRef`, including
   schema and producer version, source/input snapshot identity, freshness or
   expiry semantics and canonical content hash.
5. Verify that required evidence falls inside policy freshness and
   cross-source skew limits, and that declared input identities are compatible
   with this run.
6. If bounded candidate discovery is released, rank only its eligible universe
   and retain the top 3-5 explainable candidates. Otherwise use only the
   configured strategy universe.

A discovered or research-generated candidate is evidence, not permission to
trade. It still passes planning, economic, risk and approval gates.

### 3. Prepare the immutable plan

The planner must be deterministic for the same validated evidence, snapshots and
policies.

1. Classify the market regime and record reason codes and uncertainty.
2. Select fewer high-quality candidates when evidence or capital is limited.
   `NO_TRADE` is a valid result.
3. Build a static daily entry grid. Every entry has one exchange-attached
   take-profit and one catastrophic stop; the collection of entries forms the
   plan-level exit ladder.
4. Normalize price and quantity only through instrument constraints and the
   authoritative exact-decimal rounding policy. Reject an economically
   infeasible order rather than silently changing strategy risk.
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

Persist snapshots, validated evidence references and hashes, policy versions,
desired/current diff, decisions and the canonical plan hash before review.
Research/model artifacts remain outside execution authority; only validated,
runtime-neutral decision evidence may influence planning.

### 4. Review before approval

Present compact Markdown tables, not raw JSON. At minimum review:

| Review surface | Required evidence                                                        |
| -------------- | ------------------------------------------------------------------------ |
| Inputs         | `asOf`, freshness, provenance, evidence hashes and quality status        |
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

Any relevant change to snapshots, validated evidence references or hashes,
policies, constraints, desired/current diff or normalized orders creates a new
canonical plan hash and invalidates the approval.

### 6. Execute the approved diff

Execution is allowed only in the approved environment.

1. Reacquire the account lock and revalidate approval, evidence and account
   freshness, including evidence provenance, input identity and integrity.
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
2. input freshness, quality, evidence identities and canonical hashes;
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
- stale, incompatible, malformed or integrity-invalid decision evidence;
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
