"""Merge data/idxopt/<day>.parquet into one clean table per underlying and write an audit.

    python data/build_idxopt_clean.py
Outputs: data/idxopt_nifty.parquet, data/idxopt_banknifty.parquet (options only: date, expiry, strike, opt_type, open, high,
low, close, settle, volume, oi, chg_oi, underlying), data/idxopt_audit.json
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import DATA_DIR  # noqa: E402

OPT_COLS = ["date", "expiry", "strike", "opt_type", "open", "high", "low", "close", "settle", "volume", "oi", "chg_oi",
            "underlying"]


def main():
    files = sorted((DATA_DIR / "idxopt").glob("*.parquet"))
    cal = sorted(pd.Timestamp(p.stem) for p in (DATA_DIR / "fo").glob("*.parquet"))
    frames = [pd.read_parquet(f) for f in files]
    allx = pd.concat(frames, ignore_index=True)
    allx["date"] = pd.to_datetime(allx["date"])
    allx["expiry"] = pd.to_datetime(allx["expiry"])
    audit = {"files": len(files), "calendar_days": len(cal), "first": str(allx.date.min().date()),
             "last": str(allx.date.max().date()),
             "calendar_days_without_file": [str(d.date()) for d in cal if f"{d:%Y-%m-%d}" not in {f.stem for f in files}][:60]}
    for sym in ("NIFTY", "BANKNIFTY"):
        o = allx[(allx.symbol == sym) & (allx.kind == "O")][OPT_COLS].copy()
        o = o.drop_duplicates(["date", "expiry", "strike", "opt_type"]).sort_values(["date", "expiry", "strike", "opt_type"])
        o.to_parquet(DATA_DIR / f"idxopt_{sym.lower()}.parquet", index=False)
        per_day = o.groupby("date").size()
        live = o[(o.oi > 0) | (o.volume > 0)]
        by_year = {}
        for y, g in o.groupby(o.date.dt.year):
            by_year[str(y)] = {"days": int(g.date.nunique()), "median_rows_per_day": int(g.groupby("date").size().median()),
                               "distinct_expiries": int(g.expiry.nunique()),
                               "median_live_contracts": int(live[live.date.dt.year == y].groupby("date").size().median())}
        # sanity: a call/put settle can never be below its intrinsic value vs the nearest-expiry parity spot proxy
        bad_nonpos = int((o.settle <= 0).sum())
        # put-call parity on live same-strike pairs of the nearest expiry: implied forward should be near-constant per day
        near = live[live.expiry == live.groupby("date").expiry.transform("min")]
        pc = near.pivot_table(index=["date", "strike"], columns="opt_type", values="settle").dropna()
        pc = pc[(pc.C > 5) & (pc.P > 5)]
        pc["fwd"] = pc.index.get_level_values("strike") + pc.C - pc.P
        spread = pc.groupby(level="date").fwd.agg(lambda s: float(s.max() - s.min()))
        audit[sym] = {"rows": int(len(o)), "days": int(o.date.nunique()), "min_rows_per_day": int(per_day.min()),
                      "settle_nonpositive_rows": bad_nonpos, "by_year": by_year,
                      "parity_forward_spread_median_pts": round(float(spread.median()), 2) if len(spread) else None,
                      "parity_days_spread_gt_100": int((spread > 100).sum()),
                      "stale_close_vs_settle_pct": round(float(((o.volume == 0) & (o.close.sub(o.settle).abs() > 1)).mean() * 100), 1),
                      "expiry_weekdays": o.drop_duplicates("expiry").expiry.dt.day_name().value_counts().to_dict()}
    (DATA_DIR / "idxopt_audit.json").write_text(json.dumps(audit, indent=1), encoding="utf-8")
    print(json.dumps({k: v for k, v in audit.items() if k not in ("NIFTY", "BANKNIFTY")}, indent=1))
    print(json.dumps({s: {k: v for k, v in audit[s].items() if k != "by_year"} for s in ("NIFTY", "BANKNIFTY")}, indent=1))


if __name__ == "__main__":
    main()
