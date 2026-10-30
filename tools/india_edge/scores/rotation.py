"""Sector rotation board: 4 stages from 20-day strength vs Nifty and its 5-day change."""
from __future__ import annotations

import pandas as pd

STAGES = {(True, True): "Leading", (True, False): "Weakening",
          (False, True): "Improving", (False, False): "Lagging"}
STAGE_SAYS = {"Leading": "Ahead of the market and gaining", "Weakening": "Ahead of the market but losing pace",
              "Improving": "Behind the market but gaining", "Lagging": "Behind the market and losing pace"}


def board(p: dict, f: dict, day: pd.Timestamp) -> list[dict]:
    rel = (f["ret"][20].sub(f["nret"][20], axis=0))
    sec = rel.T.groupby(p["sector"]).mean().T          # date x sector
    now, prev = sec.loc[day], sec.shift(5).loc[day]
    rows = []
    for s in sec.columns:
        if pd.isna(now[s]) or pd.isna(prev[s]):
            continue
        stage = STAGES[(bool(now[s] >= 0), bool(now[s] - prev[s] >= 0))]
        rows.append({"sector": s, "stage": stage, "says": STAGE_SAYS[stage],
                     "strength": round(float(now[s]), 1), "change": round(float(now[s] - prev[s]), 1)})
    return sorted(rows, key=lambda r: -r["strength"])
