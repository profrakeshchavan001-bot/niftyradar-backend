"""CC8 forward-test harness: logs the next-session signal of each surviving options strategy to a paper ledger.

PAPER ONLY. No orders, no broker calls. It replays the frozen backtest rules (backtest/options_real.py) over all stored
history up to the latest session and records: (a) the position the rules would hold now, (b) the entry the rules would plan
for the next session (indicative prices = last settle), (c) hypothetical exits that fired on the latest session.

    python paper_forward.py                 # ONLY the variants listed in backtest/survivors.json (both indices)
    python paper_forward.py --all           # research mode: the four monthly structures, labelled with their verdict
    python paper_forward.py --no-fetch      # skip the NSE refresh (offline)
    python paper_forward.py --symbol BANKNIFTY   # restrict either mode to one index
Also writes out/cc8_daily_summary_<asof>.txt and out/cc8_daily_summary_latest.txt (one screen, plain text).
Task Scheduler: run run_paper_forward.bat once a day after ~19:45 IST (bhavcopy is published by then).
"""
from __future__ import annotations

import argparse
import copy
import io
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "backtest"))
sys.path.insert(0, str(ROOT / "data"))
import options_real as R  # noqa: E402
from common import DATA_DIR  # noqa: E402

LEDGER = ROOT / "out" / "cc8_paper_ledger.csv"
STATS = {"NIFTY": ROOT / "backtest" / "options_real_stats.json",
         "BANKNIFTY": ROOT / "backtest" / "options_real_banknifty_stats.json"}
SURVIVORS = ROOT / "backtest" / "survivors.json"
SUMMARY_DIR = ROOT / "out"
COLS = ["logged_at", "asof", "symbol", "variant", "strategy", "verdict", "kind", "detail"]


def refresh(days_back=12):
    """Fetch the newest F&O bhavcopy rows (polite, cached). Failures are logged, never fatal."""
    try:
        import fetch_idxopt
        start = (pd.Timestamp.today().normalize() - pd.Timedelta(days=days_back)).strftime("%Y-%m-%d")
        fetch_idxopt.main(["--from", start])
    except (Exception, SystemExit) as exc:  # noqa: BLE001  (argparse/NSE failures must never stop the logger)
        print(f"refresh skipped: {type(exc).__name__}: {exc}")


def append_tail_ohlc():
    """Append sessions that have option files but no spot row yet, from the NSE index close archive."""
    from nsehttp import FetchError, Fetcher
    f = DATA_DIR / "nifty" / "nifty50_ohlc.csv"
    spot = pd.read_csv(f, parse_dates=["date"])
    have = set(spot.date)
    fx = Fetcher(DATA_DIR / "nifty" / "raw")
    rows = []
    for p in sorted((DATA_DIR / "idxopt").glob("*.parquet")):
        d = pd.Timestamp(p.stem)
        if d in have or d < spot.date.max():
            continue
        try:
            raw = fx.get(f"https://nsearchives.nseindia.com/content/indices/ind_close_all_{d:%d%m%Y}.csv",
                         f"ind_close_all_{d:%d%m%Y}.csv")
        except FetchError:
            continue
        if raw is None:
            continue
        df = pd.read_csv(io.BytesIO(raw), skipinitialspace=True)
        df.columns = [c.strip() for c in df.columns]
        r = df[df["Index Name"].astype(str).str.strip().isin(["Nifty 50", "CNX Nifty"])].iloc[0]
        rows.append({"date": d, "open": r["Open Index Value"], "high": r["High Index Value"],
                     "low": r["Low Index Value"], "close": r["Closing Index Value"], "source": "nse_archive"})
    if rows:
        pd.concat([spot, pd.DataFrame(rows)]).to_csv(f, index=False)
        R.spot_table.cache_clear()


def describe(pos):
    return [{"side": "long" if L.side > 0 else "short", "type": L.cp, "strike": L.K, "expiry": str(L.exp.date()),
             "entry": round(L.entry, 2), "last": round(L.last, 2)} for L in pos.legs]


