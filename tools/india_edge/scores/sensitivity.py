"""How much does the overall ranking move when the (untuned) weights are nudged?
Each weight is scaled by 0.75 and 1.25 in turn (others renormalised); we report the rank correlation
with the baseline overall score and the top-10 overlap, averaged over the last `days` trading days.
Stable rankings mean no hidden dependence on one lucky weight. Research output only."""
from __future__ import annotations

import numpy as np
import pandas as pd

from scores import engine


def run(P, R, cfg: dict | None = None, days: int = 60) -> dict:
    cfg = cfg or engine.load_cfg()
    W = {k: v for k, v in cfg["weights"].items() if k in R.scores}
    last = P.dates[-days:]
    base = R.scores["overall"].loc[last]
    out = {}
    for k in W:
        for f in (0.75, 1.25):
            w2 = dict(W)
            w2[k] = W[k] * f
            num = sum(R.scores[n].fillna(0) * w2[n] for n in w2)
            den = sum(R.scores[n].notna().astype(float) * w2[n] for n in w2)
            alt = (num / den.where(den > 0)).where(R.status == "ok").loc[last]
            rho, ov = [], []
            for d in last:
                a, b = base.loc[d].dropna(), alt.loc[d].dropna()
                if len(a) < 12:
                    continue
                rho.append(a.rank().corr(b.rank()))
                ov.append(len(set(a.nlargest(10).index) & set(b.nlargest(10).index)) / 10)
            out[f"{k} x{f}"] = {"rank_corr": round(float(np.mean(rho)), 4), "top10_overlap": round(float(np.mean(ov)), 3)}
    worst = min(out.items(), key=lambda kv: kv[1]["rank_corr"])
    return {"days": len(last), "variants": out, "min_rank_corr": worst[1]["rank_corr"], "most_sensitive": worst[0]}


def screener_sensitivity(P, R, cfg: dict | None = None, days: int = 500) -> dict:
    """Scale every screener percentile/band by 0.8 and 1.2 and report, over the last `days` days, the
    change in average list size and the share of stock-days whose membership flips. Percentile rules
    should move list size roughly in proportion and flip few stock-days (tested)."""
    from scores import screeners
    cfg = cfg or engine.load_cfg()
    cache: dict = {}
    base, _, _ = screeners.masks(P, R, cfg["screeners"], cache)
    out = {}
    for f in (0.8, 1.2):
        alt, _, _ = screeners.masks(P, R, screeners._scaled(cfg["screeners"], f), cache)
        for k in base:
            b, a = base[k].iloc[-days:], alt[k].iloc[-days:]
            nb, na = float(b.sum(axis=1).mean()), float(a.sum(axis=1).mean())
            out.setdefault(k, {})[f"x{f}"] = {"avg_count_base": round(nb, 2), "avg_count": round(na, 2),
                                              "count_ratio": None if nb == 0 else round(na / nb, 3),
                                              "flip_share": round(float((b != a).to_numpy().mean()), 4)}
    return {"days": days, "screeners": out}


def heatmap(P, R, cfg: dict | None = None, screener: str = "strong_trend", days: int = 750,
            enters=(0.05, 0.10, 0.15, 0.20, 0.25, 0.30), exits_extra=(0.0, 0.05, 0.10, 0.15)) -> dict:
    """Enter-percent x exit-band grid for one screener (fixtures or real): average list size, daily
    turnover (changes per listed stock per day) and mean gross 10-day return of listed stocks minus the
    universe. Descriptive only: nothing is selected from it."""
    from scores import screeners, validate
    cfg = cfg or engine.load_cfg()
    fwd = validate.forward(P.close, cfg["validate"]["horizon"])
    uni = fwd.where(R.status == "ok").mean(axis=1)
    cache: dict = {}
    cells = []
    for e in enters:
        row = []
        for x in exits_extra:
            T = {k: dict(v) for k, v in cfg["screeners"].items()}
            T[screener]["enter"], T[screener]["exit"] = e, min(0.9, e + x)
            m = screeners.masks(P, R, T, cache)[0][screener].iloc[-days:]
            cnt = m.sum(axis=1)
            chg = (m != m.shift(1)).iloc[1:].sum(axis=1)
            ex = (fwd.iloc[-days:].where(m).mean(axis=1) - uni.iloc[-days:]).dropna()
            row.append({"avg_count": round(float(cnt.mean()), 2),
                        "turnover": None if cnt.mean() == 0 else round(float(chg.mean() / cnt.mean()), 4),
                        "excess_10d_pct": None if ex.empty else round(float(ex.mean() * 100), 3)})
        cells.append(row)
    return {"screener": screener, "days": days, "enter": list(enters), "exit_extra": list(exits_extra), "cells": cells,
            "note": "Descriptive grid: thresholds were fixed up front and are not chosen from this table."}
