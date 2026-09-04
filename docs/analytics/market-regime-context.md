# Crypto Market Regime, Liquidity and Trap Model Context

> **Status:** research context, not an executable trading policy or production
> contract.
>
> **Provenance:** reconstructed from the `Crypto Dashboard v2` project
> conversations through June 2026 and normalized on 2026-09-05. The project
> evolved several incompatible score scales and directions; those differences
> are preserved below instead of being silently flattened.
>
> **Safety boundary:** code, tests, `docs/architecture/invariants.md`, approved
> plans and GitHub Issues remain authoritative for live behavior. Research
> output is evidence only. Missing, stale, contradictory or mixed-run evidence
> must not silently authorize new exposure.

## 1. Purpose

The dashboard is intended to answer three questions:

1. **What market regime are we in?** — risk-on, risk-off, transition and the
   current market phase.
2. **Where is the best risk-adjusted edge?** — BTC, majors, selected alts or
   cash/hedge.
3. **What action fits the regime?** — long, short, wait, DCA, swing, grid,
   hedge or cash, with an explicit horizon and invalidation.

The recurring project principle is **regime + scenario probability + signal
quality**, not point-price prediction. A single indicator must not become a
trade signal by itself.

## 2. Recovered dashboard architecture

The most complete explicit seven-block weighting preserved in the project is:

| Group            |   Weight | Role                                                                    |
| ---------------- | -------: | ----------------------------------------------------------------------- |
| Macro            |      20% | Cross-asset risk appetite and discount-rate pressure                    |
| Liquidity        |      20% | Fiat/global and crypto-native liquidity availability                    |
| Derivatives      |      15% | Leverage, crowding, squeeze and liquidation risk                        |
| Market Structure |      15% | Trend, levels, breakout quality and volatility structure                |
| Sentiment        |      10% | Fear/greed and behavioral extremes                                      |
| ETF Flows        |      15% | Institutional spot demand/supply, separated to avoid hiding it in macro |
| Breadth          |       5% | Whether strength is broad, BTC-led or concentrated in a few alts        |
| **Total**        | **100%** |                                                                         |

Historical context also contains earlier variants, including
`25/20/15/15/10/10/5` and a six-block `25/25/20/15/10/5` formula before ETF
flows were split back out. The seven-block table above is the cleanest recovered
post-ETF-separated target, but production weights still require evidence-based
calibration rather than manual curve fitting.

### 2.1 Macro

Core inputs repeatedly used:

- **DXY** — rising is normally a crypto/risk headwind; falling is supportive.
- **US 2Y / US 10Y yields** — rising yields are normally a headwind; falling
  yields are supportive, subject to the reason for the move.
- **VIX** — rising volatility is risk-off. Historical Trap analysis used
  roughly `<28` as supportive for squeeze/recovery, `30–40` as high-volatility
  territory and `>40` as crash-risk territory; these are heuristics, not a
  production contract.
- **MOVE** — rising Treasury volatility means higher liquidity/financial stress.
- **SPX / NDX** — broad equity strength is supportive; sharp declines are
  cross-asset risk-off confirmation.
- **HYG / high-yield spread** — weaker credit or widening spread confirms
  stress; contained/tightening credit is supportive.
- **WTI oil** — a sharp rise can add inflation/rates stress; a sharp fall can
  instead signal growth stress. Direction therefore needs context.
- **Gold** — was sometimes used as a defensive/risk-off marker, but should be a
  low-confidence contextual input rather than a mechanical inverse-crypto
  signal.

Macro is a regime input, not a timer by itself. A bearish DXY/yields impulse can
be temporarily overruled by a liquidation squeeze; the dashboard should show
that disagreement rather than average it away.

### 2.2 Liquidity

Recurring inputs:

- US, China, Euro-area and Japan **M2** and a global-liquidity aggregate;
- **WALCL** / Federal Reserve balance sheet;
- **RRP** / overnight reverse repo;
- Treasury cash/liability proxy such as **TGA / WTREGEN**;
- stablecoin aggregate supply and changes in **USDT / USDC** supply;
- stablecoin exchange inflows/outflows when available;
- **USDT dominance (USDT.D)** as a defensive-positioning signal.

