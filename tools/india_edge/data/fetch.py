"""Download NSE daily bhavcopies (cash+delivery, F&O, index closes) to parquet.

    python data/fetch.py --from 2026-09-01 --to 2026-10-28

Incremental: a day already stored is skipped. Weekends are skipped; days NSE
answers 404 for (holidays) are remembered in data/.missing.json so they are
not retried once they are old enough that the file can no longer be "late".
"""
from __future__ import annotations

import argparse
import io
import json
import random
import sys
import time
from pathlib import Path

import pandas as pd
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import DATA_DIR, day_file  # noqa: E402

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/csv,application/zip,application/octet-stream,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.nseindia.com/all-reports",
}
URLS = {
    "cash": "https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_{dmy}.csv",
    "fo": "https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_{ymd}_F_0000.csv.zip",
    "idx": "https://nsearchives.nseindia.com/content/indices/ind_close_all_{dmy}.csv",
}
MISSING_FILE = DATA_DIR / ".missing.json"
MISSING_AFTER_DAYS = 4  # a 404 older than this is a holiday, not "not published yet"
POLITE_DELAY = 1.0


# ---------------------------------------------------------------- parsing
def parse_cash(raw: bytes, day: pd.Timestamp) -> pd.DataFrame:
    df = pd.read_csv(io.BytesIO(raw), skipinitialspace=True)
    df.columns = [c.strip() for c in df.columns]
    df = df[df["SERIES"].astype(str).str.strip() == "EQ"].copy()
    num = lambda c: pd.to_numeric(df[c], errors="coerce")  # noqa: E731
    out = pd.DataFrame({
        "date": day,
        "symbol": df["SYMBOL"].astype(str).str.strip(),
        "prev_close": num("PREV_CLOSE"),
        "open": num("OPEN_PRICE"),
        "high": num("HIGH_PRICE"),
        "low": num("LOW_PRICE"),
        "close": num("CLOSE_PRICE"),
        "volume": num("TTL_TRD_QNTY"),
        "deliv_qty": num("DELIV_QTY"),
        "deliv_pct": num("DELIV_PER"),
    })
    return out.reset_index(drop=True)


def parse_fo(raw: bytes, day: pd.Timestamp) -> pd.DataFrame:
    """UDiFF F&O bhavcopy; keeps stock futures (STF) and stock options (STO)."""
    df = pd.read_csv(io.BytesIO(raw), compression="zip")
    df = df[df["FinInstrmTp"].isin(["STF", "STO"])].copy()
    num = lambda c: pd.to_numeric(df[c], errors="coerce")  # noqa: E731
    out = pd.DataFrame({
        "date": day,
        "instr": df["FinInstrmTp"].values,
        "symbol": df["TckrSymb"].astype(str).str.strip().values,
        "expiry": df["XpryDt"].astype(str).values,
        "strike": num("StrkPric").values,
        "opt_type": df["OptnTp"].astype(str).values,
        "close": num("ClsPric").values,
        "oi": num("OpnIntrst").values,
        "chg_oi": num("ChngInOpnIntrst").values,
        "volume": num("TtlTradgVol").values,
    })
    return out.reset_index(drop=True)


def parse_idx(raw: bytes, day: pd.Timestamp) -> pd.DataFrame:
    df = pd.read_csv(io.BytesIO(raw), skipinitialspace=True)
    df.columns = [c.strip() for c in df.columns]
    return pd.DataFrame({
        "date": day,
        "index_name": df["Index Name"].astype(str).str.strip(),
        "close": pd.to_numeric(df["Closing Index Value"], errors="coerce"),
    })


PARSERS = {"cash": parse_cash, "fo": parse_fo, "idx": parse_idx}


# ---------------------------------------------------------------- network
def make_session() -> requests.Session:
    s = requests.Session()
    s.headers.update(HEADERS)
    try:  # cookie warm-up; NSE sometimes rejects cookie-less clients
        s.get("https://www.nseindia.com", timeout=20)
    except requests.RequestException:
        pass
    return s


def download(session: requests.Session, url: str, retries: int = 4) -> bytes | None:
    """Return body bytes, None for 404 (no file for that day). Raises after retries."""
    delay = 2.0
    last: Exception | None = None
    for _ in range(retries):
        try:
            r = session.get(url, timeout=45)
            if r.status_code == 404:
                return None
            if r.status_code == 200 and r.content:
                return r.content
            last = RuntimeError(f"HTTP {r.status_code} for {url}")
        except requests.RequestException as exc:
            last = exc
        time.sleep(delay + random.uniform(0, 1))
        delay *= 2
    raise RuntimeError(f"giving up on {url}: {last}")


# ---------------------------------------------------------------- driver
def _load_missing() -> dict:
    try:
        return json.loads(MISSING_FILE.read_text())
    except (OSError, ValueError):
        return {}


def fetch_range(start: pd.Timestamp, end: pd.Timestamp, log=print) -> dict:
    missing = _load_missing()
    today = pd.Timestamp.today().normalize()
    stats = {"downloaded": 0, "skipped": 0, "no_file": 0, "failed": 0}
    session = None
    for day in pd.date_range(start, end, freq="D"):
        if day.weekday() >= 5:
            continue
        for name, url_t in URLS.items():
            path = day_file(name, day)
            key = f"{name}:{day:%Y-%m-%d}"
            if path.exists() or key in missing:
                stats["skipped"] += 1
                continue
            session = session or make_session()
            url = url_t.format(dmy=f"{day:%d%m%Y}", ymd=f"{day:%Y%m%d}")
            try:
                raw = download(session, url)
            except RuntimeError as exc:
                log(f"FAIL {key}: {exc}")
                stats["failed"] += 1
                continue
            time.sleep(POLITE_DELAY)
            if raw is None:
                stats["no_file"] += 1
                if (today - day).days > MISSING_AFTER_DAYS:
                    missing[key] = True
                continue
            try:
                PARSERS[name](raw, day).to_parquet(path, index=False)
                stats["downloaded"] += 1
                log(f"ok   {key}")
            except Exception as exc:  # malformed file: report, keep going
                log(f"FAIL {key}: parse error {exc}")
                stats["failed"] += 1
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    MISSING_FILE.write_text(json.dumps(missing, indent=0))
    return stats


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--from", dest="start", required=True, help="YYYY-MM-DD")
    ap.add_argument("--to", dest="end", default=None, help="YYYY-MM-DD (default today)")
    a = ap.parse_args(argv)
    end = pd.Timestamp(a.end) if a.end else pd.Timestamp.today().normalize()
    stats = fetch_range(pd.Timestamp(a.start), end)
    print(stats)
    return 1 if stats["failed"] else 0


if __name__ == "__main__":
    sys.exit(main())
