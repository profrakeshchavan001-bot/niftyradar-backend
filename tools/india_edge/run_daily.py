"""Daily driver: scanner -> cause/early/option plan -> 15m timing -> vetoes -> paper bot -> Morning Desk JSON.

    python run_daily.py                    # nightly: settle yesterday's desk if its bars exist, scan, write desk
    python run_daily.py --replay 30        # paper-trade the last 30 sessions day by day (fixtures demo / backfill)
    python run_daily.py --asof 2026-10-27 --simulate-next-day

DATA_DIR unset -> synthetic fixtures; DATA_DIR set -> real bhavcopy (see docs/INDIA-EDGE-RUNBOOK.md).
Broken or missing inputs never crash the run: they appear in the desk's data_health block.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pandas as pd

import alerts as A
import enrich
from backtest.engine import monthly_membership
from common import ROOT, load_config
from early import early_alert_items
from layer1 import build_feature_frame, scan
from loader import load_market
from morning_desk import base_rates, build_desk, empty_desk, write_desk
from paper_ledger import PaperLedger
from robust import MarketDataError, bad_health, data_health, sanitize_market
from session import run_session
from telegram_fmt import format_message
from timing import exec_config
from vetoes import veto_config

WEB = ROOT / "web"
OUT = ROOT / "out"


def pick_dicts(df: pd.DataFrame, market=None, asof=None) -> list[dict]:
    """Picks for the session. With a market, each also gets its cause label and early-detection result."""
    out = []
    for _, r in df.iterrows():
        d = dict(symbol=r["symbol"], side=r["direction"], grade=r["grade"], score=float(r["score"]), setup=r["setup"])
        if market is not None:
            c = enrich._safe(enrich.cause_for, market, r, asof)
            e = enrich._safe(enrich.early_for, market, r["symbol"], asof)
            d["cause"] = c.get("label") if isinstance(c, dict) else None
            d["early"] = e
            d["early_stage"] = e.get("stage") if isinstance(e, dict) else None
        out.append(d)
    return out


def early_events(prev: dict, picks: list[dict]) -> tuple[list[dict], dict]:
    """Early-detection stage changes as alert events (pre-market) and the updated announced-stage map."""
    items, nxt = early_alert_items(prev, {p["symbol"]: p["early"] for p in picks if isinstance(p.get("early"), dict)
                                          and "stage" in p["early"]})
    ev = [dict(ts=None, symbol=i["symbol"], kind="alert", text=t, info={k: v for k, v in i.items()
                                                                      if isinstance(v, (str, int, float, bool, type(None)))})
          for t, i in items]
    return ev, nxt


def save_alerts(events: list[dict], trade_date: str, out: Path) -> Path:
    p = out / f"alerts_{trade_date}.txt"
    p.write_text("\n".join(f"{e['ts'] or 'pre-market'}  {e['text']}" for e in events if e["kind"] == "alert") + "\n",
                 encoding="utf-8")
    return p


def telegram_texts(events: list[dict]) -> list[str]:
    """Compact formatted messages when an event carries structured info, else the plain text."""
    return [format_message(e["info"]) if e.get("info") and e["info"].get("stage") else e["text"]
            for e in events if e["kind"] == "alert"]


def run(asof=None, replay: int = 0, simulate_next_day: bool = False, out_dir: Path = WEB,
        state_dir: Path = OUT, reset_ledger: bool = False, send: bool = False, market=None, quiet=False) -> dict:
    log = (lambda *a: None) if quiet else print
    state_dir.mkdir(parents=True, exist_ok=True)
    out_dir.mkdir(parents=True, exist_ok=True)
    cfg, ecfg = load_config(), exec_config()
    vcfg = veto_config(ecfg)
    db = state_dir / "paper.sqlite"
    if reset_ledger or replay:
        db.unlink(missing_ok=True)
    ledger = PaperLedger(db, ecfg)
    try:
        market = market or load_market()
        if not market.health_notes:
            market = sanitize_market(market)
    except MarketDataError as exc:
        desk = empty_desk(bad_health(str(exc), asof), ledger, str(exc))
        write_desk(desk, out_dir / "morning_desk.json")
        log(f"desk not built: {exc}")
        return desk

    dates = market.dates
    session, mode, scan_error = None, "premarket", None
    early_prev: dict = {}
    extra: list[dict] = []

    if replay:
        feats = build_feature_frame(market, cfg, symbols=sorted(market.cash["symbol"].unique()))
        member = monthly_membership(market.fo, dates, cfg["universe"]["size"], cfg["universe"]["lookback_days"]) \
            if len(market.fo) else None
        start = max(len(dates) - 1 - replay, 25)
        last = None
        for k in range(start, len(dates) - 1):
            d, nxt = dates[k], dates[k + 1]
            allowed = set(member.columns[member.loc[d].to_numpy()]) if member is not None else None
            picks = scan(market, d, cfg, feats=feats, allowed=allowed)
            if picks.empty:
                continue
            pd_ = pick_dicts(picks, market, d)
            session = run_session(market, pd_, d, nxt, ledger, ecfg, vcfg)
            extra, early_prev = early_events(early_prev, pd_)
            last = (d, nxt, picks)
        if last is None:
            desk = empty_desk(data_health(market, dates[-1]), ledger, "replay produced no picks")
            write_desk(desk, out_dir / "morning_desk.json")
            return desk
        asof_ts, trade_ts, picks = last
        mode = "replay"
        log(f"replayed {len(dates) - 1 - start} sessions")
    else:
        state_f = state_dir / "desk_state.json"
        state = json.loads(state_f.read_text()) if state_f.exists() else {}
        early_prev = state.get("early_prev", {})
        if state and not simulate_next_day:
            td = pd.Timestamp(state["trade_date"])
            if td in set(dates) and not state.get("settled"):
                sess = run_session(market, state["picks"], state["asof"], td, ledger, ecfg, vcfg)
                state["settled"] = True
                save_alerts(sess["events"], f"{td:%Y-%m-%d}", state_dir)
                log(f"settled {td:%Y-%m-%d}: {len(sess['events'])} events")
        asof_ts = pd.Timestamp(asof) if asof else dates[-1]
        try:
            picks = scan(market, asof_ts, cfg)
        except Exception as exc:  # never let a data problem stop the desk from being written
            picks, scan_error = pd.DataFrame(), f"scanner failed: {type(exc).__name__}: {exc}"
        nxt_i = dates.searchsorted(asof_ts) + 1
        pd_ = pick_dicts(picks, market, asof_ts) if len(picks) else []
        extra, early_prev = early_events(early_prev, pd_)
        if simulate_next_day:
            if nxt_i >= len(dates):
                raise SystemExit("no next trading day in the data to simulate")
            trade_ts = dates[nxt_i]
            session = run_session(market, pd_, asof_ts, trade_ts, ledger, ecfg, vcfg)
            mode = "simulated"
        else:
            trade_ts = dates[nxt_i] if nxt_i < len(dates) else asof_ts + pd.offsets.BDay(1)
            state_f.write_text(json.dumps(dict(asof=f"{asof_ts:%Y-%m-%d}", trade_date=f"{trade_ts:%Y-%m-%d}",
                                               picks=[{k: v for k, v in p.items()} for p in pd_], settled=False,
                                               early_prev=early_prev), default=str))

    try:
        rates = base_rates(market, asof_ts, cfg)
    except Exception as exc:
        rates = dict(asof=f"{asof_ts:%Y-%m-%d}", basis="unavailable", overall=dict(n=0, win_pct=None, expectancy_r=None),
                     by_grade={}, by_grade_setup={}, error=f"{type(exc).__name__}: {exc}")
    bars_n = len(session["bars"]) if session else None
    health = data_health(market, asof_ts, trade_ts, bars_n, len(picks) if session else None,
                         today=pd.Timestamp.today().normalize() if market.source == "real" else None)
    if scan_error:
        health["warnings"].append(scan_error)
        health["status"] = "bad" if health["status"] == "bad" else "degraded"
    if rates.get("error"):
        health["warnings"].append("base rates unavailable: " + rates["error"])
    desk = build_desk(market, picks, asof_ts, trade_ts, cfg, vcfg, rates, ledger, session, mode, health, extra)
    write_desk(desk, out_dir / "morning_desk.json")
    ledger.export_csv(state_dir / "paper_trades.csv")
    events = desk["alerts"]
    save_alerts(events, f"{trade_ts:%Y-%m-%d}", state_dir)
    if send:
        n = A.dispatch(telegram_texts(events))
        log(f"telegram: {n} sent (TELEGRAM_ENABLED must be true)")
    log(f"desk {desk['asof']} -> {desk['trade_date']} [{mode}] health={health['status']} picks={len(desk['picks'])} "
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