Historical interpretation:

- falling RRP was repeatedly treated as liquidity release/supportive;
- rising Treasury cash balance was treated as a liquidity drain/headwind;
- expanding M2/WALCL and growing stablecoin supply were supportive;
- rising USDT.D was defensive/risk-off even when total stablecoin supply was
  growing.

Do not conflate **liquidity quantity** with **liquidity stress**. Total
stablecoin supply can rise while market participants simultaneously rotate into
USDT defensively.

### 2.3 Derivatives

Core inputs:

- aggregate and asset-level **open interest (OI)** and its change;
- **funding** across major exchanges, not only one venue;
- liquidations split into **longs vs shorts** over 1h / 4h / 12h / 24h;
- BTC and ETH options/implied-volatility context when available;
- liquidation heatmaps and distance to major clusters;
- basis/crowding where available.

Recurring interpretation rules:

- negative funding is **squeeze fuel, not a long signal by itself**;
- negative funding + rising/holding price + short liquidations + improving spot
  confirmation increases short-squeeze / bear-trap probability;
- strongly positive funding + rising OI + resistance + weak spot/ETF demand
  increases long-crowding / bull-trap risk;
- an OI collapse after a liquidation cascade indicates deleveraging/reset;
- rising OI without spot/ETF confirmation is fragile leverage;
- after a very large long wipeout, opening a fresh market-wide short can be late
  even if the higher-timeframe regime is still bearish.

Funding, OI and liquidations are causally related. The implementation should
avoid counting the same leverage event three times as independent evidence.

### 2.4 Market Structure

The requested structure is multi-timeframe: **1h / 4h / 1d / 1w**.

Recurring features:

- trend and swing structure;
- support/resistance and volume profile;
- VWAP;
- RSI and MACD;
- ATR / realized-volatility regime;
- volume and breakout quality;
- distance to liquidation clusters;
- TOTAL / TOTAL2 and BTC/ETH market-cap dominance.

The project repeatedly used session/reference levels such as daily open,
previous-day high/low, previous-week high/low, previous-month high/low and
week/month/year opens. Labels such as `DO`, `PDH`, `PDL`, `PWH`, `PWL`, `PMH`,
`PML`, `WO`, `MO` and `YO` are chart conventions, not exchange-domain
contracts.

A breakout should be judged by acceptance/retest, volume, leverage response and
spot/ETF confirmation, not by one candle piercing a level.

### 2.5 Sentiment

Recurring inputs:

- Crypto **Fear & Greed**;
- extreme funding/crowding as a behavioral confirmation, while keeping the raw
  derivatives data in the derivatives group;
- optional market sentiment/news measures if source quality is explicit.

Extreme fear can be both bearish state and contrarian opportunity. It should
therefore modify scenario probability only together with structure,
deleveraging and liquidity rather than mechanically flip the signal.

### 2.6 ETF flows

BTC and ETH spot-ETF flows were intentionally separated into their own block.
Track:

- daily net flow by asset;
- multi-day inflow/outflow streak;
- change in flow regime, not only the latest print;
- source timestamp and reporting lag.

A recurring lesson from the project was that a wrong ETF-flow reading could
materially change CEWS. ETF data therefore needs explicit provenance and must
not be mixed with rumors, stale screenshots or a different reporting day.

### 2.7 Breadth and crypto rotation

Recurring inputs:

- percentage of eligible coins above EMA20 / EMA50 / EMA200;
- alt/BTC relative strength;
- BTC dominance and ETH dominance;
- TOTAL2 / alt market-cap trend;
- Altcoin Season Index;
- concentration of gains in a few leaders vs broad participation.

The dashboard distinguishes:

- **Bitcoin Season** — BTC leadership / rising dominance / weak alt breadth;
- **Selective Alt Rotation** — selected leaders outperform while broad breadth
  remains mixed;
- **Broad Altseason** — falling BTC dominance plus broad alt participation;
- **Risk-Off** — defensive rotation / weak breadth / falling total market risk.

## 3. Market Regime Engine v2.0

The project explicitly defined six primary phases:

