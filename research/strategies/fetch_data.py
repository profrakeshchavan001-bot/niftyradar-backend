#!/usr/bin/env python3
"""Populate data/research_cache/ with every series the 10 strategies need.

Run: python3 research/strategies/fetch_data.py

Logs every attempt (hit/miss) to data/research_cache/FETCH_LOG.txt. Never fabricates data: a
failed fetch is logged and skipped, not filled in with synthetic prices.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from data_loader import fetch_daily, fetch_intraday, _log  # noqa: E402
from universe import MACRO_TICKERS, load_fno_universe, load_nifty200_like  # noqa: E402

INTRADAY_SAMPLE = ["^NSEI", "RELIANCE.NS", "HDFCBANK.NS", "ICICIBANK.NS", "TCS.NS", "BTC-USD"]


def main() -> None:
    _log("=== fetch_data.py run start ===")

    for name, ticker in MACRO_TICKERS.items():
        fetch_daily(ticker)

    for sym in load_nifty200_like():
        fetch_daily(f"{sym}.NS")

    for sym in load_fno_universe():
        fetch_daily(f"{sym}.NS")

    for sym in INTRADAY_SAMPLE:
        fetch_intraday(sym, "30m")
        fetch_intraday(sym, "5m")

    _log("=== fetch_data.py run end ===")


if __name__ == "__main__":
    main()
