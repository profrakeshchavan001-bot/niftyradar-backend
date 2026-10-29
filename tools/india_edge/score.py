"""0-100 selection score, direction, grade and setup type (weights in config.yaml)."""
from __future__ import annotations

import numpy as np
import pandas as pd

BIAS = {"long_buildup": 1, "short_covering": 1, "short_buildup": -1,
        "long_unwinding": -1, "neutral": 0}


def _clip01(x) -> float:
    return 0.0 if pd.isna(x) else float(min(max(x, 0.0), 1.0))


def grade(score: float, cfg: dict) -> str:
    if score >= cfg["grades"]["A"]:
        return "A"
    if score >= cfg["grades"]["B"]:
        return "B"
    return "C"


def direction(quadrant: str, rs: float) -> str:
    """long: long buildup/short covering + RS>0; short: short buildup/long unwinding + RS<0."""
    b = BIAS.get(quadrant, 0)
    if pd.isna(rs):
        return "none"
    if b > 0 and rs > 0:
        return "long"
    if b < 0 and rs < 0:
        return "short"
    return "none"


def components(row, cfg: dict) -> dict:
    """Each component as a 0..1 fraction (before weighting)."""
    t = cfg["thresholds"]
    b = BIAS.get(row["quadrant"], 0)
    quad = 0.0 if b == 0 else (1.0 if row["quadrant"] in ("long_buildup", "short_buildup")
                               else t["quadrant_reversal_weight"])
    dr = row["deliv_ratio"]
    deliv = _clip01((dr - 1) / (t["delivery_full_mult"] - 1)) if not pd.isna(dr) else 0.0
    # RS only counts when it agrees with the OI bias
    rs = _clip01(b * row["rs"] / t["rs_full_pct"])
    sec = _clip01(b * row["sector_rs"] / t["sector_rs_full_pct"])
    uo = row["unusual_oi"]
    unusual = _clip01((uo - 1) / (t["unusual_oi_full"] - 1)) if not pd.isna(uo) else 0.0
    return {"quadrant": quad, "delivery": deliv, "rs": rs, "sector_rs": sec, "unusual_oi": unusual}


def setup_type(quadrant: str, comp: dict, cfg: dict) -> str:
    """index: move is sector/market-led (strong sector, weak stock-specific RS);
    trend: fresh positions (buildup); pullback: position-closing move (covering/unwinding)."""
    t = cfg["thresholds"]
    if comp["sector_rs"] >= t["index_sector_min"] and comp["rs"] <= t["index_stock_max"]:
        return "index"
    return "trend" if quadrant in ("long_buildup", "short_buildup") else "pullback"


def score_row(row, cfg: dict) -> dict:
    comp = components(row, cfg)
    w = cfg["weights"]
    total = sum(comp[k] * w[k] for k in w)
    s = round(float(total), 1)
    return {
        "score": s,
        "grade": grade(s, cfg),
        "direction": direction(row["quadrant"], row["rs"]),
        "setup": setup_type(row["quadrant"], comp, cfg),
        "components": {k: round(comp[k] * w[k], 1) for k in w},
    }


def score_frame(df: pd.DataFrame, cfg: dict) -> pd.DataFrame:
    res = [score_row(r, cfg) for _, r in df.iterrows()]
    out = df.reset_index(drop=True).copy()
    for k in ("score", "grade", "direction", "setup", "components"):
        out[k] = [r[k] for r in res]
    out["deliv_spike"] = out["deliv_ratio"] >= cfg["thresholds"]["delivery_spike_mult"]
    out["unusual_flag"] = out["unusual_oi"] >= cfg["thresholds"]["unusual_oi_flag"]
    return out


def top_n(scored: pd.DataFrame, cfg: dict, date) -> pd.DataFrame:
    day = scored[(scored["date"] == pd.Timestamp(date))
                 & (scored["direction"] != "none")
                 & (scored["adv_cr"] >= cfg["min_adv_cr"])]
    return day.sort_values(["score", "adv_cr"], ascending=False).head(cfg["top_n"])
