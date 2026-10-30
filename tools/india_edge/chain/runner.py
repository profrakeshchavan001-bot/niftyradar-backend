"""CLI: python -m india_edge.chain {run,fetch,backtest,make-fixtures,live} (run from the tools/ directory)."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from . import adapters, backtest, fixtures, signalbox

OUT_DIR = adapters.ROOT / "out"


def available_days(raw_dir: Path) -> list[str]:
    days = []
    for p in sorted(Path(raw_dir).glob("fo_*.csv")):
        y = p.stem[3:]
        days.append(f"{y[:4]}-{y[4:6]}-{y[6:]}")
    return days


def load_day(day: str, raw_dir: Path, spots: dict | None = None):
    fo_p, part_p, mkt_p = adapters.raw_paths(day, raw_dir)
    fo = adapters.parse_fo_bhavcopy(fo_p.read_bytes(), spots=spots)
    part = adapters.parse_participant_oi(part_p.read_bytes()) if part_p.exists() else {}
    ctx = json.loads(mkt_p.read_text()) if mkt_p.exists() else {}
    return fo, part, ctx


def run_day(day: str, raw_dir: Path) -> dict:
    days = available_days(raw_dir)
    if day not in days:
        raise SystemExit(f"no bhavcopy for {day} in {raw_dir}")
    i = days.index(day)
    fo, part, ctx = load_day(day, raw_dir)
    prev, part_prev = (None, {})
    if i > 0:
        prev, part_prev, _ = load_day(days[i - 1], raw_dir)
    return signalbox.analyse(fo, prev, part, part_prev, ctx)


def run_backtest(raw_dir: Path, start: str | None = None, end: str | None = None) -> dict:
    days = [d for d in available_days(raw_dir) if (not start or d >= start) and (not end or d <= end)]
    labels, prev_pack = [], None
    cache = {}
    for i, d in enumerate(days):
        cache[d] = cache.get(d) or load_day(d, raw_dir)
    for i, d in enumerate(days[:-1]):
        fo, part, ctx = cache[d]
        prev = cache[days[i - 1]] if i else None
        res = signalbox.analyse(fo, prev[0] if prev else None, part, prev[1] if prev else {}, ctx)
        nxt = {s: c.spot for s, c in cache[days[i + 1]][0].chains.items()}
        labels += backtest.label_day(res["records"], nxt)
        cache.pop(days[i - 1], None) if i else None
    return {"days": len(days), "labels": len(labels), "base_rates": backtest.base_rates(labels)}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="india_edge.chain")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="analyse one stored day")
    r.add_argument("--date"); r.add_argument("--raw-dir", default=str(adapters.RAW_DIR)); r.add_argument("--out-dir", default=str(OUT_DIR))
    r.add_argument("--fixture", action="store_true", help="generate fixtures into --raw-dir first if missing")
    f = sub.add_parser("fetch", help="download bhavcopy + participant OI")
    f.add_argument("--from", dest="start", required=True); f.add_argument("--to", dest="end"); f.add_argument("--raw-dir", default=str(adapters.RAW_DIR))
    b = sub.add_parser("backtest", help="label every stored day and print base rates")
    b.add_argument("--from", dest="start"); b.add_argument("--to", dest="end"); b.add_argument("--raw-dir", default=str(adapters.RAW_DIR)); b.add_argument("--out", default=None)
    m = sub.add_parser("make-fixtures"); m.add_argument("--out", required=True); m.add_argument("--end", default="2026-10-28"); m.add_argument("--days", type=int, default=60)
    lv = sub.add_parser("live", help="print the live chain S/R once (PC use; 60-180 s refresh)")
    lv.add_argument("--symbol", default="NIFTY"); lv.add_argument("--fixture-dir")
    a = ap.parse_args(argv)

    if a.cmd == "make-fixtures":
        print(f"{len(fixtures.make_fixtures(a.out, a.end, a.days))} days written to {a.out}")
        return 0
    if a.cmd == "fetch":
        import pandas as pd
        end = pd.Timestamp(a.end) if a.end else pd.Timestamp.today().normalize()
        bad = 0
        for d in pd.date_range(a.start, end):
            if d.weekday() < 5:
                res = adapters.download_day(f"{d:%Y-%m-%d}", a.raw_dir)
                print(d.date(), res)
                bad += not all(res.values())
        return 1 if bad else 0
    if a.cmd == "live":
        from . import sr
        ch = adapters.LiveChainFetcher(fixture_dir=a.fixture_dir).get(a.symbol)
        print(json.dumps({"symbol": ch.symbol, "spot": ch.spot, **sr.support_resistance(ch), "pcr": sr.pcr_bar(ch)}, indent=1))
        return 0
    raw = Path(a.raw_dir)
    if a.cmd == "run":
        if a.fixture and not available_days(raw):
            fixtures.make_fixtures(raw)
        day = a.date or (available_days(raw) or [None])[-1]
        if not day:
            raise SystemExit(f"no data in {raw}")
        res = run_day(day, raw)
        out = Path(a.out_dir)
        out.mkdir(parents=True, exist_ok=True)
        (out / f"chain_{day}.json").write_text(json.dumps(res, indent=1, default=str))
        print(f"chain_{day}.json: {len(res['records'])} symbols, market {res['market']['overview']['label']}")
        return 0
    res = run_backtest(raw, a.start, a.end)
    if a.out:
        Path(a.out).write_text(json.dumps(res, indent=1))
    print(json.dumps(res["base_rates"], indent=1))
    return 0
