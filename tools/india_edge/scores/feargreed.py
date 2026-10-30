"""Fear/greed meter 0-100 from five market readings. Public output: value, label, plain facts."""
from __future__ import annotations

import numpy as np
import pandas as pd

LABELS = [(25, "Extreme fear"), (45, "Fear"), (55, "Neutral"), (75, "Greed"), (101, "Extreme greed")]


def label(x: float) -> str:
    return next(n for t, n in LABELS if x < t)


def _lin(x, lo, hi) -> float:
    return float(np.clip((x - lo) / (hi - lo), 0, 1) * 100)


def meter(p: dict, f: dict, day: pd.Timestamp) -> dict:
    c, n, vix = p["close"].loc[day], p["nifty"], p["vix"]
    n125 = n.rolling(125, min_periods=60).mean()
    parts = {
        "Nifty vs 125-day average": _lin((n.loc[day] / n125.loc[day] - 1) * 100, -6, 6),
        "Stocks above 50-day average": _lin((c > f["ma"][50].loc[day]).mean() * 100, 20, 80),
        "Stocks near 52-week high vs low": _lin(
            ((c - f["lo52"].loc[day]) / (f["hi52"].loc[day] - f["lo52"].loc[day])).mean() * 100, 25, 75),
        "India VIX vs its 50-day average": _lin(-(vix.loc[day] / vix.rolling(50, min_periods=20).mean().loc[day] - 1) * 100, -25, 25),
        "Nifty 20-day momentum": _lin(n.pct_change(20, fill_method=None).loc[day] * 100, -5, 5),
    }
    val = int(round(float(np.mean(list(parts.values())))))
    return {"value": val, "label": label(val),
            "parts": [{"name": k, "value": int(round(v)), "label": label(v)} for k, v in parts.items()]}
