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


def run(P, R, day, T: dict | None = None) -> list[dict]:
    from scores import engine
    T = T or engine.load_cfg()["screeners"]
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

    add("strong_trend", "Strong trend", f"Trend score {T['strong_trend']:g}+ and overall {T['strong_overall']:g}+",
        (S["trend"] >= T["strong_trend"]) & (S["overall"] >= T["strong_overall"]), S["trend"],
        lambda s, v: f"Trend score {v:.0f}; close {((c[s] / ma50[s]) - 1) * 100:+.1f}% from its 50-day average")
    add("pullback_uptrend", "Pullback inside an uptrend", f"Trend score {T['pullback_trend']:g}+, 5-day return -{T['pullback_drop'] * 100:g}% or lower, still above the 50-day average",
        (S["trend"] >= T["pullback_trend"]) & (r5 <= -T["pullback_drop"]) & (c > ma50), r5,
        lambda s, v: f"Down {abs(v) * 100:.1f}% in 5 days, trend score {S['trend'][s]:.0f}, above its 50-day average", asc=True)
    add("volume_breakout", "Volume breakout", f"Close above the prior 20-day high on volume {T['breakout_volume']:g}x the 20-day average",
        (c > g(I["hi20_prior"])) & (g(I["vol_today"]) >= T["breakout_volume"]), g(I["vol_today"]),
        lambda s, v: f"Closed above its 20-day high on {v:.1f}x usual volume")
    add("rs_leaders", "Relative-strength leaders", f"Relative-strength score {T['rs_score']:g}+ and trend score {T['rs_trend']:g}+",
        (S["relative_strength"] >= T["rs_score"]) & (S["trend"] >= T["rs_trend"]), S["relative_strength"],
        lambda s, v: f"Relative-strength score {v:.0f}; {g(R.comps['relative_strength'][0].raw)[s] * 100:+.1f} pts vs Nifty 50 over 3 months")
    add("near_52w_high", "Near 52-week high", f"Close within {T['near_high'] * 100:g}% of its 52-week high",
        (c / g(I["hi252"]) - 1) >= -T["near_high"], c / g(I["hi252"]) - 1,
        lambda s, v: "At its 52-week high" if v > -0.0005 else f"{abs(v) * 100:.1f}% below its 52-week high")
    add("delivery_rise", "Delivery rising", f"5-day delivery % at least {T['delivery_ratio']:g}x the prior 20-day average and a positive 20-day return",
        (g(I["dr"]) >= T["delivery_ratio"]) & (r20 > 0), g(I["dr"]),
        lambda s, v: f"Delivery % {v:.2f}x its usual level, {r20[s] * 100:+.1f}% in 1 month")
    add("steady_uptrend", "Steady uptrends", f"Stability score {T['steady_stability']:g}+ and trend score {T['steady_trend']:g}+",
        (S["volatility"] >= T["steady_stability"]) & (S["trend"] >= T["steady_trend"]), S["volatility"],
        lambda s, v: f"Stability score {v:.0f} with trend score {S['trend'][s]:.0f}")
    add("weakest", "Weakest scores", f"Overall score {T['weak_overall']:g} or lower, or trend and momentum scores both {T['weak_both']:g} or lower",
        (S["overall"] <= T["weak_overall"]) | ((S["trend"] <= T["weak_both"]) & (S["momentum"] <= T["weak_both"])), S["overall"],
        lambda s, v: f"Overall {v:.0f}; trend {S['trend'][s]:.0f}, momentum {S['momentum'][s]:.0f}", asc=True)
    return out
