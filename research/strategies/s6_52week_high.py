"""S6 - 52-week high, monthly rebalance.

At each month-end t, rank Nifty200-like stocks by close[t] / rolling_52w_high[t] (both using
only data dated <= t), take the top 30, hold 1 month. No skip-month here (the strategy as
specified ranks on the live price/52w-high ratio, not a formation-return), so the 52-week high
itself is computed on a rolling trailing window ending at t -- never using t+1 data.
"""
from __future__ import annotations

import pandas as pd

from costs import equity_delivery_costs
from metrics import summarize


def _monthly_panel_with_52w_high(closes: dict[str, pd.Series]):
    month_close, month_52w_high = {}, {}
    for sym, s in closes.items():
        s = s.dropna()
        if len(s) < 260:
            continue
        roll_high = s.rolling(window=252, min_periods=100).max()
        month_close[sym] = s.resample("ME").last()
        month_52w_high[sym] = roll_high.resample("ME").last()
    return pd.DataFrame(month_close), pd.DataFrame(month_52w_high)


def backtest_s6(stock_closes: dict[str, pd.Series], capital: float = 100_000.0, top_n: int = 30):
    close_panel, high_panel = _monthly_panel_with_52w_high(stock_closes)
    idx = close_panel.index
    trades = []
    for i in range(0, len(idx) - 1):
        ratio = (close_panel.iloc[i] / high_panel.iloc[i]).dropna()
        ratio = ratio.replace([float("inf"), float("-inf")], pd.NA).dropna()
        if len(ratio) == 0:
            continue
        picks = list(ratio.sort_values(ascending=False).head(top_n).index)
        per_stock_capital = capital / top_n
        for sym in picks:
            entry_px, exit_px = close_panel[sym].iloc[i], close_panel[sym].iloc[i + 1]
            if pd.isna(entry_px) or pd.isna(exit_px) or entry_px <= 0:
                continue
            buy_value = per_stock_capital
            sell_value = per_stock_capital * (exit_px / entry_px)
            c = equity_delivery_costs(buy_value, sell_value)
            trades.append({
                "entry_date": idx[i], "exit_date": idx[i + 1], "symbol": sym, "side": "long",
                "entry_px": float(entry_px), "exit_px": float(exit_px),
                "pnl_inr": round((sell_value - buy_value) - c.total, 2), "costs_inr": c.total,
            })
    return trades


def run(stock_closes_train: dict, stock_closes_test: dict, capital: float = 100_000.0) -> dict:
    train_trades = backtest_s6(stock_closes_train, capital)
    test_trades = backtest_s6(stock_closes_test, capital)
    return {"train": summarize(train_trades, capital), "test": summarize(test_trades, capital),
            "train_trades": train_trades, "test_trades": test_trades}
