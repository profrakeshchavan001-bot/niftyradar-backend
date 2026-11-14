"""CC4: do NiftyRadar's signals make money on past data?  Writes backtest/results/signal_backtest.json.

    set DATA_DIR=<folder with cash/ fo/ idx/ and stockopt_ohlc.parquet>
    python backtest/run_signal_backtest.py [--groups l1,early,chain,scores] [--no-options]

Rules (sigbt.py): signal on D uses data to D's close, entry D+1 open; Rs 1,00,000, 1.5% risk, max 2 open, costs 2x;
train = entries to 2022-12-31, test = from 2023-01-01. Nothing is tuned: every parameter is the repo's own default.
"""
from __future__ import annotations

import argparse
import json
import pickle
import sys
import time
from pathlib import Path

import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import sig_events as SE  # noqa: E402
import sigbt as B  # noqa: E402
from common import DATA_DIR  # noqa: E402
from sig_load import load_market_light as load_market  # noqa: E402

OUT = HERE / "results"


def underlying_trades(w: B.World, events: list[dict], cache: dict) -> list[dict]:
    out = []
    for e in events:
        di = w.pos.get(pd.Timestamp(e["date"]))
        if di is None:
            continue
        hold = e.get("hold", 5)
        key = (e["symbol"], di, e["side"], hold, e.get("stop_dist"), e.get("target_px"))
        if key not in cache:
            cache[key] = B.sim_underlying(w, e["symbol"], di, e["side"], hold=hold,
                                          stop_dist=e.get("stop_dist"), target_px=e.get("target_px"))
        t = cache[key]
        if t is None:
            continue
        out.append(dict(t, rank=e.get("rank", 0.0), hold=hold, signal_date=pd.Timestamp(e["date"])))
    return out


def option_trades(w, store, trades, moneyness, ocache):
    out = []
    for t in trades:
        key = (t["sym"], t["entry_idx"], t["exit_idx"], t["side"], moneyness, t["hold"])
        if key not in ocache:
            ocache[key] = B.price_option_trade(w, store, t, moneyness, 10 if t["hold"] <= 5 else 20)
        o = ocache[key]
        if o is not None:
            out.append(dict(t, opt=o))
    return out


TOP_PER_DAY = 2      # only 2 positions can be open, so at most the 2 best signals per day are offered (Layer 1's own list is top 5: its events are already <= 5/day and are all offered)


def cap_per_day(events: list[dict], n: int | None = None) -> list[dict]:
    """Keep the n best-ranked events per signal day; ties broken by a stable hash (no alphabetical bias)."""
    import zlib
    n = n or (5 if len(events) and "grade" in events[0] else TOP_PER_DAY)
    by: dict = {}
    for e in events:
        by.setdefault(pd.Timestamp(e["date"]), []).append(e)
    out = []
    for d, lst in by.items():
        lst.sort(key=lambda e: (-e.get("rank", 0.0), zlib.crc32(f"{e['symbol']}{d:%Y%m%d}".encode())))
        out.extend(lst[:n])
    return out


def prewarm(w, store, evs: dict, ucache, ocache) -> None:
    """Price every option trade of the whole group once, in entry-date order, so each day file is read about once."""
    todo = {}
    for events in evs.values():
        for t in underlying_trades(w, cap_per_day(events), ucache):
            todo[(t["sym"], t["entry_idx"], t["exit_idx"], t["side"], t["hold"])] = t
    items = sorted(todo.values(), key=lambda t: t["entry_idx"])
    print(f"  pricing {len(items)} distinct option trades x 2 strikes ...", flush=True)
    for m in ("atm", "itm1"):
        for t in items:
            key = (t["sym"], t["entry_idx"], t["exit_idx"], t["side"], m, t["hold"])
            if key not in ocache:
                ocache[key] = B.price_option_trade(w, store, t, m, 10 if t["hold"] <= 5 else 20)


def run_signal(key: str, events: list[dict], w, store, ucache, ocache) -> dict:
    n_raw = len(events)
    events = cap_per_day(events)
    ut = underlying_trades(w, events, ucache)
    res = {"events": n_raw, "offered": len(events), "stock": B.evaluate(ut, "stock", w)}
    if store is not None:
        for m in ("atm", "itm1"):
            ot = option_trades(w, store, ut, m, ocache)
            r = B.evaluate(ot, "opt", w)
            r["priceable_pct"] = round(100 * len(ot) / max(len(ut), 1), 1)
            res["opt_" + m] = r
    return res


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--groups", default="l1")
    ap.add_argument("--no-options", action="store_true")
    ap.add_argument("--out", default=str(OUT / "signal_backtest.json"))
    a = ap.parse_args()
    t0 = time.time()
    print("loading market ...", flush=True)
    market = load_market()
    w = B.World(market.cash)
    store = None if a.no_options else B.OptionStore(DATA_DIR / "stockopt_days")
    print(f"world {w.C.shape}, {w.dates[0].date()}..{w.dates[-1].date()} ({time.time() - t0:.0f}s)", flush=True)
    OUT.mkdir(parents=True, exist_ok=True)
    results = json.loads(Path(a.out).read_text()) if Path(a.out).exists() else {}
    ucache, ocache = {}, {}
    for g in a.groups.split(","):
        cf = OUT / f"events_{g}.pkl"
        if cf.exists():
            evs = pickle.loads(cf.read_bytes())
        else:
            evs = getattr(SE, f"{g}_events")(market, w)
            cf.write_bytes(pickle.dumps(evs))
        print(f"group {g}: {({k: len(v) for k, v in evs.items()})} ({time.time() - t0:.0f}s)", flush=True)
        if store is not None:
            prewarm(w, store, evs, ucache, ocache)
            print(f"  priced ({time.time() - t0:.0f}s)", flush=True)
        for k, ev in evs.items():
            results[k] = run_signal(k, ev, w, store, ucache, ocache)
            r = results[k]["stock"]
            print(f"  {k:22s} stock train {r['train']['trades']:4d}/{r['train']['pnl']:>9,.0f}  "
                  f"test {r['test']['trades']:4d}/{r['test']['pnl']:>9,.0f}  {r['verdict']}", flush=True)
            Path(a.out).write_text(json.dumps(results, indent=1, default=str))
    print(f"done in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