def plan_for_next_session(name, st):
    prev = st["prev"]
    P = st["params"]
    if prev is None or (not name.startswith("strangle") and st["book"]):
        return None
    ind = copy.copy(prev)
    ind.opn = dict(prev.settle)  # indicative: last settle stands in for tomorrow's open
    pos = None
    if name in ("condor", "strangle_d18", "strangle_p100"):
        if P.get("entry_tdays") is not None:
            # next session = next weekday (the NSE holiday calendar is not in the data, so this is indicative only)
            nxt = pd.Timestamp(np.busday_offset(prev.date.date(), 1, roll="forward"))
            E = next((e for e in prev.expiries
                      if e not in st["done"] and int(np.busday_count(nxt.date(), e.date())) == P["entry_tdays"]), None)
        elif P.get("weekly"):
            E = next((e for e in prev.expiries if P["entry_lo"] <= (e - (prev.date + pd.Timedelta(days=1))).days <= P["entry_hi"]
                      and e not in st["done"]), None)
        else:
            E = next((e for e in R.monthly_expiries(prev.expiries)
                      if P["dte_lo"] <= (e - prev.date).days <= P["dte_hi"] and e not in st["done"]), None)
        if E is not None:
            pos = R.enter_condor(prev, ind, E, P) if name == "condor" else R.enter_strangle(prev, ind, E, P)
    elif name == "calendar":
        E1 = next((e for e in prev.expiries
                   if P["dte_lo"] <= (e - prev.date).days <= P["dte_hi"] and e not in st["done"]), None)
        if E1 is not None:
            pos = R.enter_calendar(prev, ind, E1, P)
    if pos is None:
        return None
    pos.credit_inr = sum(-L.side * L.entry for L in pos.legs) * R.LOT
    return {"legs": describe(pos), "indicative_net_credit_inr": round(pos.credit_inr),
            "margin_est_inr": R.margin_estimate(name, prev.S_close, pos), "indicative": True}


def load_survivors(path=None):
    """backtest/survivors.json: {"survivors": [{label, symbol, structure, params}, ...]}. Missing file or empty list = none."""
    f = Path(path) if path else SURVIVORS
    return json.loads(f.read_text(encoding="utf-8")).get("survivors", []) if f.exists() else []


def work_items(a, stats):
    """[(symbol, variant, structure, params, verdict)] for this run: survivors only, or the research set with --all."""
    syms = sorted(STATS) if a.symbol == "ALL" else [a.symbol]
    if a.all:
        items = []
        for sym in ([a.symbol] if a.symbol != "ALL" else ["NIFTY"]):
            verdicts = {k: v.get("verdict", "unknown") for k, v in stats.get(sym, {}).get("strategies", {}).items()}
            items += [(sym, "monthly", n, {}, verdicts.get(n, "unknown")) for n in R.DEFAULTS]
        return items
    return [(x["symbol"], x["label"], x["structure"], x.get("params", {}), "survivor") for x in load_survivors()
            if x["symbol"] in syms]


def run_item(sym, variant, name, params, verdict):
    R.configure(sym, 2.0)
    days = R.trading_days()
    asof = days[-1]
    trades, eq, _ = R.run(name, days, params)
    st = dict(R.LAST_STATE)
    rows, base = [], {"symbol": sym, "variant": variant, "strategy": name, "verdict": verdict}
    summ = {"label": f"{sym} {variant}", "asof": asof, "open": [], "exits": [], "plan": None, "closed": len(trades),
            "closed_net": round(sum(t["net"] for t in trades))}
    for pos in st["book"]:
        d = {"entered": str(pos.entry_date.date()), "legs": describe(pos),
             "open_pnl_inr": round(R.gross(pos, st["prev"]) - pos.costs), "expiry": str(pos.meta["E"].date())}
        summ["open"].append(d)
        rows.append({**base, "kind": "POSITION_OPEN", "detail": json.dumps(d)})
    for t in trades:
        if t["exit"] == asof:
            d = {k: (str(t[k].date()) if hasattr(t[k], "date") else t[k]) for k in ("entry", "exit", "reason", "net")}
            summ["exits"].append(d)
            rows.append({**base, "kind": "HYPOTHETICAL_EXIT", "detail": json.dumps(d)})
    plan = plan_for_next_session(name, st)
    summ["plan"] = plan
    rows.append({**base, "kind": "PLAN_ENTRY" if plan else "NO_SIGNAL",
                 "detail": json.dumps(plan) if plan else "rules give no entry for the next session"})
    return rows, summ


