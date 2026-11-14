"""Morning Desk JSON: top-5 with grade, levels, option strikes, base rate and logic checklist."""
from __future__ import annotations

import json
import math
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from backtest.engine import COMPONENTS, EXEC, build_panel, normalise, prepare_candidates
from features import load_sectors
from score import BIAS
from session import veto_context
from vetoes import apply_vetoes

NOTICE = "Paper trading and historical statistics only. Not investment advice."
STRIKE_STEPS = [(100, 2.5), (250, 5), (500, 10), (1000, 20), (2500, 50), (5000, 100), (float("inf"), 250)]


# ------------------------------------------------------------------ helpers
def clean(o):
    """Make an object JSON-safe: numpy -> python, NaN/inf -> None, Timestamps -> strings."""
    if isinstance(o, dict):
        return {str(k): clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple, np.ndarray, pd.Series)):
        return [clean(v) for v in o]
    if isinstance(o, (pd.Timestamp, datetime)):
        return f"{pd.Timestamp(o):%Y-%m-%d %H:%M}" if pd.Timestamp(o).hour or pd.Timestamp(o).minute \
            else f"{pd.Timestamp(o):%Y-%m-%d}"
    if isinstance(o, (np.floating, float)):
        return None if (math.isnan(o) or math.isinf(o)) else float(o)
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, np.bool_):
        return bool(o)
    return o


def strike_step(price: float) -> float:
    return next(step for lim, step in STRIKE_STEPS if price < lim)


def suggest_strike(price: float, side: str, expiry=None) -> dict:
    """ATM strike on an approximate interval table (verify against the live option chain)."""
    step = strike_step(price)
    atm = round(price / step) * step
    return dict(type="CE" if side == "long" else "PE", atm=float(atm), step=step,
                otm1=float(atm + step if side == "long" else atm - step),
                expiry=f"{pd.Timestamp(expiry):%Y-%m-%d}" if expiry is not None else None,
                note="approximate strike interval; check the live option chain")


def next_expiry(market, symbol: str, trade_date):
    exp = pd.to_datetime(pd.Series(market.fo.loc[market.fo["symbol"] == symbol, "expiry"].unique()),
                         errors="coerce").dropna()
    fut = exp[exp >= pd.Timestamp(trade_date)]
    return fut.min() if len(fut) else None


def daily_atr(cash: pd.DataFrame, symbol: str, asof, n: int = 14) -> float:
    c = cash[(cash["symbol"] == symbol) & (cash["date"] <= pd.Timestamp(asof))].sort_values("date").tail(n + 1)
    if len(c) < n + 1:
        return float("nan")
    pc = c["close"].shift(1)
    tr = np.maximum(c["high"] - c["low"], np.maximum((c["high"] - pc).abs(), (c["low"] - pc).abs()))
    return float(tr.iloc[1:].mean())


# ------------------------------------------------------------------ base rates
def base_rates(market, asof, cfg: dict) -> dict:
    """Win rate / expectancy of every qualifying Layer 1 signal up to `asof` (outcomes that had
    fully played out by then), grouped by grade and by grade+setup. Uses the backtest's
    execution model; costs included. Not limited to the daily top 5."""
    m = market.truncate(asof)
    panel = build_panel(m.cash, m.fo, m.idx, cfg, load_sectors())
    cand = prepare_candidates(panel, cfg)
    w = normalise(cfg["weights"])
    cand = cand.assign(score=sum(cand["f_" + k] * w[k] for k in COMPONENTS))
    cand["grade"] = np.where(cand["score"] >= cfg["grades"]["A"], "A",
                             np.where(cand["score"] >= cfg["grades"]["B"], "B", "C"))
    cand["net"] = cand["gross_R"] - EXEC["cost_r"]

    def agg(g):
        return dict(n=int(len(g)), win_pct=float(100 * (g["net"] > 0).mean()), expectancy_r=float(g["net"].mean())) \
            if len(g) else dict(n=0, win_pct=None, expectancy_r=None)

    return dict(
        asof=f"{pd.Timestamp(asof):%Y-%m-%d}", basis="all qualifying signals, 5-day horizon, net of 0.1R cost",
        overall=agg(cand),
        by_grade={g: agg(d) for g, d in cand.groupby("grade")},
        by_grade_setup={f"{g}|{s}": agg(d) for (g, s), d in cand.groupby(["grade", "setup"])})


def rate_for(rates: dict, grade: str, setup: str) -> dict:
    gs = rates["by_grade_setup"].get(f"{grade}|{setup}")
    return gs if gs and gs["n"] >= 30 else rates["by_grade"].get(grade, rates["overall"])


