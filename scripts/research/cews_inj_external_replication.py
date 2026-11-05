#!/usr/bin/env python3
"""CEWS fixed-rule public INJUSDT data audit. No auth, account, or trading code.

--fetch uses ONLY public GET /v5/market/kline to collect a bounded archive.
--replay uses local response files only; it is network-free.
When native 4h history is unavailable, --pages-4h 0 derives complete 4h bars from hourly candles.

Examples (later, on a network that permits public Bybit GET):
  python cews_inj_external_replication.py --source-dir ./cews-inj-aug-sep \
    --start 2026-08-01T00:00:00Z --end 2026-10-01T00:00:00Z \
    --pages-1h 8 --pages-4h 2 --fetch
  python cews_inj_external_replication.py --source-dir ./cews-inj-aug-sep \
    --start 2026-08-01T00:00:00Z --end 2026-10-01T00:00:00Z \
    --pages-1h 8 --pages-4h 0 --replay
"""
import argparse
import hashlib
import json
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta
from decimal import Decimal as D, ROUND_HALF_EVEN, getcontext
from pathlib import Path

getcontext().prec = 60
Q = D('0.000000000000000001')
H_MS = 3600000
FOUR_MS = 4 * H_MS
RULES = ('never', 'always', 'price24h_down', 'below_sma24h', 'range_shock', 'down_and_range_shock')


def ms(iso):
    return int(datetime.fromisoformat(iso.replace('Z', '+00:00')).timestamp() * 1000)


def iso(t):
    return datetime.fromtimestamp(t / 1000, tz=timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def div(v, n):
    return (v / D(n)).quantize(Q, rounding=ROUND_HALF_EVEN)


def get_rows(document, interval):
    # Supports original #154 retained connector-response envelopes and direct Bybit V5 HTTP JSON.
    if 'toolResult' in document:
        data = document['toolResult']['structuredContent']
        assert data['symbol'] == 'INJUSDT' and data['category'] == 'linear' and data['interval'] == interval
        return data['candles']
    assert document['retCode'] == 0
    data = document['result']
    assert data['symbol'] == 'INJUSDT' and data['category'] == 'linear'
    return [{'time': iso(int(x[0])), 'open': x[1], 'high': x[2], 'low': x[3], 'close': x[4], 'volume': x[5]} for x in data['list']]


def fetch(output, end_ms, count_1h, count_4h):
    output.mkdir(parents=True, exist_ok=True)
    for interval, size, n in [('1h', H_MS, count_1h), ('4h', FOUR_MS, count_4h)]:
        end_time = end_ms - 1
        for page in range(1, n + 1):
            args = {'category': 'linear', 'symbol': 'INJUSDT', 'interval': ('60' if interval == '1h' else '240'), 'limit': '200', 'end': str(end_time)}
            url = 'https://api.bybit.com/v5/market/kline?' + urllib.parse.urlencode(args)
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'CEWS-price-study/1.0'}), timeout=15) as response:
                payload = response.read()
            doc = json.loads(payload)
            rows = get_rows(doc, interval)
            if len(rows) != 200:
                raise RuntimeError(f'{interval} page {page} incomplete: {len(rows)} / 200')
            ts = [ms(x['time']) for x in rows]
            if any(t > end_time for t in ts) or len(set(ts)) != 200:
                raise RuntimeError(f'{interval} page {page} invalid timestamp/cursor')
            name = f'{interval}-page-{page}.json'
            (output / name).write_bytes(payload)
            print(f'{name}: {len(rows)} rows; {iso(min(ts))} - {iso(max(ts))}')
            end_time = min(ts) - 1


