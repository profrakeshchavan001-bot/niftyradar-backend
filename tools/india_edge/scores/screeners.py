"""Screeners driven by the scores, with rank/percentile thresholds and hysteresis.

Why: absolute cut-offs (e.g. "trend score >= 75") swing the list size wildly when the market regime
shifts or a threshold moves a little. Here a stock must rank in the top/bottom X% of today's scored
stocks to ENTER, and stays listed until it falls out of a wider band (EXIT), so lists are a stable size
and do not flicker. Public wording is data-only (no buy/sell tips). Rule text is shown to the user;
formulas are not.

Hysteresis state depends on earlier days only (tests cut the future). Results can differ slightly if
history starts at a different date, because a stock "already inside the band" at the start is only
picked up once it ranks inside the ENTER band.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

TOP = 10


def xpct(df: pd.DataFrame, ok: pd.DataFrame) -> pd.DataFrame:
    """Cross-sectional percentile among scored stocks: 1.0 = highest value, ~0 = lowest."""
    return df.where(ok).rank(axis=1, pct=True)


def hysteresis(enter: pd.DataFrame, stay: pd.DataFrame) -> pd.DataFrame:
    """bool frame: on when `enter`; stays on while `stay` holds; off otherwise. Looks backward only."""
    e, s = enter.fillna(False).to_numpy(bool), stay.fillna(False).to_numpy(bool)
    out = np.zeros_like(e)
    prev = np.zeros(e.shape[1], bool)
    for i in range(len(e)):
        prev = e[i] | (prev & s[i])
        out[i] = prev
    return pd.DataFrame(out, index=enter.index, columns=enter.columns)


def _scaled(T: dict, f: float) -> dict:
    """Scale every percent/band by f (sensitivity); capped so a band never exceeds 90% of stocks."""
    return {k: {a: min(0.9, b * f) if isinstance(b, (int, float)) else b for a, b in v.items()} for k, v in T.items()}


def masks(P, R, T: dict | None = None, cache: dict | None = None):
    """-> (members {id: bool frame}, order {id: frame to sort by (higher = listed first)}, meta {id: (title, rule)})."""
    from scores import engine
    T = T or engine.load_cfg()["screeners"]
    ok = R.status == "ok"
    S, I = R.scores, R.extra["ind"]
    c, ma50 = P.close, I["ma"][50]
    cache = {} if cache is None else cache           # percentile ranks depend on the data only, so callers that vary T share it

    def X(key, df):
        if key not in cache:
            cache[key] = xpct(df, ok)
        return cache[key]
    pct = lambda x: f"{x * 100:g}%"                  # noqa: E731
    r5, r20 = I["ret"][5], I["ret"][21]
    dist = (c / I["hi252"] - 1)
    out, order, meta = {}, {}, {}

    def band(id_, title, rule, e, s, rank):
        out[id_] = (hysteresis(e & ok, s & ok) if s is not None else (e & ok))
        order[id_], meta[id_] = rank, (title, rule)

    t = T["strong_trend"]
    band("strong_trend", "Strong trend",
         f"Trend score in the top {pct(t['enter'])} of stocks (stays listed until it leaves the top {pct(t['exit'])}) and overall score in the top {pct(t['overall'])}",
         (X("trend", S["trend"]) >= 1 - t["enter"]) & (X("overall", S["overall"]) >= 1 - t["overall"]),
         (X("trend", S["trend"]) >= 1 - t["exit"]) & (X("overall", S["overall"]) >= 1 - t["overall"] - 0.15), S["trend"])
    t = T["pullback_uptrend"]
    band("pullback_uptrend", "Pullback inside an uptrend",
         f"5-day return in the weakest {pct(t['enter'])} of stocks (stays until it leaves the weakest {pct(t['exit'])}), trend score in the top {pct(t['trend'])}, close above the 50-day average",
         (X("r5", r5) <= t["enter"]) & (X("trend", S["trend"]) >= 1 - t["trend"]) & (c > ma50),
         (X("r5", r5) <= t["exit"]) & (X("trend", S["trend"]) >= 1 - t["trend"] - 0.10) & (c > ma50), -r5)
    t = T["volume_breakout"]
    band("volume_breakout", "Volume breakout",
         f"Close above the prior 20-day high on volume in the top {pct(t['enter'])} of stocks versus their 20-day average",
         (c > I["hi20_prior"]) & (X("vol_today", I["vol_today"]) >= 1 - t["enter"]), None, I["vol_today"])
    t = T["rs_leaders"]
    band("rs_leaders", "Relative-strength leaders",
         f"Relative-strength score in the top {pct(t['enter'])} of stocks (stays until it leaves the top {pct(t['exit'])}) with trend score in the top {pct(t['trend'])}",
         (X("relative_strength", S["relative_strength"]) >= 1 - t["enter"]) & (X("trend", S["trend"]) >= 1 - t["trend"]),
         (X("relative_strength", S["relative_strength"]) >= 1 - t["exit"]) & (X("trend", S["trend"]) >= 1 - t["trend"] - 0.10), S["relative_strength"])
    t = T["near_52w_high"]
    band("near_52w_high", "Near 52-week high",
         f"Close within {pct(t['enter'])} of its 52-week high (stays listed until more than {pct(t['exit'])} below)",
         dist >= -t["enter"], dist >= -t["exit"], dist)
    t = T["delivery_rise"]
    band("delivery_rise", "Delivery rising",
         f"5-day delivery % ratio in the top {pct(t['enter'])} of stocks (stays until it leaves the top {pct(t['exit'])}) with a positive 1-month return",
         (X("dr", I["dr"]) >= 1 - t["enter"]) & (r20 > 0), (X("dr", I["dr"]) >= 1 - t["exit"]) & (r20 > 0), I["dr"])
    t = T["steady_uptrend"]
    band("steady_uptrend", "Steady uptrends",
         f"Stability score in the top {pct(t['enter'])} of stocks (stays until it leaves the top {pct(t['exit'])}) with trend score in the top {pct(t['trend'])}",
         (X("volatility", S["volatility"]) >= 1 - t["enter"]) & (X("trend", S["trend"]) >= 1 - t["trend"]),
         (X("volatility", S["volatility"]) >= 1 - t["exit"]) & (X("trend", S["trend"]) >= 1 - t["trend"] - 0.10), S["volatility"])
    t = T["weakest"]
    band("weakest", "Weakest scores",
         f"Overall score in the lowest {pct(t['enter'])} of stocks (stays until it leaves the lowest {pct(t['exit'])})",
         X("overall", S["overall"]) <= t["enter"], X("overall", S["overall"]) <= t["exit"], -S["overall"])
    return out, order, meta


def _n(x):
    return None if pd.isna(x) else int(round(x))


def run(P, R, day, T: dict | None = None, _m=None) -> list[dict]:
    members, order, meta = _m or masks(P, R, T)
    S, I = {k: v.loc[day] for k, v in R.scores.items()}, R.extra["ind"]
    c = P.close.loc[day]
    ma50, hi = I["ma"][50].loc[day], I["hi252"].loc[day]
    r5, r20 = I["ret"][5].loc[day], I["ret"][21].loc[day]
    why = {
        "strong_trend": lambda s: f"Trend score {S['trend'][s]:.0f}; close {(c[s] / ma50[s] - 1) * 100:+.1f}% from its 50-day average",
        "pullback_uptrend": lambda s: f"Down {abs(r5[s]) * 100:.1f}% in 5 days, trend score {S['trend'][s]:.0f}, above its 50-day average" if r5[s] < 0 else f"Up {r5[s] * 100:.1f}% in 5 days, trend score {S['trend'][s]:.0f}",
        "volume_breakout": lambda s: f"Closed above its 20-day high on {I['vol_today'].loc[day][s]:.1f}x usual volume",
        "rs_leaders": lambda s: f"Relative-strength score {S['relative_strength'][s]:.0f}; {R.comps['relative_strength'][0].raw.loc[day][s] * 100:+.1f} pts vs Nifty 50 over 3 months",
        "near_52w_high": lambda s: "At its 52-week high" if c[s] / hi[s] - 1 > -0.0005 else f"{abs(c[s] / hi[s] - 1) * 100:.1f}% below its 52-week high",
        "delivery_rise": lambda s: f"Delivery % {I['dr'].loc[day][s]:.2f}x its usual level, {r20[s] * 100:+.1f}% in 1 month",
        "steady_uptrend": lambda s: f"Stability score {S['volatility'][s]:.0f} with trend score {S['trend'][s]:.0f}",
        "weakest": lambda s: f"Overall {S['overall'][s]:.0f}; trend {S['trend'][s]:.0f}, momentum {S['momentum'][s]:.0f}",
    }
    out = []
    for id_, (title, rule) in meta.items():
        m = members[id_].loc[day]
        ser = order[id_].loc[day][m].dropna().sort_values(ascending=False).head(TOP)
        out.append({"id": id_, "title": title, "rule": rule, "count": int(m.sum()),
                    "rows": [{"symbol": s, "sector": P.sector[s], "overall": _n(S["overall"][s]), "why": why[id_](s)} for s in ser.index]})
    return out
