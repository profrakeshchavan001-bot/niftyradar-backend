"""Memory-light market loader for the CC4 signal backtest.

The raw data/fo day files hold every strike of every expiry (about 100M rows for 2015-now), too big to
concatenate on a normal PC. Layer 1 only needs per-symbol sums, so each day file is aggregated on read:
  STF  oi, chg_oi, volume summed over expiries
  STO  oi, volume summed; chg_oi = sum of ABS(chg_oi)  (features.py takes abs() per row, then sums)
The aggregate is cached in data/fo_agg.parquet.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import DATA_DIR  # noqa: E402
from loader import Market, _opt, read_days  # noqa: E402


def aggregate_fo_day(df: pd.DataFrame) -> pd.DataFrame:
    df = df[df["instr"].isin(["STF", "STO"])].copy()
    df["chg_oi"] = df["chg_oi"].where(df["instr"] == "STF", df["chg_oi"].abs())
    g = df.groupby(["date", "instr", "symbol"], as_index=False)[["oi", "chg_oi", "volume"]].sum()
    g["expiry"], g["strike"], g["opt_type"], g["close"] = "", float("nan"), "", float("nan")
    return g


def load_fo_agg() -> pd.DataFrame:
    cache = DATA_DIR / "fo_agg.parquet"
    if cache.exists():
        return pd.read_parquet(cache)
    parts = []
    for f in sorted((DATA_DIR / "fo").glob("*.parquet")):
        try:
            d = pd.read_parquet(f)
        except Exception:
            continue
        if len(d):
            parts.append(aggregate_fo_day(d))
    out = pd.concat(parts, ignore_index=True)
    out["date"] = pd.to_datetime(out["date"])
    out.to_parquet(cache, index=False)
    return out


def load_market_light() -> Market:
    """Sanitised market restricted to stocks that were ever in the F&O segment (the only ones any signal can
    trade). The sanitised result is cached in data/sig_cache_*.parquet because the full cash set is ~7M rows."""
    from robust import sanitize_market
    cc, ci = DATA_DIR / "sig_cache_cash.parquet", DATA_DIR / "sig_cache_idx.parquet"
    if cc.exists() and ci.exists():
        m = Market(pd.read_parquet(cc), load_fo_agg(), pd.read_parquet(ci), pd.DataFrame(), pd.DataFrame(), "real")
        m.health_notes = {"cache": True}
        return m
    errors: list = []
    cash, idx = read_days("cash", errors), read_days("idx", errors)
    fo = load_fo_agg()
    ever = set(fo["symbol"].unique())
    cash = cash[cash["symbol"].isin(ever)].copy()
    m = Market(cash, fo, idx, _opt(DATA_DIR / "iv.parquet"), _opt(DATA_DIR / "events.csv", csv=True), "real")
    m = sanitize_market(m, load_errors=errors)
    m.cash.to_parquet(cc, index=False)
    m.idx.to_parquet(ci, index=False)
    return m