def read_window(path, interval, pages, start, end):
    width = H_MS if interval == '1h' else FOUR_MS
    all_rows, hashes = [], {}
    for i in range(1, pages + 1):
        name = f'{interval}-page-{i}.json'
        raw = (path / name).read_bytes()
        hashes[name] = hashlib.sha256(raw).hexdigest()
        all_rows.extend(get_rows(json.loads(raw), interval))
    data = {}
    outside = 0
    for item in all_rows:
        t = ms(item['time'])
        if t < start or t + width > end:
            outside += 1
            continue
        if t in data or t % width:
            raise ValueError('duplicate or misaligned candle: ' + iso(t))
        r = {'time': t, **{k: D(item[k]) for k in ('open', 'high', 'low', 'close', 'volume')}}
        if not all(x.is_finite() for x in r.values() if isinstance(x, D)):
            raise ValueError('nonfinite candle')
        if min(r[k] for k in ('open', 'high', 'low', 'close')) <= 0 or not (r['low'] <= r['open'] <= r['high'] and r['low'] <= r['close'] <= r['high']) or r['volume'] < 0:
            raise ValueError('invalid OHLCV')
        data[t] = r
    times = sorted(data)
    for p, q in zip(times, times[1:]):
        if q != p + width:
            raise ValueError(f'gap in {interval}: {iso(p)} -> {iso(q)}')
    bars = [data[t] for t in times]
    return bars, hashes, {'rawRows': len(all_rows), 'admitted': len(bars), 'excludedOutside': outside, 'first': iso(times[0]), 'last': iso(times[-1]), 'interiorGaps': 0}


def derive_four_hour(hourly, four_start):
    """Build *complete* 4h OHLCV candles from archived hourly data, no provider read.

    Never pass derived rows off as native exchange observations.
    """
    hour_map = {x['time']: x for x in hourly}
    if not hourly:
        raise ValueError('empty source history')
    end = max(hour_map) + H_MS
    rows = []
    for t in range(four_start, end, FOUR_MS):
        pieces = [hour_map.get(t + offset * H_MS) for offset in range(4)]
        if any(x is None for x in pieces):
            if t + FOUR_MS <= end:
                raise ValueError('incomplete 4h source: ' + iso(t))
            break
        rows.append({
            'time': t,
            'open': pieces[0]['open'],
            'high': max(x['high'] for x in pieces),
            'low': min(x['low'] for x in pieces),
            'close': pieces[-1]['close'],
            'volume': sum(x['volume'] for x in pieces),
        })
    if not rows:
        raise ValueError('no complete derived 4h bars')
    return rows


def atr_and_tr(bars):
    atr, ranges = {}, {}
    for i in range(1, len(bars)):
        x = bars[i]
        prev = bars[i - 1]['close']
        tr = max(x['high'] - x['low'], abs(x['high'] - prev), abs(x['low'] - prev))
        ranges[i] = tr
        if i == 14:
            atr[i] = div(sum(ranges.values()), 14)
        elif i > 14:
            atr[i] = div(atr[i - 1] * 13 + tr, 14)
    return atr, ranges


def score(rows, key='2'):
    events = sum(s['events'][key] for s in rows)
    out = {'count': len(rows), 'positive': events, 'baseRatePct': float(D(100) * D(events) / len(rows)) if rows else None, 'rules': {}}
    for name in RULES:
        TP = FP = FN = TN = 0
        for s in rows:
            y, w = s['events'][key], s['warnings'][name]
            if y and w: TP += 1
            elif not y and w: FP += 1
            elif y: FN += 1
            else: TN += 1
        pct = lambda a, b: float(D(100) * D(a) / D(b)) if b else None
        out['rules'][name] = {'TP': TP, 'FP': FP, 'FN': FN, 'TN': TN, 'precisionPct': pct(TP, TP+FP), 'recallPct': pct(TP, TP+FN), 'falseAlarmPct': pct(FP, TP+FP), 'FPRPct': pct(FP, FP+TN), 'warningSharePct': pct(TP+FP, len(rows))}
    return out


