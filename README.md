# Crypto Analyst Trader

Private TypeScript system for risk-gated daily trading with direct exchange
execution. The first adapter targets Bybit USDT linear perpetuals. Product
decisions follow the [product principles](docs/product-principles.md); profit is
an objective, not a guarantee.

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

The repository is a modular monolith with pure domain modules, narrow ports and
Bybit V5 REST and SQLite adapters. The current component model, lifecycle and
execution sequence live in the system design rather than being repeated here.

Start with:

- [System design](docs/architecture/system-design.md)
- [Safety invariants](docs/architecture/invariants.md)
- [Market regime research context](docs/analytics/market-regime-context.md)
- [Product principles](docs/product-principles.md)
- [Daily operator runbook](docs/operator-runbook.md)
- [Development workflow](docs/workflow.md)
- [Architecture decisions](docs/adr/README.md)
- [Release milestones](https://github.com/olegeech/crypto-analyst-trader/milestones)
- [Active milestone queue](https://github.com/olegeech/crypto-analyst-trader/issues/33)

[GitHub Issues](https://github.com/olegeech/crypto-analyst-trader/issues) are the
canonical active backlog. Closed issues and merged pull requests are the
history; this repository intentionally has no duplicated Markdown backlog or
roadmap.

## Development

Requirements:

- Node.js 22+
- npm 10+

```bash
npm ci
npm run test:release
```

See [Contributing](CONTRIBUTING.md) and the
[system invariants](docs/architecture/invariants.md) for verification and
credential boundaries.

Repository-native skills:

- `$daily-rebalance`: run the released daily operator path;
- `$test-current-feature-pr`: validate an exact pull request without mainnet
  writes;
- `$develop-next-roadmap-story`: select and deliver the next ready roadmap
  item.

## Safety

Credential and incident rules live in [SECURITY.md](SECURITY.md). Mainnet is
disabled by default; [issue #31](https://github.com/olegeech/crypto-analyst-trader/issues/31)
owns its manually approved, small-capital canary enablement.
