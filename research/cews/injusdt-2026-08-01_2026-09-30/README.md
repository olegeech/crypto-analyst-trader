# INJUSDT CEWS — August–September 2026 public candle archive

This directory contains **public Bybit-plugin-transformed historical OHLCV**, not raw exchange HTTP responses, confidential/account data, trade records, or a released warning model. It supports the [pre-registered #115 comparison](https://github.com/olegeech/crypto-analyst-trader/issues/115#issuecomment-6652544182) and the [observed research results](https://github.com/olegeech/crypto-analyst-trader/issues/115#issuecomment-6652670148). The original 33-day #154 study remains a separate retained ZIP, **not included here**.

## Captured source, scope and caveats

- Instrument: **INJUSDT**, Bybit `linear` USDT perpetual. Frozen UTC research window **[2026-08-01T00:00:00Z, 2026-10-01T00:00:00Z)**.
- Eight `1h-page-N.json` files preserve **eight public connector responses**, each with 200 candles, exact plugin query arguments, source metadata and retrieval timestamp. Pages were reacquired **2026-11-05 09:58–09:59 UTC** specifically for versioned repository retention. Some returned rows precede August; replay excludes them, rather than silently changing the fixed cohort.
- 1,600 returned 1h rows; **1,464** closed UTC-hour candles admitted (61 days); **136** pre-window rows excluded; **zero interior gaps, duplicate timestamps or invalid OHLCV**. No account, credential, order or private API data is present.
- **Partial native 4h evidence is retained:** `4h-page-1.json` contains **200 genuine connector-transformed 4h candles** from **2026-08-28 16:00 to 2026-09-30 20:00 UTC**. The second requested 4h page was blocked by Bybit `retCode=10006` (rate limit), so **166 earlier native 4h rows are not archived**. Independent readback compared this retained native page against its constituent archived hourly candles: **200/200 OHLC matched, 0 mismatches**. The offline full-window checker deliberately constructs all **366 complete 4h OHLCV bars** from the 1h archive, marked `derived-from-archived-1h`; it must **not** claim all 366 are independently sourced native 4h. An earlier nonarchived analysis had 366/366 native/derived matches, but its complete native 4h data cannot be replayed from this PR.
- These candles were obtained retrospectively: **point-in-time publication latency and contemporaneous historical availability are not proven**. The earlier interval predates #154 development. This is a **reverse-time historical replication**, not a newer chronological untouched holdout. No predictive edge or production CEWS usefulness is claimed.
- The experiment used the **frozen k=2 event threshold** over the next 24h, Wilder ATR(14) on completed 4h candles, and unchanged six deterministic warning rules. 1× and 3× are sensitivity only.

## Replay (Python standard library, no network)

From the repository root:

```bash
python3 scripts/research/cews_inj_external_replication.py \
  --source-dir research/cews/injusdt-2026-08-01_2026-09-30 \
  --start 2026-08-01T00:00:00Z \
  --end 2026-10-01T00:00:00Z \
  --pages-1h 8 --pages-4h 0 --replay
```

The command never calls any API. It validates timestamps, OHLCV constraints, cross-bar continuity, computes derived 4h candles, decimal Wilder ATR and forward 24h labels, and writes an **ignored** `offline-replay-result.json` containing the six confusion matrices, coverage and SHA-256 hashes of each retained response file. The `--fetch` mode is separately available for limited **public HTTP GET** collection, but is **not needed for offline replay** and may encounter region restrictions or rate limits.

## Expected checks

| Item | Expected |
| --- | ---: |
| Retained raw 1h pages | 8 × 200 rows |
| Valid 1h rows in frozen interval | **1,464** |
| Derived full 4h bars | **366** |
| Retained native 4h spot-check | **200 OHLC matches / 200 retained** |
| Excluded for ATR warm-up / absent full 24h forward horizon | **14 / 6** |
| 4h-spaced eligible decision cutoffs | **346** |
| Positive cutoffs at primary 2×ATR | **50 (14.45%)** |
| UTC 04:00 daily, nonoverlapping decision cutoffs | **57** |
| Positive daily cutoffs | **9 (15.79%)** |
| `last TR > ATR` at all cutoffs: TP / FP / FN / TN | **21 / 118 / 29 / 178** |
| `last TR > ATR` at daily 04:00: TP / FP / FN / TN | **6 / 24 / 3 / 24** |

These expected values were recomputed from the **GitHub-committed eight public source pages** by a separate in-memory Decimal18/BigInt audit on 2026-11-05 and matched the earlier research note. The **Python script's derived-4h path** was tested on the original #154 ZIP (179 cutoffs/35 events; 20 TP/49 FP/15 FN/95 TN) and matched its native-4h path. A Python offline execution **against this newly retained 61-day archive** still needs to be confirmed by checkout/CI; do not confuse independent in-memory recomputation with a completed Python replay of these eight committed files.

## Result / promotion boundary

The fixed `TR > ATR` rule's precision was **15.11%** on overlapping cutoffs vs **14.45%** base incidence, with **84.89%** of warnings false. At daily nonoverlapping cutoffs it was **20.0%** vs **15.79%** incidence, on only **nine** positives. **Insufficient to claim predictive advantage.**

#154 remains closed; #115 holds this follow-up and #155 does **not** start automatically. No M1/strategy/approval/HALT/accounting/trading source or behavior changes are in scope.
