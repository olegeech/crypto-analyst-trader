"""Archive public Bybit history for the M1 grid research spike."""
import argparse
from bisect import bisect_right
from statistics import median
import gzip
import hashlib
import io
import json
import re
import tarfile
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen

ORIGIN = "https://api.bybit.com"
HOUR = 3_600_000
DAY = 24 * HOUR
SERIES = {
    "kline": ("kline", {"interval": "60"}, "end", 1000, 0),
    "oi": ("open-interest", {"intervalTime": "1h"}, "endTime", 200, "timestamp"),
    "funding": ("funding/history", {}, "endTime", 200, "fundingRateTimestamp"),
}


def request(path, params):
    for attempt in range(4):
        try:
            with urlopen(ORIGIN + "/v5/market/" + path + "?" + urlencode(params),
                         timeout=30) as response:
                data = json.load(response)
            if data["retCode"] != 0:
                raise ValueError(f"Bybit {path}: {data['retCode']} {data['retMsg']}")
            return data["result"]
        except (OSError, ValueError):
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)


def download(symbol, kind, start, end):
    path, options, end_key, limit, time_key = SERIES[kind]
    rows = {}
    cursor = end - 1
    while cursor >= start:
        page = request(path, {"category": "linear", "symbol": symbol,
                              "limit": limit, end_key: cursor, **options})["list"]
        if not page:
            break
        oldest = cursor + 1
        for row in page:
            stamp = int(row[time_key])
            oldest = min(stamp, oldest)
            if start <= stamp < end:
                rows[stamp] = row
        if oldest > cursor:
            raise ValueError(f"{symbol} {kind}: pagination did not advance")
        cursor = oldest - 1
    return rows


