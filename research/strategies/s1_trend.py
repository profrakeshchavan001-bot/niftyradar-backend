"""S1 - Cross-asset time-series trend following.

Rule: at each month-end rebalance date t, look at the trailing 12-month return using ONLY
prices up to and including t (no lookahead: the signal never reads a price dated after t).
return_12m > 0 -> long for the next 1 month; return_12m < 0 -> short for the next 1 month;
== 0 -> flat. Instruments: Nifty, BankNifty, Gold, Crude, USDINR.

Cost model: futures_costs() for Nifty/BankNifty (traded via index futures), same for
gold/crude (commodity futures) and USDINR (currency futures) since none of these are cash
equity -- there is no NSE STT/stamp-duty equivalent for a futures roll.
"""
from __future__ import annotations

import pandas as pd

from costs import futures_costs
from metrics import summarize


def monthly_closes(daily: pd.DataFrame) -> pd.Series:
    """Last available close of each calendar month, using only that month's own data."""
    close = daily["close"].dropna()
    return close.resample("ME").last()


def backtest_s1(daily: pd.DataFrame, capital: float = 100_000.0, notional_frac: float = 1.0):
    """daily: DataFrame indexed by date with a 'close' column. Returns list of trade dicts.

    No-lookahead guard: the signal computed for month-end m uses monthly_closes()[m] and
    monthly_closes()[m-12], both <= m's date; the trade is then held from m to m+1 (the NEXT
    month-end), i.e. it only ever uses information available at decision time.
    """
    m = monthly_closes(daily)
    if len(m) < 14:
        return []
    trades = []
    for i in range(12, len(m) - 1):
        ret_12m = m.iloc[i] / m.iloc[i - 12] - 1.0
        if ret_12m == 0:
            continue
        side = "long" if ret_12m > 0 else "short"
        entry_px, exit_px = float(m.iloc[i]), float(m.iloc[i + 1])
        qty_value = capital * notional_frac
        if side == "long":
            buy_value, sell_value = qty_value, qty_value * (exit_px / entry_px)
            gross = sell_value - buy_value
        else:
            sell_value, buy_value = qty_value, qty_value * (exit_px / entry_px)
            gross = sell_value - buy_value
        c = futures_costs(buy_value, sell_value)
        trades.append({
            "entry_date": m.index[i], "exit_date": m.index[i + 1], "side": side,
            "entry_px": entry_px, "exit_px": exit_px,
            "pnl_inr": round(gross - c.total, 2), "costs_inr": c.total,
        })
    return trades


def run(daily_train: pd.DataFrame, daily_test: pd.DataFrame, capital: float = 100_000.0) -> dict:
    train_trades = backtest_s1(daily_train, capital)
    test_trades = backtest_s1(daily_test, capital)
    return {"train": summarize(train_trades, capital), "test": summarize(test_trades, capital),
            "train_trades": train_trades, "test_trades": test_trades}
