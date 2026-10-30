"""CC8 forward-test harness: logs the next-session signal of each surviving options strategy to a paper ledger.

PAPER ONLY. No orders, no broker calls. It replays the frozen backtest rules (backtest/options_real.py) over all stored
history up to the latest session and records: (a) the position the rules would hold now, (b) the entry the rules would plan
for the next session (indicative prices = last settle), (c) hypothetical exits that fired on the latest session.

    python paper_forward.py                 # surviving strategies only (from backtest/options_real_stats.json)
    python paper_forward.py --all           # research mode: log every strategy, labelled with its verdict
    python paper_forward.py --no-fetch      # skip the NSE refresh (offline)
Task Scheduler: run run_paper_forward.bat once a day after ~19:45 IST (bhavcopy is published by then).
"""
from __future__ import annotations

import argparse
import copy
import io
import json
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "backtest"))
sys.path.insert(0, str(ROOT / "data"))
import options_real as R  # noqa: E402
from common import DATA_DIR  # noqa: E402

LEDGER = ROOT / "out" / "cc8_paper_ledger.csv"
STATS = ROOT / "backtest" / "options_real_stats.json"
COLS = ["logged_at", "asof", "strategy", "verdict", "kind", "detail"]


def refresh(days_back=12):
    """Fetch the newest F&O bhavcopy rows (polite, cached). Failures are logged, never fatal."""
    try:
        import fetch_idxopt
        start = (pd.Timestamp.today().normalize() - pd.Timedelta(days=days_back)).strftime("%Y-%m-%d")
        fetch_idxopt.main(["--from", start])
    except Exception as exc:  # noqa: BLE001
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


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--no-fetch", action="store_true")
    a = ap.parse_args(argv)
    if not a.no_fetch:
        refresh()
        try:
            append_tail_ohlc()
        except Exception as exc:  # noqa: BLE001
            print(f"ohlc tail skipped: {exc}")
    stats = json.loads(STATS.read_text(encoding="utf-8")) if STATS.exists() else {"strategies": {}}
    verdicts = {k: v.get("verdict", "unknown") for k, v in stats["strategies"].items()}
    names = list(R.DEFAULTS) if a.all else [k for k, v in verdicts.items() if v == "survives"]
    days = R.trading_days()
    asof = days[-1]
    rows = []
    if not names:
        rows.append({"strategy": "-", "verdict": "-", "kind": "NO_SURVIVORS",
                     "detail": "no strategy passed the real-data test; nothing to forward-test (use --all for research logging)"})
    for name in names:
        trades, eq, _ = R.run(name, days)
        st = dict(R.LAST_STATE)
        v = verdicts.get(name, "unknown")
        for pos in st["book"]:
            rows.append({"strategy": name, "verdict": v, "kind": "POSITION_OPEN",
                         "detail": json.dumps({"entered": str(pos.entry_date.date()), "legs": describe(pos),
                                               "open_pnl_inr": round(R.gross(pos, st["prev"]) - pos.costs),
                                               "expiry": str(pos.meta["E"].date())})})
        for t in trades:
            if t["exit"] == asof:
                rows.append({"strategy": name, "verdict": v, "kind": "HYPOTHETICAL_EXIT",
                             "detail": json.dumps({k: (str(t[k].date()) if hasattr(t[k], "date") else t[k])
                                                   for k in ("entry", "exit", "reason", "net")})})
        plan = plan_for_next_session(name, st)
        rows.append({"strategy": name, "verdict": v, "kind": "PLAN_ENTRY" if plan else "NO_SIGNAL",
                     "detail": json.dumps(plan) if plan else "rules give no entry for the next session"})
    LEDGER.parent.mkdir(exist_ok=True)
    now = pd.Timestamp.now().strftime("%Y-%m-%d %H:%M:%S")
    new = pd.DataFrame([{**r, "logged_at": now, "asof": str(asof.date())} for r in rows])[COLS]
    if LEDGER.exists():
        old = pd.read_csv(LEDGER, dtype=str)
        key = lambda d: d.asof + "|" + d.strategy + "|" + d.kind + "|" + d.detail  # noqa: E731
        new = new[~key(new).isin(set(key(old)))]
        new = pd.concat([old, new])
    new.to_csv(LEDGER, index=False)
    print(f"paper ledger updated: asof {asof.date()}, {len(rows)} rows -> {LEDGER}")


if __name__ == "__main__":
    main()
