"""8 transparent screeners. Each row carries a one-line 'why this stock is listed'.

Screener criteria are plain and shown to the user; score formulas are not.
Statistics only, not advice.
"""
from __future__ import annotations

import pandas as pd

TOP = 8
SCREENERS = [
    ("near_52w_high", "Near 52-week high", "Closing within 3% of the 52-week high"),
    ("volume_surge", "Volume surge", "5-day average volume at least 1.8x the prior 20-day average"),
    ("delivery_rise", "Delivery rising", "5-day delivery % at least 1.2x the prior 20-day average"),
    ("momentum_leaders", "Momentum leaders", "Top-ranked 3-month return in the group"),
    ("rs_leaders", "Outperforming Nifty", "3-month return ahead of the Nifty 50 by 5+ points"),
    ("sector_leaders", "Sector leaders", "Best overall score inside the strongest sector"),
    ("dip_in_uptrend", "Dip within uptrend", "Down 3%+ in 5 days while above the 50-day average"),
    ("weak_and_falling", "Weak and falling", "Below the 50-day average and down 8%+ in 20 days"),
]


def run(p: dict, f: dict, scores: pd.DataFrame, day: pd.Timestamp) -> list[dict]:
    c = p["close"].loc[day]
    g = lambda k: f[k].loc[day]  # noqa: E731
    r5, r20, r63 = (f["ret"][k].loc[day] for k in (5, 20, 63))
    rs63 = r63 - f["nret"][63].loc[day]
    dist_hi = (g("hi52") - c) / g("hi52") * 100
    ma50 = f["ma"][50].loc[day]
    top_sector = scores.groupby("sector")["overall"].mean().idxmax()
    cand = {
        "near_52w_high": (dist_hi[dist_hi <= 3], lambda s, v: "Closed at its 52-week high" if v < 0.05 else f"Closed {v:.1f}% below its 52-week high", False),
        "volume_surge": (g("vol_ratio")[g("vol_ratio") >= 1.8], lambda s, v: f"Volume {v:.1f}x its usual level", True),
        "delivery_rise": (g("deliv_ratio")[g("deliv_ratio") >= 1.2], lambda s, v: f"Delivery % {v:.2f}x its usual level", True),
        "momentum_leaders": (r63, lambda s, v: f"3-month return {v:+.1f}%", True),
        "rs_leaders": (rs63[rs63 >= 5], lambda s, v: f"{v:+.1f} points ahead of the Nifty 50 over 3 months", True),
        "sector_leaders": (scores[scores["sector"] == top_sector]["overall"],
                           lambda s, v: f"Overall score {v:.0f}, in {top_sector}, the highest-scoring sector", True),
        "dip_in_uptrend": (r5[(r5 <= -3) & (c > ma50)], lambda s, v: f"{v:+.1f}% in 5 days, still above its 50-day average", False),
        "weak_and_falling": (r20[(c < ma50) & (r20 <= -8)], lambda s, v: f"{v:+.1f}% in 20 days, below its 50-day average", False),
    }
    out = []
    for key, title, rule in SCREENERS:
        ser, why, desc = cand[key]
        ser = ser.dropna().sort_values(ascending=not desc).head(TOP)
        out.append({"id": key, "title": title, "rule": rule,
                    "rows": [{"symbol": s, "sector": p["sector"][s], "why": why(s, float(v))}
                             for s, v in ser.items()]})
    return out
