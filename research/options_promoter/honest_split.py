"""Train (first 60%) / test (last 40%) split, lookahead audit, and the brief's PASS/FAIL/LOW-DATA
verdict rule. One shared place so Group 2 and Group 3 are judged identically.
"""
from __future__ import annotations

from dataclasses import dataclass


def split_by_date(trades: list, date_field: str, train_frac: float = 0.6):
    """Split a chronologically-sorted trade list into train/test by DATE RANGE, not by trade
    count -- so a cluster of trades near the boundary cannot leak across it.
    """
    dated = sorted(trades, key=lambda t: getattr(t, date_field))
    if not dated:
        return [], []
    start, end = getattr(dated[0], date_field), getattr(dated[-1], date_field)
    cutoff_days = (end - start).days * train_frac
    cutoff = start.fromordinal(start.toordinal() + int(cutoff_days))
    train = [t for t in dated if getattr(t, date_field) <= cutoff]
    test = [t for t in dated if getattr(t, date_field) > cutoff]
    return train, test


def net_profit(trades: list, pnl_field: str = "net_pnl") -> float:
    return round(sum(getattr(t, pnl_field) for t in trades), 2)


def worst_week_vs_six_month_avg(trades: list, date_field: str, pnl_field: str) -> tuple[float, float, bool]:
    """Returns (worst_week_pnl, six_month_avg_profit, worst_week_wipes_out_6mo_avg)."""
    if not trades:
        return 0.0, 0.0, False
    by_week: dict = {}
    for t in trades:
        d = getattr(t, date_field)
        key = (d.isocalendar()[0], d.isocalendar()[1])
        by_week.setdefault(key, 0.0)
        by_week[key] += getattr(t, pnl_field)
    worst_week = min(by_week.values()) if by_week else 0.0

    dated = sorted(trades, key=lambda t: getattr(t, date_field))
    start, end = getattr(dated[0], date_field), getattr(dated[-1], date_field)
    months = max((end - start).days / 30.44, 1e-6)
    monthly_avg = net_profit(trades, pnl_field) / months
    six_month_avg = monthly_avg * 6
    wiped_out = worst_week < 0 and abs(worst_week) > six_month_avg
    return round(worst_week, 2), round(six_month_avg, 2), wiped_out


@dataclass
class Verdict:
    variant_name: str
    verdict: str  # "PASS" / "FAIL" / "LOW-DATA"
    reason: str
    train_net: float
    test_net: float
    test_trade_count: int


def judge(variant_name: str, train_trades: list, test_trades: list, *, pnl_field: str = "net_pnl",
          date_field: str = "entry_date", min_test_trades: int = 30,
          check_worst_week: bool = False) -> Verdict:
    train_net = net_profit(train_trades, pnl_field)
    test_net = net_profit(test_trades, pnl_field)
    n_test = len(test_trades)

    if n_test < min_test_trades:
        return Verdict(variant_name, "LOW-DATA",
                        f"only {n_test} test trades (need >= {min_test_trades}); "
                        "not enough data to call pass or fail", train_net, test_net, n_test)

    if train_net <= 0 or test_net <= 0:
        return Verdict(variant_name, "FAIL",
                        f"net profit after costs was train={train_net}, test={test_net} -- "
                        "needs to be positive on BOTH to pass", train_net, test_net, n_test)

    if check_worst_week:
        worst_week, six_mo_avg, wiped = worst_week_vs_six_month_avg(train_trades + test_trades,
                                                                     date_field, pnl_field)
        if wiped:
            return Verdict(variant_name, "FAIL",
                            f"worst week lost Rs {abs(worst_week)}, more than 6 months of average "
                            f"profit (Rs {six_mo_avg}) -- one bad week can erase half a year's gains",
                            train_net, test_net, n_test)

    return Verdict(variant_name, "PASS",
                    f"net positive after costs on both train (Rs {train_net}) and test "
                    f"(Rs {test_net}), {n_test} test trades", train_net, test_net, n_test)


def lookahead_audit(build_fn, full_data, cutoff_date, date_field: str = "date") -> bool:
    """Cut-the-future check: result for all dates <= cutoff built from the FULL dataset must equal
    the result built from data truncated at cutoff_date. Returns True if no lookahead detected.
    `build_fn(data) -> list of records with a date_field <= cutoff to compare`.
    """
    truncated = full_data[full_data[date_field] <= cutoff_date]
    full_result = [r for r in build_fn(full_data) if getattr(r, date_field, None) is None or
                   getattr(r, date_field) <= cutoff_date]
    truncated_result = build_fn(truncated)
    return full_result == truncated_result
