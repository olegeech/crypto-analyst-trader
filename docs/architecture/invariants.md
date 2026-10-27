# System Invariants

These rules are the current normative safety set across modules and should stay
short enough to read for every trading-related change. ADRs preserve the
rationale and decision history.

1. Stale, incomplete, mixed-run or contradictory state never authorizes new
   exposure. The only manual-evidence exception is the bounded, source-bound
   recovery in invariant 18; relevant facts that are uninspected, unclear or
   contradictory remain `UNKNOWN` and block.
2. An exchange write requires an approved, unexpired exact plan hash. The
   bounded Testnet and Demo capability probes treat explicit invocation as
   their run-scoped authorization, while still hashing and revalidating every
   exact write plan before dispatch.
3. A strategy exclusively owns `account + symbol + side` in the MVP.
4. Only orders with durable local ownership and matching exchange identity may
   be changed or cancelled.
5. A managed entry requires at least one exchange-native take-profit in the
   same exchange request; a catastrophic stop-loss is optional and is never
   injected by the generic execution path.
6. Protective exits are never included in routine entry cancellation.
7. An asynchronous acknowledgement is pending, not success.
8. An ambiguous timeout is reconciled before retry.
9. Every intended write is durably recorded before submission.
10. Price, quantity, money and fees use exact decimal representations and
    explicit exchange-rule rounding for authoritative calculations.
11. Immutable plan and evidence identity uses versioned canonical serialization
    before hashing; equivalent logical inputs cannot depend on runtime-specific
    JSON behavior.
12. Net performance includes fees, funding and slippage; transfers are not
    profit.
13. HALT blocks new entries until an explicit, source-bound recovery resolves
    an eligible incident. Recovery may use fresh API reconciliation or the
    bounded manual-attestation path in invariant 18; it never clears a HALT
    automatically. HALT-free pending cleanup creates no fictitious clearance,
    and unrelated, newer or uncorrelated incidents remain blocking. A status
    answer about manual action is provenance only; it grants no recovery or
    entry authority.
14. CI and default local tests cannot reach an exchange write endpoint.
15. Mainnet always requires explicit configuration and cannot be the default.
16. Preparation and execution remain separate; preparation or scheduling cannot
    implicitly trigger a mainnet write.
17. External exchange, file and process payloads are untrusted until runtime
    validation succeeds; unchecked casts do not establish domain validity.
18. Evidence that can affect a live-ready plan is versioned, attributable,
    freshness-aware and canonically hashed; incompatible or stale evidence
    cannot silently authorize exposure. For one supervised Mainnet operator,
    bounded manual-attestation recovery may supply only named unavailable or
    inconclusive prior-source reconciliation facts and current-target position
    and open-order facts. The attestation is validated, redacted provenance
    marked `MANUAL_ATTESTED_NOT_API_VERIFIED`; it never changes API outcomes or
    claims `verified-clean` or `TP_LIFECYCLE_PASS`. It binds the dedicated
    account and environment, prior source and owned identities, inspected
    orders, fills, position and take-profit, observation time, actions and
    accepted uncertainty. The Bybit inspection covers all currently open
    orders and positions on that dedicated account; any relevant uninspected
    or unclear scope is `UNKNOWN`, not zero. All other mandatory machine gates
    remain in force, including account identity and permissions, available
    balance/margin and fee-inclusive capacity, instrument, quote and fee
    validity, capital cap, exact-plan consent, ownership and attached
    take-profit. A separate explicit recovery authorization binds an eligible
    account-scoped HALT/source revision to one saved exact upcoming plan; its grant is
    single-use, cannot be reminted from the same attestation, and expires no
    later than five minutes after UI observation or the plan expiry. A newer
    source or HALT revision, known contradiction,
    wrong identity or unrelated incident invalidates or blocks it. A latest,
    source-attributed API status reconciliation with `verified-clean` releases
    the pending-source gate independently of any unused or expired grant.
    `UNKNOWN`, pending, missing or manual-attestation-only evidence remains
    blocking. An expired grant never authorizes CREATE, and an active HALT
    remains a separate gate. If API cleanup is not verified, the source remains
    blocking until the same eligible grant is atomically consumed with its
    bound durable intent. Recovery does not authorize unattended execution or
    a later plan.
19. Research and ML produce decision evidence only. Exchange-valid order intents
    remain the responsibility of the TypeScript planner and cannot bypass risk
    or immutable approval.
