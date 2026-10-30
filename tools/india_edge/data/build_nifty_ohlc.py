"""Merge the niftyindices.com 'NIFTY 50 Historical PR' CSV chunks (Open/High/Low/Close) and fill the gaps from the NSE
archive index close files (ind_close_all_<DDMMYYYY>.csv, which carry Open/High/Low/Close).

    python data/build_nifty_ohlc.py [--downloads ~/Downloads]
Output: data/nifty/nifty50_ohlc.csv (date,open,high,low,close,source) and data/nifty/ohlc_audit.json
"""
from __future__ import annotations

import argparse
import io
import json
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import DATA_DIR  # noqa: E402
from nsehttp import FetchError, Fetcher  # noqa: E402

URL = "https://nsearchives.nseindia.com/content/indices/ind_close_all_{dmy}.csv"


def read_chunks(folder: Path):
    frames, per_file = [], []
    for f in sorted(folder.glob("NIFTY 50_Historical_PR_*.csv")):
        d = pd.read_csv(f)
        d.columns = [c.strip() for c in d.columns]
        d["date"] = pd.to_datetime(d["Date"].str.strip(), format="%d %b %Y")
        d = d[["date", "Open", "High", "Low", "Close"]].rename(columns=str.lower)
        for c in ("open", "high", "low", "close"):
            d[c] = pd.to_numeric(d[c], errors="coerce")
        per_file.append({"file": f.name, "rows": len(d), "first": str(d.date.min().date()), "last": str(d.date.max().date())})
        frames.append(d.assign(source="niftyindices"))
    return pd.concat(frames, ignore_index=True), per_file


def sane(d: pd.DataFrame) -> pd.Series:
    hi_ok = d.high >= d[["open", "close"]].max(axis=1) - 1e-6
    lo_ok = d.low <= d[["open", "close"]].min(axis=1) + 1e-6
    return d[["open", "high", "low", "close"]].gt(0).all(axis=1) & hi_ok & lo_ok


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--downloads", default=str(Path.home() / "Downloads"))
    ap.add_argument("--delay", type=float, default=2.4)
    a = ap.parse_args(argv)
    out_dir = DATA_DIR / "nifty"
    out_dir.mkdir(parents=True, exist_ok=True)
    chunks, per_file = read_chunks(Path(a.downloads))
    audit = {"files": per_file, "chunk_rows": int(len(chunks))}
    chunks = chunks.drop_duplicates("date").sort_values("date")
    days = sorted(pd.Timestamp(p.stem) for p in (DATA_DIR / "fo").glob("*.parquet"))
    have = set(chunks.date)
    gap = [d for d in days if d not in have]
    audit["gap_days_to_fill"] = len(gap)
    fx = Fetcher(DATA_DIR / "nifty" / "raw", delay=(a.delay, a.delay + 0.8))
    rows, none = [], []
    for d in gap:
        try:
            raw = fx.get(URL.format(dmy=f"{d:%d%m%Y}"), f"ind_close_all_{d:%d%m%Y}.csv")
        except FetchError as exc:
            print(f"FETCH FAIL {d.date()}: {exc}", flush=True)
            none.append(str(d.date()) + " (fetch failed)")
            continue
        if raw is None:
            none.append(str(d.date()))
            continue
        df = pd.read_csv(io.BytesIO(raw), skipinitialspace=True)
        df.columns = [c.strip() for c in df.columns]
        r = df[df["Index Name"].astype(str).str.strip().isin(["Nifty 50", "CNX Nifty"])]  # renamed Nov 2015
        if r.empty:
            none.append(str(d.date()))
            continue
        r = r.iloc[0]
        rows.append({"date": d, "open": pd.to_numeric(r["Open Index Value"], errors="coerce"),
                     "high": pd.to_numeric(r["High Index Value"], errors="coerce"),
                     "low": pd.to_numeric(r["Low Index Value"], errors="coerce"),
                     "close": pd.to_numeric(r["Closing Index Value"], errors="coerce"), "source": "nse_archive"})
    allr = pd.concat([chunks, pd.DataFrame(rows)], ignore_index=True).sort_values("date").drop_duplicates("date")
    allr["ohlc_sane"] = sane(allr)
    # cross-check closes against the idx parquet (independent NSE index close file already stored)
    chk, diffs = [], []
    for d in allr.date.iloc[::7]:
        p = DATA_DIR / "idx" / f"{d:%Y-%m-%d}.parquet"
        if p.exists():
            x = pd.read_parquet(p)
            x = x[x.index_name.isin(["Nifty 50", "CNX Nifty"])]
            if len(x):
                diffs.append(abs(float(x.close.iloc[0]) - float(allr.loc[allr.date == d, "close"].iloc[0])))
    audit.update({
        "final_rows": int(len(allr)), "first": str(allr.date.min().date()), "last": str(allr.date.max().date()),
        "filled_from_nse_archive": int((allr.source == "nse_archive").sum()),
        "no_file_days": none, "ohlc_insane_rows": int((~allr.ohlc_sane).sum()),
        "insane_dates": [str(x.date()) for x in allr.loc[~allr.ohlc_sane, "date"]][:30],
        "open_equals_prev_close_pct": round(float((allr.open.sub(allr.close.shift(1)).abs() < 0.01).mean() * 100), 1),
        "close_crosscheck_samples": len(diffs), "close_crosscheck_max_diff": round(max(diffs), 3) if diffs else None,
        "days_in_trading_calendar_missing": [str(d.date()) for d in days if d not in set(allr.date)][:40]})
    allr.drop(columns="ohlc_sane").to_csv(out_dir / "nifty50_ohlc.csv", index=False)
    (out_dir / "ohlc_audit.json").write_text(json.dumps(audit, indent=1), encoding="utf-8")
    print(json.dumps({k: v for k, v in audit.items() if k != "files"}, indent=1))


if __name__ == "__main__":
    main()
