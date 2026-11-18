"""Group 5: how everything that PASSED here moves together with the 3 research bots already
live, and the combined worst drawdown on Rs 1,00,000 per strategy.

Takes daily return series (not trade lists) so option-selling, promoter-buying and the existing
research bots can be compared on one calendar. Produces nothing on its own tonight because
nothing passed (see docs/OPTION-SELLING-AND-PROMOTER-REPORT.md) -- this module is the ready-to-run
code for whenever a variant passes and the 3 live bots' return series can be read.
"""
from __future__ import annotations


def daily_returns_from_trades(trades: list, date_field: str, pnl_field: str, capital: float):
    """Turn a trade list into a {date: return_pct_of_capital} series (per trade's exit date)."""
    out: dict = {}
    for t in trades:
        d = getattr(t, date_field)
        out[d] = out.get(d, 0.0) + getattr(t, pnl_field) / capital
    return out


def correlation_matrix(series_by_name: dict) -> dict:
    """Pearson correlation of overlapping dates between every pair of named return series."""
    import math

    names = list(series_by_name.keys())
    result = {a: {} for a in names}
    for a in names:
        for b in names:
            dates = sorted(set(series_by_name[a]) & set(series_by_name[b]))
            if len(dates) < 2:
                result[a][b] = None
                continue
            xs = [series_by_name[a][d] for d in dates]
            ys = [series_by_name[b][d] for d in dates]
            mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
            cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
            vx = sum((x - mx) ** 2 for x in xs)
            vy = sum((y - my) ** 2 for y in ys)
            result[a][b] = round(cov / math.sqrt(vx * vy), 4) if vx > 0 and vy > 0 else None
    return result


def combined_worst_drawdown(series_by_name: dict, capital_per_strategy: float = 100000.0):
    """Equal-capital combined equity curve's max drawdown, in rupees and percent."""
    all_dates = sorted(set().union(*[set(s.keys()) for s in series_by_name.values()])) if series_by_name else []
    equity = capital_per_strategy * len(series_by_name)
    peak = equity
    worst_dd_rupees, worst_dd_pct = 0.0, 0.0
    for d in all_dates:
        day_pnl = sum(series_by_name[name].get(d, 0.0) * capital_per_strategy for name in series_by_name)
        equity += day_pnl
        peak = max(peak, equity)
        dd = equity - peak
        if dd < worst_dd_rupees:
            worst_dd_rupees = dd
            worst_dd_pct = round(100 * dd / peak, 4) if peak else 0.0
    return round(worst_dd_rupees, 2), worst_dd_pct