1. **Accumulation**
2. **Early Expansion**
3. **Expansion**
4. **Recovery**
5. **Distribution**
6. **Markdown / Capitulation**

Overlays/flags are separate from the primary phase: `Risk-Off`,
`Bitcoin Season`, `Selective Alt Rotation`, `Broad Altseason`.

The engine is expected to emit a score for each phase, transition probability,
confidence, false-breakout risk and a strategy mapping to
`Long / DCA / Grid / Hedge / Short / Cash`.

The following are synthesized heuristics from repeated project analyses; they
are not yet calibrated production rules:

| Phase                   | Typical evidence                                                                                                       | Typical posture                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Accumulation            | Post-selloff base, funding neutral/negative, leverage reset, supportive liquidity, fear elevated, breadth still narrow | DCA and selective swing; low leverage                                               |
| Early Expansion         | Reclaim/breakout attempt, shorts squeezed, funding not yet crowded, spot/ETF demand improving, breadth begins to widen | Swing long / buy pullbacks; avoid chasing spikes                                    |
| Expansion               | Higher-timeframe uptrend, broader participation, controlled leverage, improving flows                                  | Trend following, buy dips, partial profit-taking as crowding rises                  |
| Recovery                | Bounce after flush while macro/ETF/breadth remain mixed                                                                | Smaller longs/grid, wait for confirmation, retain hedge flexibility                 |
| Distribution            | Price near highs/range, funding/OI crowded, breadth divergence, spot/ETF confirmation weakens                          | Reduce risk, take profit, hedge; short only on confirmed failure                    |
| Markdown / Capitulation | Broad structure down, long-liquidation cascade, OI reset, fear/risk-off                                                | Cash/hedge; avoid chasing shorts after the flush; watch for accumulation transition |

A recurring phase sequence was
`late accumulation -> early expansion -> expansion -> local flush/reset`, with
Recovery used when price bounced before macro and breadth fully repaired.

## 4. CEWS — historical definitions and semantic drift

`CEWS` changed meaning several times. This is the most important ambiguity to
preserve before implementation.

| Period            | Scale / direction                             | Recovered interpretation                                                                                                                                                                                                                                  |
| ----------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-03-07        | ~0–30, **higher = more warning/risk**         | 0–8 bullish/pump, 9–15 range, 16–22 risk-off, 23–30 crash. Initial model used 12 indicators with 0/1/2 states and block multipliers (for example volatility/liquidity/crypto-flow 1.5, rates 1.2, credit 1.3).                                            |
| 2026-03-11/12     | 0–30, **higher = more warning/risk**          | Variants used roughly 0–8/10 bullish, 9/10–15/18 neutral, 16/18–22/24 risk-off, 23/25+ panic/crash. On 12 Mar one explicit point set was VIX +2, DXY +1, US10Y +2, MOVE +2, RRP +1, WTI +2, SPX/NDX 0, Gold +1, Fear & Greed -1, liquidations +1 = 11/30. |
| 2026-03-16        | 0–30 but direction effectively **flipped**    | Negative funding and short liquidations were assigned positive bullish points while DXY/yields were negative; CEWS 17/30 was called `volatile bullish`. This is incompatible with the earlier warning-score direction.                                    |
| 2026-03-30 to Apr | 0–10, **higher = healthier/bullish**          | 6.4 `bullish but fragile`, 7.2 `bullish improving`, 5.9 `neutral-to-bearish`; on 9 Apr CEWS was revised 6.3 -> 5.7 after correcting ETF outflows; on 13 Apr 7.1 -> 7.8 -> 8.4 accompanied strengthening expansion.                                        |
| 2026-05-23        | 0–100, **higher = healthier/bullish**         | `<40` panic/capitulation, `40–55` bearish pressure, `55–70` neutral/volatile, `70+` strong bullish expansion; a 58 reading described a late-risk-off shakeout/reset.                                                                                      |
| 2026-06-07        | 0–100, **higher was again described as risk** | 68 -> 73 was described as rising risk. This conflicts with the May 0–100 direction and should not be copied into code without an explicit version decision.                                                                                               |

