"""Plain data holders shared by every chain module."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date as _date

INDEX_SYMBOLS = ("NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50")


@dataclass
class Strike:
    strike: float
    ce_oi: float = 0
    ce_vol: float = 0
    ce_chg: float = 0
    ce_ltp: float = 0.0
    pe_oi: float = 0
    pe_vol: float = 0
    pe_chg: float = 0
    pe_ltp: float = 0.0


@dataclass
class Chain:
    symbol: str
    date: str          # ISO trade date
    expiry: str        # ISO expiry
    spot: float
    rows: list = field(default_factory=list)   # list[Strike], sorted by strike

    def __post_init__(self):
        self.rows.sort(key=lambda r: r.strike)

    @property
    def dte(self) -> int:
        return (_date.fromisoformat(self.expiry) - _date.fromisoformat(self.date)).days

    @property
    def years(self) -> float:
        return max(self.dte, 0.5) / 365.0

    @property
    def step(self) -> float:
        ks = [r.strike for r in self.rows]
        diffs = [b - a for a, b in zip(ks, ks[1:]) if b > a]
        return min(diffs) if diffs else 1.0

    def row(self, strike: float):
        for r in self.rows:
            if abs(r.strike - strike) < 1e-9:
                return r
        return None
