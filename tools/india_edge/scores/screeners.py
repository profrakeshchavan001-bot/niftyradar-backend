"""Screeners driven by the scores. Public wording is data-only (no buy/sell tips).
Rule text is shown to the user (transparent); score formulas are not."""
from __future__ import annotations

import pandas as pd

TOP = 10


def _rows(P, R, day, ser: pd.Series, why, asc=False, key="overall"):
    ser = ser.dropna().sort_values(ascending=asc).head(TOP)
    return [{"symbol": s, "sector": P.sector[s], "overall": _n(R.scores["overall"].at[day, s]), "why": why(s, v)}
            for s, v in ser.items()]


def _n(x):
    return None if pd.isna(x) else int(round(x))


def run(P, R, day) -> list[dict]:
    S, I = {k: v.loc[day] for k, v in R.scores.items()}, R.extra["ind"]
    g = lambda d: d.loc[day]  # noqa: E731
    ok = R.status.loc[day] == "ok"
    c, ma50, ma200 = P.close.loc[day], g(I["ma"][50]), g(I["ma"][200])
    r5, r20 = g(I["ret"][5]), g(I["ret"][21])
    out = []

    def add(id_, title, rule, mask, rank, why, asc=False):
        m = mask.fillna(False) & ok
        out.append({"id": id_, "title": title, "rule": rule, "count": int(m.sum()),
                    "rows": _rows(P, R, day, rank[m], why, asc)})

    add("strong_trend", "Strong trend", "Trend score 75+ and overall 60+",
        (S["trend"] >= 75) & (S["overall"] >= 60), S["trend"],
        lambda s, v: f"Trend score {v:.0f}; close {((c[s] / ma50[s]) - 1) * 100:+.1f}% from its 50-day average")
    add("pullback_uptrend", "Pullback inside an uptrend", "Trend score 65+, 5-day return -2% or lower, still above the 50-day average",
        (S["trend"] >= 65) & (r5 <= -0.02) & (c > ma50), r5,
        lambda s, v: f"Down {abs(v) * 100:.1f}% in 5 days, trend score {S['trend'][s]:.0f}, above its 50-day average", asc=True)
    add("volume_breakout", "Volume breakout", "Close above the prior 20-day high on volume 1.5x the 20-day average",
        (c > g(I["hi20_prior"])) & (g(I["vol_today"]) >= 1.5), g(I["vol_today"]),
        lambda s, v: f"Closed above its 20-day high on {v:.1f}x usual volume")
    add("rs_leaders", "Relative-strength leaders", "Relative-strength score 80+ and trend score 50+",
        (S["relative_strength"] >= 80) & (S["trend"] >= 50), S["relative_strength"],
        lambda s, v: f"Relative-strength score {v:.0f}; {g(R.comps['relative_strength'][0].raw)[s] * 100:+.1f} pts vs Nifty 50 over 3 months")
    add("near_52w_high", "Near 52-week high", "Close within 3% of its 52-week high",
        (c / g(I["hi252"]) - 1) >= -0.03, c / g(I["hi252"]) - 1,
        lambda s, v: "At its 52-week high" if v > -0.0005 else f"{abs(v) * 100:.1f}% below its 52-week high")
    add("delivery_rise", "Delivery rising", "5-day delivery % at least 1.3x the prior 20-day average and a positive 20-day return",
        (g(I["dr"]) >= 1.3) & (r20 > 0), g(I["dr"]),
        lambda s, v: f"Delivery % {v:.2f}x its usual level, {r20[s] * 100:+.1f}% in 1 month")
    add("steady_uptrend", "Steady uptrends", "Stability score 70+ and trend score 60+",
        (S["volatility"] >= 70) & (S["trend"] >= 60), S["volatility"],
        lambda s, v: f"Stability score {v:.0f} with trend score {S['trend'][s]:.0f}")
    add("weakest", "Weakest scores", "Overall score 30 or lower, or trend and momentum scores both 25 or lower",
        (S["overall"] <= 30) | ((S["trend"] <= 25) & (S["momentum"] <= 25)), S["overall"],
        lambda s, v: f"Overall {v:.0f}; trend {S['trend'][s]:.0f}, momentum {S['momentum'][s]:.0f}", asc=True)
    return out
