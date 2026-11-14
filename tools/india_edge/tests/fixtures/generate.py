"""Deterministic synthetic NSE-style market data (no network).

    python tests/fixtures/generate.py            # rewrites the parquet files next to this script

60 F&O-style symbols, 2015-01-01 -> 2026-10-28. Each stock walks through trend-up,
trend-down and chop regimes, with earnings-style gap days and a few market-wide events.
Output frames use the same schema as data/fetch.py writes (cash, fo, idx), plus
iv (implied-vol proxy, option spread %, premium) and events (gap/event calendar).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
SEED = 7
START, END = "2015-01-01", "2026-10-28"
REGIMES = ("up", "down", "chop")


def symbols(n: int = 60) -> list[str]:
    sectors = json.loads((HERE.parents[1] / "sectors.json").read_text())
    return list(sectors)[:n]


def calendar(rng) -> pd.DatetimeIndex:
    d = pd.bdate_range(START, END)
    return d[rng.random(len(d)) > 0.03]  # ~3% of weekdays are market holidays


def monthly_expiry(day: pd.Timestamp) -> pd.Timestamp:
    """Last Thursday of the month (Tuesday from Sep 2025, as NSE moved it)."""
    wd = 3 if day < pd.Timestamp("2025-09-01") else 1
    last = day + pd.offsets.MonthEnd(0)
    while last.weekday() != wd:
        last -= pd.Timedelta(days=1)
    return last


def regime_path(rng, n: int) -> np.ndarray:
    out = np.empty(n, dtype=np.int8)
    i, cur = 0, int(rng.integers(0, 3))
    while i < n:
        length = int(rng.geometric(1 / (45 if cur == 2 else 70))) + 10
        out[i:i + length] = cur
        i += length
        cur = int(rng.choice([r for r in range(3) if r != cur]))
    return out


def generate(seed: int = SEED, n_symbols: int = 60) -> dict[str, pd.DataFrame]:
    rng = np.random.default_rng(seed)
    dates = calendar(rng)
    n, syms = len(dates), symbols(n_symbols)
    m = len(syms)

    # market factor with its own regimes
    mreg = regime_path(rng, n)
    mdrift = np.array([0.0006, -0.0006, 0.0])[mreg]
    mret = mdrift + rng.normal(0, 0.007, n)
    nifty = 7800 * np.cumprod(1 + mret)
    idx = pd.DataFrame({"date": dates, "index_name": "Nifty 50", "close": nifty.round(2)})

    event_rows = []
    mkt_events = rng.choice(n - 5, size=3 * 12, replace=False)
    for i in sorted(mkt_events):
        event_rows.append((dates[i], "ALL", "macro"))
    cash, fo, ivrows = [], [], []
    for s_i, sym in enumerate(syms):
        beta = rng.uniform(0.6, 1.4)
        idio = rng.uniform(0.010, 0.020)
        reg = regime_path(rng, n)
        drift = np.array([0.0020, -0.0018, 0.0])[reg]
        vscale = np.array([1.0, 1.25, 0.75])[reg]
        eps = rng.normal(0, 1, n)
        ret = drift + beta * mret + idio * vscale * eps
        # chop mean reversion: yesterday's idio move partly reverses
        rev = np.zeros(n)
        rev[1:] = -0.25 * (idio * eps[:-1])
        ret = ret + np.where(reg == 2, rev, 0.0)
        gap = np.zeros(n)
        for i in rng.choice(np.arange(30, n - 3), size=int(n / 63), replace=False):
            gap[i] = rng.choice([-1, 1]) * rng.uniform(0.03, 0.08)
            event_rows.append((dates[i], sym, "earnings"))
        base = rng.lognormal(6.3, 0.9)
        # OPEN carries the gap; close follows the day's return
        prev = np.empty(n)
        close = np.empty(n)
        opn = np.empty(n)
        c = base
        for i in range(n):
            prev[i] = c
            opn[i] = c * (1 + gap[i] + rng.normal(0, 0.0015))
            c = max(opn[i] * (1 + ret[i] - 0.0), 5.0) if gap[i] else max(c * (1 + ret[i]), 5.0)
            close[i] = c
        rng_hi = np.abs(rng.normal(0, 0.006, n)) * vscale
        rng_lo = np.abs(rng.normal(0, 0.006, n)) * vscale
        high = np.maximum(opn, close) * (1 + rng_hi)
        low = np.minimum(opn, close) * (1 - rng_lo)
        value_cr = rng.uniform(80, 1500)
        vol_mult = np.exp(rng.normal(0, 0.25, n)) * (1 + 6 * np.abs(ret)) * (1 + 1.5 * (gap != 0))
        volume = np.round(value_cr * 1e7 / close * vol_mult)
        deliv = np.clip(rng.normal(46, 5, n) + 8 * (gap != 0) + 10 * (rng.random(n) < 0.03), 15, 95)
        cash.append(pd.DataFrame({
            "date": dates, "symbol": sym, "prev_close": prev.round(2), "open": opn.round(2),
            "high": high.round(2), "low": low.round(2), "close": close.round(2),
            "volume": volume, "deliv_qty": (volume * deliv / 100).round(), "deliv_pct": deliv.round(1)}))

        # futures OI: builds with big moves and inside trends
        trend = (reg != 2).astype(float)
        oi_pct = 0.004 * trend + 0.6 * np.abs(ret) * np.sign(ret * (drift if drift.any() else 1)) \
            + rng.normal(0, 0.012, n)
        oi_pct = np.where(reg == 2, rng.normal(0, 0.015, n), oi_pct)
        oi = np.empty(n)
        o = rng.uniform(2e5, 4e6)
        for i in range(n):
            o = max(o * (1 + oi_pct[i]), 1e4)
            oi[i] = o
        chg = np.diff(np.concatenate([[oi[0] / (1 + oi_pct[0])], oi]))
        expiry = [f"{monthly_expiry(d):%Y-%m-%d}" for d in dates]
        fo.append(pd.DataFrame({
            "date": dates, "instr": "STF", "symbol": sym, "expiry": expiry, "strike": 0.0,
            "opt_type": "XX", "close": (close * 1.002).round(2), "oi": oi.round(), "chg_oi": chg.round(),
            "volume": np.round(volume / 40 * (1 + rng.normal(0, 0.1, n)))}))
        opt_base = rng.uniform(2e3, 8e4) * (value_cr / 500)
        spike = 1 + 3 * (rng.random(n) < 0.04) + 2 * (gap != 0)
        optv = np.round(opt_base * np.exp(rng.normal(0, 0.25, n)) * (1 + 4 * np.abs(ret)) * spike)
        fo.append(pd.DataFrame({
            "date": dates, "instr": "STO", "symbol": sym, "expiry": expiry, "strike": np.round(close, 0),
            "opt_type": "CE", "close": (close * 0.02).round(2), "oi": np.round(optv * 12),
            "chg_oi": np.round(rng.normal(0, 1, n) * optv * 0.6 * spike), "volume": optv}))

        # IV proxy: smoothed realised vol + pre-event bump; spread % of premium
        real = pd.Series(ret).rolling(20, min_periods=5).std().bfill().to_numpy() * np.sqrt(252)
        iv = np.empty(n)
        v = real[0]
        pre = np.zeros(n)
        for i in np.nonzero(gap)[0]:
            pre[max(0, i - 5):i + 1] += 0.08
        for i in range(n):
            v = 0.8 * v + 0.2 * (real[i] * 1.1 + pre[i]) + rng.normal(0, 0.005)
            iv[i] = max(v, 0.08)
        spread = np.exp(rng.normal(np.log(0.008), 0.6, n))
        ivrows.append(pd.DataFrame({
            "date": dates, "symbol": sym, "iv": iv.round(4), "opt_spread_pct": spread.round(4),
            "opt_premium": (close * iv * 0.4 * np.sqrt(30 / 365)).round(2)}))

    events = pd.DataFrame(sorted(event_rows), columns=["date", "symbol", "kind"])
    return {"cash": pd.concat(cash, ignore_index=True), "fo": pd.concat(fo, ignore_index=True),
            "idx": idx, "iv": pd.concat(ivrows, ignore_index=True), "events": events}


def write(out_dir: Path = HERE, **kw) -> dict[str, Path]:
    paths = {}
    for name, df in generate(**kw).items():
        p = out_dir / f"{name}.parquet"
        df.to_parquet(p, index=False, compression="zstd", compression_level=19)
        paths[name] = p
    return paths


if __name__ == "__main__":
    for k, p in write().items():
        print(f"{k:7s} {p.stat().st_size / 1e6:6.2f} MB")
    sys.exit(0)
