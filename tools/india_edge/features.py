"""Per-stock, per-day features from bhavcopy data (no network)."""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

from common import ROOT

SECTORS_FILE = ROOT / "sectors.json"
NIFTY = "Nifty 50"


def oi_quadrant(price_chg_pct: float, oi_chg_pct: float) -> str:
    """Price/OI classic four-way read; zero or missing on either axis is neutral."""
    if pd.isna(price_chg_pct) or pd.isna(oi_chg_pct) or price_chg_pct == 0 or oi_chg_pct == 0:
        return "neutral"
    if oi_chg_pct > 0:
        return "long_buildup" if price_chg_pct > 0 else "short_buildup"
    return "short_covering" if price_chg_pct > 0 else "long_unwinding"


def load_sectors(path=SECTORS_FILE) -> dict:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def build_features(cash: pd.DataFrame, fo: pd.DataFrame, idx: pd.DataFrame,
                   symbols: list[str], sectors: dict, lookback: int = 20) -> pd.DataFrame:
    """Long frame (date, symbol, ...) with every feature the scorer needs.

    Averages use only PRIOR days (shift(1)) so today's spike does not dilute
    its own baseline. Futures/options are summed across expiries.
    """
    cash = cash[cash["symbol"].isin(symbols)]
    wide = lambda col: cash.pivot(index="date", columns="symbol", values=col).sort_index()  # noqa: E731
    close, prev_close = wide("close"), wide("prev_close")
    volume, deliv = wide("volume"), wide("deliv_pct")
    dates = close.index

    price_chg = (close / prev_close - 1) * 100
    ret_n = close.pct_change(lookback, fill_method=None) * 100

    nifty = (idx[idx["index_name"] == NIFTY].set_index("date")["close"]
             .sort_index().reindex(dates))
    nifty_ret = nifty.pct_change(lookback, fill_method=None) * 100
    rs = ret_n.sub(nifty_ret, axis=0)

    # sector RS: equal-weight mean n-day return of universe members minus Nifty
    sec_of = {s: sectors.get(s, "Other") for s in close.columns}
    sec_ret = ret_n.T.groupby(pd.Series(sec_of)).mean().T
    sec_rs = sec_ret.sub(nifty_ret, axis=0)
    sector_rs = pd.DataFrame({s: sec_rs[sec_of[s]] for s in close.columns})

    deliv_avg = deliv.shift(1).rolling(lookback, min_periods=max(5, lookback // 2)).mean()
    deliv_ratio = deliv / deliv_avg

    adv_cr = (close * volume).rolling(lookback, min_periods=max(5, lookback // 2)).mean() / 1e7

    fut = fo[fo["instr"] == "STF"].groupby(["date", "symbol"])[["oi", "chg_oi"]].sum()
    fut_oi = fut["oi"].unstack().reindex(index=dates, columns=close.columns)
    fut_chg = fut["chg_oi"].unstack().reindex(index=dates, columns=close.columns)
    oi_chg_pct = fut_chg / (fut_oi - fut_chg).where((fut_oi - fut_chg) > 0) * 100

    opt = fo[fo["instr"] == "STO"]
    opt = opt.assign(abs_chg=opt["abs_chg_oi"] if "abs_chg_oi" in opt else opt["chg_oi"].abs())
    opt_abs = (opt.groupby(["date", "symbol"])["abs_chg"].sum().unstack()
               .reindex(index=dates, columns=close.columns))
    opt_base = opt_abs.shift(1).rolling(lookback, min_periods=max(5, lookback // 2)).mean()
    unusual_oi = opt_abs / opt_base.where(opt_base > 0)

    def long(df, name):
        s = df.stack()
        s.index.names = ["date", "symbol"]
        return s.rename(name)

    out = pd.concat([
        long(close, "close"), long(price_chg, "price_chg_pct"),
        long(fut_oi, "fut_oi"), long(oi_chg_pct, "oi_chg_pct"),
        long(deliv, "deliv_pct"), long(deliv_ratio, "deliv_ratio"),
        long(rs, "rs"), long(sector_rs, "sector_rs"),
        long(unusual_oi, "unusual_oi"), long(adv_cr, "adv_cr"),
    ], axis=1).reset_index()
    out["sector"] = out["symbol"].map(sec_of)
    out["quadrant"] = [oi_quadrant(p, o) for p, o in zip(out["price_chg_pct"], out["oi_chg_pct"])]
    return out
