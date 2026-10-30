"""Deterministic synthetic fixtures (no network, no real prices). Real data run: CC8.

    python scores/make_fixtures.py
Writes fixtures/cash.csv, fixtures/idx.csv, fixtures/baserates.json.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
FIX = HERE / "fixtures"
SECTORS = {"Banks": ["HDFCBANK", "ICICIBANK", "SBIN", "AXISBANK"],
           "IT": ["TCS", "INFY", "WIPRO", "HCLTECH"],
           "Auto": ["MARUTI", "M&M", "BAJAJ-AUTO", "EICHERMOT"],
           "Energy": ["RELIANCE", "ONGC", "BPCL", "IOC"],
           "Metals": ["TATASTEEL", "JSWSTEEL", "HINDALCO", "VEDL"],
           "FMCG": ["ITC", "HINDUNILVR", "NESTLEIND", "DABUR"]}


def make(days: int = 300, seed: int = 7, end: str = "2026-10-28"):
    rng = np.random.default_rng(seed)
    dates = pd.bdate_range(end=end, periods=days)
    mkt = rng.normal(0.0004, 0.008, days)
    rows, sec_drift = [], {s: rng.normal(0, 0.0006) for s in SECTORS}
    for sec, syms in SECTORS.items():
        sec_noise = rng.normal(sec_drift[sec], 0.004, days)
        for s in syms:
            r = mkt + sec_noise + rng.normal(rng.normal(0, 0.0004), 0.011, days)
            close = 100 * rng.uniform(2, 20) * np.exp(np.cumsum(r))
            vol = rng.uniform(2e6, 9e6) * np.exp(rng.normal(0, 0.25, days))
            vol[-5:] *= rng.choice([1, 1, 2.2])
            deliv = np.clip(rng.normal(48, 6, days), 15, 90)
            rows.append(pd.DataFrame({"date": dates, "symbol": s, "sector": sec,
                                      "close": close.round(2), "volume": vol.round(),
                                      "deliv_pct": deliv.round(1)}))
    cash = pd.concat(rows, ignore_index=True)
    idx = pd.DataFrame({"date": dates, "nifty": (22000 * np.exp(np.cumsum(mkt))).round(2),
                        "vix": np.clip(15 + np.cumsum(rng.normal(0, 0.5, days)) * 0.3
                                       - mkt * 200, 9, 40).round(2)})
    return cash, idx


BASERATES = {
    "asof": "2026-10-28", "source": "fixture", "horizon_days": 10, "n_tested": 4,
    "setups": [
        {"name": "Delivery spike + above 50-day average", "samples": 412, "hit_rate": 0.57,
         "base_rate": 0.51, "p_value": 0.012, "survived": True,
         "note": "Survived out-of-sample and multiple-test correction."},
        {"name": "Fresh 52-week high with volume surge", "samples": 230, "hit_rate": 0.53,
         "base_rate": 0.51, "p_value": 0.31, "survived": False, "note": "Not distinguishable from base rate."},
        {"name": "Sector leader pullback", "samples": 96, "hit_rate": 0.49,
         "base_rate": 0.51, "p_value": 0.62, "survived": False, "note": "Too few samples."},
        {"name": "Oversold bounce", "samples": 301, "hit_rate": 0.50,
         "base_rate": 0.51, "p_value": 0.74, "survived": False, "note": "No difference from base rate."},
    ],
}

if __name__ == "__main__":
    FIX.mkdir(exist_ok=True)
    c, i = make()
    c.to_csv(FIX / "cash.csv", index=False)
    i.to_csv(FIX / "idx.csv", index=False)
    (FIX / "baserates.json").write_text(json.dumps(BASERATES, indent=2))
    print("fixtures:", len(c), "cash rows,", len(i), "idx rows")
