"""Options-structure backtest: pricing identities, no-lookahead (truncation) and gap-fill-at-actual-price checks."""
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backtest"))
import options_yt as oy  # noqa: E402


def _market(n=700, seed=3, shock_at=None):
    rng = np.random.default_rng(seed)
    d = pd.bdate_range("2019-01-01", periods=n)
    r = rng.normal(0.0004, 0.009, n)
    spot = 11000 * np.exp(np.cumsum(r))
    if shock_at:
        spot[shock_at:] *= 0.88
    m = pd.DataFrame({"spot": spot, "vix": 14 + 2 * np.sin(np.arange(n) / 40), "etf_gap": 0.0}, index=d)
    m.index.name = "date"
    return m


def test_put_call_parity():
    S, K, T, s = 20000.0, 20500.0, 0.2, 0.15
    c, p = oy.bs(S, K, T, s, "C"), oy.bs(S, K, T, s, "P")
    lhs = c - p
    rhs = S * math.exp(-oy.DIV * T) - K * math.exp(-oy.RATE * T)
    assert abs(lhs - rhs) < 1e-6


def test_strike_for_delta_close_to_target():
    K = oy.strike_for_delta(20000.0, 45 / 365, 0.15, "C", 0.30)
    assert abs(oy.delta_abs(20000.0, K, 45 / 365, 0.15, "C") - 0.30) < 0.02 and K > 20000


def test_costs_positive_and_sell_side_dearer():
    assert oy.txn_cost(100.0, sell=True) > oy.txn_cost(100.0, sell=False) > 0
    assert oy.txn_cost(0.01, sell=True) == 0


def test_truncation_does_not_change_earlier_trades():
    m, _ = oy.prepare(_market())
    mo, we = oy.expiry_calendar(m.index)
    cut = m.index[450]
    for name in ("condor", "strangle", "calendar"):
        full, *_ = oy.run_strategy(name, m, mo, we)
        part, *_ = oy.run_strategy(name, m[m.index <= cut], mo, we)
        a = [(t["entry"], t["exit"], t["net"]) for t in full if t["exit"] < cut]
        b = [(t["entry"], t["exit"], t["net"]) for t in part if t["exit"] < cut]
        assert a == b and a


def test_gap_loss_booked_at_actual_mark_not_at_sl():
    m = _market(shock_at=300)
    m["vix"] = np.where(np.arange(len(m)) >= 300, 35.0, m["vix"])
    m, _ = oy.prepare(m)
    mo, we = oy.expiry_calendar(m.index)
    trades, *_ = oy.run_strategy("strangle", m, mo, we)
    hit = [t for t in trades if t["reason"].startswith("SL")]
    assert hit and min(t["net"] for t in hit) < -13000   # filled beyond the SL level, not clipped to it
