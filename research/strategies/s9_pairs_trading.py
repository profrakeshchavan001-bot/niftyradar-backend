"""S9 - Pairs trading on same-sector F&O stocks.

No-lookahead guard (the whole point of this module): `select_pairs()` is handed ONLY the
train-period price panel and picks cointegrated pairs + hedge ratios using exclusively that
data. `backtest_pairs()` then applies those FIXED pairs/ratios to a separate price panel
(which may be train or test) without ever re-fitting on it. Calling code must never pass the
test panel into `select_pairs()` -- `run()` enforces this by construction (it only calls
`select_pairs` on `closes_train`).
"""
from __future__ import annotations

from itertools import combinations

import numpy as np
import pandas as pd
from statsmodels.tsa.stattools import coint

from costs import equity_delivery_costs
from metrics import summarize


def select_pairs(closes_train: dict[str, pd.Series], sector_map: dict, pval_threshold: float = 0.05):
    """Engle-Granger cointegration test, TRAIN DATA ONLY. Returns a list of
    (sym_a, sym_b, hedge_ratio) picked using nothing but closes_train."""
    pairs = []
    for sector, info in sector_map.items():
        stocks = [s for s in info.get("stocks", []) if s in closes_train]
        for a, b in combinations(stocks, 2):
            sa, sb = closes_train[a].dropna(), closes_train[b].dropna()
            idx = sa.index.intersection(sb.index)
            if len(idx) < 250:
                continue
            sa, sb = sa.loc[idx], sb.loc[idx]
            try:
                _, pvalue, _ = coint(sa.values, sb.values)
            except Exception:
                continue
            if pvalue < pval_threshold:
                hedge_ratio = float(np.polyfit(sb.values, sa.values, 1)[0])
                pairs.append((a, b, hedge_ratio, pvalue))
    pairs.sort(key=lambda p: p[3])
    return pairs


def _spread_zscore(sa: pd.Series, sb: pd.Series, hedge_ratio: float, window: int = 60):
    spread = sa - hedge_ratio * sb
    mean = spread.rolling(window).mean()
    std = spread.rolling(window).std()
    return (spread - mean) / std, spread


def backtest_pair(sa: pd.Series, sb: pd.Series, hedge_ratio: float, capital_leg: float = 50_000.0,
                   entry_z: float = 2.0, exit_z: float = 0.0, stop_z: float = 3.0):
    idx = sa.index.intersection(sb.index)
    sa, sb = sa.loc[idx].dropna(), sb.loc[idx].dropna()
    idx = sa.index.intersection(sb.index)
    sa, sb = sa.loc[idx], sb.loc[idx]
    z, spread = _spread_zscore(sa, sb, hedge_ratio)

    trades = []
    pos = None  # {"side": "long_spread"/"short_spread", "entry_i": i}
    for i in range(60, len(idx)):
        zi = z.iloc[i]
        if pd.isna(zi):
            continue
        if pos is None:
            if zi >= entry_z:
                pos = {"side": "short_spread", "entry_i": i}  # spread too high -> short A, long B
            elif zi <= -entry_z:
                pos = {"side": "long_spread", "entry_i": i}
        else:
            stopped = (pos["side"] == "short_spread" and zi >= stop_z) or \
                      (pos["side"] == "long_spread" and zi <= -stop_z)
            reverted = (pos["side"] == "short_spread" and zi <= exit_z) or \
                       (pos["side"] == "long_spread" and zi >= exit_z)
            if stopped or reverted or i == len(idx) - 1:
                entry_i = pos["entry_i"]
                a_entry, a_exit = float(sa.iloc[entry_i]), float(sa.iloc[i])
                b_entry, b_exit = float(sb.iloc[entry_i]), float(sb.iloc[i])
                if pos["side"] == "short_spread":  # short A, long B
                    a_pnl = capital_leg * (a_entry - a_exit) / a_entry
                    b_pnl = capital_leg * (b_exit - b_entry) / b_entry
                else:
                    a_pnl = capital_leg * (a_exit - a_entry) / a_entry
                    b_pnl = capital_leg * (b_entry - b_exit) / b_entry
                c = equity_delivery_costs(capital_leg, capital_leg)
                c2 = equity_delivery_costs(capital_leg, capital_leg)
                gross = a_pnl + b_pnl
                trades.append({
                    "entry_date": idx[entry_i], "exit_date": idx[i], "side": pos["side"],
                    "pnl_inr": round(gross - c.total - c2.total, 2), "costs_inr": c.total + c2.total,
                })
                pos = None
    return trades


def run(closes_train: dict[str, pd.Series], closes_test: dict[str, pd.Series], sector_map: dict,
        capital: float = 100_000.0, max_pairs: int = 5) -> dict:
    pairs = select_pairs(closes_train, sector_map)  # TRAIN ONLY, by construction
    pairs = pairs[:max_pairs]
    capital_leg = capital / max(1, len(pairs)) / 2

    train_trades, test_trades = [], []
    for a, b, hedge_ratio, _ in pairs:
        if a in closes_train and b in closes_train:
            train_trades += backtest_pair(closes_train[a], closes_train[b], hedge_ratio, capital_leg)
        if a in closes_test and b in closes_test:
            test_trades += backtest_pair(closes_test[a], closes_test[b], hedge_ratio, capital_leg)

    return {"pairs": [(a, b, round(h, 3), round(p, 4)) for a, b, h, p in pairs],
            "train": summarize(train_trades, capital), "test": summarize(test_trades, capital),
            "train_trades": train_trades, "test_trades": test_trades}
