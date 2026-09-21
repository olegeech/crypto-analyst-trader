# System Invariants

These rules are the current normative safety set across modules and should stay
short enough to read for every trading-related change. ADRs preserve the
rationale and decision history.

1. Stale, incomplete, mixed-run or contradictory state never authorizes new
   exposure.
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
13. HALT blocks new entries until explicitly cleared after reconciliation.
14. CI and default local tests cannot reach an exchange write endpoint.
15. Mainnet always requires explicit configuration and cannot be the default.
16. Preparation and execution remain separate; preparation or scheduling cannot
    implicitly trigger a mainnet write.
17. External exchange, file and process payloads are untrusted until runtime
    validation succeeds; unchecked casts do not establish domain validity.
18. Evidence that can affect a live-ready plan is versioned, attributable,
    freshness-aware and canonically hashed; incompatible or stale evidence
    cannot silently authorize exposure.
19. Research and ML produce decision evidence only. Exchange-valid order intents
    remain the responsibility of the TypeScript planner and cannot bypass risk
    or immutable approval.