def replay(path, start, end, pages1h, pages4h, four_start):
    one, h1, cov1 = read_window(path, '1h', pages1h, start, end)
    if pages4h:
        four, h4, cov4 = read_window(path, '4h', pages4h, four_start, end)
        resolution = 'native-4h-independent-check'
    else:
        four = derive_four_hour(one, four_start)
        h4 = {}
        cov4 = {'rawRows': None, 'admitted': len(four), 'excludedOutside': None,
                'first': iso(four[0]['time']), 'last': iso(four[-1]['time']),
                'interiorGaps': 0, 'source': 'derived-from-archived-1h'}
        resolution = 'derived-4h-NOT-independent-source-verification'
    hourly = {x['time']: x for x in one}
    for x in four:
        parts = [hourly.get(x['time'] + j*H_MS) for j in range(4)]
        if any(y is None for y in parts):
            raise ValueError('cross-resolution constituent gap')
        if x['open'] != parts[0]['open'] or x['close'] != parts[-1]['close'] or x['high'] != max(y['high'] for y in parts) or x['low'] != min(y['low'] for y in parts):
            raise ValueError('native 4h OHLC != 1h aggregate')
    atr, ranges = atr_and_tr(four)
    samples, warmup, missing = [], 0, 0
    for i, x in enumerate(four):
        if i not in atr:
            warmup += 1
            continue
        t = x['time'] + FOUR_MS
        future = [hourly.get(t + j*H_MS) for j in range(24)]
        if any(y is None for y in future):
            missing += 1
            continue
        loss = max(D(0), x['close'] - min(y['low'] for y in future))
        down = x['close'] < four[i-6]['close']
        sma = x['close']*6 < sum(y['close'] for y in four[i-5:i+1])
        shock = ranges[i] > atr[i]
        samples.append({'time': t, 'events': {str(k): loss >= D(k)*atr[i] for k in (1,2,3)}, 'warnings': {'never':False, 'always':True, 'price24h_down':down, 'below_sma24h':sma, 'range_shock':shock, 'down_and_range_shock':down and shock}})
    daily = [x for x in samples if datetime.fromtimestamp(x['time']/1000, tz=timezone.utc).hour == 4]
    summary = {'source': 'retrospectively reacquired Bybit public OHLCV; PIT publication availability unverified', 'symbol': 'INJUSDT', 'category': 'linear', 'comparison': 'reverse-time historical replication, NOT forward chronological holdout', 'range': {'startUTC':iso(start), 'fourHourStartUTC':iso(four_start), 'endExclusiveUTC':iso(end)}, 'coverage':{'1h':cov1, '4h':cov4, 'crossResolutionMatches':(len(four) if pages4h else None), 'fourHourSource':resolution}, 'excluded': {'atrWarmup':warmup, 'forwardIncomplete':missing}, 'events':{'k1':sum(x['events']['1'] for x in samples), 'k2':sum(x['events']['2'] for x in samples), 'k3':sum(x['events']['3'] for x in samples)}, 'overlapping':score(samples), 'daily04UTC':score(daily), 'sourceFileSha256': {**h1, **h4}, 'exchangeWrites':0, 'publicOnly':True}
    return summary


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--source-dir', required=True, type=Path)
    p.add_argument('--start', required=True)
    p.add_argument('--four-start', help='Start of 4h series, defaults to --start')
    p.add_argument('--end', required=True)
    p.add_argument('--pages-1h', required=True, type=int)
    p.add_argument('--pages-4h', required=True, type=int)
    mode = p.add_mutually_exclusive_group(required=True)
    mode.add_argument('--fetch', action='store_true')
    mode.add_argument('--replay', action='store_true')
    args = p.parse_args()
    if not 1 <= args.pages_1h <= 8 or not 0 <= args.pages_4h <= 2:
        p.error('bounded research: max 8 hourly and 2 fourhour pages; 0 fourhour uses 1h aggregation')
    start, end, four_start = ms(args.start), ms(args.end), ms(args.four_start or args.start)
    if end <= start or four_start < start or four_start % FOUR_MS:
        p.error('bad window alignment')
    if args.fetch:
        fetch(args.source_dir, end, args.pages_1h, args.pages_4h)
    else:
        result = replay(args.source_dir, start, end, args.pages_1h, args.pages_4h, four_start)
        out = args.source_dir / 'offline-replay-result.json'
        out.write_text(json.dumps(result, indent=2) + '\n')
        print('Replayed:', result['overlapping']['count'], '4h cutoffs,', result['daily04UTC']['count'], 'daily cutoffs')
        print('2xATR:', result['overlapping']['positive'], 'positive overlapping;', result['daily04UTC']['positive'], 'daily')
        print('Wrote:', out)


if __name__ == '__main__':
    main()
