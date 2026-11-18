"""Add-on variants A (market mood filter) and B (volatility position sizing).

Both are pure functions over OHLC data the caller already has; neither reads anything dated
after the bar being classified/sized, so neither introduces lookahead on its own -- but each
MUST be composed with a strategy's own no-lookahead signal to stay lookahead-free end to end.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def adx(daily: pd.DataFrame, period: int = 14) -> pd.Series:
    high, low, close = daily["high"], daily["low"], daily["close"]
    up_move = high.diff()
    down_move = -low.diff()
    plus_dm = np.where((up_move > down_move) & (up_move > 0), up_move, 0.0)
    minus_dm = np.where((down_move > up_move) & (down_move > 0), down_move, 0.0)
    tr = pd.concat([(high - low), (high - close.shift(1)).abs(), (low - close.shift(1)).abs()], axis=1).max(axis=1)
    atr = tr.rolling(period).mean()
    plus_di = 100 * pd.Series(plus_dm, index=daily.index).rolling(period).mean() / atr
    minus_di = 100 * pd.Series(minus_dm, index=daily.index).rolling(period).mean() / atr
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di)
    return dx.rolling(period).mean()


def mood_filter(daily: pd.DataFrame, adx_period: int = 14, trend_threshold: float = 20.0) -> pd.Series:
    """Returns a boolean Series: True = 'trend day' (ADX computed up to and including that
    day's bar >= threshold), False = 'chop day'. Using ADX[t] to decide whether to trade
    strategies on day t is NOT a lookahead as long as the strategy's own intraday signal is
    itself decided intraday on day t using only day t's own bars plus history -- ADX here is
    purely a daily-bar regime classifier, computed from closed daily bars up to t."""
    dx = adx(daily, adx_period)
    return dx >= trend_threshold


def realized_vol(daily: pd.DataFrame, window: int = 20) -> pd.Series:
    ret = daily["close"].pct_change()
    return ret.rolling(window).std() * np.sqrt(252)


def vol_sized_qty(capital_at_risk_inr: float, entry_px: float, stop_px: float) -> float:
    """Constant-Rs-risk sizing: size so that (entry-stop)*qty == capital_at_risk_inr."""
    risk_per_unit = abs(entry_px - stop_px)
    if risk_per_unit <= 0:
        return 0.0
    return capital_at_risk_inr / risk_per_unit


def target_risk_from_vol(base_risk_inr: float, current_vol: float, median_vol: float) -> float:
    """Scale the per-trade Rs-risk budget inversely to recent realized vol vs its own median,
    so risk shrinks in high-vol regimes and grows (capped at 1.5x) in low-vol regimes."""
    if current_vol <= 0 or median_vol <= 0 or pd.isna(current_vol) or pd.isna(median_vol):
        return base_risk_inr
    scale = min(1.5, max(0.25, median_vol / current_vol))
    return base_risk_inr * scale
