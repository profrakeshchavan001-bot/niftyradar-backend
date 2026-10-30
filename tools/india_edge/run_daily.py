"""Daily driver: scanner -> 15m timing -> vetoes -> paper bot -> Morning Desk JSON.

    python run_daily.py                    # nightly: settle yesterday's desk if its bars exist, scan, write desk
    python run_daily.py --replay 30        # paper-trade the last 30 sessions day by day (fixtures demo / backfill)
    python run_daily.py --asof 2026-10-27 --simulate-next-day

DATA_DIR unset -> synthetic fixtures; DATA_DIR set -> real bhavcopy (see docs/INDIA-EDGE-RUNBOOK.md).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pandas as pd

import alerts as A
from backtest.engine import monthly_membership
from common import ROOT, load_config
from layer1 import build_feature_frame, scan
from loader import load_market
from morning_desk import base_rates, build_desk, write_desk
from paper_ledger import PaperLedger
from session import run_session
from timing import exec_config
from vetoes import veto_config

WEB = ROOT / "web"
OUT = ROOT / "out"


def pick_dicts(df: pd.DataFrame) -> list[dict]:
    return [dict(symbol=r["symbol"], side=r["direction"], grade=r["grade"], score=float(r["score"]),
                 setup=r["setup"]) for _, r in df.iterrows()]


def save_alerts(events: list[dict], trade_date: str, out: Path) -> Path:
    p = out / f"alerts_{trade_date}.txt"
    p.write_text("\n".join(f"{e['ts'] or 'pre-market'}  {e['text']}" for e in events if e["kind"] == "alert") + "\n",
                 encoding="utf-8")
    return p


def run(asof=None, replay: int = 0, simulate_next_day: bool = False, out_dir: Path = WEB,
        state_dir: Path = OUT, reset_ledger: bool = False, send: bool = False, market=None, quiet=False) -> dict:
    log = (lambda *a: None) if quiet else print
    market = market or load_market()
    cfg, ecfg = load_config(), exec_config()
    vcfg = veto_config(ecfg)
    state_dir.mkdir(parents=True, exist_ok=True)
    out_dir.mkdir(parents=True, exist_ok=True)
    dates = market.dates
    db = state_dir / "paper.sqlite"
    if reset_ledger or replay:
        db.unlink(missing_ok=True)
    ledger = PaperLedger(db, ecfg)
    session = None
    mode = "premarket"

    if replay:
        feats = build_feature_frame(market, cfg, symbols=sorted(market.cash["symbol"].unique()))
        member = monthly_membership(market.fo, dates, cfg["universe"]["size"], cfg["universe"]["lookback_days"])
        start = max(len(dates) - 1 - replay, 25)
        for k in range(start, len(dates) - 1):
            d, nxt = dates[k], dates[k + 1]
            allowed = set(member.columns[member.loc[d].to_numpy()])
            picks = scan(market, d, cfg, feats=feats, allowed=allowed)
            if picks.empty:
                continue
            session = run_session(market, pick_dicts(picks), d, nxt, ledger, ecfg, vcfg)
            last = (d, nxt, picks)
        asof_ts, trade_ts, picks = last
        mode = "replay"
        log(f"replayed {len(dates) - 1 - start} sessions")
    else:
        state_f = state_dir / "desk_state.json"
        last_data = dates[-1]
        # settle the previous desk once its trading day's bars are in the data
        if state_f.exists() and not simulate_next_day:
            st = json.loads(state_f.read_text())
            td = pd.Timestamp(st["trade_date"])
            if td in set(dates) and not st.get("settled"):
                sess = run_session(market, st["picks"], st["asof"], td, ledger, ecfg, vcfg)
                st["settled"] = True
                state_f.write_text(json.dumps(st))
                save_alerts(sess["events"], f"{td:%Y-%m-%d}", state_dir)
                log(f"settled {td:%Y-%m-%d}: {len(sess['events'])} events")
        asof_ts = pd.Timestamp(asof) if asof else last_data
        picks = scan(market, asof_ts, cfg)
        nxt_i = dates.searchsorted(asof_ts) + 1
        if simulate_next_day:
            if nxt_i >= len(dates):
                raise SystemExit("no next trading day in the data to simulate")
            trade_ts = dates[nxt_i]
            session = run_session(market, pick_dicts(picks), asof_ts, trade_ts, ledger, ecfg, vcfg)
            mode = "simulated"
        else:
            trade_ts = dates[nxt_i] if nxt_i < len(dates) else asof_ts + pd.offsets.BDay(1)
            state_f.write_text(json.dumps(dict(asof=f"{asof_ts:%Y-%m-%d}", trade_date=f"{trade_ts:%Y-%m-%d}",
                                               picks=pick_dicts(picks), settled=False)))

    rates = base_rates(market, asof_ts, cfg)
    desk = build_desk(market, picks, asof_ts, trade_ts, cfg, vcfg, rates, ledger, session, mode)
    write_desk(desk, out_dir / "morning_desk.json")
    ledger.export_csv(state_dir / "paper_trades.csv")
    if session:
        save_alerts(session["events"], f"{trade_ts:%Y-%m-%d}", state_dir)
        if send:
            n = A.dispatch([e["text"] for e in session["events"] if e["kind"] == "alert"])
            log(f"telegram: {n} sent (TELEGRAM_ENABLED must be true)")
    log(f"desk {desk['asof']} -> {desk['trade_date']} [{mode}] picks={len(desk['picks'])} "
        f"paper trades={desk['paper']['summary']['closed_trades']} -> {out_dir / 'morning_desk.json'}")
    return desk


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--asof", default=None, help="signal date (default: last date in the data)")
    ap.add_argument("--replay", type=int, default=0, help="paper-trade the last N sessions from a clean ledger")
    ap.add_argument("--simulate-next-day", action="store_true", help="run the next day's 15m session from data")
    ap.add_argument("--out-dir", default=str(WEB))
    ap.add_argument("--reset-ledger", action="store_true")
    ap.add_argument("--send", action="store_true", help="dispatch alerts (still needs TELEGRAM_ENABLED=true)")
    a = ap.parse_args(argv)
    run(a.asof, a.replay, a.simulate_next_day, Path(a.out_dir), OUT, a.reset_ledger, a.send)
    return 0


if __name__ == "__main__":
    sys.exit(main())