### Recommended normalization before coding

Do not expose an unversioned `CEWS` scalar to the production planner. The cleanest
future separation is:

- `MarketRegimeScore` — 0–100, **higher = more risk-on/healthy**, derived from
  the seven weighted groups;
- `CEWS` / `EarlyWarningRisk` — 0–100, **higher = more warning/risk**;
- `Confidence` — a separate 0–100 evidence-quality measure, never folded into
  bullish/bearish direction.

This recommendation resolves the historical direction collision; it is not yet
an accepted production contract.

## 5. LSI — Liquidity Stress Indicator

LSI has been semantically more stable: **lower is better, higher means more
liquidity stress**. Its normalization changed over time.

Historical forms:

- **2026-03-11, 0–20:** `0–6 risk-on`, `7–12 neutral`, `13–16 stress`, `17+ crisis`.
- **2026-03-12, 0–100:** `0–40 liquidity expansion`, `40–60 neutral`,
  `60–75 stress`, `75+ crisis`; examples moved from about 64 to about 71 as
  stress increased.
- **April, 0–10:** examples 3.9, then 4.3 -> 3.2 -> 2.6 as liquidity conditions
  improved.
- **2026-05-30, 0–100:** 58 -> 52, explicitly interpreted as improving because
  lower is better.
- **2026-06-07, 0–100:** 72 -> 76, interpreted as worsening stress.

The 0–100 March-v2 bands are the most consistent basis for a future normalized
LSI:

|    LSI | Regime                           |
| -----: | -------------------------------- |
|   0–40 | Liquidity expansion / low stress |
|  40–60 | Neutral                          |
|  60–75 | Stress                           |
| 75–100 | Crisis / severe stress           |

No stable per-input LSI weight set was recovered. Inputs repeatedly included
RRP, Treasury cash/liabilities, WALCL, M2, DXY/yields, VIX/MOVE, credit stress
and sometimes ETF/crypto liquidity. Because ETF flows already have their own
15% dashboard block, a future LSI formula should avoid double-counting them
unless validation shows incremental value.

## 6. Crypto Trap Model v2.0

The project began with two basic traps:

- **Bull / long trap** — attract longs before downside reversal;
- **Bear / short trap** — attract shorts before upside squeeze.

An early sequence used in analysis was:

`panic -> dump -> liquidations -> relief rally / short squeeze -> FOMO longs -> bull trap -> possible final dump`.

By May the requested `Crypto Trap Model v2.0` taxonomy was explicit:

1. Bull trap
2. Bear trap
3. Liquidity sweep
4. Short squeeze trap
5. Long squeeze trap
6. Distribution trap

### 6.1 Requested factor set

Each factor is evaluated on 0–100 evidence:

- Funding
- Open Interest
- Liquidations
- Volume
- Stablecoin flows
- BTC Dominance
- Order Book imbalance

No stable factor weights were recovered for this seven-factor model. An earlier
`Liquidity & Flow 40% / Funding & Positioning 30% / Structure 30%` weighting
was used for bot/pair filtering and must **not** be assumed to be the Trap v2
formula.

### 6.2 Trap Score risk bands

The requested v2 risk interpretation is:

| Trap Score | Risk     |
| ---------: | -------- |
|       0–20 | Low      |
|      20–40 | Moderate |
|      40–60 | Elevated |
|      60–80 | High     |
|     80–100 | Extreme  |

The model should also emit probabilities for:

- Continuation
- Reversal
- Squeeze
- Range

and always include:

- trap type;
- confirmation signals;
- invalidation signals;
- time horizon;
- confidence / evidence quality.

Project outputs also used explicit hourly/day/week scenario probabilities.
Those probabilities are analyst estimates until they are calibrated against a
historical holdout and should not be presented as statistical frequencies.

### 6.3 Confirmation and invalidation logic

Recurring confirmation logic:

- price acceptance or failed acceptance around a key level;
- funding direction and whether it is becoming more or less crowded;
- OI build/reset;
- long-vs-short liquidation imbalance;
- spot/ETF confirmation or divergence;
- volume/breadth confirmation;
- location relative to liquidation clusters;
- macro/session context.

