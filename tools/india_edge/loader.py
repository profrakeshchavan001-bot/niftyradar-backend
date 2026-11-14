"""One entry point for market data: synthetic fixtures or real bhavcopy.

    DATA_DIR unset -> tests/fixtures/*.parquet (synthetic, deterministic)
    DATA_DIR set   -> <DATA_DIR>/{cash,fo,idx}/YYYY-MM-DD.parquet written by data/fetch.py
                      (optional <DATA_DIR>/iv.parquet and events.csv if you have them)
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

import pandas as pd

from common import ROOT, load_dataset

FIXTURES = ROOT / "tests" / "fixtures"


@dataclass
class Market:
    cash: pd.DataFrame
    fo: pd.DataFrame
    idx: pd.DataFrame
    iv: pd.DataFrame = field(default_factory=pd.DataFrame)       # date, symbol, iv, opt_spread_pct, opt_premium
    events: pd.DataFrame = field(default_factory=pd.DataFrame)   # date, symbol ('ALL' = market-wide), kind
    source: str = "fixtures"

    @property
    def dates(self) -> pd.DatetimeIndex:
        return pd.DatetimeIndex(sorted(self.cash["date"].unique()))

    def truncate(self, last: pd.Timestamp) -> "Market":
        """Only data up to and including `last` (what the scanner may see as-of that day)."""
        cut = lambda df: df[df["date"] <= pd.Timestamp(last)] if len(df) else df  # noqa: E731
        return Market(cut(self.cash), cut(self.fo), cut(self.idx), self.iv, self.events, self.source)


def _opt(path: Path, csv: bool = False) -> pd.DataFrame:
    if not path.exists():
        return pd.DataFrame()
    df = pd.read_csv(path) if csv else pd.read_parquet(path)
    df["date"] = pd.to_datetime(df["date"])
    return df


def load_fixtures(directory: Path = FIXTURES) -> Market:
    if not (directory / "cash.parquet").exists():  # regenerate deterministically if absent
        import importlib.util
        spec = importlib.util.spec_from_file_location("fx_generate", FIXTURES / "generate.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        mod.write(directory)
    rd = lambda n: _opt(directory / f"{n}.parquet")  # noqa: E731
    return Market(rd("cash"), rd("fo"), rd("idx"), rd("iv"), rd("events"), "fixtures")


def load_market() -> Market:
    env = os.environ.get("DATA_DIR")
    if not env:
        return load_fixtures()
    cash, fo, idx = load_dataset("cash"), load_dataset("fo"), load_dataset("idx")
    if cash.empty or fo.empty or idx.empty:
        raise SystemExit(f"DATA_DIR={env} has no cash/fo/idx day files; run data/fetch.py first")
    root = Path(env)
    return Market(cash, fo, idx, _opt(root / "iv.parquet"), _opt(root / "events.csv", csv=True), "real")
