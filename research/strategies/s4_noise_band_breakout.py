"""S4 - Noise-band breakout (Nifty and BTC).

band(t) = open(t) +/- avg_abs_move_from_open_at_this_time_of_day(last 14 days)
At each 30-min bar, if close > band_upper -> long; if close < band_lower -> short.
Trail stop at the running VWAP since the day's open; exit forced at the session close.

No-lookahead: the "average absolute move at this time-of-day over the last 14 days" for bar
at time-of-day T on day D uses only bars at time-of-day T on days D-14..D-1 (all strictly
before D) plus day D's own open (known at the start of day D) -- never a same-day future bar.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from costs import futures_costs, crypto_costs
from metrics import summarize


def _session_vwap(day_df: pd.DataFrame, upto_idx: int) -> float:
    seg = day_df.iloc[: upto_idx + 1]
    tp = (seg["high"] + seg["low"] + seg["close"]) / 3.0
    vol = seg["volume"].replace(0, np.nan).fillna(1.0)
    return float((tp * vol).sum() / vol.sum())


def backtest_s4(intraday: pd.DataFrame, capital: float = 100_000.0, instrument: str = "index",
                 lookback_days: int = 14):
    """intraday: 30-min bars, date-time indexed, columns open/high/low/close/volume."""
    df = intraday.copy()
    df["date"] = df.index.date
    df["tod"] = df.index.strftime("%H:%M")
    df["move_from_open"] = np.nan

    days = sorted(df["date"].unique())
    day_opens = {d: df[df["date"] == d]["open"].iloc[0] for d in days}
    for d in days:
        mask = df["date"] == d
        df.loc[mask, "move_from_open"] = (df.loc[mask, "close"] - day_opens[d]).abs()

    trades = []
    cost_fn = crypto_costs if instrument == "crypto" else futures_costs

    for di, d in enumerate(days):
        if di < lookback_days:
            continue
        day_df = df[df["date"] == d].reset_index()
        prior_days = days[di - lookback_days: di]
        prior_df = df[df["date"].isin(prior_days)]
        position = None  # dict(side, entry_px, entry_idx)

        for bar_i in range(len(day_df)):
            tod = day_df["tod"].iloc[bar_i]
            prior_same_tod = prior_df[prior_df["tod"] == tod]["move_from_open"]
            if len(prior_same_tod) == 0:
                continue
            band = float(prior_same_tod.mean())
            o = day_opens[d]
            upper, lower = o + band, o - band
            close_px = day_df["close"].iloc[bar_i]
            is_last_bar = bar_i == len(day_df) - 1
            vwap = _session_vwap(day_df, bar_i)

            if position is None:
                if close_px > upper:
                    position = {"side": "long", "entry_px": close_px, "entry_time": day_df["index"].iloc[bar_i]}
                elif close_px < lower:
                    position = {"side": "short", "entry_px": close_px, "entry_time": day_df["index"].iloc[bar_i]}
            else:
                hit_trail = (position["side"] == "long" and close_px < vwap) or \
                            (position["side"] == "short" and close_px > vwap)
                if hit_trail or is_last_bar:
                    exit_px = close_px
                    entry_px = position["entry_px"]
                    if position["side"] == "long":
                        buy_value, sell_value = capital, capital * (exit_px / entry_px)
                    else:
                        sell_value, buy_value = capital, capital * (exit_px / entry_px)
                    c = cost_fn(buy_value, sell_value)
                    gross = (sell_value - buy_value) if position["side"] == "long" else (sell_value - buy_value)
                    trades.append({
                        "entry_date": position["entry_time"], "exit_date": day_df["index"].iloc[bar_i],
                        "side": position["side"], "entry_px": float(entry_px), "exit_px": float(exit_px),
                        "pnl_inr": round(gross - c.total, 2), "costs_inr": c.total,
                    })
                    position = None
    return trades


def run(train_intraday: pd.DataFrame, test_intraday: pd.DataFrame, capital: float = 100_000.0,
        instrument: str = "index") -> dict:
    train_trades = backtest_s4(train_intraday, capital, instrument)
    test_trades = backtest_s4(test_intraday, capital, instrument)
    return {"train": summarize(train_trades, capital), "test": summarize(test_trades, capital),
            "train_trades": train_trades, "test_trades": test_trades}
