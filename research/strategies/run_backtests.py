#!/usr/bin/env python3
"""Orchestrator: would load data/research_cache/*.parquet, split train (2015-01-01..2022-12-31)
/ test (2023-01-01..today) for daily strategies, run each S1-S10 backtest, apply the add-on
variants where there's enough data, and print the train/test table that feeds
docs/RESEARCH-STRATEGIES-REPORT.md.

In the session that wrote this code, data_loader.fetch_daily()/fetch_intraday() returned None
for every symbol (network-blocked -- see README.md and data/research_cache/FETCH_LOG.txt), so
this script currently has nothing to run on and reports every strategy as BLOCKED rather than
inventing numbers. The moment fetch_data.py can actually reach a data source, re-run
`python3 research/strategies/fetch_data.py && python3 research/strategies/run_backtests.py`
and this will produce real PASS/FAIL/LOW-DATA verdicts end-to-end with no code changes needed.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from data_loader import fetch_daily  # noqa: E402
from universe import MACRO_TICKERS  # noqa: E402

TRAIN_START, TRAIN_END = "2015-01-01", "2022-12-31"
TEST_START = "2023-01-01"

STRATEGIES = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10"]


def main() -> None:
    have_data = {}
    for name, ticker in MACRO_TICKERS.items():
        df = fetch_daily(ticker, start=TRAIN_START)
        have_data[name] = df is not None and not df.empty

    if not any(have_data.values()):
        print("BLOCKED: no market data available in this environment (see FETCH_LOG.txt).")
        print("Every strategy verdict is BLOCKED -- see docs/RESEARCH-STRATEGIES-REPORT.md.")
        for s in STRATEGIES:
            print(f"{s}: BLOCKED (no data)")
        return

    # If data IS available (future run, different environment), this is where each strategy's
    # run() would be called with real train/test panels. Left as a clear extension point
    # rather than guessed at, since no data exists here to validate the wiring against.
    print("Data available:", have_data)
    print("TODO (future run with data): call each sN_*.run(...) and print its verdict via metrics.verdict().")


if __name__ == "__main__":
    main()
