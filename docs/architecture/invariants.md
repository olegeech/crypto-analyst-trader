# System Invariants

These rules apply across modules and should stay short enough to read for every
trading-related change.

1. Stale, incomplete, mixed-run or contradictory state never authorizes new
   exposure.
2. An exchange write requires an approved, unexpired exact plan hash.
3. A strategy exclusively owns `account + symbol + side` in the MVP.
4. Only orders with durable local ownership and matching exchange identity may
   be changed or cancelled.
5. A managed entry requires an attached take-profit and catastrophic stop in
   the same exchange request.
6. Protective exits are never included in routine entry cancellation.
7. An asynchronous acknowledgement is pending, not success.
8. An ambiguous timeout is reconciled before retry.
9. Every intended write is durably recorded before submission.
10. Price, quantity, money and fees use exact decimal representations.
11. Net performance includes fees, funding and slippage; transfers are not
    profit.
12. HALT blocks new entries until explicitly cleared after reconciliation.
13. CI and default local tests cannot reach an exchange write endpoint.
14. Mainnet always requires explicit configuration and cannot be the default.
