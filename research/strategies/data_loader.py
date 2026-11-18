"""yfinance-backed data loader with on-disk parquet caching under data/research_cache/.

This module does not fabricate anything: if a fetch fails, it raises / returns None and the
caller must log the gap. See fetch_data.py for the one script meant to populate the cache, and
research/strategies/README.md + data/research_cache/FETCH_LOG.txt for why, in the session that
wrote this code, the cache could not be populated (sandbox network policy blocked every
market-data host tried: Yahoo Finance, Binance, NSE, Stooq).
"""
from __future__ import annotations

import datetime as dt
from pathlib import Path

CACHE_DIR = Path(__file__).resolve().parents[2] / "data" / "research_cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)
FETCH_LOG = CACHE_DIR / "FETCH_LOG.txt"


def _log(msg: str) -> None:
    ts = dt.datetime.utcnow().isoformat() + "Z"
    with open(FETCH_LOG, "a") as f:
        f.write(f"[{ts}] {msg}\n")
    print(msg)


def cache_path(symbol: str, interval: str) -> Path:
    safe = symbol.replace("^", "IDX_").replace("=", "_").replace("/", "_")
    return CACHE_DIR / f"{safe}_{interval}.parquet"


def fetch_daily(symbol: str, start: str = "2015-01-01", end: str | None = None):
    """Fetch and cache daily OHLC for `symbol` via yfinance. Returns a DataFrame or None.

    Any already-cached parquet is reused (no re-download) so repeated runs don't hammer the
    network once it IS available.
    """
    import pandas as pd

    end = end or dt.date.today().isoformat()
    path = cache_path(symbol, "1d")
    if path.exists():
        _log(f"cache hit: {symbol} 1d -> {path}")
        return pd.read_parquet(path)

    try:
        import yfinance as yf
    except ImportError:
        _log(f"BLOCKED: yfinance not importable, cannot fetch {symbol}")
        return None

    try:
        df = yf.download(symbol, start=start, end=end, interval="1d", progress=False, auto_adjust=False)
        if df is None or df.empty:
            _log(f"BLOCKED: empty response for {symbol} 1d ({start}..{end})")
            return None
        df.columns = [str(c).lower() if not isinstance(c, tuple) else str(c[0]).lower() for c in df.columns]
        df.index.name = "date"
        df.to_parquet(path)
        _log(f"fetched {symbol} 1d: {len(df)} rows, {df.index.min()}..{df.index.max()} -> {path}")
        return df
    except Exception as exc:  # network blocked, rate-limited, symbol not found, etc.
        _log(f"BLOCKED: fetch_daily({symbol}) failed: {type(exc).__name__}: {exc}")
        return None


def fetch_intraday(symbol: str, interval: str = "30m"):
    """Fetch and cache intraday bars. yfinance serves ~60 calendar days for <=30m bars and
    ~730 days for 60m. Whatever range it actually returns is cached and the exact day-count is
    logged -- callers must report that honestly rather than assume a full history."""
    import pandas as pd

    path = cache_path(symbol, interval)
    if path.exists():
        _log(f"cache hit: {symbol} {interval} -> {path}")
        return pd.read_parquet(path)

    try:
        import yfinance as yf
    except ImportError:
        _log(f"BLOCKED: yfinance not importable, cannot fetch {symbol} {interval}")
        return None

    try:
        df = yf.download(symbol, period="60d" if interval in ("1m", "2m", "5m", "15m", "30m") else "730d",
                          interval=interval, progress=False, auto_adjust=False)
        if df is None or df.empty:
            _log(f"BLOCKED: empty intraday response for {symbol} {interval}")
            return None
        df.columns = [str(c).lower() if not isinstance(c, tuple) else str(c[0]).lower() for c in df.columns]
        df.index.name = "datetime"
        df.to_parquet(path)
        n_days = len(set(df.index.date)) if hasattr(df.index, "date") else None
        _log(f"fetched {symbol} {interval}: {len(df)} bars, {n_days} distinct days, "
             f"{df.index.min()}..{df.index.max()} -> {path}")
        return df
    except Exception as exc:
        _log(f"BLOCKED: fetch_intraday({symbol}, {interval}) failed: {type(exc).__name__}: {exc}")
        return None
