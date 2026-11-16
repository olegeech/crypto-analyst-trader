# M1 daily grid research

The universe comes from the archived discovery snapshot. The replay period is
2024-11-16 through 2026-11-15 UTC, with the last six months held out. Later
listings enter after their indicator warm-up.

```sh
python3 scripts/research/m1_grid_backtest.py --fetch research/m1-grid/2026-11-16
python3 scripts/research/m1_grid_backtest.py --replay research/m1-grid/2026-11-16
```

The replay uses hourly candles and last settled funding. The discovery list
applies current turnover leaders to history. Stock and metal perpetuals
(SOXLUSDT, NVDAUSDT, XAUUSDT and XAGUSDT) remain in the sample. The signal
excludes liquidations and applies research quorums across three groups.
Production v1 accepts four symbols.

The execution model uses hourly fills, last-traded prices for funding, and the
previous hourly close as the anchor. It uses unrounded quantities and prices
and omits venue bounds. Historical evidence is not a profit guarantee.
