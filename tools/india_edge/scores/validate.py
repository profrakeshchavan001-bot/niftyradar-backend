"""Honest check: do higher scores precede higher forward returns? Research only, never a trading rule.

Rules (set before looking at any result):
  * Nothing is tuned here. Weights/thresholds are fixed up front in config.yaml, so there is no fitting
    on train data; train (2015-2022) and test (2023-now) are simply reported separately, test untouched.
  * Signal on close of day t, entry at close of t+1 (one-day delay), exit h=10 sessions later.
  * Dates are non-overlapping (every h days) so observations are not double-counted.
  * Costs: base 0.10%/side, DOUBLED to 0.20%/side -> 0.40% round trip charged on the top-quintile leg.
  * Walk-forward by year: every year scored out of sample by construction.
  * Caveat printed in every report: a universe chosen with today's knowledge (current F&O list) has
    survivorship bias; fundamentals are a snapshot and are excluded from validation.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from scores import engine

CAVEATS = [
    "Universe is a current list of liquid F&O stocks: survivorship bias flatters any real-data result.",
    "Quality and valuation use a fundamentals snapshot (not point-in-time) and are excluded here.",
    "Fixture (synthetic) data has planted trend regimes per stock, so a positive link there comes from the generator and proves nothing.",
    "Score weights are fixed first-guess values, not fitted; no edge is claimed.",
]


def spearman(a: pd.Series, b: pd.Series) -> float:
    m = a.notna() & b.notna()
    if m.sum() < 8:
        return np.nan
    return float(a[m].rank().corr(b[m].rank()))


def forward(close: pd.DataFrame, h: int) -> pd.DataFrame:
    """Return from close of t+1 to close of t+1+h (one-day execution delay)."""
    return close.shift(-(1 + h)) / close.shift(-1) - 1


def run(P, R, cfg: dict | None = None) -> dict:
    cfg = cfg or engine.load_cfg()
    v = cfg["validate"]
    h, cost = v["horizon"], 2 * v["cost_per_side_pct"] * 2 / 100       # doubled, round trip
    fwd = forward(P.close, h)
    dates = [d for i, d in enumerate(P.dates) if i % h == 0 and d in fwd.index and fwd.loc[d].notna().sum() >= 20]
    n200 = P.nifty.rolling(200, min_periods=200).mean()
    names = [k for k in R.scores if k not in ("quality", "valuation")]
    rows = []
    for d in dates:
        f = fwd.loc[d]
        rec = {"date": d, "regime": "up" if P.nifty.loc[d] > n200.loc[d] else "down" if not np.isnan(n200.loc[d]) else "na"}
        for k in names:
            s = R.scores[k].loc[d]
            rec["ic_" + k] = spearman(s, f)
        s = R.scores["overall"].loc[d]
        ok = s.notna() & f.notna()
        if ok.sum() >= 20:
            q = s[ok].rank(pct=True)
            top, bot = f[ok][q > 0.8], f[ok][q <= 0.2]
            rec["top_minus_all"] = top.mean() - f[ok].mean()
            rec["top_minus_all_net"] = rec["top_minus_all"] - cost
            rec["top_minus_bottom"] = top.mean() - bot.mean()
        rows.append(rec)
    D = pd.DataFrame(rows).set_index("date")

    def max_dd(r: pd.Series) -> float | None:
        r = r.dropna()
        if r.empty:
            return None
        eq = (1 + r).cumprod()
        return float((eq / eq.cummax() - 1).min())

    def summ(x: pd.DataFrame) -> dict:
        ic = x["ic_overall"].dropna()
        n = len(ic)
        t = float(ic.mean() / (ic.std(ddof=1) / np.sqrt(n))) if n > 2 and ic.std(ddof=1) > 0 else None
        return {"periods": int(n), "ic_overall_mean": None if not n else round(float(ic.mean()), 4),
                "ic_overall_t": None if t is None else round(t, 2),
                "ic_hit_rate": None if not n else round(float((ic > 0).mean()), 3),
                "top_quintile_minus_all_net_pct": None if x["top_minus_all_net"].dropna().empty else round(float(x["top_minus_all_net"].mean() * 100), 3),
                "top_minus_bottom_gross_pct": None if x["top_minus_bottom"].dropna().empty else round(float(x["top_minus_bottom"].mean() * 100), 3),
                "top_quintile_max_drawdown_pct": None if max_dd(x["top_minus_all_net"]) is None else round(max_dd(x["top_minus_all_net"]) * 100, 2),
                "ic_by_score": {k: round(float(x["ic_" + k].mean()), 4) for k in names if x["ic_" + k].notna().any()}}

    tr, te = pd.Timestamp(v["train_end"]), pd.Timestamp(v["test_start"])
    out = {"source": getattr(P, "source", "unknown"), "horizon_days": h, "round_trip_cost_pct": round(cost * 100, 2), "caveats": CAVEATS,
           "train": summ(D[D.index <= tr]), "test": summ(D[D.index >= te]), "all": summ(D),
           "by_year": {str(y): summ(g) for y, g in D.groupby(D.index.year)},
           "by_regime": {r: summ(g) for r, g in D.groupby("regime") if r != "na"}}
    t = out["test"]
    out["verdict"] = verdict(t)
    if out["source"] == "fixtures":
        out["verdict"] = "Fixture data only: the planted trends make this meaningless as evidence. Re-run on real data (CC8)."
    return out


def verdict(t: dict) -> str:
    """Plain words from the untouched test period; never claims an edge from a weak result."""
    if not t["periods"]:
        return "Not enough test-period data to judge."
    ic, tt, net = t["ic_overall_mean"], t["ic_overall_t"], t["top_quintile_minus_all_net_pct"]
    if tt is not None and tt >= 2 and ic > 0 and net is not None and net > 0:
        return "Test period shows a positive rank link that survives doubled costs. Treat as a lead to re-check, not proof."
    return "No edge found in the test period: scores did not rank forward returns reliably after doubled costs."


def write(out: dict, path: Path) -> None:
    path.write_text(json.dumps(out, indent=1, allow_nan=False))
