"""Check the stored bhavcopies, retry gaps, write data/manifest.json.

    python data/verify.py [--from 2015-01-01] [--to YYYY-MM-DD] [--no-retry]

A weekday is a trading day if any dataset has a file for it (NSE answers 404 for
every file on a holiday, and holiday copies of the cash file are not stored).
A trading day missing one dataset is a gap; gaps are retried (with fetch.py's
backoff) after clearing their "known missing" mark. Nothing is ever deleted.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import DATA_DIR, DATASETS, day_file  # noqa: E402
from data import fetch  # noqa: E402

MANIFEST = DATA_DIR / "manifest.json"


def scan(start: pd.Timestamp, end: pd.Timestamp) -> tuple[list, dict]:
    """(trading days, {dataset: [missing dates]})."""
    trading, gaps = [], {n: [] for n in DATASETS}
    for d in pd.bdate_range(start, end):
        have = {n: day_file(n, d).exists() for n in DATASETS}
        if not any(have.values()):
            continue
        trading.append(d)
        for n, ok in have.items():
            if not ok:
                gaps[n].append(f"{d:%Y-%m-%d}")
    return trading, gaps


def retry(gaps: dict, log=print) -> dict:
    missing = fetch._load_missing()
    days = sorted({d for ds in gaps.values() for d in ds})
    for n, ds in gaps.items():
        for d in ds:
            missing.pop(f"{n}:{d}", None)
    fetch.MISSING_FILE.write_text(json.dumps(missing, indent=0))
    total = {"downloaded": 0, "no_file": 0, "failed": 0}
    for d in days:
        s = fetch.fetch_range(pd.Timestamp(d), pd.Timestamp(d), log=log)
        for k in total:
            total[k] += s[k]
    return total


def build_manifest(start, end, trading, gaps, retried) -> dict:
    years = {}
    for d in trading:
        y = years.setdefault(str(d.year), {"trading_days": 0, **{n: 0 for n in DATASETS}})
        y["trading_days"] += 1
        for n in DATASETS:
            y[n] += day_file(n, d).exists()
    return {
        "generated_at": pd.Timestamp.now().strftime("%Y-%m-%d %H:%M:%S"),
        "range": [f"{start:%Y-%m-%d}", f"{end:%Y-%m-%d}"],
        "trading_days": len(trading),
        "first_day": f"{trading[0]:%Y-%m-%d}" if trading else None,
        "last_day": f"{trading[-1]:%Y-%m-%d}" if trading else None,
        "files_per_year": years,
        "missing": gaps,
        "retry": retried,
        "note": "trading day = any dataset stored; idx gaps are NSE 404s, cash gaps are "
                "sessions NSE did not publish separately (e.g. Muhurat).",
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--from", dest="start", default="2015-01-01")
    ap.add_argument("--to", dest="end", default=None)
    ap.add_argument("--no-retry", action="store_true")
    a = ap.parse_args(argv)
    start = pd.Timestamp(a.start)
    end = pd.Timestamp(a.end) if a.end else pd.Timestamp.today().normalize()
    trading, gaps = scan(start, end)
    retried = None
    if not a.no_retry and any(gaps.values()):
        retried = retry(gaps)
        trading, gaps = scan(start, end)
    m = build_manifest(start, end, trading, gaps, retried)
    MANIFEST.write_text(json.dumps(m, indent=1))
    print(f"{m['trading_days']} trading days {m['first_day']}..{m['last_day']}; "
          f"gaps: " + ", ".join(f"{n} {len(v)}" for n, v in gaps.items()) + f" -> {MANIFEST}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
