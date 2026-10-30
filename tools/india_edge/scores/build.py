"""Build the browser-safe JSON. PUBLIC output holds scores, plain sentences and the plain readings per
component; never weights, thresholds or formulas. Run:  python -m scores.run  (see run.py)."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from scores import engine, feargreed, health, rotation, screeners

DISCLAIMER = "Historical statistics for education only. Not investment advice."
SCHEMA = 1


def _int(x):
    return None if pd.isna(x) else int(round(x))


def stock_card(P, R, s, day, cfg) -> dict:
    out = {"symbol": s, "sector": P.sector[s], "status": R.status.at[day, s], "scores": {}}
    if out["status"] != "ok":
        out["note"] = {"new_listing": "Too little price history for a reliable score.",
                       "suspended": "No trade print on the latest day.",
                       "illiquid": "Too many zero-volume days recently.",
                       "not_listed": "Not listed in this window.",
                       "not_in_universe": "Not in the F&O list on this date."}[out["status"]]
        return out
    for k in (*engine.NAMES, "overall"):
        if k not in R.scores:
            continue
        v = R.scores[k].at[day, s]
        if pd.isna(v):
            continue
        b = engine.band(v, cfg)
        card = {"score": _int(v), "band": b, "says": engine.says(k, b)}
        if k != "overall":
            card["components"] = [{"name": c.name, "reading": c.fmt(c.raw.at[day, s]), "score": _int(c.score.at[day, s])}
                                  for c in R.comps[k] if not pd.isna(c.raw.at[day, s]) and not pd.isna(c.score.at[day, s])]
        else:
            card["coverage"] = int(R.extra["coverage"].at[day, s])
        out["scores"][k] = card
    return out


def build(P, cfg=None, day=None) -> dict:
    cfg = cfg or engine.load_cfg()
    R = engine.compute(P, cfg)
    day = pd.Timestamp(day) if day is not None else P.dates[-1]
    if day not in P.dates:
        raise ValueError(f"{day:%Y-%m-%d} is not a trading day in the data")
    cards = [stock_card(P, R, s, day, cfg) for s in P.symbols if R.status.at[day, s] not in ("not_listed", "not_in_universe")]
    scored = sorted([c for c in cards if c["status"] == "ok" and "overall" in c["scores"]],
                    key=lambda c: -c["scores"]["overall"]["score"])
    d = f"{day:%Y-%m-%d}"
    h = health.check(P, R, day)
    return {
        "scores": {"schema": SCHEMA, "date": d, "stocks": cards, "disclaimer": DISCLAIMER},
        "screeners": {"schema": SCHEMA, "date": d, "screeners": screeners.run(P, R, day), "disclaimer": DISCLAIMER},
        "rotation": {"schema": SCHEMA, "date": d, "sectors": rotation.board(P, R, day, cfg), "disclaimer": DISCLAIMER},
        "feargreed": {"schema": SCHEMA, "date": d, **feargreed.public(P, R, day, cfg), "disclaimer": DISCLAIMER},
        "health": {"schema": SCHEMA, "date": d, **h},
        "overview": {"schema": SCHEMA, "date": d, "scored": len(scored), "top": scored[:8], "bottom": scored[-5:][::-1],
                     "avg_overall": None if not scored else int(round(np.mean([c["scores"]["overall"]["score"] for c in scored]))),
                     "health_grade": h["grade"], "disclaimer": DISCLAIMER},
    }, R


def write(out: dict, directory: Path) -> list[str]:
    directory.mkdir(parents=True, exist_ok=True)
    for k, v in out.items():
        (directory / f"{k}.json").write_text(json.dumps(v, indent=1, allow_nan=False))
    return sorted(out)
