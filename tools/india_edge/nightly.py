"""One command for the Windows nightly job (real data only).

    python nightly.py [--no-fetch] [--send]

1. downloads any missing bhavcopy days of the last 10 calendar days (incremental)
2. python run_scanner.py equivalent output (out/top5_<date>.*) for the latest day
3. run_daily: settles yesterday's desk if intraday bars exist, scans, writes web/morning_desk.json
DATA_DIR defaults to tools/india_edge/data so this never falls back to the synthetic fixtures.
"""
from __future__ import annotations

import argparse
import os
import sys

import pandas as pd

from common import ROOT


def main(argv=None) -> int:
    os.environ.setdefault("DATA_DIR", str(ROOT / "data"))
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--no-fetch", action="store_true")
    ap.add_argument("--send", action="store_true", help="send alerts (also needs TELEGRAM_ENABLED=true)")
    a = ap.parse_args(argv)
    if not a.no_fetch:
        from data.fetch import fetch_range
        today = pd.Timestamp.today().normalize()
        print("fetch:", fetch_range(today - pd.Timedelta(days=10), today))
    import run_daily
    import run_scanner
    run_scanner.run(fetch=False)
    run_daily.run(send=a.send)
    return 0


if __name__ == "__main__":
    sys.exit(main())