Examples of repeated logic:

- negative funding + shorts being liquidated + price holding/reclaiming a level
  supports a short-squeeze/bear-trap thesis;
- positive funding + OI build + weak breadth/spot confirmation near resistance
  supports a bull-trap/distribution thesis;
- a downside wick through liquidity followed by fast reclaim and OI reset
  supports a liquidity-sweep interpretation;
- a failed reclaim/retest invalidates a bullish trap thesis even if funding
  remains negative.

### 6.4 Boundary: Trap Model should not become a catch-all

A later project design discussion explicitly recognized that `Trap Model` was
becoming too broad. Useful sub-models to keep conceptually separable are:

1. Liquidation Trap Model
2. Funding/Basis Crowding Model
3. Liquidity Sweep / Stop-Run Model
4. Breakout Failure / False-Breakout Model
5. Squeeze Transition Model
6. Macro Liquidity Regime Model
7. Market Structure / Trend-Continuation Model
8. Volatility Compression / Expansion Model
9. Options Dealer Gamma / Pinning Model
10. Flow / Positioning Model

`Crypto Trap Model v2.0` can remain the operator-facing classifier, but the
implementation should prefer explainable sub-scores and reason codes over one
opaque number.

## 7. Session, calendar and news context

Project analyses explicitly changed posture by time of day and day of week.
Examples included Sunday compression/thin liquidity, Europe open, US risk-asset
sessions and confirmation after futures/ETF participation returned.

A dashboard run should therefore carry session context:

- local presentation timezone: `Europe/Berlin` (CET/CEST as applicable);
- canonical storage timestamp: UTC;
- weekday/weekend and holiday state;
- Europe and US cash-session state;
- crypto-futures/CME session state resolved from a market calendar;
- availability/lag of ETF-flow reporting;
- scheduled macro-event window.

Do not hardcode local clock assumptions that break on DST or holidays.
Weekend moves deserve lower confidence when liquidity is thin and the move is
primarily derivative-driven. A Sunday breakout should preferably be confirmed
by stronger-liquidity sessions before being promoted to a higher-timeframe
phase transition.

### News / catalyst overlay

Live analysis repeatedly required checking the current news background. Keep
this as a timestamped **catalyst overlay** unless backtesting proves a stable
numeric contribution. Relevant classes include central-bank/Treasury data,
inflation and labor releases, regulatory/ETF news, exchange/security incidents,
major protocol events and material cross-asset/geopolitical shocks.

Each catalyst needs source quality, timestamp, expected horizon, directional
interpretation and confidence. Narrative should not silently override measured
market evidence.

## 8. Evidence, freshness and trend tracking

Project requirements repeatedly asked to preserve trends rather than only the
latest number. Every run should be one coherent evidence snapshot and expose
at least:

- `asOf` / source timestamp;
- source and provenance;
- freshness / expiry state;
- raw value and normalized interpretation;
- bullish / neutral / bearish direction where meaningful;
- confidence / data availability;
- change vs previous run;
- short trend (for example rising/falling/flat, or an explicit slope/window);
- reason codes / top drivers.

The dashboard should produce:

- each group score plus confidence;
- overall regime score plus confidence;
- CEWS, LSI and Trap output with explicit model version;
- current primary phase plus overlay flags;
- transition probability and false-breakout risk;
- 3–5 main drivers;
- scenario probabilities by relevant horizon;
- explicit confirmation/invalidation levels or conditions;
- recommended strategy class as evidence, not as an exchange order.

Missing required data must remain missing. It may lower confidence or produce
`REVIEW/BLOCK`; it must not be silently converted to zero. Conflicting sources
must be surfaced. A fallback provider is acceptable only with explicit
provenance and coherent timestamps.

An implementation-neutral evidence shape could look like:

