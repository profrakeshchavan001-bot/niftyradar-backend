"""S2 - BTC weekly momentum.

Rule: at each week-start (Monday), compute the trailing 7-calendar-day return using only
prices dated on or before the decision day. If that return > threshold (default 0, i.e.
"strongly positive" is defined as simply positive -- documented, tunable on TRAIN only),
go long for 1 week; else stay in cash (no short, since the strategy text says "else cash").
"""
from __future__ import annotations

import pandas as pd

from costs import crypto_costs
from metrics import summarize

THRESHOLD = 0.0  # tuned conceptually on train only; 0 = "any positive 7d momentum"


def backtest_s2(daily: pd.DataFrame, capital: float = 100_000.0, threshold: float = THRESHOLD):
    close = daily["close"].dropna()
    weekly = close.resample("W-MON").last()
    if len(weekly) < 3:
        return []
    trades = []
    for i in range(1, len(weekly) - 1):
        ret_7d = weekly.iloc[i] / weekly.iloc[i - 1] - 1.0
        if ret_7d <= threshold:
            continue  # cash week, no trade
        entry_px, exit_px = float(weekly.iloc[i]), float(weekly.iloc[i + 1])
        buy_value = capital
        sell_value = capital * (exit_px / entry_px)
        c = crypto_costs(buy_value, sell_value)
        trades.append({
            "entry_date": weekly.index[i], "exit_date": weekly.index[i + 1], "side": "long",
            "entry_px": entry_px, "exit_px": exit_px,
            "pnl_inr": round((sell_value - buy_value) - c.total, 2), "costs_inr": c.total,
        })
    return trades


def run(daily_train: pd.DataFrame, daily_test: pd.DataFrame, capital: float = 100_000.0) -> dict:
    train_trades = backtest_s2(daily_train, capital)
    test_trades = backtest_s2(daily_test, capital)
    return {"train": summarize(train_trades, capital), "test": summarize(test_trades, capital),
            "train_trades": train_trades, "test_trades": test_trades}
