"""Point-in-time event generators for every NiftyRadar signal that can be rebuilt from EOD bhavcopy.

Each generator returns a list of dicts: date (signal day D), symbol, side ('long'/'short'), rank (higher =
taken first), optional hold / stop_dist / target_px, optional tags. Entry is always D+1's open (sigbt).
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))


# ------------------------------------------------------------------ Layer 1 scanner (+ Layer 3 chop veto)
def efficiency_ratio_frame(C: pd.DataFrame, n: int = 20) -> pd.DataFrame:
    """vetoes.efficiency_ratio for every symbol/day at once (uses closes up to and including the day)."""
    net = (C - C.shift(n)).abs()
    path = C.diff().abs().rolling(n, min_periods=n).sum()
    return net / path.where(path > 0)


def layer1_events(market, w) -> dict[str, list[dict]]:
    from common import load_config
    from backtest import engine
    from features import load_sectors
    cfg = load_config()
    panel = engine.build_panel(market.cash, market.fo, market.idx, cfg, load_sectors())
    cand = engine.prepare_candidates(panel, cfg)
    picks = engine.select_trades(cand, cfg, cfg["weights"], w.dates[0], w.dates[-1])
    er = efficiency_ratio_frame(w.C)
    ev = []
    for r in picks.itertuples(index=False):
        e = er.at[r.date, r.symbol] if r.symbol in er.columns else np.nan
        ev.append(dict(date=r.date, symbol=r.symbol, side=r.direction, rank=float(r.score), grade=r.grade,
                       setup=r.setup, er=None if pd.isna(e) else float(e)))
    out = {"l1_all": ev,
           "l1_grade_A": [x for x in ev if x["grade"] == "A"],
           "l1_setup_trend": [x for x in ev if x["setup"] == "trend"],
           "l1_setup_pullback": [x for x in ev if x["setup"] == "pullback"],
           "l1_setup_index": [x for x in ev if x["setup"] == "index"],
           "l1_long": [x for x in ev if x["side"] == "long"],
           "l1_short": [x for x in ev if x["side"] == "short"],
           # Layer 3 chop veto (the only veto that can be rebuilt on EOD data): ER(20) < 0.25 is vetoed
           "l3_chop_kept": [x for x in ev if x["er"] is None or x["er"] >= 0.25],
           "l3_chop_vetoed": [x for x in ev if x["er"] is not None and x["er"] < 0.25]}
    return out


# ------------------------------------------------------------------ Signal Box derivatives group / AOC chain screeners
BULL = {"SFB", "STT", "TRIPLE_SR_SUPPORT", "POWER_BULL", "OI2OI_LONG", "BIG_BULL"}
BEAR = {"SFT", "STB", "TRIPLE_SR_RESISTANCE", "POWER_BEAR", "OI2OI_SHORT", "BIG_BEAR"}
# SR_*_TOUCH, SUPPORT_BREAK and RESISTANCE_BREAK need the reversal-price solver on intraday ticks; not rebuilt here.


def _chain_from_day(sym: str, g: pd.DataFrame, date: pd.Timestamp, spot: float):
    from chain.model import Chain, Strike
    g = g[g["expiry"] >= date]
    if g.empty:
        return None
    exp = g["expiry"].min()
    g = g[g["expiry"] == exp]
    rows: dict[float, Strike] = {}
    for r in g.itertuples(index=False):
        s = rows.setdefault(float(r.strike), Strike(strike=float(r.strike)))
        p = "ce" if r.opt_type.upper().startswith("C") else "pe"
        setattr(s, f"{p}_oi", float(r.oi)); setattr(s, f"{p}_vol", float(r.volume))
        setattr(s, f"{p}_chg", float(r.chg_oi)); setattr(s, f"{p}_ltp", float(r.close))
    if len(rows) < 5:
        return None
    return Chain(sym, f"{date:%Y-%m-%d}", f"{pd.Timestamp(exp):%Y-%m-%d}", float(spot), list(rows.values()))


def chain_events(market, w) -> dict[str, list[dict]]:
    from common import DATA_DIR, load_config
    from backtest import engine
    from chain import screeners as scr, shifts, sr
    cfg = load_config()
    member = engine.monthly_membership(market.fo, w.dates, cfg["universe"]["size"], cfg["universe"]["lookback_days"])
    prev: dict[str, tuple] = {}
    flags_by_day: list[dict] = []
    for di, d in enumerate(w.dates):
        f = DATA_DIR / "fo" / f"{d:%Y-%m-%d}.parquet"
        if not f.exists():
            continue
        fo = pd.read_parquet(f, columns=["instr", "symbol", "expiry", "strike", "opt_type", "close", "oi", "chg_oi", "volume"])
        fo = fo[fo["instr"] == "STO"]
        if fo.empty:
            continue
        fo["expiry"] = pd.to_datetime(fo["expiry"])
        allowed = set(member.columns[member.loc[d].to_numpy()])
        for sym, g in fo[fo["symbol"].isin(allowed)].groupby("symbol"):
            spot = w.C.at[d, sym] if sym in w.C.columns else np.nan
            if not spot or np.isnan(spot):
                continue
            ch = _chain_from_day(sym, g, d, spot)
            if ch is None:
                continue
            s = sr.support_resistance(ch)
            sup, res = s["primary_support"], s["primary_resistance"]
            flags: list[str] = []
            if sym in prev:
                flags += shifts.shift_flags(prev[sym][0], prev[sym][1], sup, res)["flags"]
            prev[sym] = (sup, res)
            t = scr.triple_sr(ch)
            if t["support"] is not None:
                flags.append("TRIPLE_SR_SUPPORT")
            if t["resistance"] is not None:
                flags.append("TRIPLE_SR_RESISTANCE")
            p = scr.power_stock(ch)
            if p:
                flags.append("POWER_BULL" if p == "bull" else "POWER_BEAR")
            o = scr.oi2oi(ch)
            if o:
                flags.append("OI2OI_LONG" if o["side"] == "long" else "OI2OI_SHORT")
            flags += scr.trap_signal(ch)
            if flags:
                flags_by_day.append(dict(date=d, symbol=sym, flags=flags, oi2oi=o, spot=float(spot)))
    ev: dict[str, list[dict]] = {}

    def add(key, e):
        ev.setdefault(key, []).append(e)

    for r in flags_by_day:
        nb, ns = sum(f in BULL for f in r["flags"]), sum(f in BEAR for f in r["flags"])
        for f in r["flags"]:
            if f in BULL or f in BEAR:
                side = "long" if f in BULL else "short"
                e = dict(date=r["date"], symbol=r["symbol"], side=side, rank=float(nb + ns))
                if f.startswith("OI2OI") and r["oi2oi"]:
                    o = r["oi2oi"]
                    e["stop_dist"] = float(o["sl"])
                    e["target_px"] = float(o["target"])
                add("chain_" + f.lower(), e)
        if nb > ns:
            add("signalbox_bull_long", dict(date=r["date"], symbol=r["symbol"], side="long", rank=float(nb)))
        if ns > nb:
            add("signalbox_bear_short", dict(date=r["date"], symbol=r["symbol"], side="short", rank=float(ns)))
    for grp, names in (("aoc_shifts", {"SFB", "STT", "SFT", "STB"}),
                       ("aoc_screeners", {"TRIPLE_SR_SUPPORT", "TRIPLE_SR_RESISTANCE", "POWER_BULL", "POWER_BEAR",
                                          "OI2OI_LONG", "OI2OI_SHORT", "BIG_BULL", "BIG_BEAR"})):
        for r in flags_by_day:
            fl = [f for f in r["flags"] if f in names]
            nb, ns = sum(f in BULL for f in fl), sum(f in BEAR for f in fl)
            if nb != ns:
                add(grp, dict(date=r["date"], symbol=r["symbol"], side="long" if nb > ns else "short", rank=float(abs(nb - ns))))
    return ev


# ------------------------------------------------------------------ Block H early detection (Watch / Ready / Go)
def early_events(market, w) -> dict[str, list[dict]]:
    import early
    from common import load_config
    from timing import exec_config
    from backtest import engine
    cfg = load_config()
    ecfg = exec_config()          # loaded once: early.* re-reads the YAML on every call otherwise (60 ms each)
    member = engine.monthly_membership(market.fo, w.dates, cfg["universe"]["size"], cfg["universe"]["lookback_days"])
    # the 120 symbols that spent the most days in the point-in-time top-60 F&O universe (a liquidity measure, not a
    # performance one); the union of all 241 ever-members made the per-day stage scan too slow on this PC
    days = member.sum().sort_values(ascending=False)
    syms = [s for s in days.index[:120] if days[s] > 0 and s in w.cols]
    ev = {"early_accumulation": [], "early_trigger": [], "early_confirmation": []}
    stage_key = {"accumulation": "early_accumulation", "trigger": "early_trigger", "confirmation": "early_confirmation"}
    last = w.dates[-1]
    for n_s, sym in enumerate(syms):
        h = early.history(market, sym, last, n=100000)
        memo: dict = {}

        def flags_fn(hh, memo=memo):
            k = hh["date"].iloc[-1]
            if k not in memo:
                memo[k] = early.detect_flags(hh, ecfg)
            return memo[k]

        prev_stage = (None, None)
        last_emit: dict = {}
        for i in range(40, len(h)):
            d = h["date"].iloc[i]
            if d not in member.index or not member.at[d, sym]:
                prev_stage = (None, None)
                continue
            r = early.early_stage(h.iloc[max(0, i - 169): i + 1], cfg=ecfg, flags_fn=flags_fn)
            cur = (r["stage"], r["side"])
            if r["stage"] != "none" and r["side"] and cur != prev_stage:
                k = stage_key[r["stage"]]
                if i - last_emit.get(k, -99) > 5:
                    ev[k].append(dict(date=d, symbol=sym, side=r["side"], rank=float(r["strength"])))
                    last_emit[k] = i
            prev_stage = cur
        if n_s % 20 == 0:
            print(f"  early: {n_s}/{len(syms)} symbols", flush=True)
    return ev


# ------------------------------------------------------------------ CC5 scores screeners (8 lists)
def scores_events(market, w) -> dict[str, list[dict]]:
    """A stock is a signal on the day it ENTERS a screener list (top 10 by the list's own ordering). The scores
    engine's own horizon is 10 sessions, so hold=10. 'Weakest scores' is read as a short, the rest as longs."""
    from scores import data, engine, screeners
    P = data.from_market(market, data.load_sectors())
    R = engine.compute(P, use_fundamentals=False)
    members, order, _ = screeners.masks(P, R)
    ev = {}
    for id_, m in members.items():
        new = m & ~m.shift(1, fill_value=False)
        rk = order[id_]
        lst = []
        for d in new.index[new.any(axis=1)]:
            names = rk.loc[d][new.loc[d]].dropna().sort_values(ascending=False).head(screeners.TOP)
            for s, v in names.items():
                lst.append(dict(date=d, symbol=s, side="short" if id_ == "weakest" else "long", rank=float(v), hold=10))
        ev["scr_" + id_] = lst
    return ev
