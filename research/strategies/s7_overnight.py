"""S7 - Overnight: buy Nifty at close, sell at next day's open. Always-on, no signal (so no
lookahead question arises: both prices used for a given trade are already known by the time
the position is closed, and the entry close itself is known at entry time)."""
from __future__ import annotations

import pandas as pd

from costs import index_spot_proxy_costs
from metrics import summarize


def backtest_s7(daily: pd.DataFrame, capital: float = 100_000.0):
    df = daily.dropna(subset=["open", "close"])
    trades = []
    idx = df.index
    for i in range(len(idx) - 1):
        entry_px = float(df["close"].iloc[i])
        exit_px = float(df["open"].iloc[i + 1])
        buy_value, sell_value = capital, capital * (exit_px / entry_px)
        c = index_spot_proxy_costs(buy_value, sell_value)
        trades.append({
            "entry_date": idx[i], "exit_date": idx[i + 1], "side": "long",
            "entry_px": entry_px, "exit_px": exit_px,
            "pnl_inr": round((sell_value - buy_value) - c.total, 2), "costs_inr": c.total,
        })
    return trades


def run(daily_train: pd.DataFrame, daily_test: pd.DataFrame, capital: float = 100_000.0) -> dict:
    train_trades = backtest_s7(daily_train, capital)
    test_trades = backtest_s7(daily_test, capital)
    return {"train": summarize(train_trades, capital), "test": summarize(test_trades, capital),
            "train_trades": train_trades, "test_trades": test_trades}
