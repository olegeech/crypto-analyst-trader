# Daily Rebalance Operator Runbook

## Purpose

This runbook documents the bounded daily operator workflow and related
environment-scoped capability checks. The target lifecycle is:

```text
prepare -> review -> approve -> execute -> reconcile -> report
```

The released #19 daily CLI path is `prepare -> review -> approve` and ends at
decision-only consent; it does not execute. Execution, reconciliation and
reporting are separate target use cases unless a command is released by its
own issue. Testnet/Demo capability probes are separate opt-in flows, not stages
in the forward release path.

It applies to direct Bybit execution. Product boundaries live in `README.md`,
and mandatory safety rules live in `docs/architecture/invariants.md`. If this
runbook conflicts with an invariant, the invariant wins.

## Released daily prepare, review and consent (issue #19)

This M1 path ends at decision-only consent, **not execution**. Explicit prepare
performs bounded public Bybit mainnet and Coinalyze reads, then selected-environment
authenticated account/risk GETs. It never trades. Configure credentials in Keychain
before an operator-authorized live run; these commands are absent from default CI.

```bash
npm run daily:prepare -- --environment mainnet --symbol BTCUSDT --allocation 100
npm run daily:review -- --environment mainnet --prepared-hash sha256:<exact-64-hex>
npm run daily:approve -- --environment mainnet --prepared-hash sha256:<exact-64-hex>
```

Substitute the exact `PREPARED_HASH`, not a filename or latest alias. Private
canonical artifacts use the existing environment SQLite database with authenticated
hashed account scope; no default report file is created. Review/approve work offline
after restart, reproduce the saved snapshot, and never recollect or reprice. No
`--daily-plan`, `--composition`, `--actor`, policy/time override or automatic yes
option exists. Actor is derived from the local OS identity; approval needs a terminal
and explicit `yes`. An ordinary note is optional; an actual REVIEW requires a
nonblank note (prompt or `--note`). A BLOCKED artifact cannot be approved or
overridden by consent.

The fixed `provisional-m1-v1` policy requires native returns, funding, OI,
liquidation imbalance and ATR. External Regime/CEWS/LSI/Trap absence and provisional
policy are visible informational metadata, not REVIEW triggers. Real non-blocking
quality degradation or exceptional warnings produce REVIEW. Missing required native
data fails closed. Under #122, an omitted Coinalyze bucket is a provider-implied zero
only for a present symbol after a valid history response and complete catalogue proof;
missing symbols, incomplete coverage, or invalid/partial responses remain unresolved.
The `daily:prepare` summary keeps global `coverageProof`/`historyProof` separate and
lists each required liquidation request's asset, window, observed/expected
constituent-bucket counts, completeness and missing counts by venue (up to 20
sorted venues, plus omitted-group/missing totals). Counts are `null` when the
source or catalogue coverage is not proven; these diagnostics do not change the
quality verdict.

ADD requires a flat target with no active target orders; other account state is
evaluated by risk. HOLD is no action, and REDUCE is a declarative quantity-only
proposal/no-op, not execution authority. Review shows normalized Limit/GTC grid/TP,
quality, target comparison, aggregate capacity/economics, policy identities and
historical provider evaluation time. Consent expires 15 minutes after approval;
the exact expiry is expired. Neither consent nor TTL refreshes stale account facts
or creates authority for a future exchange write.

Exit codes: 0 success, 2 invalid input, 3 declined/noninteractive consent, 4 unavailable
provider/admission, 5 BLOCKED/invalid approval, 1 unexpected failure. Reasons are
shown separately. An upstream failure has no invented prepared/account hash; a
trustworthy account-bound risk BLOCK can be saved as a BLOCKED review artifact.

## Forward Mainnet validation path

