"""Point-in-time F&O universe built from the bhavcopy itself (no current-list survivorship).

A stock is a member on date t if it had stock-futures rows with open interest or volume on t. Days with
no F&O file at all (holiday gaps, late files) carry the previous day's membership for up to `carry`
days. Everything here looks only at rows dated <= t, so there is no look-ahead (tests cut the future).

Known limits (also in docs): symbol changes need `symbol_renames.json` (suspect_renames() lists likely
missing ones), mergers end membership on the last trading day and validation exits at the last traded
price, and lot sizes are not in the parsed bhavcopy columns (lot_changes() works only if a `lot` column
exists).
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def membership(fo: pd.DataFrame, dates: pd.DatetimeIndex, renames: dict | None = None, carry: int = 3) -> pd.DataFrame:
    """bool frame date x symbol. `dates` = the trading calendar to evaluate on (cash dates)."""
    if fo is None or len(fo) == 0:
        return pd.DataFrame(False, index=dates, columns=pd.Index([], name="symbol"))
    f = fo[fo["instr"] == "STF"].copy()
    f["date"] = pd.to_datetime(f["date"])
    live = (f.get("oi", 0).fillna(0) > 0) | (f.get("volume", 0).fillna(0) > 0)
    f = f[live]
    if renames:
        f["symbol"] = f["symbol"].replace({k: v for k, v in renames.items() if not str(k).startswith("_")})
    present = (f.groupby(["date", "symbol"]).size().unstack(fill_value=0) > 0)
    file_days = pd.DatetimeIndex(pd.to_datetime(fo["date"]).unique())
    m = present.reindex(dates).fillna(False).astype(bool)
    missing_file = ~pd.Index(dates).isin(file_days)
    if missing_file.any():
        # a day with NO F&O file is not "everyone left": carry the last known membership forward
        prev = m.where(~pd.Series(missing_file, index=dates), np.nan)
        m = prev.ffill(limit=carry).fillna(False).astype(bool)
    return m


def ever_members(m: pd.DataFrame) -> list[str]:
    return sorted(m.columns[m.any(axis=0)])


def members_on(m: pd.DataFrame, day) -> list[str]:
    return sorted(m.columns[m.loc[pd.Timestamp(day)].to_numpy()])


def changes(m: pd.DataFrame) -> pd.DataFrame:
    """Entries/exits: one row per change (date, symbol, event)."""
    rows = []
    prev = m.shift(1, fill_value=False)
    for ev, mask in (("enter", m & ~prev), ("exit", ~m & prev)):
        s = mask.stack()
        for (d, sym), v in s.items():
            if v:
                rows.append({"date": d, "symbol": sym, "event": ev})
    out = pd.DataFrame(rows, columns=["date", "symbol", "event"])
    if len(out) and m.index[0] in set(out[out.event == "enter"].date) and (m.iloc[0].sum() > 0):
        out = out[~((out.event == "enter") & (out.date == m.index[0]))]       # first day = starting list, not entries
    return out.sort_values(["date", "symbol"]).reset_index(drop=True)


def suspect_renames(fo: pd.DataFrame, window: int = 3, tol: float = 0.25) -> list[dict]:
    """Pairs (old, new): old stops, new starts within `window` trading days, never overlapping, and the old
    symbol's last-day total futures OI is within `tol` of the new symbol's first-day OI. A hint to add
    to symbol_renames.json, never applied automatically."""
    f = fo[fo["instr"] == "STF"].copy()
    f["date"] = pd.to_datetime(f["date"])
    g = f.groupby(["symbol", "date"])["oi"].sum().reset_index()
    span = g.groupby("symbol")["date"].agg(["min", "max"])
    last_day = g["date"].max()
    cal = pd.DatetimeIndex(sorted(g["date"].unique()))
    pos = {d: i for i, d in enumerate(cal)}            # gaps are counted in trading days, not calendar days
    out = []
    for old, o in span.iterrows():
        if o["max"] >= last_day:
            continue
        oi_old = g[(g.symbol == old) & (g.date == o["max"])]["oi"].iloc[0]
        for new, n in span.iterrows():
            if new == old or n["min"] <= o["max"] or pos[n["min"]] - pos[o["max"]] > window:
                continue
            if n["min"] <= o["min"]:
                continue
            oi_new = g[(g.symbol == new) & (g.date == n["min"])]["oi"].iloc[0]
            if oi_old > 0 and abs(oi_new / oi_old - 1) <= tol:
                out.append({"old": old, "new": new, "old_last": f"{o['max']:%Y-%m-%d}", "new_first": f"{n['min']:%Y-%m-%d}"})
    return out


def lot_changes(fo: pd.DataFrame) -> pd.DataFrame:
    """Dates where a stock's contract lot size changed (needs a `lot` column; empty if absent)."""
    if "lot" not in fo.columns:
        return pd.DataFrame(columns=["date", "symbol", "old", "new"])
    f = fo[(fo["instr"] == "STF") & fo["lot"].notna()].copy()
    f["date"] = pd.to_datetime(f["date"])
    g = f.groupby(["symbol", "date"])["lot"].max().reset_index().sort_values(["symbol", "date"])
    g["old"] = g.groupby("symbol")["lot"].shift(1)
    ch = g[g["old"].notna() & (g["old"] != g["lot"])]
    return ch.rename(columns={"lot": "new"})[["date", "symbol", "old", "new"]].reset_index(drop=True)


def current_members_from_market() -> list[str]:
    """Symbols in F&O on the latest day of the loaded bhavcopy (what fundamentals should be fetched for)."""
    from loader import load_market
    m = load_market()
    mem = membership(m.fo, pd.DatetimeIndex(sorted(m.cash["date"].unique())))
    return members_on(mem, mem.index[-1])
