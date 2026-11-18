"""S10 - 5-min opening-range breakout on "stocks in play".

Each day: rank the universe by (first-5-min volume) / (14-day average first-5-min volume at
the same time-of-day, using only the PRIOR 14 days -- strictly before today), take the top 20.
For each: if the first 5-min candle is green, buy above its high; if red, short below its low.
Stop = 10% of ATR (ATR computed on daily bars up to and including the prior day, never today's
still-forming range). Exit at close.
"""
from __future__ import annotations

import pandas as pd

from costs import equity_intraday_costs
from metrics import summarize


def _daily_atr(daily: pd.DataFrame, period: int = 14) -> pd.Series:
    high, low, close = daily["high"], daily["low"], daily["close"]
    prev_close = close.shift(1)
    tr = pd.concat([(high - low), (high - prev_close).abs(), (low - prev_close).abs()], axis=1).max(axis=1)
    return tr.rolling(period).mean()


def rank_stocks_in_play(first5_vols_by_symbol: dict[str, pd.Series], lookback: int = 14) -> pd.DataFrame:
    """first5_vols_by_symbol[sym] is a daily-indexed Series of that day's first-5-min volume.
    Ranks on volume[day] / mean(volume[day-14..day-1]) -- only prior days in the denominator."""
    out = {}
    for sym, s in first5_vols_by_symbol.items():
        avg_prior = s.shift(1).rolling(lookback).mean()
        out[sym] = s / avg_prior
    return pd.DataFrame(out)


def backtest_s10_symbol(day_5min: pd.DataFrame, daily_atr_value: float, capital_leg: float = 5_000.0):
    """day_5min: one day's 5-min bars for one symbol. Returns 0 or 1 trade dict."""
    if len(day_5min) < 2 or pd.isna(daily_atr_value):
        return None
    first = day_5min.iloc[0]
    is_green = first["close"] >= first["open"]
    side = "long" if is_green else "short"
    trigger = first["high"] if is_green else first["low"]
    stop_dist = 0.10 * daily_atr_value

    entry_px, entry_time = None, None
    for i in range(1, len(day_5min)):
        bar = day_5min.iloc[i]
        if entry_px is None:
            if side == "long" and bar["high"] > trigger:
                entry_px, entry_time = trigger, day_5min.index[i]
            elif side == "short" and bar["low"] < trigger:
                entry_px, entry_time = trigger, day_5min.index[i]
            continue
        stop_px = entry_px - stop_dist if side == "long" else entry_px + stop_dist
        hit_stop = (side == "long" and bar["low"] <= stop_px) or (side == "short" and bar["high"] >= stop_px)
        if hit_stop:
            exit_px = stop_px
            return _close_trade(side, entry_px, exit_px, entry_time, day_5min.index[i], capital_leg)
    if entry_px is not None:
        exit_px = day_5min["close"].iloc[-1]
        return _close_trade(side, entry_px, exit_px, entry_time, day_5min.index[-1], capital_leg)
    return None


def _close_trade(side, entry_px, exit_px, entry_time, exit_time, capital_leg):
    if side == "long":
        buy_value, sell_value = capital_leg, capital_leg * (exit_px / entry_px)
    else:
        sell_value, buy_value = capital_leg, capital_leg * (exit_px / entry_px)
    c = equity_intraday_costs(buy_value, sell_value)
    return {"entry_date": entry_time, "exit_date": exit_time, "side": side,
            "entry_px": float(entry_px), "exit_px": float(exit_px),
            "pnl_inr": round((sell_value - buy_value) - c.total, 2), "costs_inr": c.total}


def run(all_trades_train: list, all_trades_test: list, capital: float = 100_000.0) -> dict:
    """Caller assembles trade lists day-by-day via backtest_s10_symbol over the ranked top-20;
    this just aggregates, to keep the per-symbol/per-day loop (which needs real 5-min + daily
    ATR data) out of this pure-logic module."""
    return {"train": summarize(all_trades_train, capital), "test": summarize(all_trades_test, capital),
            "train_trades": all_trades_train, "test_trades": all_trades_test}
