"""Scores engine. Formulas live ONLY here (server side). Public output = numbers + plain words.

Every score at date t uses data up to and including t only (checked by tests/test_leak.py).
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import yaml

HERE = Path(__file__).resolve().parent
KEYS = ("trend", "momentum", "volume_delivery", "relative_strength", "sector_strength")


def load_cfg() -> dict:
    with open(HERE / "config.yaml", encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def _pct(s: pd.Series) -> pd.Series:
    """Cross-sectional percentile rank 0-100 (NaN stays NaN)."""
    return s.rank(pct=True) * 100


def panel(cash: pd.DataFrame, idx: pd.DataFrame) -> dict:
    cash = cash.copy()
    cash["date"] = pd.to_datetime(cash["date"])
    w = lambda c: cash.pivot(index="date", columns="symbol", values=c).sort_index()  # noqa: E731
    nifty = idx.assign(date=pd.to_datetime(idx["date"])).set_index("date").sort_index()
    sec = cash.drop_duplicates("symbol").set_index("symbol")["sector"]
    return {"close": w("close"), "volume": w("volume"), "deliv": w("deliv_pct"),
            "nifty": nifty["nifty"].reindex(w("close").index), "vix": nifty["vix"].reindex(w("close").index),
            "sector": sec}


def features(p: dict) -> dict:
    """Time-aligned feature frames. Only trailing windows -> no lookahead."""
    c, v, d, n = p["close"], p["volume"], p["deliv"], p["nifty"]
    ma = {k: c.rolling(k, min_periods=k).mean() for k in (20, 50, 200)}
    ret = {k: c.pct_change(k, fill_method=None) * 100 for k in (5, 20, 63)}
    nret = {k: n.pct_change(k, fill_method=None) * 100 for k in (20, 63)}
    return {"ma": ma, "ma50_prev": ma[50].shift(10), "ret": ret, "nret": nret,
            "vol_ratio": v.rolling(5).mean() / v.shift(5).rolling(20).mean(),
            "deliv_ratio": d.rolling(5).mean() / d.shift(5).rolling(20).mean(),
            "hi52": c.rolling(252, min_periods=60).max(), "lo52": c.rolling(252, min_periods=60).min()}


def score_day(p: dict, f: dict, day: pd.Timestamp, cfg: dict | None = None) -> pd.DataFrame:
    """Five 0-100 scores + overall for every symbol on `day`."""
    cfg = cfg or load_cfg()
    c = p["close"].loc[day]
    ma20, ma50 = f["ma"][20].loc[day], f["ma"][50].loc[day]
    ma200 = f["ma"][200].loc[day]
    # trend: share of five trend conditions met (200-day only counts once it exists)
    conds = pd.concat([(c > ma20), (c > ma50), (ma20 > ma50),
                       (c > ma200).where(ma200.notna(), c > ma50),
                       ma50 > f["ma50_prev"].loc[day]], axis=1).astype(float)
    trend = conds.mean(axis=1) * 100
    momentum = (_pct(f["ret"][63].loc[day]) * 0.6 + _pct(f["ret"][20].loc[day]) * 0.4)
    voldel = (_pct(f["vol_ratio"].loc[day]) + _pct(f["deliv_ratio"].loc[day])) / 2
    rs = _pct(f["ret"][63].loc[day] - f["nret"][63].loc[day])
    sec_rs = (f["ret"][20].loc[day] - f["nret"][20].loc[day]).groupby(p["sector"]).mean()
    sector = _pct(sec_rs).reindex(p["sector"].values).set_axis(p["sector"].index)
    out = pd.DataFrame({"trend": trend, "momentum": momentum, "volume_delivery": voldel,
                        "relative_strength": rs, "sector_strength": sector})
    out["overall"] = sum(out[k] * cfg["weights"][k] for k in KEYS)
    out = out.round(0).clip(0, 100)
    out["sector"] = p["sector"]
    return out.dropna(subset=list(KEYS))


def band(x: float, cfg: dict | None = None) -> str:
    b = (cfg or load_cfg())["bands"]
    return "Strong" if x >= b["strong"] else "Mixed" if x >= b["mixed"] else "Weak"


# What each score SAYS, in plain words (never how it is computed).
SAYS = {
    "trend": {"Strong": "Price is holding above its recent averages.",
              "Mixed": "Price is near its recent averages, no clear direction.",
              "Weak": "Price is below its recent averages."},
    "momentum": {"Strong": "Recent gains rank among the better ones in the group.",
                 "Mixed": "Recent gains are about average for the group.",
                 "Weak": "Recent gains rank among the weaker ones in the group."},
    "volume_delivery": {"Strong": "Trading and delivery interest is higher than usual.",
                        "Mixed": "Trading and delivery interest is close to usual.",
                        "Weak": "Trading and delivery interest is lower than usual."},
    "relative_strength": {"Strong": "Has done better than the Nifty 50 lately.",
                          "Mixed": "Has moved about in line with the Nifty 50.",
                          "Weak": "Has done worse than the Nifty 50 lately."},
    "sector_strength": {"Strong": "Its sector is ahead of the market.",
                        "Mixed": "Its sector is moving with the market.",
                        "Weak": "Its sector is behind the market."},
    "overall": {"Strong": "Most readings are favourable.",
                "Mixed": "Readings are mixed.",
                "Weak": "Most readings are unfavourable."},
}


def describe(row: pd.Series, cfg: dict | None = None) -> dict:
    cfg = cfg or load_cfg()
    out = {}
    for k in (*KEYS, "overall"):
        b = band(row[k], cfg)
        out[k] = {"score": int(row[k]), "band": b, "says": SAYS[k][b]}
    return out
