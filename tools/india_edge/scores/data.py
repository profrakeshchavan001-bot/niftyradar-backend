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
    return pd.read_csv(path)


def from_market(market, sectors: dict | None = None, fundamentals: pd.DataFrame | None = None) -> Panels:
    return Panels(market.cash, market.idx, sectors if sectors is not None else load_sectors(),
                  market.fo if len(market.fo) else None, fundamentals)


def load(fundamentals_path=None, sectors_path=None) -> Panels:
    """Fixtures if DATA_DIR unset, else real day files (loader.load_market decides)."""
    from loader import load_market
    m = load_market()
    P = from_market(m, load_sectors(sectors_path), read_fundamentals(fundamentals_path))
    P.source = m.source
    return P