def write_summary(summaries, asof, now, out_dir=None):
    """Plain-text one-screen daily summary (PAPER ONLY)."""
    out_dir = Path(out_dir or SUMMARY_DIR)
    L = [f"CC8 paper-forward summary | asof {asof:%Y-%m-%d} | generated {now} | PAPER ONLY, no orders", ""]
    if not summaries:
        L.append("NO_SURVIVORS: backtest/survivors.json lists no variant; nothing is being forward-tested.")
    for s in summaries:
        L.append(f"{s['label']}: {len(s['open'])} open, {len(s['exits'])} hypothetical exit(s) today, "
                 f"{s['closed']} closed in replay (net Rs {s['closed_net']:,} per lot, 2x costs)")
        for o in s["open"]:
            L.append(f"    open since {o['entered']}, expiry {o['expiry']}, open P&L Rs {o['open_pnl_inr']:,}")
        for e in s["exits"]:
            L.append(f"    exit {e['exit']} {e['reason']} net Rs {e['net']:,}")
        if s["plan"]:
            L.append(f"    PLAN next session: net credit Rs {s['plan']['indicative_net_credit_inr']:,}, "
                     f"margin est Rs {s['plan']['margin_est_inr']:,} (indicative prices = last settle)")
        else:
            L.append("    no entry planned for the next session")
    L += ["", "Notes: next-session dates assume no NSE holiday (calendar not in data); prices are last settles; estimates only."]
    out_dir.mkdir(exist_ok=True)
    text = "\n".join(L) + "\n"
    (out_dir / f"cc8_daily_summary_{asof:%Y-%m-%d}.txt").write_text(text, encoding="utf-8")
    (out_dir / "cc8_daily_summary_latest.txt").write_text(text, encoding="utf-8")
    return text


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--no-fetch", action="store_true")
    ap.add_argument("--symbol", default="ALL", choices=["ALL"] + sorted(STATS))
    a = ap.parse_args(argv)
    if not a.no_fetch:
        refresh()
        try:
            append_tail_ohlc()
        except Exception as exc:  # noqa: BLE001
            print(f"ohlc tail skipped: {exc}")
        try:
            import build_banknifty_spot
            build_banknifty_spot.main()
        except Exception as exc:  # noqa: BLE001
            print(f"banknifty spot skipped: {exc}")
    stats = {s: (json.loads(f.read_text(encoding="utf-8")) if f.exists() else {"strategies": {}}) for s, f in STATS.items()}
    items = work_items(a, stats)
    rows, summaries = [], []
    for sym, variant, name, params, verdict in items:
        r, sm = run_item(sym, variant, name, params, verdict)
        rows += r
        summaries.append(sm)
    if summaries:
        asof = max(s["asof"] for s in summaries)
    else:
        R.configure("NIFTY", 2.0)
        asof = R.trading_days()[-1]
        rows.append({"symbol": "-", "variant": "-", "strategy": "-", "verdict": "-", "kind": "NO_SURVIVORS",
                     "detail": "no variant listed in backtest/survivors.json; nothing to forward-test (use --all for research logging)"})
    LEDGER.parent.mkdir(exist_ok=True)
    now = pd.Timestamp.now().strftime("%Y-%m-%d %H:%M:%S")
    new = pd.DataFrame([{**r, "logged_at": now, "asof": str(asof.date())} for r in rows])[COLS]
    if LEDGER.exists():
        old = pd.read_csv(LEDGER, dtype=str)
        for c, dv in (("symbol", "NIFTY"), ("variant", "")):
            if c not in old:
                old[c] = dv
        old["variant"] = old["variant"].fillna("")
        key = lambda d: d["asof"] + "|" + d["symbol"] + "|" + d["variant"] + "|" + d["strategy"] + "|" + d["kind"] + "|" + d["detail"]  # noqa: E731
        new = new[~key(new).isin(set(key(old)))]
        new = pd.concat([old[COLS], new])
    new.to_csv(LEDGER, index=False)
    write_summary(summaries, asof, now)
    print(f"paper ledger updated: {a.symbol} asof {asof.date()}, {len(rows)} rows -> {LEDGER}")
    return new


if __name__ == "__main__":
    main()
