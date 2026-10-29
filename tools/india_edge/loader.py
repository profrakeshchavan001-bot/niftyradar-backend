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

from common import ROOT, data_root

FIXTURES = ROOT / "tests" / "fixtures"


@dataclass
class Market:
    cash: pd.DataFrame
    fo: pd.DataFrame
    idx: pd.DataFrame
    iv: pd.DataFrame = field(default_factory=pd.DataFrame)       # date, symbol, iv, opt_spread_pct, opt_premium
    events: pd.DataFrame = field(default_factory=pd.DataFrame)   # date, symbol ('ALL' = market-wide), kind
    source: str = "fixtures"
    health_notes: dict = field(default_factory=dict)

    @property
    def dates(self) -> pd.DatetimeIndex:
        return pd.DatetimeIndex(sorted(self.cash["date"].unique()))

    def truncate(self, last: pd.Timestamp) -> "Market":
        """Only data up to and including `last` (what the scanner may see as-of that day)."""
        cut = lambda df: df[df["date"] <= pd.Timestamp(last)] if len(df) else df  # noqa: E731
        m = Market(cut(self.cash), cut(self.fo), cut(self.idx), self.iv, self.events, self.source)
        m.health_notes = self.health_notes
        return m


def _opt(path: Path, csv: bool = False) -> pd.DataFrame:
    """Optional input: missing, unreadable or malformed files give an empty frame."""
    if not path.exists():
        return pd.DataFrame()
    try:
        df = pd.read_csv(path) if csv else pd.read_parquet(path)
        df["date"] = pd.to_datetime(df["date"])
    except Exception:
        return pd.DataFrame()
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


def read_days(name: str, errors: list) -> pd.DataFrame:
    """Concatenate every readable day file of one dataset. Unreadable or empty files are skipped and
    recorded in `errors`; a missing folder is just an empty frame."""
    d = data_root() / name
    if not d.is_dir():
        return pd.DataFrame()
    frames = []
    for f in sorted(d.glob("*.parquet")):
        try:
            df = pd.read_parquet(f)
        except Exception as exc:  # corrupt/partial download
            errors.append(f"{name}/{f.name}: {type(exc).__name__}")
            continue
        if len(df) == 0:
            errors.append(f"{name}/{f.name}: empty")
            continue
        frames.append(df)
    if not frames:
        return pd.DataFrame()
    out = pd.concat(frames, ignore_index=True)
    if "date" in out.columns:
        out["date"] = pd.to_datetime(out["date"], errors="coerce")
    return out


def load_market() -> Market:
    """Fixtures when DATA_DIR is unset, else real day files. Always returns a sanitised Market or
    raises MarketDataError (a SystemExit with a readable message) if cash or the index is unusable."""
    from robust import MarketDataError, sanitize_market
    env = os.environ.get("DATA_DIR")
    if not env:
        return sanitize_market(load_fixtures())
    errors: list = []
    cash, fo, idx = read_days("cash", errors), read_days("fo", errors), read_days("idx", errors)
    if cash.empty:
        raise MarketDataError(f"DATA_DIR={env} has no readable cash day files; run data/fetch.py first")
    if idx.empty:
        raise MarketDataError(f"DATA_DIR={env} has no readable index day files (Nifty 50 needed for RS)")
    root = Path(env)
    m = Market(cash, fo, idx, _opt(root / "iv.parquet"), _opt(root / "events.csv", csv=True), "real")
    return sanitize_market(m, load_errors=errors)
