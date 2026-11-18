#!/usr/bin/env python3
"""Fetch NSE F&O bhavcopy (Nifty/Bank Nifty options + spot) and India VIX, 2019-today.

Never fabricates data: every miss is logged to FETCH_LOG.txt and skipped, not filled in.
Run from repo root: python3 research/options_promoter/nse_fno_fetcher.py
"""
from __future__ import annotations

import datetime as dt
from pathlib import Path

CACHE_DIR = Path(__file__).resolve().parents[2] / "data" / "options_promoter_cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)
FETCH_LOG = CACHE_DIR / "FETCH_LOG.txt"

NSE_BHAVCOPY_URL = (
    "https://archives.nseindia.com/content/historical/DERIVATIVES/{yyyy}/{mon}/"
    "fo{dd}{mon}{yyyy}bhav.csv.zip"
)
NSE_VIX_URL = "https://www.nseindia.com/api/historicalOR/vixhistory"
NSE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (research backtest; contact via repo issues)",
    "Accept": "application/json,text/csv,*/*",
}


def _log(msg: str) -> None:
    ts = dt.datetime.utcnow().isoformat() + "Z"
    with open(FETCH_LOG, "a") as f:
        f.write(f"[{ts}] {msg}\n")
    print(msg)


def fetch_one_day_bhavcopy(date: dt.date, session=None):
    """Download one day's F&O bhavcopy CSV (zipped). Returns the raw bytes or None on failure."""
    import requests

    session = session or requests.Session()
    url = NSE_BHAVCOPY_URL.format(
        yyyy=date.year, mon=date.strftime("%b").upper(), dd=f"{date.day:02d}"
    )
    try:
        resp = session.get(url, headers=NSE_HEADERS, timeout=15)
        if resp.status_code != 200 or not resp.content:
            _log(f"BLOCKED: {url} -> HTTP {resp.status_code}")
            return None
        _log(f"fetched bhavcopy {date.isoformat()}: {len(resp.content)} bytes")
        return resp.content
    except Exception as exc:  # network/proxy failures of any kind
        _log(f"BLOCKED: {url} -> {exc!r}")
        return None


def fetch_india_vix_history(session=None):
    import requests

    session = session or requests.Session()
    try:
        resp = session.get(NSE_VIX_URL, headers=NSE_HEADERS, timeout=15)
        if resp.status_code != 200:
            _log(f"BLOCKED: {NSE_VIX_URL} -> HTTP {resp.status_code}")
            return None
        _log(f"fetched India VIX history: {len(resp.content)} bytes")
        return resp.json()
    except Exception as exc:
        _log(f"BLOCKED: {NSE_VIX_URL} -> {exc!r}")
        return None


def main() -> None:
    _log("=== nse_fno_fetcher.py run start ===")
    import requests

    session = requests.Session()
    start = dt.date(2019, 1, 1)
    end = dt.date.today()
    day = start
    ok, blocked = 0, 0
    while day <= end:
        if day.weekday() < 5:  # Mon-Fri only
            content = fetch_one_day_bhavcopy(day, session)
            if content is None:
                blocked += 1
                if blocked == 1:
                    _log("First bhavcopy day failed -- stopping the sweep (every later day will "
                         "fail the same way if this is a proxy/host block, not a holiday).")
                    break
            else:
                ok += 1
                out = CACHE_DIR / f"fo_bhav_{day.isoformat()}.csv.zip"
                out.write_bytes(content)
        day += dt.timedelta(days=1)
    vix = fetch_india_vix_history(session)
    _log(f"=== nse_fno_fetcher.py run end: {ok} days ok, {blocked} blocked, "
         f"vix={'ok' if vix else 'blocked'} ===")


if __name__ == "__main__":
    main()