```json
{
  "schemaVersion": "...",
  "asOf": "...",
  "snapshotId": "...",
  "session": { "timezone": "Europe/Berlin", "state": "..." },
  "groups": {
    "macro": { "score": 0, "confidence": 0, "trend": "..." },
    "liquidity": { "score": 0, "confidence": 0, "trend": "..." }
  },
  "cews": { "modelVersion": "...", "score": 0, "confidence": 0 },
  "lsi": { "modelVersion": "...", "score": 0, "confidence": 0 },
  "trap": {
    "modelVersion": "...",
    "score": 0,
    "type": "...",
    "scenarioProbabilities": {}
  },
  "regime": {
    "phase": "...",
    "overlays": [],
    "confidence": 0,
    "transitionProbabilities": {}
  },
  "drivers": [],
  "provenance": []
}
```

This is illustrative research context, not the production decision-evidence
schema. Any production contract must respect canonical serialization, hashing,
provenance and freshness rules in the system invariants and related research
issues.

## 9. Strategy mapping used in the project

Recurring posture by evidence state:

- **DCA / spot:** supportive macro/liquidity plus accumulation/recovery where
  leverage has reset and long-horizon structure is acceptable;
- **Swing long:** early expansion / expansion, preferably on pullbacks rather
  than vertical spikes;
- **Trend/grid bot:** only when structure and liquidity suit the strategy; do
  not deploy simply because funding is attractive;
- **Hedge / cash:** risk-off, distribution or mixed evidence with high LSI;
- **Short:** confirmed structural failure/distribution/markdown; avoid chasing a
  short immediately after a large long-liquidation flush;
- **Wait:** contradictory evidence, stale data, thin weekend liquidity or a
  breakout without confirmation.

Position sizing and live order intent are outside this research layer and remain
subject to planner, economics, risk and immutable-approval gates.

## 10. Historical calibration examples worth preserving

These are examples of how the models were used, not target calibration data:

- **2026-03-09:** after panic/deleveraging, Trap analysis estimated short squeeze
  40%, range 30%, further dump 30%; high VIX and negative/falling funding were
  key context.
- **2026-04-09:** `Bear trap / accumulation`; scenarios roughly slow uptrend 40%,
  fake pump -> dump 25%, sideways 25%, dump 10%; posture favored DCA/swing over
  aggressive leverage.
- **2026-04-13:** CEWS improved 7.1 -> 7.8 -> 8.4 while LSI improved
  4.3 -> 3.2 -> 2.6 and the phase moved from accumulation/early expansion into
  expansion.
- **2026-05-22:** a common sequence was modeled as slow grind up -> short squeeze
  -> retail FOMO -> local flush; elevated OI and increasingly positive funding
  raised overheating risk even while the broader phase remained constructive.
- **2026-05-23:** after a large long wipeout, CEWS 58/100 was interpreted as a
  neutral-bearish volatile reset rather than automatic macro capitulation because
  cross-asset risk and liquidity were still partly supportive.
- **2026-05-30:** LSI improved approximately 58 -> 52 during the day; the project
  explicitly interpreted lower LSI as better liquidity conditions.
- **2026-06-07:** Sunday short liquidations and negative funding supported a
  squeeze/recovery thesis, but DXY/yields/VIX/equity weakness and thin weekend
  liquidity kept bull-trap risk elevated. The CEWS direction used in that one
  update conflicts with the prior May convention and is preserved here as a
  warning against unversioned score semantics.

## 11. Open decisions before implementation

1. Freeze score direction and names. The strongest recommendation is a separate
   bullish `MarketRegimeScore` and bearish `CEWS/EarlyWarningRisk`.
2. Calibrate per-indicator and within-group weights using walk-forward/holdout
   evidence; do not treat conversation-era heuristic points as optimized
   coefficients.
3. Freeze one 0–100 LSI formula and document missing-data behavior.
4. Decide whether Trap v2 exposes one aggregate risk score plus type
   probabilities or only explainable sub-model probabilities.
5. Define correlation/double-counting controls, especially among funding, OI,
   liquidations, VIX/MOVE, ETF flows and breadth.
6. Define freshness windows by source cadence (tick/intraday/daily/monthly) and
   market-session context.
7. Validate scenario-probability calibration before presenting percentages as
   statistical frequencies.

These decisions naturally belong with the analytics/evidence work around #10,
#12, #14 and the research/ML boundary in #39. They must not bypass the
production planner or system invariants.
