"""Extract STOCK option OHLC (open/high/low/close/settle) from the raw F&O bhavcopy zips.

The cleaned data/fo day files keep only close/OI for stock options; the CC4 signal backtest needs the
next-day OPEN to price an option entry. Reads data/idxopt_raw/fo_YYYYMMDD.zip (legacy and UDiFF layouts)
and writes one data/stockopt_days/<date>.parquet per trading day.

    python data/build_stockopt_ohlc.py [--workers 6]

Kept rows: stock options only, expiry <= 50 days after the trade date, strike within +-15% of the
underlying's cash close, traded or with open interest. Everything else is dropped to keep the file small.
"""
from __future__ import annotations

import argparse
import sys
import zipfile
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import DATA_DIR  # noqa: E402

COLS = ["date", "symbol", "expiry", "strike", "opt_type", "open", "high", "low", "close", "settle", "volume", "oi", "lot"]


def parse_day(path: Path) -> int:
    """Write data/stockopt_days/<YYYY-MM-DD>.parquet for one raw zip; returns rows kept (resumable)."""
    d = pd.to_datetime(path.stem.split("_")[1], format="%Y%m%d")
    target = DATA_DIR / "stockopt_days" / f"{d:%Y-%m-%d}.parquet"
    if target.exists():
        return -1
    df = _parse_raw(path)
    if df.empty:
        pd.DataFrame(columns=COLS).to_parquet(target, index=False)
        return 0
    day = f"{df['date'].iloc[0]:%Y-%m-%d}"
    u = pd.Series(np.nan, index=df.index)
    cp = DATA_DIR / "cash" / f"{day}.parquet"
    if cp.exists():
        c = pd.read_parquet(cp, columns=["symbol", "close"]).drop_duplicates("symbol").set_index("symbol")["close"]
        u = df["symbol"].map(c)
    if "under" in df:
        u = u.fillna(df["under"])
    ok = (df["strike"] / u).between(0.85, 1.15)
    out = df[ok][COLS].copy()
    out["symbol"] = out["symbol"].astype(str)
    for c in ("strike", "open", "high", "low", "close", "settle"):
        out[c] = out[c].astype("float32")
    out.to_parquet(target, index=False)
    return len(out)


def _parse_raw(path: Path) -> pd.DataFrame:
    try:
        z = zipfile.ZipFile(path)
        df = pd.read_csv(z.open(z.namelist()[0]), low_memory=False)
    except Exception:
        return pd.DataFrame(columns=COLS)
    if "INSTRUMENT" in df.columns:                      # legacy layout
        df = df[df["INSTRUMENT"] == "OPTSTK"]
        out = pd.DataFrame({
            "date": pd.to_datetime(df["TIMESTAMP"], format="%d-%b-%Y", errors="coerce"),
            "symbol": df["SYMBOL"], "expiry": pd.to_datetime(df["EXPIRY_DT"], format="%d-%b-%Y", errors="coerce"),
            "strike": df["STRIKE_PR"], "opt_type": df["OPTION_TYP"].str[0],
            "open": df["OPEN"], "high": df["HIGH"], "low": df["LOW"], "close": df["CLOSE"], "settle": df["SETTLE_PR"],
            "volume": df["CONTRACTS"], "oi": df["OPEN_INT"], "lot": np.nan})
    else:                                               # UDiFF layout
        df = df[df["FinInstrmTp"] == "STO"]
        out = pd.DataFrame({
            "date": pd.to_datetime(df["TradDt"], errors="coerce"), "symbol": df["TckrSymb"],
            "expiry": pd.to_datetime(df["XpryDt"], errors="coerce"), "strike": df["StrkPric"],
            "opt_type": df["OptnTp"].str[0], "open": df["OpnPric"], "high": df["HghPric"], "low": df["LwPric"],
            "close": df["ClsPric"], "settle": df["SttlmPric"], "volume": df["TtlTradgVol"], "oi": df["OpnIntrst"],
            "lot": df["NewBrdLotQty"]})
        out["under"] = df["UndrlygPric"].to_numpy()
    if out.empty:
        return pd.DataFrame(columns=COLS)
    out = out.dropna(subset=["date", "expiry", "strike"])
    out = out[(out["expiry"] - out["date"]).dt.days.between(0, 50) & ((out["volume"] > 0) | (out["oi"] > 0))]
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=6)
    a = ap.parse_args()
    files = sorted((DATA_DIR / "idxopt_raw").glob("fo_*.zip"))
    (DATA_DIR / "stockopt_days").mkdir(exist_ok=True)
    with ProcessPoolExecutor(a.workers) as ex:
        n = sum(max(r, 0) for r in ex.map(parse_day, files, chunksize=16))
    print(f"{n:,} rows written to {DATA_DIR / 'stockopt_days'}")


if __name__ == "__main__":
    main()
