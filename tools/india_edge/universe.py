"""Top-N F&O stocks by 20-day average stock-option contracts traded.

Saved to universe.json and refreshed once per calendar month (or --force).
"""
from __future__ import annotations

import argparse
import json

import pandas as pd

from common import ROOT, load_config, load_dataset

UNIVERSE_FILE = ROOT / "universe.json"


def compute_universe(fo: pd.DataFrame, asof: pd.Timestamp, size: int = 60,
                     lookback: int = 20) -> dict:
    opts = fo[(fo["instr"] == "STO") & (fo["date"] <= asof)]
    days = sorted(opts["date"].unique())[-lookback:]
    if not days:
        raise ValueError("no stock-option data on or before asof")
    opts = opts[opts["date"].isin(days)]
    per_day = opts.groupby(["symbol", "date"])["volume"].sum().unstack(fill_value=0)
    avg = per_day.reindex(columns=days, fill_value=0).mean(axis=1)
    top = avg.sort_values(ascending=False).head(size)
    return {
        "asof": f"{pd.Timestamp(asof):%Y-%m-%d}",
        "month": f"{pd.Timestamp(asof):%Y-%m}",
        "lookback_days": len(days),
        "symbols": list(top.index),
        "avg_option_contracts": {s: float(v) for s, v in top.items()},
    }


def load_universe(asof: pd.Timestamp, force: bool = False, cfg: dict | None = None) -> dict:
    """Return the cached universe if it is from asof's month, else rebuild."""
    month = f"{pd.Timestamp(asof):%Y-%m}"
    if UNIVERSE_FILE.exists() and not force:
        cached = json.loads(UNIVERSE_FILE.read_text())
        if cached.get("month") == month:
            return cached
    cfg = cfg or load_config()
    u = compute_universe(load_dataset("fo"), asof, cfg["universe"]["size"],
                         cfg["universe"]["lookback_days"])
    UNIVERSE_FILE.write_text(json.dumps(u, indent=1))
    return u


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=None)
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    fo = load_dataset("fo")
    asof = pd.Timestamp(a.date) if a.date else fo["date"].max()
    u = load_universe(asof, force=a.force)
    print(f"universe {u['asof']}: {len(u['symbols'])} symbols")
