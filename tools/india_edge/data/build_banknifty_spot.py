"""Build data/nifty/banknifty_ohlc.csv: Nifty Bank daily close for every session that has BANKNIFTY option files.

Source: NSE index close archive rows already stored in data/idx ('Nifty Bank'). Sessions with no index row (2015 and a few
gaps) fall back to the put-call-parity spot implied by the nearest-expiry chain (S = (K + C - P) * exp(-(r-q)T)); those rows
are flagged source='parity'. Open/high/low are not available for the index: open = high = low = close here (the backtest
only uses the close of the index).
    python data/build_banknifty_spot.py
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from common import DATA_DIR  # noqa: E402

RATE, DIV = 0.065, 0.012


def idx_closes() -> dict:
    out = {}
    for p in sorted((DATA_DIR / "idx").glob("*.parquet")):
        x = pd.read_parquet(p)
        x = x[x.index_name == "Nifty Bank"]
        if len(x):
            out[pd.Timestamp(p.stem)] = float(x.close.iloc[0])
    return out


def parity_spot(d: pd.Timestamp):
    df = pd.read_parquet(DATA_DIR / "idxopt" / f"{d:%Y-%m-%d}.parquet")
    df = df[(df.symbol == "BANKNIFTY") & (df.kind == "O") & (df.oi > 0) & (df.settle > 0)].copy()
    df["expiry"] = pd.to_datetime(df.expiry)
    df = df[df.expiry > d]
    if df.empty:
        return None
    e = df.expiry.min()
    df = df[df.expiry == e]
    c = df[df.opt_type == "C"].set_index("strike").settle
    p = df[df.opt_type == "P"].set_index("strike").settle
    k = c.index.intersection(p.index)
    if len(k) == 0:
        return None
    diff = (c[k] - p[k]).abs()
    kk = diff.idxmin()
    T = max((e - d).days, 0.5) / 365.0
    return float((kk + c[kk] - p[kk]) * math.exp(-(RATE - DIV) * T))


def main():
    cl = idx_closes()
    rows = []
    for p in sorted((DATA_DIR / "idxopt").glob("*.parquet")):
        d = pd.Timestamp(p.stem)
        if d in cl:
            rows.append((d, cl[d], "nse_archive"))
        else:
            s = parity_spot(d)
            if s is not None and np.isfinite(s):
                rows.append((d, s, "parity"))
    df = pd.DataFrame(rows, columns=["date", "close", "source"])
    df["open"] = df["high"] = df["low"] = df.close
    df[["date", "open", "high", "low", "close", "source"]].to_csv(DATA_DIR / "nifty" / "banknifty_ohlc.csv", index=False)
    print(df.source.value_counts().to_dict(), df.date.min().date(), df.date.max().date())


if __name__ == "__main__":
    main()