# ------------------------------------------------------------------ checklist
def _item(name, status, detail):
    return dict(name=name, status=status, detail=detail)


def checklist(row, side: str, cfg: dict, veto: dict | None, timing: dict | None) -> list[dict]:
    b = 1 if side == "long" else -1
    items = [
        _item("OI quadrant", "pass" if BIAS.get(row["quadrant"], 0) == b else "fail",
              f"{row['quadrant'].replace('_', ' ')}: price {row['price_chg_pct']:+.1f}%, futures OI "
              f"{row['oi_chg_pct']:+.1f}%"),
        _item("Delivery spike", "pass" if row["deliv_spike"] else "fail",
              f"delivery {row['deliv_pct']:.0f}% = {row['deliv_ratio']:.2f}x its 20-day average"),
        _item("RS vs Nifty (20d)", "pass" if b * row["rs"] > 0 else "fail", f"{row['rs']:+.1f} pts"),
        _item("Sector RS", "pass" if b * row["sector_rs"] > 0 else "fail",
              f"{row['sector']} {row['sector_rs']:+.1f} pts"),
        _item("Unusual option OI", "pass" if row["unusual_flag"] else "fail",
              f"{row['unusual_oi']:.1f}x its 20-day average" if not pd.isna(row["unusual_oi"]) else "n/a"),
        _item("Liquidity", "pass" if row["adv_cr"] >= cfg["min_adv_cr"] else "fail",
              f"20-day ADV {row['adv_cr']:.0f} cr (min {cfg['min_adv_cr']})"),
    ]
    if veto:
        for name, vetoed, detail in veto["checks"]:
            unknown = any(k in detail for k in ("unavailable", "too short", "unknown", "not enough"))
            items.append(_item(f"Veto: {name}", "unknown" if unknown else ("fail" if vetoed else "pass"), detail))
    state = (timing or {}).get("stage", "Watch")
    items.append(_item("15m timing (OB/FVG pullback + BOS/engulfing)",
                       {"Go": "pass", "Ready": "pending", "Watch": "pending", "Vetoed": "fail"}.get(state, "pending"),
                       f"stage {state}" + (f": {(timing or {}).get('detail')}" if (timing or {}).get("detail") else "")))
    return items


# ------------------------------------------------------------------ cards
def candles(cash: pd.DataFrame, symbol: str, asof, n: int = 80) -> list[dict]:
    c = cash[(cash["symbol"] == symbol) & (cash["date"] <= pd.Timestamp(asof))].sort_values("date").tail(n)
    return [dict(time=f"{d:%Y-%m-%d}", open=o, high=h, low=l, close=cl)
            for d, o, h, l, cl in zip(c["date"], c["open"], c["high"], c["low"], c["close"])]


def oi_series(fo: pd.DataFrame, symbol: str, asof, n: int = 80) -> list[dict]:
    f = fo[(fo["symbol"] == symbol) & (fo["instr"] == "STF") & (fo["date"] <= pd.Timestamp(asof))]
    g = f.groupby("date")[["oi", "chg_oi"]].sum().tail(n)
    return [dict(time=f"{d:%Y-%m-%d}", oi=r.oi, chg_oi=r.chg_oi) for d, r in g.iterrows()]


def intraday_json(bars: pd.DataFrame, markers: list[dict]) -> dict:
    """Times are IST wall-clock encoded as UTC seconds so lightweight-charts shows IST."""
    t = (pd.to_datetime(bars["ts"]) - pd.Timestamp("1970-01-01")) // pd.Timedelta(seconds=1)
    return dict(candles=[dict(time=int(a), open=o, high=h, low=l, close=c) for a, o, h, l, c in
                         zip(t, bars["open"], bars["high"], bars["low"], bars["close"])], markers=markers)


