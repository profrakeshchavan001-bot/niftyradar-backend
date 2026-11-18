"""S8 - Last-30min momentum (Nifty). Signal = sign(close[15:00] / prev_close - 1), decided and
executed starting exactly at 15:00 using only the 15:00 bar and the prior day's close (both
already known at 15:00) -- trade window 15:00-15:30."""
from __future__ import annotations

import pandas as pd

from costs import index_spot_proxy_costs
from metrics import summarize


def backtest_s8(intraday_30m: pd.DataFrame, capital: float = 100_000.0):
    df = intraday_30m.copy()
    df["date"] = df.index.date
    df["tod"] = df.index.strftime("%H:%M")
    days = sorted(df["date"].unique())
    trades = []
    prev_close = None
    for d in days:
        day_df = df[df["date"] == d]
        row_1500 = day_df[day_df["tod"] == "15:00"]
        row_1530 = day_df[day_df["tod"] == "15:30"]
        day_close = day_df["close"].iloc[-1]
        if prev_close is None or row_1500.empty:
            prev_close = day_close
            continue
        px_1500 = float(row_1500["close"].iloc[0])
        sig = px_1500 / prev_close - 1.0
        if sig == 0:
            prev_close = day_close
            continue
        side = "long" if sig > 0 else "short"
        entry_px = px_1500
        exit_px = float(row_1530["close"].iloc[0]) if not row_1530.empty else day_close
        if side == "long":
            buy_value, sell_value = capital, capital * (exit_px / entry_px)
        else:
            sell_value, buy_value = capital, capital * (exit_px / entry_px)
        c = index_spot_proxy_costs(buy_value, sell_value)
        trades.append({
            "entry_date": row_1500.index[0], "exit_date": d, "side": side,
            "entry_px": entry_px, "exit_px": exit_px,
            "pnl_inr": round((sell_value - buy_value) - c.total, 2), "costs_inr": c.total,
        })
        prev_close = day_close
    return trades


def run(train_intraday: pd.DataFrame, test_intraday: pd.DataFrame, capital: float = 100_000.0) -> dict:
    train_trades = backtest_s8(train_intraday, capital)
    test_trades = backtest_s8(test_intraday, capital)
    return {"train": summarize(train_trades, capital), "test": summarize(test_trades, capital),
            "train_trades": train_trades, "test_trades": test_trades}
