"""S3 - Nifty 200 momentum (12-1 month momentum, the classic Jegadeesh-Titman formation
window), monthly rebalance, only active when Nifty's OWN trailing 12-month return > 0.

No-lookahead guard (read this before touching the ranking math):
  At rebalance date t (a month-end), the formation-period return for each stock is
      close[t - 1 month] / close[t - 12 months] - 1
  i.e. the most recent completed month (t-1m .. t) is SKIPPED on purpose (classic momentum
  "skip the most recent month" to avoid 1-month reversal / microstructure noise), and every
  price used is dated <= t-1month, strictly before the rebalance date t. The trade entered AT
  t then holds to t+1 using only the entry price at t (known) and the t+1 close (realized in
  the future, which is fine -- that's the P&L being measured, not a lookahead in the SIGNAL).
"""
from __future__ import annotations

import pandas as pd

from costs import equity_delivery_costs
from metrics import summarize


def _monthly_close_panel(closes: dict[str, pd.Series]) -> pd.DataFrame:
    cols = {}
    for sym, s in closes.items():
        s = s.dropna()
        if len(s) == 0:
            continue
        cols[sym] = s.resample("ME").last()
    return pd.DataFrame(cols)


def rank_top_n(panel: pd.DataFrame, as_of_idx: int, n: int = 30) -> list[str]:
    """Rank stocks by (close[as_of-1] / close[as_of-12] - 1), i.e. the 11-month return ending
    one month BEFORE `as_of`. Returns the top-n symbol names. `as_of_idx` is a row position in
    `panel`; only rows strictly before as_of_idx are read -- no lookahead."""
    if as_of_idx < 12:
        return []
    skip_row = panel.iloc[as_of_idx - 1]   # month t-1 (the skipped month's start price)
    base_row = panel.iloc[as_of_idx - 12]  # month t-12
    mom = (skip_row / base_row - 1.0).dropna()
    mom = mom.replace([float("inf"), float("-inf")], pd.NA).dropna()
    return list(mom.sort_values(ascending=False).head(n).index)


def backtest_s3(nifty_daily: pd.DataFrame, stock_closes: dict[str, pd.Series],
                 capital: float = 100_000.0, top_n: int = 30):
    nifty_m = nifty_daily["close"].dropna().resample("ME").last()
    panel = _monthly_close_panel(stock_closes)
    common_idx = panel.index.intersection(nifty_m.index).sort_values()
    panel = panel.reindex(common_idx)
    nifty_m = nifty_m.reindex(common_idx)

    trades = []
    for i in range(12, len(common_idx) - 1):
        nifty_12m_ret = nifty_m.iloc[i] / nifty_m.iloc[i - 12] - 1.0
        if nifty_12m_ret <= 0:
            continue  # regime filter: only active when Nifty's own 12m return > 0
        picks = rank_top_n(panel, i, top_n)
        if not picks:
            continue
        per_stock_capital = capital / top_n
        for sym in picks:
            entry_px, exit_px = panel[sym].iloc[i], panel[sym].iloc[i + 1]
            if pd.isna(entry_px) or pd.isna(exit_px) or entry_px <= 0:
                continue
            buy_value = per_stock_capital
            sell_value = per_stock_capital * (exit_px / entry_px)
            c = equity_delivery_costs(buy_value, sell_value)
            trades.append({
                "entry_date": common_idx[i], "exit_date": common_idx[i + 1], "symbol": sym,
                "side": "long", "entry_px": float(entry_px), "exit_px": float(exit_px),
                "pnl_inr": round((sell_value - buy_value) - c.total, 2), "costs_inr": c.total,
            })
    return trades


def run(nifty_train, nifty_test, stock_closes_train: dict, stock_closes_test: dict,
        capital: float = 100_000.0) -> dict:
    train_trades = backtest_s3(nifty_train, stock_closes_train, capital)
    test_trades = backtest_s3(nifty_test, stock_closes_test, capital)
    return {"train": summarize(train_trades, capital), "test": summarize(test_trades, capital),
            "train_trades": train_trades, "test_trades": test_trades}
