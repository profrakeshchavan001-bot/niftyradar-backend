"""Market -> wide panels (date x symbol). The ONLY place that touches the loader.

Real data: set DATA_DIR (see loader.py) and optionally pass fundamentals.csv. Nothing here is
hard-wired to fixtures.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

NIFTY = "Nifty 50"
VIX = "India VIX"
FUND_COLS = ["symbol", "roe", "debt_equity", "profit_margin", "pe", "pb", "promoter_pct", "promoter_pledge_pct"]


class Panels:
    """Plain container: wide frames + metadata. All frames share one date index and symbol columns."""

    def __init__(self, cash: pd.DataFrame, idx: pd.DataFrame, sectors: dict, fo: pd.DataFrame | None = None,
                 fundamentals: pd.DataFrame | None = None):
        cash = cash.copy()
        cash["date"] = pd.to_datetime(cash["date"])
        cash = cash.drop_duplicates(["date", "symbol"], keep="last")
        w = lambda c: cash.pivot(index="date", columns="symbol", values=c).sort_index()  # noqa: E731
        self.close, self.open = w("close"), w("open")
        self.high, self.low = w("high"), w("low")
        self.volume, self.deliv = w("volume"), w("deliv_pct")
        self.dates, self.symbols = self.close.index, self.close.columns
        i = idx.copy()
        i["date"] = pd.to_datetime(i["date"])
        piv = i.pivot_table(index="date", columns="index_name", values="close", aggfunc="last").sort_index()
        self.nifty = piv[NIFTY].reindex(self.dates) if NIFTY in piv else pd.Series(np.nan, index=self.dates)
        self.vix = piv[VIX].reindex(self.dates) if VIX in piv else None
        self.sector = pd.Series({s: sectors.get(s, "Other") for s in self.symbols})
        self.pcr = _pcr(fo, self.dates)
        self.fundamentals = _fund(fundamentals, self.symbols)
        self.source = "unknown"
        self.member = None            # date x symbol bool, point-in-time F&O membership (None = no F&O data)


def _pcr(fo, dates):
    """Stock-option put/call open-interest ratio per day (None if no option rows)."""
    if fo is None or len(fo) == 0 or "opt_type" not in fo or "instr" not in fo:
        return None
    o = fo[fo["instr"] == "STO"].copy()
    if o.empty:
        return None
    o["date"] = pd.to_datetime(o["date"])
    g = o.groupby(["date", "opt_type"])["oi"].sum().unstack()
    if "PE" not in g or "CE" not in g:
        return None
    return (g["PE"] / g["CE"].where(g["CE"] > 0)).reindex(dates)


def _fund(f, symbols):
    if f is None or len(f) == 0:
        return None
    f = f.copy()
    for c in FUND_COLS[1:]:
        if c not in f:
            f[c] = np.nan
    return f.drop_duplicates("symbol", keep="last").set_index("symbol").reindex(symbols)[FUND_COLS[1:]].apply(pd.to_numeric, errors="coerce")


def load_sectors(path: Path | None = None) -> dict:
    with open(path or ROOT / "sectors.json", encoding="utf-8") as fh:
        return json.load(fh)


def read_fundamentals(path) -> pd.DataFrame | None:
    """fundamentals.csv: symbol, roe, debt_equity, profit_margin, pe, pb, promoter_pct, promoter_pledge_pct.
    A point-in-time-unsafe SNAPSHOT: used for today's score only, never in validation."""
    if not path or not Path(path).exists():
        return None
    try:
        df = pd.read_csv(path)
    except Exception as exc:               # empty/corrupt file: do not take the whole run down, say so
        print(f"WARNING: fundamentals file {path} unreadable ({type(exc).__name__}); quality/valuation skipped", file=sys.stderr)
        return None
    from scores import fundamentals as F  # noqa: PLC0415
    errs = F.validate_frame(df[[c for c in F.SCHEMA if c in df.columns]].reindex(columns=F.SCHEMA), min_fill=0.0) if len(df) else ["no rows"]
    bad = [e for e in errs if "outside" in e or "duplicate" in e or "non-numeric" in e or "no rows" in e]
    if bad:
        print("WARNING: fundamentals file has problems, quality/valuation skipped: " + "; ".join(bad[:3]), file=sys.stderr)
        return None
    return df


def from_market(market, sectors: dict | None = None, fundamentals: pd.DataFrame | None = None,
                pit_universe: bool = True) -> Panels:
    """Panels for the point-in-time F&O universe: only stocks that were ever in F&O are loaded, and a
    stock is scored only on days it was a member (survivorship-free by construction)."""
    from scores import universe
    cash, fo = market.cash, (market.fo if len(market.fo) else None)
    mem = None
    if pit_universe and fo is not None:
        dates = pd.DatetimeIndex(sorted(pd.to_datetime(cash["date"]).unique()))
        mem = universe.membership(fo, dates, _renames())
        ever = universe.ever_members(mem)
        if ever:
            cash = cash[cash["symbol"].isin(ever)]
            mem = mem[ever]
    P = Panels(cash, market.idx, sectors if sectors is not None else load_sectors(), fo, fundamentals)
    if mem is not None and len(mem.columns):
        P.member = mem.reindex(index=P.dates, columns=P.symbols, fill_value=False)
    return P


def _renames() -> dict:
    try:
        with open(ROOT / "symbol_renames.json", encoding="utf-8") as fh:
            return {k: v for k, v in json.load(fh).items() if not k.startswith("_")}
    except (OSError, ValueError):
        return {}


def load(fundamentals_path=None, sectors_path=None) -> Panels:
    """Fixtures if DATA_DIR unset, else real day files (loader.load_market decides)."""
    from loader import load_market
    m = load_market()
    P = from_market(m, load_sectors(sectors_path), read_fundamentals(fundamentals_path))
    P.source = m.source
    return P
