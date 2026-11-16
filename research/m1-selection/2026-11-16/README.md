# M1 instrument selection with shared capital

The snapshot freezes the universe and slot order. The universe file records
exclusions and the fixed periods. Set A covers 2022-11-16 to 2024-11-16.
Set B covers 2024-11-16 to 2026-11-16 on other instruments. The reference
uses the same period as set B and reads the archive from #163.

Run from the repository root.

```sh
python3 scripts/research/m1_grid_backtest.py --replay research/m1-selection/2026-11-16
```

The replay evaluates three and five shared slots against four fixed M1
allocations. It reruns each verdict set without its best three-slot
contributor, using the original baseline for comparison.
