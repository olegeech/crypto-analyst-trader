# INJUSDT CEWS research archive (August–September 2026)

This directory contains public, connector-transformed Bybit OHLCV data.
It contains no exchange credentials, account data, orders or trading state.

The experiment and fixed rules are documented in Issue #115. Issue #154
remains closed; the candidate model in #155 has not been started.

## Source and coverage

- Instrument: `INJUSDT`, Bybit `linear` USDT perpetual.
- Fixed UTC window: `[2026-08-01, 2026-10-01)` (61 days).
- Eight `1h-page-N.json` files: 200 public candles each.
- Reacquired on 2026-11-05 with exact query and capture timestamps.
- Admitted hours: 1,464. Out-of-window rows: 136.
- Gaps, duplicates and invalid OHLCV in the window: zero.
- One `4h-page-1.json` also survives: 200 native 4h candles.
- Those 200 native 4h OHLC match the archived hourly aggregates.
- A second native 4h request hit Bybit rate limit `10006`.
- The full-period replay derives all 366 complete 4h bars from 1h.

Native 4h source coverage is **partial**; a derived bar is not a native
exchange response. The earlier unarchived 366/366 native comparison
does not establish complete native-source replay from these files.

## Offline replay

From the repository root (Python standard library; **no network**):

```bash
python3 scripts/research/cews_inj_external_replication.py \
  --source-dir research/cews/injusdt-2026-08-01_2026-09-30 \
  --start 2026-08-01T00:00:00Z \
  --end 2026-10-01T00:00:00Z \
  --pages-1h 8 --pages-4h 0 --replay
```

The output `offline-replay-result.json` is gitignored. It reports
coverage, input SHA-256 digests and confusion matrices for six fixed
rules, using the frozen primary adverse-LONG event threshold 2×ATR.

Expected results from independent GitHub-data readback:

- 346 eligible 4h decision cutoffs; 50 positive 2×ATR events.
- 57 nonoverlapping UTC 04:00 cutoffs; 9 positive events.
- `TR > ATR`: TP/FP/FN/TN = 21/118/29/178 (all cutoffs).
- `TR > ATR`: TP/FP/FN/TN = 6/24/3/24 (daily cutoffs).

The derived-4h Python path was tested on the original #154 ZIP.
The newly committed 61-day files were independently recalculated
in memory, but Python replay from a new checkout awaits CI/review.

## Interpretation and boundaries

The current rule has not shown a stable predictive advantage.
The 61-day dataset predates the Oct–Nov development period: it is
a reverse-time comparison, **not a newer chronological holdout**.

Responses were transformed by a public Bybit connector; they are
not byte-preserved raw exchange HTTP responses. Historical point-in-time
publication availability and predictive calibration are unverified.
No M1 behavior, approval policy or trading authority changes here.
