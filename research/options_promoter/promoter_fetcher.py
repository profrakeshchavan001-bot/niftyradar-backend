#!/usr/bin/env python3
"""Fetch NSE + BSE promoter/promoter-group insider-trading disclosures, 2015-today, plus daily
prices for the disclosed stocks (via the shared yfinance loader).

Never fabricates data: every miss is logged and skipped.
Run from repo root: python3 research/options_promoter/promoter_fetcher.py
"""
from __future__ import annotations

import datetime as dt
from pathlib import Path

CACHE_DIR = Path(__file__).resolve().parents[2] / "data" / "options_promoter_cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)
FETCH_LOG = CACHE_DIR / "FETCH_LOG.txt"

# NSE's public "insider trading (SAST/PIT)" disclosure feed.
NSE_INSIDER_URL = "https://www.nseindia.com/api/corporate-insider-trading"
# BSE's public corp-announcements feed, filtered to insider-trading disclosures.
BSE_INSIDER_URL = "https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w"
NSE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (research backtest; contact via repo issues)",
    "Accept": "application/json,*/*",
}


def _log(msg: str) -> None:
    ts = dt.datetime.utcnow().isoformat() + "Z"
    with open(FETCH_LOG, "a") as f:
        f.write(f"[{ts}] {msg}\n")
    print(msg)


def fetch_nse_insider_disclosures(from_date: dt.date, to_date: dt.date, session=None):
    import requests

    session = session or requests.Session()
    params = {
        "index": "equities",
        "from_date": from_date.strftime("%d-%m-%Y"),
        "to_date": to_date.strftime("%d-%m-%Y"),
    }
    try:
        # NSE requires a warm-up GET to the homepage first to get cookies.
        session.get("https://www.nseindia.com", headers=NSE_HEADERS, timeout=15)
        resp = session.get(NSE_INSIDER_URL, headers=NSE_HEADERS, params=params, timeout=15)
        if resp.status_code != 200:
            _log(f"BLOCKED: {NSE_INSIDER_URL} {params} -> HTTP {resp.status_code}")
            return None
        data = resp.json()
        _log(f"fetched NSE insider disclosures {from_date}..{to_date}: "
             f"{len(data.get('data', []))} rows")
        return data
    except Exception as exc:
        _log(f"BLOCKED: {NSE_INSIDER_URL} {params} -> {exc!r}")
        return None


def fetch_bse_insider_disclosures(from_date: dt.date, to_date: dt.date, session=None):
    import requests

    session = session or requests.Session()
    params = {
        "strCat": "-1",
        "strPrevDate": from_date.strftime("%Y%m%d"),
        "strScrip": "",
        "strSearch": "P",
        "strToDate": to_date.strftime("%Y%m%d"),
        "strType": "C",
    }
    try:
        resp = session.get(BSE_INSIDER_URL, headers=NSE_HEADERS, params=params, timeout=15)
        if resp.status_code != 200:
            _log(f"BLOCKED: {BSE_INSIDER_URL} {params} -> HTTP {resp.status_code}")
            return None
        data = resp.json()
        _log(f"fetched BSE insider disclosures {from_date}..{to_date}: rows ok")
        return data
    except Exception as exc:
        _log(f"BLOCKED: {BSE_INSIDER_URL} {params} -> {exc!r}")
        return None


def main() -> None:
    _log("=== promoter_fetcher.py run start ===")
    import requests

    session = requests.Session()
    start, end = dt.date(2015, 1, 1), dt.date.today()
    # NSE's endpoint only accepts short windows; sweep year by year.
    year = start.year
    any_ok = False
    while year <= end.year:
        y_from = dt.date(year, 1, 1)
        y_to = min(dt.date(year, 12, 31), end)
        nse_data = fetch_nse_insider_disclosures(y_from, y_to, session)
        if nse_data:
            any_ok = True
            out = CACHE_DIR / f"nse_insider_{year}.json"
            import json
            out.write_text(json.dumps(nse_data))
        else:
            _log(f"NSE insider feed blocked for {year} -- stopping the NSE sweep.")
            break
        year += 1
    bse_data = fetch_bse_insider_disclosures(start, end, session)
    if bse_data:
        any_ok = True
        import json
        (CACHE_DIR / "bse_insider_all.json").write_text(json.dumps(bse_data))
    _log(f"=== promoter_fetcher.py run end: any_ok={any_ok} ===")


if __name__ == "__main__":
    main()
