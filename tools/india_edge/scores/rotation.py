"""Sector rotation: equal-weight sector index vs Nifty 50, strength and its change."""
from __future__ import annotations

import numpy as np
import pandas as pd

from scores import engine

STAGE_SAYS = {"Leading": "Ahead of the market and gaining", "Weakening": "Ahead of the market but losing pace",
              "Improving": "Behind the market but gaining", "Lagging": "Behind the market and losing pace"}


def stage(strength: float, change: float) -> str:
    return {(True, True): "Leading", (True, False): "Weakening",
            (False, True): "Improving", (False, False): "Lagging"}[(strength >= 0, change >= 0)]


def series(P, R, cfg: dict) -> dict[str, pd.DataFrame]:
    """date x sector frames: strength (% vs own 60-day RS average), change over N days, n stocks, breadth."""
    rc = cfg["rotation"]
    ok = R.status == "ok"
    r1 = P.close.pct_change(1, fill_method=None).where(ok)
    sec_ret = engine.sector_mean(P, r1)                      # date x sector equal-weight daily return
    n_ok = engine.sector_count(P, ok)
    idx = (1 + sec_ret.fillna(0)).cumprod()
    rs = idx.div(P.nifty / P.nifty.dropna().iloc[0], axis=0)
    strength = (rs / rs.rolling(rc["rs_ma"], min_periods=rc["rs_ma"]).mean() - 1) * 100
    change = strength - strength.shift(rc["change_days"])
    ma50 = R.extra["ind"]["ma"][50]
    above50 = engine.sector_mean(P, (P.close > ma50).astype(float).where(ma50.notna()), ok) * 100
    avg = engine.sector_mean(P, R.scores["overall"])
    return {"strength": strength.where(n_ok >= rc["min_stocks"]), "change": change.where(n_ok >= rc["min_stocks"]),
            "n": n_ok, "breadth": above50, "avg_score": avg}


def board(P, R, day, cfg: dict, trail: int = 8) -> list[dict]:
    S = series(P, R, cfg)
    pos = P.dates.get_loc(day)
    rows = []
    for sec in S["strength"].columns:
        st, ch = S["strength"][sec].iloc[pos], S["change"][sec].iloc[pos]
        if pd.isna(st) or pd.isna(ch):
            continue
        tr = [{"x": round(float(S["strength"][sec].iloc[j]), 2), "y": round(float(S["change"][sec].iloc[j]), 2)}
              for j in range(pos - trail + 1, pos + 1) if j >= 0 and not pd.isna(S["change"][sec].iloc[j])]
        stg = stage(st, ch)
        rows.append({"sector": sec, "stage": stg, "says": STAGE_SAYS[stg], "strength": round(float(st), 2),
                     "change": round(float(ch), 2), "stocks": int(S["n"][sec].iloc[pos]),
                     "breadth": None if pd.isna(S["breadth"][sec].iloc[pos]) else int(round(S["breadth"][sec].iloc[pos])),
                     "avg_score": None if pd.isna(S["avg_score"][sec].iloc[pos]) else int(round(S["avg_score"][sec].iloc[pos])),
                     "trail": tr})
    return sorted(rows, key=lambda r: -r["strength"])
