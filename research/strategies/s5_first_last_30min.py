"""S5 - First-30min-to-last-30min (Nifty).

Signal (computed by 09:45, using only data known by 09:45): return from previous day's close
to the 09:45 price. If positive -> go long 15:00-15:30; if negative -> go short 15:00-15:30.
The signal is read at 09:45 but EXECUTED only at 15:00 -- no lookahead, since nothing between
09:45 and 15:00 is used to decide direction, only to decide whether to still be flat/hold cash
(we just hold the decision, we don't re-check it).
"""
from __future__ import annotations

import pandas as pd

from costs import index_spot_proxy_costs
from metrics import summarize


def backtest_s5(intraday_30m: pd.DataFrame, capital: float = 100_000.0):
    df = intraday_30m.copy()
    df["date"] = df.index.date
    df["tod"] = df.index.strftime("%H:%M")
    days = sorted(df["date"].unique())
    trades = []
    prev_close = None
    for d in days:
        day_df = df[df["date"] == d]
        row_0945 = day_df[day_df["tod"] == "09:45"]
        row_1500 = day_df[day_df["tod"] == "15:00"]
        row_1530 = day_df[day_df["tod"] == "15:30"]
        day_close = day_df["close"].iloc[-1]
        if prev_close is None or row_0945.empty or row_1500.empty:
            prev_close = day_close
            continue
        sig_ret = float(row_0945["close"].iloc[0]) / prev_close - 1.0
        if sig_ret == 0:
            prev_close = day_close
            continue
        side = "long" if sig_ret > 0 else "short"
        entry_px = float(row_1500["close"].iloc[0])
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
    train_trades = backtest_s5(train_intraday, capital)
    test_trades = backtest_s5(test_intraday, capital)
    return {"train": summarize(train_trades, capital), "test": summarize(test_trades, capital),
            "train_trades": train_trades, "test_trades": test_trades}
