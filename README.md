# Crypto Analyst Trader

Private TypeScript system for risk-gated daily trading with direct exchange
execution. The first adapter targets Bybit USDT linear perpetuals.

The product objective is to improve net risk-adjusted return after fees, funding
and slippage while enforcing explicit exposure and drawdown limits. It does not
promise profit.

## Product boundary

The initial product is a daily batch trader, not a continuously running strategy
engine:

```text
refresh evidence
  -> build deterministic order plan
  -> run data, cost and risk gates
  -> review exact desired/current diff
  -> approve the immutable plan hash
  -> cancel stale owned entries
  -> place desired entries with exchange-attached exits
  -> reconcile through bounded REST polling
  -> persist fills, costs and daily PnL
```

MVP scope:

- Bybit Unified Trading Account, USDT linear perpetuals;
- one-way position mode;
- one strategy per account, symbol and side;
- GTC limit entries on a static daily grid;
- one attached take-profit and one catastrophic stop per entry;
- REST-only execution during a bounded daily run;
- manual approval of every exact live plan;
- SQLite as the durable execution and accounting journal.

Explicitly out of scope for the MVP:

- intraday grid replenishment or recentering;
- trailing or dynamically recalculated exits;
- multiple take-profit legs per entry;
- unattended mainnet execution;
- latency-sensitive or tick-driven strategies;
- a second exchange adapter.

## Architecture

The repository is a modular monolith with pure domain modules and adapter
boundaries:

```text
CLI / scheduler
      |
application use cases
prepare -> approve -> execute -> reconcile -> report
      |
domain
analytics | planning | risk | execution | accounting
      |
ports
market data | account state | trade execution | ledger | clock | alerts
      |
adapters
Bybit V5 REST | SQLite | files / console
```

Start with:

- [System design](docs/architecture/system-design.md)
- [Safety invariants](docs/architecture/invariants.md)
- [Product principles](docs/product-principles.md)
- [Release gates](docs/roadmap.md)
- [Development workflow](docs/workflow.md)
- [Architecture decisions](docs/adr/README.md)

GitHub Issues are the canonical active backlog. Closed issues and merged pull
requests are the history; this repository intentionally has no duplicated
markdown backlog archive.

## Development

Requirements:

- Node.js 22+
- npm 10+

```bash
npm ci
npm run test:release
```

No CI job or unit test may use exchange credentials or submit exchange writes.
Testnet smoke tests must be explicit, opt-in commands with separate credentials.

## Safety

Read [SECURITY.md](SECURITY.md) before configuring an exchange account. API keys
must not have withdrawal permission. Mainnet execution remains unavailable
until the production-canary release gate is deliberately completed.
