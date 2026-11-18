"""Trade-list -> performance metrics. Pure functions, no I/O, no lookahead risk.

A "trade" is a dict with at least: pnl_inr (float, net of costs), entry_date, exit_date.
"""
from __future__ import annotations

from typing import Iterable, Mapping, Sequence


def equity_curve(trades: Sequence[Mapping], starting_capital: float) -> list[float]:
    cap = starting_capital
    curve = [cap]
    for t in trades:
        cap += float(t["pnl_inr"])
        curve.append(cap)
    return curve


def max_drawdown_inr(trades: Sequence[Mapping], starting_capital: float) -> float:
    curve = equity_curve(trades, starting_capital)
    peak = curve[0]
    max_dd = 0.0
    for v in curve:
        if v > peak:
            peak = v
        dd = peak - v
        if dd > max_dd:
            max_dd = dd
    return round(max_dd, 2)


def profit_factor(trades: Sequence[Mapping]) -> float:
    gains = sum(t["pnl_inr"] for t in trades if t["pnl_inr"] > 0)
    losses = -sum(t["pnl_inr"] for t in trades if t["pnl_inr"] < 0)
    if losses == 0:
        return float("inf") if gains > 0 else 0.0
    return round(gains / losses, 3)


def win_rate_pct(trades: Sequence[Mapping]) -> float:
    if not trades:
        return 0.0
    wins = sum(1 for t in trades if t["pnl_inr"] > 0)
    return round(100.0 * wins / len(trades), 2)


def net_profit_inr(trades: Sequence[Mapping]) -> float:
    return round(sum(t["pnl_inr"] for t in trades), 2)


def summarize(trades: Sequence[Mapping], starting_capital: float = 100_000.0) -> dict:
    trades = list(trades)
    return {
        "n_trades": len(trades),
        "win_pct": win_rate_pct(trades),
        "net_profit_inr": net_profit_inr(trades),
        "max_drawdown_inr": max_drawdown_inr(trades, starting_capital),
        "profit_factor": profit_factor(trades),
    }


def verdict(train_summary: Mapping, test_summary: Mapping, min_test_trades: int = 30) -> tuple[str, str]:
    """PASS only if net profit > 0 on BOTH train and test, AND test has >= min_test_trades.
    Returns (verdict_str, reason). Reason is blank ("") for PASS."""
    if test_summary["n_trades"] < min_test_trades:
        return "LOW-DATA", f"only {test_summary['n_trades']} test trades (< {min_test_trades} required)"
    if train_summary["net_profit_inr"] <= 0 and test_summary["net_profit_inr"] <= 0:
        return "FAIL", "unprofitable after costs on both train and test"
    if train_summary["net_profit_inr"] <= 0:
        return "FAIL", "unprofitable after costs on train period"
    if test_summary["net_profit_inr"] <= 0:
        return "FAIL", "unprofitable after costs on test period (overfit to train)"
    return "PASS", ""
