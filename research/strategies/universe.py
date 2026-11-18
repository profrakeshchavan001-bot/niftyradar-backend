"""Instrument universe for the strategy research. Reuses what's already in the repo
(`data/nse-fno-top60.json`, `data/nse-sectors.json`) instead of re-deriving a list, per the
task's "reuse what's there" instruction.

Nifty 200 constituents are NOT present anywhere in this repo (only the 60-symbol F&O fallback
list and the sector map used by the Yahoo-candle fallback). No network access was available to
pull the official NSE Nifty200 list (nseindia.com was blocked -- see FETCH_LOG.txt), so this
module falls back to a hardcoded ~90-name liquid large/mid-cap list built by extending the
repo's existing F&O-60 list with other well-known large/mid caps. This is a documented
limitation, not the real Nifty 200 index membership.
"""
from __future__ import annotations

import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = REPO_ROOT / "data"


def load_fno_universe() -> list[str]:
    """The repo's own F&O-liquid universe (paperbot/yahoo.js fallback list)."""
    with open(DATA_DIR / "nse-fno-top60.json") as f:
        return json.load(f)["symbols"]


def load_sector_map() -> dict:
    with open(DATA_DIR / "nse-sectors.json") as f:
        return json.load(f)["sectors"]


# Extra liquid large/mid caps not already in nse-fno-top60.json, added only to approximate a
# ~90-name Nifty200-like universe for S3/S6. LIMITATION: this is not the official Nifty 200
# constituent list (no network access to fetch it); see research/strategies/README.md.
_EXTRA_LARGE_MID_CAPS = [
    "LTIM", "DABUR", "GODREJCP", "PIDILITIND", "SIEMENS", "ABB", "HAVELLS", "VOLTAS", "CROMPTON",
    "AMBUJACEM", "SHREECEM", "ACC", "GODREJPROP", "OBEROIRLTY", "PRESTIGE", "LUPIN", "ZYDUSLIFE",
    "AUROPHARMA", "TORNTPHARM", "ALKEM", "MPHASIS", "PERSISTENT", "COFORGE", "LTTS", "PAGEIND",
    "COLPAL", "MARICO", "UBL", "BERGEPAINT", "ICICIPRULI", "ICICIGI", "CHOLAFIN", "MUTHOOTFIN",
    "PFC", "RECLTD", "IRFC", "GAIL", "IOC", "PETRONET", "NMDC", "SAIL", "JINDALSTEL", "ASHOKLEY",
    "TVSMOTOR", "BOSCHLTD", "MOTHERSON", "BHARATFORG", "SRF", "PIIND", "DEEPAKNTR", "AUBANK",
    "BANDHANBNK", "FEDERALBNK", "IDFCFIRSTB", "YESBANK", "ZOMATO", "NYKAA", "POLYCAB", "DIXON",
    "ABCAPITAL", "LICHSGFIN", "INDIGO", "CONCOR", "GMRINFRA", "ADANIGREEN", "ADANIPOWER",
    "ADANIENSOL", "JSWENERGY", "TATACOMM", "IDEA", "INDUSTOWER", "LODHA", "PHOENIXLTD",
]


def load_nifty200_like() -> list[str]:
    seen, out = set(), []
    for s in load_fno_universe() + _EXTRA_LARGE_MID_CAPS:
        if s not in seen:
            seen.add(s)
            out.append(s)
    return out


MACRO_TICKERS = {
    "nifty50": "^NSEI",
    "banknifty": "^NSEBANK",
    "gold": "GC=F",
    "crude": "CL=F",
    "usdinr": "USDINR=X",
    "btc": "BTC-USD",
}
