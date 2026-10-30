"""Real-data robustness: clean broken, partial or inconsistent bhavcopy-derived frames without crashing.

Handles empty/missing frames, bad rows, duplicates, partial days, holidays, stale symbols, symbol renames
and split/bonus style corporate-action gaps, and reports what happened in a data-health dict that is
printed at the top of the Morning Desk JSON.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from common import ROOT
from timing import exec_config

PRICE_COLS = ["open", "high", "low", "close", "prev_close"]
DEFAULTS = dict(corp_action_ratio=0.10, stale_symbol_days=3, suspect_jump=0.40, partial_day_frac=0.5)
CASH_NUM = PRICE_COLS + ["volume", "deliv_qty", "deliv_pct"]


class MarketDataError(SystemExit):
    """A required input (cash bhavcopy or index) is unusable. Subclasses SystemExit so CLIs exit cleanly."""


def robust_config(cfg: dict | None = None) -> dict:
    return {**DEFAULTS, **(cfg or exec_config()).get("robust", {})}


def load_renames(path: Path | None = None) -> dict:
    p = path or ROOT / "symbol_renames.json"
    try:
        d = json.loads(Path(p).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return {k: v for k, v in d.items() if not k.startswith("_") and isinstance(v, str)}


def new_notes() -> dict:
    return dict(rows_dropped=0, duplicates=0, ohlc_repaired=0, renames=[], corp_actions=[], suspect_jumps=[],
                partial_days=[], stale_symbols=[], load_errors=[], fo_rows_dropped=0)


# ------------------------------------------------------------------ cleaning
def clean_cash(cash: pd.DataFrame, notes: dict) -> pd.DataFrame:
    if cash is None or len(cash) == 0:
        return pd.DataFrame(columns=["date", "symbol"] + CASH_NUM)
    c = cash.copy()
    c["date"] = pd.to_datetime(c["date"], errors="coerce")
    c["symbol"] = c["symbol"].astype(str).str.strip()
    for col in CASH_NUM:
        c[col] = pd.to_numeric(c[col], errors="coerce") if col in c.columns else np.nan
    bad = c["date"].isna() | c["symbol"].isin(["", "nan", "None"]) | ~(c["close"] > 0)
    notes["rows_dropped"] += int(bad.sum())
    c = c[~bad]
    dup = c.duplicated(["date", "symbol"], keep="last")
    notes["duplicates"] += int(dup.sum())
    c = c[~dup].sort_values(["symbol", "date"]).reset_index(drop=True)
    pc_bad = ~(c["prev_close"] > 0)
    c.loc[pc_bad, "prev_close"] = c.groupby("symbol")["close"].shift(1)[pc_bad]
    o = c["open"].where(c["open"] > 0, c["close"])
    hi = np.maximum.reduce([c["high"].fillna(0).to_numpy(), o.to_numpy(), c["close"].to_numpy()])
    lo = np.minimum.reduce([c["low"].where(c["low"] > 0, np.inf).to_numpy(), o.to_numpy(), c["close"].to_numpy()])
    changed = (o != c["open"]) | (hi != c["high"]) | (lo != c["low"])
    notes["ohlc_repaired"] += int(changed.sum())
    c["open"], c["high"], c["low"] = o, hi, lo
    c["volume"] = c["volume"].where(c["volume"] >= 0, 0).fillna(0)
    return c


def adjust_corporate_actions(cash: pd.DataFrame, notes: dict, ratio: float = 0.10, suspect: float = 0.40) -> pd.DataFrame:
    """Back-adjust history across split/bonus style events.

    NSE publishes prev_close already adjusted on the ex-date, so prev_close / yesterday's close far from 1
    marks an event; earlier rows are scaled by that factor so returns stay continuous. A huge move with an
    UNadjusted prev_close is only flagged (it may be a real crash)."""
    if cash.empty:
        return cash
    c = cash.sort_values(["symbol", "date"]).reset_index(drop=True)
    g = c.groupby("symbol")
    prev_close_row = g["close"].shift(1)
    gap_days = (c["date"] - g["date"].shift(1)).dt.days
    fac = c["prev_close"] / prev_close_row
    ev = ((fac - 1).abs() > ratio) & (gap_days <= 10) & fac.notna()
    jump = ((c["close"] / prev_close_row - 1).abs() > suspect) & ~ev & (gap_days <= 10) & prev_close_row.notna()
    for i in np.nonzero(jump.to_numpy())[0][:20]:
        notes["suspect_jumps"].append(dict(symbol=c.at[i, "symbol"], date=f"{c.at[i, 'date']:%Y-%m-%d}",
                                           move_pct=round(float(c.at[i, "close"] / prev_close_row[i] - 1) * 100, 1)))
    if not ev.any():
        return c
    c[["volume", "deliv_qty"]] = c[["volume", "deliv_qty"]].astype(float)
    for i in sorted(np.nonzero(ev.to_numpy())[0], key=lambda k: c.at[k, "date"], reverse=True):
        sym, d, f = c.at[i, "symbol"], c.at[i, "date"], float(fac[i])
        m = (c["symbol"] == sym) & (c["date"] < d)
        c.loc[m, PRICE_COLS] = c.loc[m, PRICE_COLS] * f
        c.loc[m, "volume"] = c.loc[m, "volume"] / f
        c.loc[m, "deliv_qty"] = c.loc[m, "deliv_qty"] / f
        notes["corp_actions"].append(dict(symbol=sym, date=f"{d:%Y-%m-%d}", factor=round(f, 6)))
    return c


def apply_renames(frames: dict[str, pd.DataFrame], renames: dict, notes: dict) -> dict[str, pd.DataFrame]:
    cash = frames.get("cash")
    for old, new in renames.items():
        if cash is None or old == new or old not in set(cash["symbol"]):
            continue
        if new in set(cash["symbol"]):                      # drop old rows on dates the new symbol already has
            new_dates = set(cash.loc[cash["symbol"] == new, "date"])
            cash = cash[~((cash["symbol"] == old) & cash["date"].isin(new_dates))]
        notes["renames"].append(f"{old}->{new}")
        frames["cash"] = cash
        for name, df in frames.items():
            if df is not None and len(df) and "symbol" in df.columns:
                frames[name] = df.assign(symbol=df["symbol"].replace(old, new))
        cash = frames["cash"]
    return frames


def clean_fo(fo: pd.DataFrame, notes: dict) -> pd.DataFrame:
    cols = ["date", "instr", "symbol", "expiry", "strike", "opt_type", "close", "oi", "chg_oi", "volume"]
    if fo is None or len(fo) == 0:
        return pd.DataFrame(columns=cols)
    f = fo.copy()
    f["date"] = pd.to_datetime(f["date"], errors="coerce")
    f["symbol"] = f["symbol"].astype(str).str.strip()
    for col in ("strike", "close", "oi", "chg_oi", "volume"):
        f[col] = pd.to_numeric(f[col], errors="coerce") if col in f.columns else np.nan
    for col in ("expiry", "opt_type", "instr"):
        if col not in f.columns:
            f[col] = ""
    bad = f["date"].isna() | f["symbol"].isin(["", "nan"])
    notes["fo_rows_dropped"] += int(bad.sum())
    return f[~bad].reset_index(drop=True)


# ------------------------------------------------------------------ market level
def sanitize_market(market, renames: dict | None = None, cfg: dict | None = None, load_errors=None):
    """Return a cleaned copy of a Market with `.health_notes` filled. Raises MarketDataError if the
    cash bhavcopy or the index series is unusable."""
    from loader import Market
    rc = robust_config(cfg)
    notes = new_notes()
    notes["load_errors"] = list(load_errors or [])
    cash = clean_cash(market.cash, notes)
    if cash.empty:
        raise MarketDataError("no usable cash bhavcopy rows (empty or all rows invalid)")
    idx = market.idx.copy() if market.idx is not None and len(market.idx) else pd.DataFrame(columns=["date", "index_name", "close"])
    if len(idx):
        idx["date"] = pd.to_datetime(idx["date"], errors="coerce")
        idx["close"] = pd.to_numeric(idx["close"], errors="coerce")
        idx = idx.dropna(subset=["date", "close"]).drop_duplicates(["date", "index_name"], keep="last")
    fo = clean_fo(market.fo, notes)
    iv = market.iv if market.iv is not None else pd.DataFrame()
    ev = market.events if market.events is not None else pd.DataFrame()
    frames = apply_renames(dict(cash=cash, fo=fo, iv=iv, events=ev), renames if renames is not None else load_renames(), notes)
    cash = adjust_corporate_actions(frames["cash"], notes, rc["corp_action_ratio"], rc["suspect_jump"])
    # partial days (most symbols missing) and stale symbols
    per_day = cash.groupby("date")["symbol"].nunique()
    med = per_day.rolling(60, min_periods=5).median().shift(1)
    part = per_day[(per_day < rc["partial_day_frac"] * med)].index[-10:]
    notes["partial_days"] = [f"{d:%Y-%m-%d}" for d in part]
    days = pd.DatetimeIndex(per_day.index)
    last_by_sym = cash.groupby("symbol")["date"].max()
    lag = days.searchsorted(days.max(), side="right") - days.searchsorted(last_by_sym.to_numpy(), side="right")
    notes["stale_symbols"] = sorted(last_by_sym.index[lag > rc["stale_symbol_days"]])[:50]
    out = Market(cash, frames["fo"], idx.reset_index(drop=True), frames["iv"], frames["events"], market.source)
    out.health_notes = notes
    return out


def data_health(market, asof, trade_date=None, bars_present: int | None = None, bars_expected: int | None = None,
                today=None) -> dict:
    """Which inputs were available for `asof` (the signal day) and what was repaired. Always returns a dict."""
    notes = getattr(market, "health_notes", None) or new_notes()
    asof = pd.Timestamp(asof)
    missing, warnings = [], []

    def day_rows(df):
        return int((df["date"] == asof).sum()) if df is not None and len(df) and "date" in df.columns else 0

    cash_n, fo_n = day_rows(market.cash), day_rows(market.fo)
    idx_n = int(((market.idx["date"] == asof) & (market.idx["index_name"] == "Nifty 50")).sum()) if len(market.idx) else 0
    required_bad = False
    if cash_n == 0:
        missing.append(f"cash bhavcopy for {asof:%Y-%m-%d}")
        required_bad = True
    if idx_n == 0:
        missing.append(f"Nifty 50 index close for {asof:%Y-%m-%d}")
        required_bad = True
    if fo_n == 0:
        missing.append(f"F&O bhavcopy for {asof:%Y-%m-%d} (OI features unavailable)")
    iv_n = day_rows(market.iv)
    if iv_n == 0:
        missing.append("iv.parquet (IV percentile, expected move and spread checks unavailable)")
    if market.events is None or len(market.events) == 0:
        missing.append("events.csv (event veto unavailable)")
    if bars_expected:
        if not bars_present:
            missing.append(f"15-minute bars for the trade day (0 of {bars_expected} picks)")
        elif bars_present < bars_expected:
            missing.append(f"15-minute bars for {bars_expected - bars_present} of {bars_expected} picks")
    if len(market.cash):
        days = pd.DatetimeIndex(sorted(market.cash["date"].unique()))
        if today is not None:
            lag = int(np.busday_count(days[-1].date(), pd.Timestamp(today).date()))
            if lag > 1:
                warnings.append(f"latest data is {days[-1]:%Y-%m-%d}, {lag} weekdays behind today")
        recent = pd.bdate_range(days[-1] - pd.Timedelta(days=30), days[-1])
        gaps = [d for d in recent if d not in set(days)]
        if gaps:
            warnings.append(f"{len(gaps)} weekday(s) in the last 30 days have no data (holidays or missing files)")
    if notes["partial_days"]:
        warnings.append("partial days (few symbols): " + ", ".join(notes["partial_days"][-3:]))
    if notes["stale_symbols"]:
        warnings.append(f"{len(notes['stale_symbols'])} symbols have stale data (e.g. {', '.join(notes['stale_symbols'][:3])})")
    if notes["corp_actions"]:
        warnings.append(f"{len(notes['corp_actions'])} split/bonus style adjustments applied to history")
    if notes["suspect_jumps"]:
        warnings.append(f"{len(notes['suspect_jumps'])} large one-day moves with unadjusted prices (check for corporate actions)")
    if notes["renames"]:
        warnings.append("symbol renames merged: " + ", ".join(notes["renames"]))
    for key, label in (("rows_dropped", "invalid cash rows dropped"), ("duplicates", "duplicate cash rows removed"),
                       ("ohlc_repaired", "cash rows with inconsistent OHLC repaired"), ("fo_rows_dropped", "invalid F&O rows dropped")):
        if notes[key]:
            warnings.append(f"{notes[key]} {label}")
    if notes["load_errors"]:
        warnings.append(f"{len(notes['load_errors'])} unreadable file(s) skipped")
    status = "bad" if required_bad else "degraded" if (missing or warnings) else "ok"
    return dict(status=status, asof=f"{asof:%Y-%m-%d}", trade_date=f"{pd.Timestamp(trade_date):%Y-%m-%d}" if trade_date is not None else None,
                source=market.source, missing=missing, warnings=warnings,
                inputs=dict(cash_rows=cash_n, fo_rows=fo_n, nifty_rows=idx_n, iv_rows=iv_n,
                            events=int(len(market.events)) if market.events is not None else 0),
                repairs=dict(corporate_actions=notes["corp_actions"][:20], renames=notes["renames"],
                             suspect_jumps=notes["suspect_jumps"][:10], stale_symbols=notes["stale_symbols"][:20],
                             load_errors=notes["load_errors"][:10]))


def bad_health(reason: str, asof=None, source: str = "real") -> dict:
    return dict(status="bad", asof=f"{pd.Timestamp(asof):%Y-%m-%d}" if asof is not None else None, trade_date=None,
                source=source, missing=[reason], warnings=[], inputs={}, repairs={})