The forward release evidence is deterministic and fault-injection/replay
verification followed by explicit read-only Mainnet readiness checks against
the isolated AI Subaccount. The first deliberately authorized Mainnet write is the bounded canary in
[issue #31](https://github.com/olegeech/crypto-analyst-trader/issues/31).
**For this one attended happy-path acceptance experiment, merge to `main`,
tagging, publication and deployment are NOT prerequisites.** An exact reviewed
PR-branch commit with passing same-SHA release checks and CI is eligible for
the test while the PR remains open. For this bounded #31 flow, successful
`mainnet:test prepare` performs the required read-only readiness assessment;
a separate `mainnet:preflight` invocation is optional diagnostics, not an
additional prerequisite. Every mandatory fresh runtime safety gate in
`execute` must still pass, and the operator must separately
approve the exact attended order. Record the actual exchange result and
reconciliation evidence to decide whether to merge or fix the PR. A green
build is not live trading authorization. Completion of #30's integrated
daily-strategy data gate is not a prerequisite for this one execution-contract
experiment; this exception does not establish daily-strategy readiness or waive
account, permission, capacity, ownership, position or HALT checks. The daily
execution paths retain their lease rules; the attended #31 flow uses no lease.

Testnet is not a release prerequisite. The bounded Testnet and Demo probes
below remain opt-in, environment-scoped capability checks; their observations
do not establish Mainnet readiness or grant Mainnet write authority. Preserve
each probe's exact-plan, isolation, ownership, bounded-action and reconciliation
rules.

### Mainnet adapter capability preflight (issue #20)

After the offline release suite is green, run the explicit read-only readiness
check against the isolated AI Subaccount:

```bash
npm run mainnet:preflight -- --symbol BTCUSDT
```

Only a configured M1 symbol is accepted. The command loads the Mainnet Keychain
credentials, collects fresh #16 account evidence, then performs one bounded
linear instrument GET and evaluates the sanitized #20 readiness contract. It
prints only the environment, symbol, READY/BLOCKED verdict, stable reason and
warning codes, unrelated coverage count, evidence age and measured request
counts. It never prints account hashes, raw UID/IP, balances, orders, headers,
credentials or provider payloads. `EXCHANGE_WRITES=0` is required; this command
has no exchange mutation path.

`CAPABILITY_STATUS=SUPPORTED` means the typed adapter surface exists; it does
not establish `LIVE_PROVEN` or authorize a Mainnet write. IP-unbound is a
warning; unsupported account/key posture, stale or incomplete required proof,
or an unsupported selected instrument blocks readiness. This preflight does
not evaluate account capacity or risk approval; those belong to #17. Issue #31
still owns the first deliberately authorized Mainnet write. This live command
is excluded from default tests, `test:release` and CI.

### Internal prepared execution boundaries (issues #21, #23 and #46)

Issues #21 and #46 add application-level boundaries for one exact approved
Mainnet leg and a bounded sequential approved grid. They release no operator
command, production authorization issuer or composition. The grid boundary
executes the exact approval in order under one lease and stops on a non-open,
filled, ambiguous or otherwise unproven result; it is not an operator workflow.
The test-only authority fixture is not part of any operator entry point.
`daily:approve` remains decision-only; a typed Mainnet writer in source is not
operator authority or `LIVE_PROVEN` evidence. Do not invoke or synthesize write
authority outside the #31-owned bounded canary. #31 remains the first
deliberately authorized Mainnet write from an exact reviewed, CI-green
#31 commit (including an unmerged PR branch), after fresh readiness checks
and applicable runtime safety gates pass. The #30
integrated daily-data release gate is not a prerequisite for this single
supervised execution-contract experiment. #21/#46 require no live write or
Testnet step.

Issue [#23](https://github.com/olegeech/crypto-analyst-trader/issues/23)
adds per-leg protection reconciliation to those internal boundaries. A new M1
entry carries `tpslMode=Partial`, Market TP and `tpTriggerBy=LastPrice`; the
one-way position is still shared across legs. After a fill, compare each
leg's deduplicated entry executions minus its attributed TP exit executions
with the remaining quantity of its active TP child, then reconcile the sum
against the fresh position. A trigger or order acknowledgement is not an exit
fill. Child proof requires a unique exchange order ID, raw
`parentOrderLinkId` equal to the approved entry link, `PartialTakeProfit`, the
approved trigger/side/type, consistent quantity/status and fresh provider
timestamps. A mapped parent-link alias, position-level TP or sibling leg does
not establish coverage. A fill stops the grid suffix even when coverage is
confirmed.

`VERIFIED_CLOSED` proves the leg has no outstanding filled exposure; its entry
may still have an unfilled remainder. Cancelling that remainder needs separate
exact authorization and fresh entry, exit, TP and position proof. With several
owned grid legs, the boundary verifies each leg independently and compares their
sum against the actual one-way position, retaining the sibling evidence in the
journal. Only the selected entry is cancelled; TP orders stay untouched.

If a filled leg has missing, stale, malformed, mismatched or ambiguous child
evidence, incomplete fill reads, or a position/coverage mismatch, the internal
boundary records `PROTECTION_PENDING` and `HALT`; it does not wait, repair,
retry the write or submit later entries. `PROTECTION_CONFIRMED` records current
evidence only and does not guarantee execution or clear a prior `HALT`. Keep
the original plan and local journal, capture sanitized reason codes and
timestamps, and reconcile the approved parent, entry fills, every uniquely
linked TP child, child exit fills and current one-way position. Do not cancel a
TP, infer a fill from a trigger, or adopt an order by its normalized alias.
For an unresolved Mainnet incident, follow the runtime containment steps in
`SECURITY.md` and the exchange-UI fallback owned by [issue
#25](https://github.com/olegeech/crypto-analyst-trader/issues/25); preserve
protective orders, act only on verified ownership, and reconcile again before
any explicit `HALT` clearance. These internal boundaries do not expose an
operator command or authorize a Mainnet write.

### Supervised Mainnet lifecycle check (issue #31 U3)

GET accounting reports `GET_COUNTS_PREFLIGHT`, `GET_COUNTS_PREPARE` and
`GET_COUNTS_EXECUTE` as endpoint-group counts per command invocation. Counts
include pagination and retries already attempted, including failed HTTP reads;
POSTs are excluded. No extra requests are made for measurement. Only fixed
group names and counts are emitted, without query strings or account data.
The operator path uses compact current evidence where it is sufficient; full
readiness collection remains a fallback. `PREPARE_COMPACT_FALLBACK_REASON`
identifies why preparation took that fallback, alongside `GET_COUNTS_PREPARE`.
These per-run diagnostics cannot establish the cause of a prior run that did
not record them. A 10–25 GET compact operator admission is an engineering
target, not measured performance.

Preparation checks the exact rounded order plus entry and exit fee reserves
against fresh account-wide available balance before saving a prepared plan.
Proven insufficiency stops early with available, required and shortfall amounts
when calculated. A zero balance stops before order/fee calculations and reports
only the known zero. Unknown, stale or ambiguous facts cannot establish affordability. Execution
still performs its own final fresh admission checks.

Admission diagnostics distinguish `QUOTE_OUTSIDE_APPROVED_RANGE`,
`QUOTE_EVIDENCE_INVALID`, `QUOTE_STALE_OR_FUTURE`,
`FEE_RATE_EVIDENCE_INVALID`, `ACCOUNT_EVIDENCE_INVALID` and
`EVIDENCE_TIME_INVALID`. Quote drift requires a fresh plan and new exact-plan
confirmation; never reprice an already approved order. A
`CRITICAL_STATE_CHANGED` report includes `CRITICAL_CHANGED_GROUPS` with group
names only, without account amounts or identifiers. These diagnostics do not
relax the existing checks. `EXECUTION_NOT_STARTED` means no durable intent was
created and no write was submitted; use GET-only diagnostics rather than
repeating `execute` or requesting `status` for a nonexistent source.

The attended CLI exposes three commands. **The first supervised #31 happy-path
test is intentionally allowed on the reviewed, same-SHA CI-green PR branch,
before any merge, to inform merge-versus-fix.** Preparation performs bounded
GET-only account/market checks, freezes the approved symbol, allocation, gross
entry notional cap and quote-deviation band, and saves the exact plan by hash:

```bash
npm run mainnet:test -- prepare --symbol BTCUSDT --allocation 10 --gross-cap 8 --max-deviation-bps 10
npm run mainnet:test -- execute --plan-hash sha256:<exact-64-hex>
# Copy the exact SOURCE_ID printed by prepare into this command.
npm run mainnet:test -- status --source-id "$SOURCE_ID"
```

Review the frozen entry Limit/GTC price, quantity, Partial Market LastPrice TP,
quote age, deviation range, allocation and gross cap before executing. The cap
limits gross entry notional only; it is not a cap on fees, slippage, funding or
total loss. Execute requires an interactive terminal and the exact lowercase
answer `yes` for one bounded CREATE attempt. Any durable intent or restart
routes to status recovery; execute will not resend it. After any attempt, run
`status` and follow the displayed next action. A successful CREATE response is
not a TP lifecycle pass.

This flow assumes one attending operator and one local process. CREATE and
status neither acquire an account lease nor trigger takeover HALT. A failed
read before intent leaves no operator lease to expire; a later attended run
can obtain fresh consent and data. Existing incident HALT still blocks entry.
After a possible submission or crash, inspect the exact client order ID,
orders, fills and position in Bybit UI, then use GET-only status. Do not resend
the same durable source or edit SQLite to bypass an incident.

If fresh admission fails before a durable intent exists, execute reports
`EXECUTION_STATE=EXECUTION_NOT_STARTED` only after a journal check and zero
exchange writes. Diagnose the printed fee-rate, quote, target-state or
validation reason with GET-only reads; there is no source for `status` yet.
Do not invoke execute to diagnose data collection. An existing intent, failed
journal read or uncertain write count retains `RECOVERY_ONLY` and the status
instruction.

Status uses bounded authenticated GET reads and appends the fresh evidence to
the local scoped journal. It never retries an exchange write, cancels an order,
closes a position or clears HALT. In an attended terminal it asks whether the
operator acted in Bybit UI since the prior check (`none`, `cancel`, `close` or
`other`). That answer is append-only provenance, not exchange proof. A manual
entry remainder cancellation can still reach TP pass after a later fresh proof;
a manual position close or mixed/manual exit remains `MANUAL_CLEANUP`.

`NOT_EXERCISED` means fresh evidence proves zero entry fills; an open GTC entry
still reports cleanup pending. `PARTIAL_EVIDENCE` means the lifecycle is
incomplete but the known evidence remains attributable. `TP_LIFECYCLE_PASS`
requires every entry fill to be closed by the exact TP child's execution fills,
with no open parent/child order and a flat position. `UNKNOWN` means fresh
proof is incomplete or contradictory and retains HALT. For pending cleanup,
manual cleanup or UNKNOWN, inspect the exact orders and position in Bybit UI,
perform any necessary action yourself, then rerun `status` to record fresh
exchange proof. Do not treat the manual declaration itself as proof or use it
to clear HALT.

### Manual-attestation recovery for an unavailable read (#25)

The bounded B path is a human-risk exception for the selected prior-source
reconciliation facts or current-target position/open-order facts that the
required read cannot establish. It is available only for one attended Mainnet
operator and one upcoming exact plan. `status` remains GET-only. Its answer to
whether you acted in Bybit since the prior check (`none`, `cancel`, `close` or
`other`) records your statement as provenance only; it does not attest that the
account is clean, authorize recovery or CREATE, or clear HALT.

Start with the exact source and account/environment shown by the local
operator record. In Bybit, select the dedicated Mainnet subaccount used by the
plan and confirm the account/environment before inspecting anything. If it
does not match, stop. Review
the source's owned parent and take-profit identities, order history, fills or
executions, current position and take-profit state. Also inspect the dedicated
account's **all currently open orders and all positions**, across symbols, not
only the old source or the proposed target. Check active filters and available
pages so a hidden or truncated list is not mistaken for empty state. Record
what you saw and when, any manual actions, and the remaining uncertainty. If a
relevant list, position, order identity or time is uninspected or unclear,
record it as `UNKNOWN`; do not attest a zero. A visible position or open order
means flat/no-open-order state has not been established, so stop and follow the
supported path for that exposure; this recovery does not authorize cancelling
or closing it.

Use the optional recovery-preparation flow to save the exact plan bound to the
typed UI facts. Preparation alone neither clears HALT nor grants CREATE. Then
review the saved account, source, owned identities, provenance, accepted
uncertainty, exact plan and expiry, and use the explicit `mainnet:test recover`
operation to authorize B. Recovery is a separate no-exchange-write action. It
binds the account-scoped HALT origin/revision and source revision to API
resolution or this attestation. It may clear an eligible active incident HALT
only after explicit acceptance; when no HALT is active it records no fictitious
clearance. A different, newer or uncorrelated incident, wrong account/source,
stale observation, or known contradiction blocks recovery.

The attestation is valid for no more than five minutes from UI observation,
and its one-plan grant expires at the earlier of that limit or the saved plan's
expiry. The grant is single-use, and the same attestation cannot mint another
grant. A later source or HALT revision invalidates an unused grant. Until it is
atomically consumed with the bound new durable intent, the old source remains
pending and blocks every other plan. That transaction records the old source's
disposition as `human-attested`, leaves its API reconciliation rows unchanged,
and starts an independent status/cleanup obligation for the new source.
Exact-plan `execute` consent and all normal machine gates still
apply: account identity and permissions, available balance/margin and
fee-inclusive capacity, instrument, quote and fees, capital cap, ownership,
attached take-profit and fresh final revalidation. The manual facts cannot
waive machine account/permission/capacity/instrument/quote/fee checks or replace
exact-plan approval, ownership checks, attached take-profit and final
revalidation of the new intent. Do not fabricate a successful API bundle. An
earlier historical fill/order that predates a later attested cleanup is not by
itself a contradiction; a reliable API fact observed at or after that cleanup
that conflicts with the attestation blocks B. If source ownership or event
ordering is unclear, stop.

For manual preparation, create a private local JSON file with the fields below.
The empty account arrays are valid only when the dedicated account UI actually
shows no open orders and no positions; include every observed source order,
fill, TP order and position. The source entry must include the exact owned
client order ID. Replace every example value with what the UI shows; never put
screenshots, credentials or API secrets in this file.

```json
{
  "observedAt": "<UTC time when the operator finished inspecting the Bybit UI>",
  "inspection": {
    "accountOpenOrdersInspected": true,
    "accountOpenOrders": [],
    "accountPositionsInspected": true,
    "accountPositions": [],
    "sourceOrderHistoryInspected": true,
    "sourceOrders": [
      {
        "orderId": "<Bybit parent order ID>",
        "clientOrderId": "<exact owned client order ID>",
        "symbol": "DOGEUSDT",
        "side": "Buy",
        "orderType": "Limit",
        "quantity": "<observed quantity>",
        "price": "<observed limit price>",
        "status": "<observed terminal status>"
      }
    ],
    "sourceFillsInspected": true,
    "sourceFills": [],
    "sourcePositionInspected": true,
    "sourcePosition": null,
    "targetLeverage": "1",
    "sourceTakeProfitInspected": true,
    "sourceTakeProfitOrders": []
  },
  "manualActions": ["none"],
  "acceptedUncertainty": ["manual-ui-may-be-stale"]
}
```

`observedAt` is required and must be the actual time the UI inspection was
completed; do not use the time the JSON file is read or saved. The application
records the separate local persistence time automatically. Preparation compares
the UI observation with Bybit server time and rejects future or more than
five-minute-old observations.

`sourcePosition` is `null` only when the UI shows none; otherwise record the
observed `{ "symbol", "side", "quantity" }`. Add every observed fill as
`{ "executionId", "orderId", "clientOrderId" (when shown), "symbol",
"side", "quantity", "price", "executedAt" }`. Add each source or TP order
using its visible IDs, symbol, side, type (`Market`, `Limit` or `Other`),
quantity, optional price and status. An active account order/position, a
nonterminal source/TP order, a leverage other than `1`, or any uninspected
section blocks this recovery.

Run preparation and recovery from an attended terminal, using the exact source
and plan hashes printed by the application:

```sh
npm run mainnet:test -- prepare --symbol DOGEUSDT --allocation 10 --gross-cap 10 --max-deviation-bps 10 --recovery-source-id <SOURCE_ID> --recovery-inspection-file /private/path/inspection.json
npm run mainnet:test -- recover --source-id <SOURCE_ID> --plan-hash <PLAN_HASH> --resolution manual
npm run mainnet:test -- execute --plan-hash <PLAN_HASH>
```

`recover` previews the source, HALT revision, provenance, exact next plan and
expiry, then requires typing lowercase `yes`. It performs no exchange reads or
writes. `execute` asks for a separate exact-plan approval and still performs
the normal fresh machine admission. For API recovery, use `--resolution api`;
it accepts only the latest `verified-clean` status result.

Persist only the typed, versioned, redacted provenance in the private journal.
Do not save or export screenshots, credentials, account identifiers or raw
account responses in the repository, issues, PRs or public logs. Do not edit
SQLite or report the attestation as `verified-clean` or `TP_LIFECYCLE_PASS`.
If recovery is declined, expires or becomes invalid, the old source stays
unresolved and no CREATE is authorized; follow the printed safe next action.
Once the new intent is durable, the grant is spent even if dispatch fails.
Inspect the exact client order ID and exchange state in Bybit, then use
GET-only `status`; never run `execute` again for that source. A subsequent
trade needs normal fresh admission or a new explicit B recovery.

The command output is a sanitized, machine-readable evidence record. Keep the
reviewed build HEAD (`git rev-parse HEAD`) with the plan schema/hash, policy
version and identity hash, approval and payload hashes, per-invocation GET and
POST counts, lifecycle/cleanup result, known entry/exit/position quantities,
reason codes and uncertainty field. Status is GET-only and always reports zero
exchange POSTs. The scoped artifacts and append-only journal stay in the existing
private Mainnet SQLite database; do not copy account identifiers, credentials,
raw provider responses or private account snapshots into PRs or public logs.
No live outcome exists until a separately authorized attended run has been
performed and reconciled; offline tests and this code PR do not complete AC7.

Exit codes: 0 means preparation succeeded or status is verified clean (including
`NOT_EXERCISED`); 2 means invalid input, 3 means execution was declined or the
terminal was unattended, 4 means preparation/admission was blocked, and 5
means status/reconciliation is needed or the exchange outcome is unresolved.

## Bybit public market evidence smoke (issue #11)

The public market-evidence boundary uses unsigned Bybit mainnet REST reads and
does not load Demo, Testnet or private-account credentials. Run this check only
after the offline release suite is green:

```text
npm run test:bybit:public
```

The command is intentionally opt-in and is excluded from default tests,
`npm run test:release` and CI. It is pinned to `https://api.bybit.com`, uses
bounded GET-only reads for the versioned M1 universe
(`BTCUSDT`, `ETHUSDT`, `SOLUSDT`, `DOGEUSDT`), and emits only status, counts and
a canonical hash. It never prints credentials, private-account data or raw
provider payloads and does not create a local raw-payload artifact. An
`incomplete` or failed collection is evidence that the public boundary could
not prove the required bundle; it is not a clean market snapshot and must not
be passed to planning.

## Coinalyze liquidation evidence smoke (issue #45)

After the offline release suite passes and the provider key is configured in
Keychain as described in `docs/credentials.md`, run this explicit read-only
characterization:

```text
npm run coinalyze:liquidation:smoke -- --live
```

The command reads the full documented Coinalyze future-market catalogue and
requests at most one deterministically selected perpetual per configured asset
for a bounded recent 24-hour history window. It uses the local clock only to
bound this adapter probe; it does not create a planner cutoff, run identity,
canonical hash, or standalone evidence bundle. `status=observed` means the
catalogue and sampled history responses were structurally valid for BTC, ETH,
SOL and DOGE; it does **not** prove history completeness for all eligible
markets.

The sanitized output includes eligible/sample/observation counts,
`explicitZeroBuckets` (returned provider rows where both long and short are
zero) and `omittedBuckets` (expected sample hours with no returned row). The
sampled script reports source rows only; it does not materialize canonical
evidence or infer complete catalogue coverage. Coinalyze support confirmed on
2026-10-09 that an omitted hourly interval means no liquidation. The full
collector below applies that provider-specific meaning only after complete
catalogue proof and all history-response integrity checks, recording each
reconstructed row as `provider-implied-zero` in liquidation-evidence/v2. The
characterization command emits no symbols, raw payloads, API key,
account/execution data, report file, or persisted planner evidence, and is
excluded from default tests, `test:release`, and CI.

## Legacy full-universe Coinalyze diagnostic (issue #45)

After the offline release suite passes and the Coinalyze key is configured in
Keychain, run the full read-only collector path:

```text
npm run coinalyze:liquidation:full-smoke -- --live
```

This compatibility diagnostic first collects a complete, exchange-cutoff
Bybit public #11 `MarketEvidenceBundle`, then collects all eligible BTC, ETH,
SOL and DOGE perpetual histories and writes a v2 artifact. Its output mode is
`legacy-full-diagnostic`; it does **not** verify the v3 decision-scoped path.
The client batches history requests at no more than 20 symbols each. Output
includes status, independent proofs, provider-explicit (including explicit
0/0), provider-implied-zero and unresolved bucket counts, and the canonical
bundle hash. `constituentsWithProviderRows` means at least one provider-explicit
row; `constituentsWithResolvedGrid` includes reconstructed zeros. It prints no
symbols, raw responses, credentials or run identity, and persists no planning
evidence.

Use it only to inspect the historical four-asset v2 diagnostic path. A
complete result must not be presented as proof of v3 selected-asset coverage.

## Decision-scoped Coinalyze v3 verification (issue #126)

After offline release checks pass, this explicit live-only diagnostic verifies
the new production-shaped v3 collector using a fixed BTC M1 composition:

```text
npm run coinalyze:liquidation:decision-smoke -- --live
```

It collects public exchange-cutoff #11 market evidence, derives BTC from the
trusted `BTCUSDT` M1 composition (no asset/policy CLI override), validates the
full Coinalyze catalogue, and requests history only for every eligible BTC
perpetual. Output includes v3/policy identity, selected and excluded counts,
independent proof states, catalogue/selected-set/canonical hashes, explicit
0/0, all explicit, implied-zero and unresolved bucket counts, and bounded
request metrics. Symbols, raw payloads, API keys, account data and write
authority are not emitted or used. This smoke requires no Bybit account
credentials; released `daily:prepare` additionally traverses authenticated
#16 account reads and uses the asset derived from its selected M1 symbol.

Only a `complete` result proves this fixed BTC collector path for that live
run. The script is excluded from default tests, release checks and CI; use
fixtures for the other supported assets and failure scenarios.

## Bybit portfolio-risk preflight smoke (issue #17)

This adapter integration diagnostic is not the normal daily operator entry point;
use the released `daily:prepare` command above for application-owned composition.
This explicit live smoke collects a fresh #16 account-evidence bundle, then
runs the #17 read-only portfolio-risk boundary against a supplied #15 daily
plan. It does not approve or execute the plan. It is excluded from default
tests, release checks and CI.

```bash
npm run smoke:bybit:portfolio-risk -- --live \
  --environment mainnet \
  --run-id risk-smoke-2026-10-04 \
  --daily-plan /path/to/daily-plan.json \
  --composition /path/to/trusted-risk-composition.mjs
```

The composition module must be trusted application code with a default export
containing exactly `policy`, `qualityProfile` and an application-owned
`qualityBoundary` created from the configured #13 admission policy. The quality
profile and boundary must match the #13 configuration that produced the plan's
assessment; #17 re-assesses the plan inputs so serialized issuer/admission
claims alone cannot establish trust. The CLI does not ship or choose a fallback
profile, boundary or policy. Never use an arbitrary JSON profile/policy as
trusted configuration. The plan file is parsed as data and must contain a
valid canonical `DailyDecisionPlan`.

The command uses only the selected environment's existing macOS Keychain
credentials and the allowlisted #16/#17 Bybit GET readers. It collects the
four versioned M1 symbols, does not persist the account bundle or report, and
prints only status, reason codes, counts, timing, environment and canonical
hashes. It never prints account identity, balances, positions/orders, raw
responses or credentials. Exit status is zero only for an evaluated `PASS`;
pre-auth failure, incomplete evidence, `BLOCK` or an unexpected failure exits
non-zero. `exchangeWrites` is always zero. Mainnet invocation is an operator
choice and is not run by CI. If a trusted application composition module is
not available, stop rather than substituting a test fixture or weakening the
profile/policy boundary.

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

## Managed Demo entry (issue #80)

The persistent managed-entry command is separate from both the adapter
verification and the historical capability probe:

```text
npm run trader:demo -- --symbol <SYMBOL> --side <buy|sell> --notional <DECIMAL> \
  --take-profit-percent <DECIMAL>
```

Use exactly one of `--take-profit-percent` or `--take-profit-price`; there is
no implicit take-profit. The command is fixed to the Bybit Demo origin and
dedicated Demo Keychain credentials. It rejects environment/origin selectors,
alternate credential namespaces, automatic cleanup flags and
`--time-in-force`. The managed entry is always `orderType=Limit` and
`timeInForce=GTC`, and those values appear in the review before the one
approval prompt.

Before account-scoped lease or execution authority is opened, the command
authenticates the key through `GET /v5/user/query-api`, proves the returned
Demo `userID` against the configured account identity, requires write-capable
`ContractTrade: Order` and `ContractTrade: Position` permissions, and rejects
Withdraw or wallet-transfer permissions. An empty IP-binding list is shown as
the warning `API_KEY_IP_UNBOUND`; it does not block Demo. Rotate or revoke a
Demo key through the Keychain setup/removal procedure when needed.

The selected symbol must be flat with no active selected-symbol order, and the
operator must use an exclusive writer for the account. The review shows the
normalized price, quantity, notional, take-profit, leverage diff, `Limit + GTC`,
plan hash and derived client identity. After approval those values are
immutable: authority, baseline, leverage, capability freshness, constraints
and approval expiry are reread before the first write, but ticker movement
alone never reprices or replans the approved limit.

The stable terminal verdicts are `CONFIRMED_FILLED`, `CONFIRMED_OPEN`,
`NOT_READY`, `DECLINED`, `HALTED` and `UNRESOLVED`. Shell exits are `0` for a
confirmed result, `1` for an unexpected/internal failure, `2` for invalid
input, `3` for decline or approval timeout, `4` for `NOT_READY`, and `5` for
`HALTED` or `UNRESOLVED`; the detailed stable reason code is separate.

An unexpired lease is never taken over: it returns `RUN_LEASE_HELD`. A valid
expired/stale takeover reconciles every prior lineage in the exact scope before
new planning. Pending, open or partial owned state keeps `HALT` active. A
filled entry clears `HALT` only when exact ownership, durable accounting and
exchange-proven TP attachment/protection establish `RECONCILED`; the expected
open position is then normal managed state, not unexplained residual exposure.
Missing, contradictory or ambiguous ownership/protection/accounting remains
`UNRESOLVED` and keeps `HALT` active. Never blind-retry an ambiguous create,
cancel an owned protection, flatten the position, or adopt a similar order.

Late exchange-order binding is one-time and exact. Recovery gathers bounded
realtime/history/execution evidence and binds only one internally consistent
candidate matching the original client ID, symbol, side, requested quantity
and ownership context. Zero candidates remain unresolved; multiple or
contradictory candidates raise conflict/HALT. Current capability authority is
fresh adapter evidence after restart; SQLite persists the plan and historical
evidence but never rehydrates execution authority.

The normal command prints sanitized terminal output and stores durable facts in
the private SQLite journal. It does not create a report file by default. Any
future explicit report mode must redact before writing and use restrictive file
permissions.

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

## Durable local journal and recovery boundary (#9)

The daily system uses one SQLite persistence facade per selected environment.
The default files are `data/private/execution/demo.db`,
`data/private/execution/testnet.db` and
`data/private/execution/mainnet.db`. The facade is local-only and stores
validated canonical artifacts, execution ownership, attempts, reconciliation,
accounting facts, checkpoints, leases and `HALT` state. It never loads
credentials or contacts Bybit.

The supported execution runtime is Node `>=22.22.3` with bundled SQLite
`>=3.51.3`. The journal requires foreign keys, WAL, full synchronous mode and
a bounded busy timeout. If runtime, schema, database identity or effective
SQLite settings fail validation, stop before granting execution authority.

Do not copy a live database. Close cleanly and checkpoint before a quiescent
copy. After a crash preserve the main database and its `-wal` file; `-shm` is a
reconstructible cache, not authoritative state. Keep all three environment
paths separate and never use a fallback database when the selected one is
missing or carries another environment identity.

Migration 005 is additive, but it advances the journal to schema version 5 for
late exchange-order identity bindings. Do not roll back the adapter binary and
point a schema-v5 journal at a v4 adapter: the older adapter must fail closed
when it sees a newer schema, and lowering the schema marker or deleting the
binding table manually is unsafe. For an incident, either forward-fix with a
v5-aware adapter while preserving the database and its `-wal`, or restore a
verified pre-migration backup before deploying the v4 adapter. On a copied
backup, verify the schema marker and that existing execution attempts remain
present before returning the journal to service.

Migration 008 is also additive and advances the journal to schema version 8
for supervised Mainnet test records. A v7 adapter must fail closed on this
database. Do not lower the marker or remove the operator-test tables manually.
Before any #31 source exists, a rollback can use a verified pre-migration v7
backup; after a source or exchange attempt exists, preserve the database and
its `-wal` file and use a v8-aware forward fix while reconciling any exchange
exposure. Restoring a v7 backup after that point would discard durable recovery
evidence.

Migration 009 removes the operator intent's lease columns and advances the
journal to v9. Historical v1 intent JSON and hashes remain unchanged; new v2
intents contain no lease fields. Use a v9-aware binary after migration; do not
lower the schema marker. General daily leases and incident HALT are unchanged.

The persistence port returns machine-readable recovery metadata that the
operator CLI will render. The safe default for every failure is no new
exposure:

| Failure category                        | Read                 | Append reconciliation | New writes/checkpoint | Safe next action                                           |
| --------------------------------------- | -------------------- | --------------------- | --------------------- | ---------------------------------------------------------- |
| Integrity, schema, runtime, environment | Stop or inspect only | No                    | No                    | Fix the local boundary or recover the database             |
| Lease held                              | Yes                  | No                    | No                    | Inspect the owner and wait for expiry/handoff              |
| Lease lost                              | Yes                  | Yes                   | No                    | Reconcile committed work, then reacquire authority         |
| Duplicate/conflict                      | Yes                  | Yes                   | No                    | Preserve the original and reconcile divergent evidence     |
| `HALT` or unresolved state              | Yes                  | Yes                   | No                    | Finish reconciliation and clear only with matched evidence |

The facade read model is evidence for recovery, not permission to bypass the
plan hash, approval, lease, ownership or reconciliation gates.

CLI names in this document describe application use cases. Invoke only commands
implemented by the current `package.json` and available for the selected
environment. For the single attended #31 acceptance experiment, an exact
reviewed PR-branch build with passing same-SHA tests/CI is sufficient: the
command need not have been merged, published or otherwise released. This
exception does not enable an unavailable daily execution mode. A missing
capability is `CAPABILITY_NOT_RELEASED`; do not replace it with an ad hoc API
call.

## Current execution scope

The released daily CLI supports prepare, review and decision-only approval; no
generic `daily:execute` command or `TESTNET_EXECUTE` / `MAINNET_EXECUTE` daily
mode is released. The Testnet and Demo probes documented below are separate,
opt-in capability checks. The first deliberately authorized Mainnet write is the bounded #31 canary
from its reviewed, CI-green exact commit, **even before merge/release**, after
fresh readiness and live-risk gates; this does not imply a general Mainnet
execution mode. No future mode may
override a `BLOCK` or `HALT`.

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
   For the attended #31 canary, the tested commit may be the open PR HEAD;
   do not demand a prior merge, tag or release.
4. Confirm no earlier run owns the account lock and no unresolved
   `PARTIAL`, `FAILED` or ambiguous execution remains.
5. Confirm credentials are available through the approved secret boundary
   without printing or copying them into artifacts.

Any uncertainty about environment, account, exact tested code or credentials
stops before private writes. An open #31 PR is not such an uncertainty by itself.

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
3. Build a static daily entry grid. Every managed entry has at least one
   exchange-attached take-profit; an optional stop-loss is included only when
   the explicitly approved strategy policy requires it. The collection of
   entries forms the plan-level exit ladder.
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
| Orders         | symbol, side, entry, quantity, notional, take-profit and optional stop   |
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
6. Submit desired entries with their attached take-profit and any explicitly
   approved optional stop.
7. Treat acknowledgements as pending and reconcile through bounded polling and
   history fallback.
8. Stop later exposure-increasing phases after any partial result.

Never blind-retry an ambiguous write and never imply transactional rollback
across independent exchange operations.

### 7. Reconcile and verify protection

Reconcile by durable client and exchange order identifiers. Confirm:

- intended, accepted, open, filled, cancelled and rejected quantities;
- every managed position has provable take-profit coverage and any optional
  strategy-required stop coverage;
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