def encode(value):
    return (json.dumps(value, separators=(",", ":"), sort_keys=True) + "\n").encode()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def fetch(directory):
    snapshot = (directory / "discover-snapshot.txt").read_bytes()
    symbols = re.findall(rb"^\d+\. (\w+)$", snapshot, re.M)
    end_date = datetime.fromisoformat(directory.name).replace(tzinfo=timezone.utc)
    start_date = end_date.replace(year=end_date.year - 2)
    start, end = (int(d.timestamp() * 1000) for d in (start_date, end_date))
    metadata = request("instruments-info", {"category": "linear", "limit": 1000})
    launches = {row["symbol"]: int(row["launchTime"]) for row in metadata["list"]}
    manifest = {"origin": ORIGIN, "start_ms": start, "end_exclusive_ms": end,
                "snapshot_sha256": sha(snapshot), "symbols": {},
                "queries": {"metadata": {"category": "linear", "limit": 1000},
                            "series": SERIES,
                            "pagination": "category=linear; symbol; end=oldest timestamp minus 1 ms"}}
    archive_path = directory / "archive.tar.gz"
    temporary = archive_path.with_suffix(".tmp")
    with temporary.open("wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0,
                                                  filename="") as compressed:
        with tarfile.open(fileobj=compressed, mode="w|") as archive:
            for symbol_bytes in symbols:
                symbol = symbol_bytes.decode()
                launch = launches[symbol]
                lower = max(start - 45 * DAY, launch // HOUR * HOUR)
                entry = {"launch_ms": launch, "fetch_start_ms": lower,
                         "full_history": launch <= start, "series": {}}
                manifest["symbols"][symbol] = entry
                for kind in SERIES:
                    rows = download(symbol, kind, lower, end)
                    stamps = sorted(rows)
                    name = f"{symbol}/{kind}.json"
                    data = encode([rows[t] for t in stamps])
                    info = tarfile.TarInfo(name)
                    info.size = len(data)
                    archive.addfile(info, io.BytesIO(data))
                    entry["series"][kind] = {
                        "file": name, "sha256": sha(data), "rows": len(stamps),
                        "first_ms": stamps[0] if stamps else None,
                        "last_ms": stamps[-1] if stamps else None,
                        "gaps": ([t for t in range(lower, end, HOUR) if t not in rows]
                                 if kind != "funding" else
                                 [[a, b] for a, b in zip(stamps, stamps[1:])
                                  if b - a > 8 * HOUR]),
                    }
                print(symbol, {k: v["rows"] for k, v in entry["series"].items()}, flush=True)
    temporary.replace(archive_path)
    data = archive_path.read_bytes()
    manifest["archive"] = {"bytes": len(data), "sha256": sha(data)}
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Archive: {len(data) / 2**20:.2f} MiB")


POLICY_COMMIT = "64e22e3"
VARIANTS = {
    "quorum3": (3, False, False),
    "quorum2": (2, False, False),
    "grid": (0, False, False),
    "hold": (0, False, False),
    "quorum3_range": (3, True, False),
    "quorum2_range": (2, True, False),
    "grid_range": (0, True, False),
    "quorum2_reduce": (2, False, True),
}


def aggregate(bars, width):
    result = {}
    for start in range(min(bars) // width * width, max(bars) + 1, width):
        block = [bars.get(t) for t in range(start, start + width, HOUR)]
        if all(block):
            result[start] = (max(row[1] for row in block),
                             min(row[2] for row in block), block[-1][3])
    return result


def decisions(bars, oi, funding, start, end, launch):
    if not bars:
        return {}
    daily = aggregate(bars, DAY)
    width = 4 * HOUR
    four = aggregate(bars, width)
    stamps = sorted(funding)
    output = {}
    first = max(start, ((launch + 250 * width + DAY - 1) // DAY) * DAY)
    for t in range(first, end, DAY):
        window = [four.get(k) for k in range(t - 250 * width, t, width)]
        previous, day_ago = (bars.get(k) for k in (t-HOUR, t-25*HOUR))
        trend_days = [daily.get(k) for k in range(t-4*DAY, t, DAY)]
        rate_index = bisect_right(stamps, t) - 1
        if not (all(window) and previous and day_ago and all(trend_days)):
            output[t] = None
            continue
        ranges = [max(h-l, abs(h-window[i-1][2]), abs(l-window[i-1][2]))
                  for i, (h,l,_) in enumerate(window) if i]
        atr = sum(ranges[:14]) / 14
        for tr in ranges[14:]:
            atr = (13 * atr + tr) / 14
        anchor = previous[3]
        rate = funding[stamps[rate_index]] if rate_index >= 0 else None
        votes = None
        if rate is not None and t in oi and t-DAY in oi:
            short, medium = anchor-day_ago[3], trend_days[-1][2]-trend_days[0][2]
            delta = oi[t]-oi[t-DAY]
            votes = (int(short > 0) + int(medium > 0) + int(rate <= 0 and delta <= 0),
                     int(short < 0) + int(medium < 0) + int(rate > 0 and delta > 0))
        days = [daily.get(k) for k in range(t-30*DAY, t, DAY)]
        upper = None
        if all(days):
            low, high = min(d[1] for d in days), max(d[0] for d in days)
            upper = anchor >= low + .75 * (high-low)
        output[t] = anchor, atr, rate, votes, upper
    return output


def simulate(name, bars, funding, signals, start, end, split):
    quorum, price_filter, reduce = VARIANTS[name]
    orders, positions, trades, episodes = [], [], [], []
    cash = 1.0
    placed = filled = missing = stuck = 0
    locked = worst = stuck_funding = 0.
    peak = 1.
    drawdown = 0.
    equity = boundary = 1.
    curve = []
    bought = False
    episode_open = False
    for t in range(start, end, HOUR):
        if t == split:
            boundary = equity
        bar = bars.get(t)
        decision = signals.get(t)
        if bar is None:
            if orders or positions:
                return None
            if t in signals:
                missing += 1
            curve.append(equity)
            continue
        opening, high, low, close = bar
        if t in funding and positions:
            charge = sum(p[1] for p in positions) * opening * funding[t]
            cash -= charge
            if opening < sum(p[0]*p[1] for p in positions)/sum(p[1] for p in positions):
                stuck_funding += charge
        if t in signals:
            if not positions:
                orders.clear()
            if decision is None:
                missing += 1
            else:
                anchor, atr, rate, votes, upper = decision
                if name == "hold":
                    if not bought:
                        qty = 1 / opening
                        cash -= 1.0002
                        positions.append([opening, qty, float("inf"), t])
                        bought = True
                elif rate is None or (quorum and votes is None) or (price_filter and upper is None):
                    missing += 1
                elif positions and reduce and votes[1] >= quorum:
                    for p in positions:
                        cash += p[1] * .25 * opening * (1-.00105)
                        p[1] *= .75
                elif not positions and (not quorum or votes[0] >= quorum) and not (price_filter and upper):
                    levels = [anchor-offset*atr for offset in (.5, 1, 1.5, 2)]
                    if all(e > 0 and atr >= e*(.0002+.001+.0005+max(0.,rate))+(e+atr)*.00055
                           for e in levels):
                        orders = [(e, .25/e, e+atr) for e in levels]
                        placed += len(orders)
        for p in positions[:]:
            entry, qty, target, opened = p
            if t > opened and high >= target:
                cash += qty*target*(1-.00105)
                positions.remove(p)
                trades.append([opened,t,entry,target,qty])
        if not positions and episode_open:
            episodes.append(stuck)
            stuck = 0
            episode_open = False
        for order in orders[:]:
            entry, qty, target = order
            if low < entry:
                cash -= entry*qty*1.0002
                positions.append([entry,qty,target,t])
                orders.remove(order)
                filled += 1
        if positions:
            episode_open = True
            basis = sum(p[0]*p[1] for p in positions)
            value = close*sum(p[1] for p in positions)
            if value < basis:
                stuck += 1
                locked += basis
                worst = max(worst, (basis-value)/basis)
        equity = cash + close*sum(p[1] for p in positions)
        curve.append(equity)
        peak = max(peak,equity)
        drawdown = max(drawdown, (peak-equity)/peak)
    if episode_open:
        episodes.append(stuck)
    return dict(net=equity-1, development=boundary-1, holdout=equity-boundary,
                drawdown=drawdown, placed=placed, filled=filled, trades=trades,
                episodes=len(episodes), median_below_hours=median(episodes) if episodes else 0,
                max_below_hours=max(episodes,default=0), locked_share=locked/((end-start)/HOUR),
                worst_unrealised=worst, stuck_funding=stuck_funding, missing=missing,
                curve=curve, episode_hours=episodes)


def replay(directory):
    manifest = json.loads((directory/"manifest.json").read_text())
    start, end = manifest["start_ms"], manifest["end_exclusive_ms"]
    last = datetime.fromtimestamp(end/1000, timezone.utc)
    month = last.month - 6
    split = int(last.replace(year=last.year-(month <= 0), month=(month-1)%12+1).timestamp()*1000)
    results = {"policy_commit": POLICY_COMMIT, "symbols": {}, "pooled": {}, "verdicts": {}}
    with tarfile.open(directory/"archive.tar.gz", "r:gz") as archive:
        for symbol, entry in manifest["symbols"].items():
            def read(kind):
                return json.load(archive.extractfile(entry["series"][kind]["file"]))
            bars = {int(r[0]): tuple(float(x) for x in r[1:5]) for r in read("kline")}
            oi = {int(r["timestamp"]): float(r["openInterest"]) for r in read("oi")}
            rates = {int(r["fundingRateTimestamp"]): float(r["fundingRate"]) for r in read("funding")}
            signals = decisions(bars, oi, rates, start, end, entry["launch_ms"])
            year = int(last.replace(year=last.year-1).timestamp()*1000)
            results["symbols"][symbol] = {
                "signals": {str(q): sum(d is not None and d[3] is not None and d[3][0]>=q
                                         for t,d in signals.items() if t>=year) for q in (3,2)},
                "variants": {name: simulate(name,bars,rates,signals,start,end,split)
                             for name in VARIANTS}}
    complete = [s for s,r in results["symbols"].items() if all(r["variants"].values())]
    results["incomplete"] = sorted(set(results["symbols"])-set(complete))
    groups = {"all": complete,
              "full_history": [s for s in complete if manifest["symbols"][s]["full_history"]],
              "m1": [s for s in complete if s in ("BTCUSDT","ETHUSDT","SOLUSDT","DOGEUSDT")]}
    for group, symbols in groups.items():
        results["pooled"][group] = {}
        for name in VARIANTS:
            rows = [results["symbols"][s]["variants"][name] for s in symbols]
            out = {k: sum(r[k] for r in rows) for k in ("net","development","holdout","episodes",
                                                        "placed","filled","stuck_funding")}
            out["return"] = out["net"]/len(rows) if rows else 0
            out["closed"] = sum(len(r["trades"]) for r in rows)
            out["fill_rate"] = out["filled"]/out["placed"] if out["placed"] else 0
            peak = len(rows)
            out["drawdown"] = 0
            for values in zip(*(r["curve"] for r in rows)) if rows else ():
                equity = sum(values)
                peak = max(peak, equity)
                out["drawdown"] = max(out["drawdown"], (peak-equity)/peak)
            hours = [h for row in rows for h in row["episode_hours"]]
            out["median_below_hours"] = median(hours) if hours else 0
            out["max_below_hours"] = max(hours, default=0)
            out["locked_share"] = sum(r["locked_share"] for r in rows)/len(rows) if rows else 0
            out["worst_unrealised"] = max((r["worst_unrealised"] for r in rows), default=0)
            results["pooled"][group][name] = out
    full = results["pooled"]["full_history"]
    total = results["pooled"]["all"]
    for name in ("quorum3","quorum2"):
        r = total[name]
        if r["closed"] < 30:
            verdict = "retest: fewer than 30 take-profit closes"
        elif (r["development"] > 0) != (r["holdout"] > 0):
            verdict = "retest: development and holdout disagree"
        elif (r["net"] > 0) != (full[name]["net"] > 0):
            verdict = "retest: all-symbol and full-history results disagree"
        elif min(r["development"],r["holdout"]) > 0 and r["return"] > total["grid"]["return"]:
            verdict = "adopt: both periods positive and return beats plain grid"
        else:
            verdict = "reject: adoption conditions not met"
        results["verdicts"][name] = verdict
    for symbol in results["symbols"].values():
        for row in symbol["variants"].values():
            if row:
                del row["curve"], row["episode_hours"]
                row["closed"] = len(row["trades"])
                row["fill_rate"] = row["filled"]/row["placed"] if row["placed"] else 0
    (directory/"results.json").write_bytes(encode(results))
    lines = ["# M1 daily grid research", "", "Historical evidence is not a profit guarantee.",
             "", "Amounts are in units of each symbol's initial allocation.",
             "", "| Group | Variant | Net | Development | Holdout | Return | TP closes |",
             "|---|---|---:|---:|---:|---:|---:|"]
    for group, variants in results["pooled"].items():
        for name,r in variants.items():
            lines.append(f"| {group} | {name} | {r['net']:.4f} | {r['development']:.4f} | "
                         f"{r['holdout']:.4f} | {r['return']:.2%} | {r['closed']} |")
    lines += ["", "## Verdicts", ""] + [f"- {n} — {v}" for n,v in results["verdicts"].items()]
    lines += ["", "Incomplete and excluded: " + (", ".join(results["incomplete"]) or "none"),
              "", "Per-symbol results, signal counts, trade logs and stuck metrics are in results.json."]
    (directory/"results.md").write_text("\n".join(lines)+"\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--fetch", type=Path, metavar="DIRECTORY")
    mode.add_argument("--replay", type=Path, metavar="DIRECTORY")
    args = parser.parse_args()
    if args.fetch:
        fetch(args.fetch)
    else:
        replay(args.replay)
