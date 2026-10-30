"""Download NSE F&O bhavcopy day files and keep ONLY index derivatives (NIFTY, BANKNIFTY) -> data/idxopt/<day>.parquet.

fetch.py keeps only stock rows (STF/STO), which is why the first run saw no index options. Two formats:
  legacy  (< 2024-07-08) fo<DD><MON><YYYY>bhav.csv.zip   INSTRUMENT FUTIDX/OPTIDX, SETTLE_PR
  UDiFF   (>= 2024-07-08) BhavCopy_NSE_FO_0_0_0_<YYYYMMDD>_F_0000.csv.zip  FinInstrmTp IDF/IDO, SttlmPric
Raw zips are cached in data/idxopt_raw/ so a re-parse costs no requests.

    python data/fetch_idxopt.py [--from 2015-01-01] [--to 2026-10-30]
"""
from __future__ import annotations

import argparse
import io
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import DATA_DIR  # noqa: E402


def data_root():
    return DATA_DIR
from nsehttp import FetchError, Fetcher  # noqa: E402

UDIFF_START = pd.Timestamp("2024-07-08")
LEGACY = "https://nsearchives.nseindia.com/content/historical/DERIVATIVES/{yyyy}/{mon}/fo{dd}{mon}{yyyy}bhav.csv.zip"
UDIFF = "https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_{ymd}_F_0000.csv.zip"
SYMS = ("NIFTY", "BANKNIFTY")
COLS = ["date", "symbol", "kind", "expiry", "strike", "opt_type", "open", "high", "low", "close", "settle",
        "volume", "oi", "chg_oi", "underlying"]


def url_for(day: pd.Timestamp) -> str:
    if day < UDIFF_START:
        return LEGACY.format(yyyy=f"{day:%Y}", mon=f"{day:%b}".upper(), dd=f"{day:%d}")
    return UDIFF.format(ymd=f"{day:%Y%m%d}")


def parse(raw: bytes, day: pd.Timestamp) -> pd.DataFrame:
    df = pd.read_csv(io.BytesIO(raw), compression="zip", skipinitialspace=True)
    df.columns = [c.strip() for c in df.columns]
    num = lambda s: pd.to_numeric(s, errors="coerce")  # noqa: E731
    if day < UDIFF_START:
        df = df[df.INSTRUMENT.isin(["FUTIDX", "OPTIDX"]) & df.SYMBOL.isin(SYMS)]
        out = pd.DataFrame({
            "date": day, "symbol": df.SYMBOL.values,
            "kind": df.INSTRUMENT.map({"FUTIDX": "F", "OPTIDX": "O"}).values,
            "expiry": pd.to_datetime(df.EXPIRY_DT, format="mixed").dt.strftime("%Y-%m-%d").values,
            "strike": num(df.STRIKE_PR).values,
            "opt_type": df.OPTION_TYP.astype(str).str.strip().map({"CE": "C", "PE": "P"}).fillna("").values,
            "open": num(df.OPEN).values, "high": num(df.HIGH).values, "low": num(df.LOW).values,
            "close": num(df.CLOSE).values, "settle": num(df.SETTLE_PR).values,
            "volume": num(df.CONTRACTS).values, "oi": num(df.OPEN_INT).values, "chg_oi": num(df.CHG_IN_OI).values,
            "underlying": float("nan")})
    else:
        df = df[df.FinInstrmTp.isin(["IDF", "IDO"]) & df.TckrSymb.isin(SYMS)]
        out = pd.DataFrame({
            "date": day, "symbol": df.TckrSymb.values, "kind": df.FinInstrmTp.map({"IDF": "F", "IDO": "O"}).values,
            "expiry": pd.to_datetime(df.XpryDt).dt.strftime("%Y-%m-%d").values,
            "strike": num(df.StrkPric).fillna(0.0).values,
            "opt_type": df.OptnTp.map({"CE": "C", "PE": "P"}).fillna("").values,
            "open": num(df.OpnPric).values, "high": num(df.HghPric).values, "low": num(df.LwPric).values,
            "close": num(df.ClsPric).values, "settle": num(df.SttlmPric).values,
            "volume": num(df.TtlTradgVol).values, "oi": num(df.OpnIntrst).values,
            "chg_oi": num(df.ChngInOpnIntrst).values, "underlying": num(df.UndrlygPric).values})
    return out[COLS].reset_index(drop=True)


def trading_days() -> list[pd.Timestamp]:
    return sorted(pd.Timestamp(p.stem) for p in (data_root() / "fo").glob("*.parquet"))


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="start", default="2015-01-01")
    ap.add_argument("--to", dest="end", default=None)
    a = ap.parse_args(argv)
    out_dir = data_root() / "idxopt"
    out_dir.mkdir(parents=True, exist_ok=True)
    fx = Fetcher(data_root() / "idxopt_raw")
    days = [d for d in trading_days() if d >= pd.Timestamp(a.start) and (a.end is None or d <= pd.Timestamp(a.end))]
    done = bad = 0
    for d in days:
        path = out_dir / f"{d:%Y-%m-%d}.parquet"
        if path.exists():
            continue
        try:
            raw = fx.get(url_for(d), f"fo_{d:%Y%m%d}.zip")
        except FetchError as exc:
            print(f"FETCH FAIL {d.date()}: {exc}", flush=True)
            bad += 1
            continue
        if raw is None:
            print(f"no file {d.date()}", flush=True)
            bad += 1
            continue
        try:
            df = parse(raw, d)
        except Exception as exc:  # malformed day: report and keep going
            print(f"parse fail {d.date()}: {exc}", flush=True)
            bad += 1
            continue
        df.to_parquet(path, index=False)
        done += 1
        if done % 100 == 0:
            print(f"{d.date()} ok {done} (requests {fx.requests})", flush=True)
    print({"downloaded": done, "failed_or_missing": bad, "days": len(days)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
