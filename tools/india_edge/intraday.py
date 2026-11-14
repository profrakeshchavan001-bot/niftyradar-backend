"""15-minute bars: synthetic (derived from a daily bar) or read from CSV files.

Real data hook: put `<DATA_DIR>/intraday/<SYMBOL>/<YYYY-MM-DD>.csv` with columns
ts,open,high,low,close,volume (ts = bar start, IST, e.g. 2026-10-29 09:15). If a file
exists it wins; otherwise bars are synthesised from the day's OHLCV (fixtures only).
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path

import numpy as np
import pandas as pd

BARS_PER_DAY = 25  # 09:15 .. 15:15 start times, 15 minutes each
_PROFILE = np.array([4.0, 2.6, 2.0, 1.6, 1.4, 1.2, 1.1, 1.0, 0.95, 0.9, 0.85, 0.85, 0.85,
                     0.85, 0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.2, 1.3, 1.5, 1.8, 2.4])  # U-shaped volume


def _seed(symbol: str, day: pd.Timestamp) -> int:
    h = hashlib.sha256(f"{symbol}|{pd.Timestamp(day):%Y-%m-%d}".encode()).digest()
    return int.from_bytes(h[:8], "big")


def synth_bars(symbol: str, day, o: float, h: float, l: float, c: float, volume: float) -> pd.DataFrame:
    """25 bars that start at the day's open, end at its close, touch its high and low exactly.

    Deterministic per (symbol, day). Bar i uses only the path up to i, so detectors that
    look at bars[:i+1] never see later information."""
    day = pd.Timestamp(day).normalize()
    rng = np.random.default_rng(_seed(symbol, day))
    n = BARS_PER_DAY
    span = max(h - l, 1e-9)
    # Brownian bridge from open to close (scaled to the day's range), clipped into [l, h]
    steps = rng.normal(0, span * 0.22, n)
    w = np.cumsum(steps)
    t = np.arange(1, n + 1) / n
    bridge = o + w - t * (w[-1] - (c - o))
    closes = np.clip(bridge, l, h)
    closes[-1] = c
    opens = np.concatenate([[o], closes[:-1]])
    wick = np.abs(rng.normal(0, span * 0.05, (2, n)))
    highs = np.minimum(np.maximum(opens, closes) + wick[0], h)
    lows = np.maximum(np.minimum(opens, closes) - wick[1], l)
    # make the day's extremes real: one bar prints the high, one prints the low
    ih, il = int(rng.integers(1, n)), int(rng.integers(1, n))
    highs[ih] = h
    lows[il] = l
    if ih == il:  # same bar cannot print both from a tiny range; spread them
        il = (il + 7) % n
        lows[il] = l
    highs = np.maximum(highs, np.maximum(opens, closes))
    lows = np.minimum(lows, np.minimum(opens, closes))
    # first bar keeps the exact open, last the exact close (already true), keep o inside bar range
    vol = _PROFILE * np.exp(rng.normal(0, 0.2, n))
    vol = np.round(vol / vol.sum() * volume)
    ts = day + pd.Timedelta(hours=9, minutes=15) + pd.to_timedelta(np.arange(n) * 15, unit="m")
    return pd.DataFrame({"ts": ts, "open": opens, "high": highs, "low": lows, "close": closes, "volume": vol})


def read_bars(symbol: str, day, root: Path | None = None) -> pd.DataFrame | None:
    base = Path(root) if root else (Path(os.environ["DATA_DIR"]) if os.environ.get("DATA_DIR") else None)
    if base is None:
        return None
    f = base / "intraday" / symbol / f"{pd.Timestamp(day):%Y-%m-%d}.csv"
    if not f.exists():
        return None
    df = pd.read_csv(f, parse_dates=["ts"])
    return df[["ts", "open", "high", "low", "close", "volume"]]


def get_bars(cash: pd.DataFrame, symbol: str, day, root: Path | None = None) -> pd.DataFrame | None:
    """Real CSV bars if present, else synthetic from the daily row, else None."""
    real = read_bars(symbol, day, root)
    if real is not None:
        return real
    row = cash[(cash["symbol"] == symbol) & (cash["date"] == pd.Timestamp(day))]
    if row.empty:
        return None
    r = row.iloc[0]
    return synth_bars(symbol, day, r["open"], r["high"], r["low"], r["close"], r["volume"])
