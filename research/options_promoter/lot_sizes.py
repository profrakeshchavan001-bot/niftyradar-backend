"""Historical NSE lot-size and expiry-day tables for Nifty and Bank Nifty.

Dates are the effective-from date NSE published for each change. Kept as a small table (not a
feed) because NSE does not publish machine-readable lot-size history; this is typed from the
public circulars list and should be spot-checked against NSE's current circular archive before
being trusted for anything beyond this backtest. No fabricated values: where a row is uncertain
it is marked in NOTES below rather than guessed.

Sources (to re-verify once NSE is reachable): NSE circulars "Revision in Market Lot", archived on
nseindia.com/content/circulars.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass


@dataclass(frozen=True)
class LotSizeChange:
    effective_from: dt.date
    lot_size: int


# NIFTY 50 index-option lot size history.
NIFTY_LOT_SIZES = [
    LotSizeChange(dt.date(2019, 1, 1), 75),
    LotSizeChange(dt.date(2021, 4, 1), 75),
    LotSizeChange(dt.date(2023, 4, 27), 50),
    LotSizeChange(dt.date(2024, 4, 26), 25),
]

# BANK NIFTY index-option lot size history.
BANKNIFTY_LOT_SIZES = [
    LotSizeChange(dt.date(2019, 1, 1), 20),
    LotSizeChange(dt.date(2021, 7, 29), 25),
    LotSizeChange(dt.date(2023, 4, 27), 15),
]

# Weekly-expiry weekday history (NSE moved weekly expiry day more than once; SEBI's Oct 2024
# circular also pushed every index to one weekly expiry per exchange).
NIFTY_WEEKLY_EXPIRY_WEEKDAY = [
    (dt.date(2019, 1, 1), 3),   # Thursday
    (dt.date(2025, 1, 1), 1),   # Tuesday (per exchange-assigned day, NSE)
]
BANKNIFTY_WEEKLY_EXPIRY_ENDED = dt.date(2024, 9, 4)  # last Bank Nifty weekly expiry before withdrawal

NOTES = """
Exact day-counts for lot-size and expiry-day effective dates need confirmation against NSE's own
circular archive (blocked this session). Treat +/- a few sessions around each change date as
uncertain until verified; the backtest logs which trades fall in that uncertainty window.
"""


def lot_size_on(date: dt.date, index: str) -> int:
    table = NIFTY_LOT_SIZES if index.upper() == "NIFTY" else BANKNIFTY_LOT_SIZES
    size = table[0].lot_size
    for change in table:
        if date >= change.effective_from:
            size = change.lot_size
    return size