def build_pick_card(market, row, rank: int, asof, trade_date, cfg: dict, vcfg: dict, rates: dict,
                    session: dict | None, ledger_rows: pd.DataFrame | None) -> dict:
    sym, side = row["symbol"], row["direction"]
    atr = daily_atr(market.cash, sym, asof)
    last = float(row["close"])
    sgn = 1 if side == "long" else -1
    stop = last - sgn * EXEC["stop_atr"] * atr if not math.isnan(atr) else None
    target = last + sgn * EXEC["target_r"] * EXEC["stop_atr"] * atr if not math.isnan(atr) else None
    # pre-market checks need no levels; the target-vs-expected-move test runs at the 15m trigger
    veto = apply_vetoes(veto_context(market, sym, asof, trade_date), vcfg)
    go = ((session or {}).get("go_checks") or {}).get(sym)
    if go:
        veto = dict(vetoed=veto["vetoed"] or any(c[1] for c in go),
                    checks=veto["checks"] + [c for c in go if c[0] == "target vs expected move"])
    else:
        veto = dict(veto, checks=veto["checks"] + [("target vs expected move", False,
                                                    "unknown: evaluated at the 15m trigger")])
    timing = None
    sess_bars = None
    if session:
        timing = dict(stage=session["stages"].get(sym, "Watch"))
        b = session["bars"].get(sym)
        if b is not None:
            mk = []
            if ledger_rows is not None:
                for _, t in ledger_rows[ledger_rows["symbol"] == sym].iterrows():
                    mk.append(dict(ts=t["entry_ts"], kind="entry", price=t["entry"], side=t["side"]))
                    if t["status"] == "closed":
                        mk.append(dict(ts=t["exit_ts"], kind="exit", price=t["exit"], side=t["side"],
                                       reason=t["exit_reason"]))
            sess_bars = intraday_json(b, mk)
    rate = rate_for(rates, row["grade"], row["setup"])
    exp = next_expiry(market, sym, trade_date)
    return dict(
        rank=rank, symbol=sym, sector=row["sector"], direction=side, grade=row["grade"], score=row["score"],
        setup=row["setup"], components=row["components"], close=last,
        features=dict(quadrant=row["quadrant"], price_chg_pct=row["price_chg_pct"], oi_chg_pct=row["oi_chg_pct"],
                      deliv_pct=row["deliv_pct"], deliv_ratio=row["deliv_ratio"], rs=row["rs"],
                      sector_rs=row["sector_rs"], unusual_oi=row["unusual_oi"], adv_cr=row["adv_cr"]),
        levels=dict(basis="reference close; stop 1.5x daily ATR(14), target 2R. Intraday levels come from the 15m zone.",
                    entry_ref=last, atr14=atr, stop=stop, target=target, r_multiple=EXEC["target_r"]),
        strikes=suggest_strike(last, side, exp),
        base_rate=dict(grade=row["grade"], setup=row["setup"], **rate, basis=rates["basis"]),
        checklist=checklist(row, side, cfg, veto, timing),
        stage=(timing or {}).get("stage", "Vetoed" if veto["vetoed"] else "Watch"),
        vetoed=veto["vetoed"] or (timing or {}).get("stage") == "Vetoed", candles=candles(market.cash, sym, asof), oi=oi_series(market.fo, sym, asof),
        intraday=sess_bars)


def build_desk(market, picks: pd.DataFrame, asof, trade_date, cfg: dict, vcfg: dict, rates: dict,
               ledger, session: dict | None = None, mode: str = "premarket") -> dict:
    day = f"{pd.Timestamp(trade_date):%Y-%m-%d}"
    rows = ledger.trades_df()
    day_rows = rows[rows["trade_date"] == day] if len(rows) else rows
    cards = [build_pick_card(market, r, k, asof, trade_date, cfg, vcfg, rates, session, day_rows)
             for k, (_, r) in enumerate(picks.iterrows(), 1)]
    summary = ledger.summary(day)
    closed = rows[rows["status"] == "closed"].tail(15) if len(rows) else rows
    eq = (ledger.cfg["capital"] + rows[rows["status"] == "closed"]["pnl"].cumsum()) if len(rows) else []
    desk = dict(
        schema=1, notice=NOTICE, mode=mode, source=market.source,
        generated_at=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        asof=f"{pd.Timestamp(asof):%Y-%m-%d}", trade_date=day,
        market=dict(nifty_close=float(market.idx[(market.idx["index_name"] == "Nifty 50")
                                                 & (market.idx["date"] <= pd.Timestamp(asof))]["close"].iloc[-1])),
        picks=cards,
        alerts=(session or {}).get("events", []),
        paper=dict(summary=summary, open=[dict(r) for _, r in rows[rows["status"] == "open"].iterrows()] if len(rows) else [],
                   recent=[dict(r) for _, r in closed.iterrows()] if len(rows) else [],
                   equity=[float(x) for x in list(eq)[-300:]]),
        base_rates=rates)
    return clean(desk)


def write_desk(desk: dict, path) -> None:
    from pathlib import Path
    Path(path).write_text(json.dumps(desk, indent=1, allow_nan=False), encoding="utf-8")
