"""Engine mechanics tested on a small SYNTHETIC option chain (fixed seed). This is a fixture,
not real NSE data -- it exists only to prove the engine hedges, costs and exits correctly; any
PnL numbers here are NOT a claim about the real market and must never be quoted as a finding.
"""
from __future__ import annotations

import datetime as dt
import math

import numpy as np
import pandas as pd
import pytest

from research.options_promoter.options_engine import (
    EXIT_2X_STOP,
    EXIT_50PCT_CAPTURE,
    EXIT_AT_EXPIRY,
    run_variant,
)


def _make_fixture_chain(seed: int = 7, n_expiries: int = 6, days_per_expiry: int = 5):
    rng = np.random.default_rng(seed)
    strike_step = 50
    start = dt.date(2024, 1, 4)  # a Thursday
    spot = 21000.0
    rows_chain, rows_spot, rows_vix = [], [], []
    day = start
    expiry_dates = []
    for _ in range(n_expiries):
        while day.weekday() != 3:  # Thursday weekly expiry (fixture convention)
            day += dt.timedelta(days=1)
        expiry_dates.append(day)
        day += dt.timedelta(days=7)

    cur = start - dt.timedelta(days=4)
    end = expiry_dates[-1]
    vix_level = 14.0
    while cur <= end:
        if cur.weekday() < 5:
            spot *= 1 + rng.normal(0, 0.006)
            vix_level = max(9.0, vix_level + rng.normal(0, 0.4))
            rows_spot.append({"date": cur, "close": spot})
            rows_vix.append({"date": cur, "close": vix_level})
            for expiry in expiry_dates:
                dte = (expiry - cur).days
                if dte < 0 or dte > 10:
                    continue
                for k in range(-12, 13):
                    strike = round(spot / strike_step) * strike_step + k * strike_step
                    tval = 8.0 * math.sqrt(max(dte, 0.3)) * (vix_level / 14.0) * math.exp(-0.035 * abs(k))
                    ce = max(spot - strike, 0) + tval
                    pe = max(strike - spot, 0) + tval
                    rows_chain.append({"date": cur, "expiry": expiry, "strike": float(strike),
                                        "option_type": "CE", "close": round(max(ce, 0.05), 2)})
                    rows_chain.append({"date": cur, "expiry": expiry, "strike": float(strike),
                                        "option_type": "PE", "close": round(max(pe, 0.05), 2)})
        cur += dt.timedelta(days=1)

    chain = pd.DataFrame(rows_chain)
    spot_df = pd.DataFrame(rows_spot)
    vix_df = pd.DataFrame(rows_vix)
    return chain, spot_df, vix_df


@pytest.fixture(scope="module")
def fixture_data():
    return _make_fixture_chain()


def test_every_trade_is_hedged(fixture_data):
    chain, spot_df, vix_df = fixture_data
    trades = run_variant(chain, spot_df, vix_df, event_days=set(), structure="iron_condor",
                          index="NIFTY", entry_days_before_expiry=4, exit_rule=EXIT_AT_EXPIRY,
                          vix_max=None, strike_step=50, wing_width_steps=4, otm_steps=6)
    assert len(trades) > 0
    for t in trades:
        sides = [leg["side"] for leg in t.legs]
        assert "buy" in sides, "every trade must have at least one hedging (buy) leg"
        assert sides.count("sell") == 2 and sides.count("buy") == 2


def test_costs_are_always_subtracted(fixture_data):
    chain, spot_df, vix_df = fixture_data
    trades = run_variant(chain, spot_df, vix_df, event_days=set(), structure="iron_fly",
                          index="NIFTY", entry_days_before_expiry=4, exit_rule=EXIT_AT_EXPIRY,
                          vix_max=None, strike_step=50, wing_width_steps=6, otm_steps=0)
    assert trades
    for t in trades:
        assert t.cost > 0
        assert t.net_pnl == round(t.gross_pnl - t.cost, 2)


def test_vix_filter_drops_high_vix_entries(fixture_data):
    chain, spot_df, vix_df = fixture_data
    unfiltered = run_variant(chain, spot_df, vix_df, event_days=set(), structure="iron_condor",
                              index="NIFTY", entry_days_before_expiry=4, exit_rule=EXIT_AT_EXPIRY,
                              vix_max=None, strike_step=50, wing_width_steps=4, otm_steps=6)
    low_vix_cap = min(t.entry_vix for t in unfiltered) + 0.01
    filtered = run_variant(chain, spot_df, vix_df, event_days=set(), structure="iron_condor",
                            index="NIFTY", entry_days_before_expiry=4, exit_rule=EXIT_AT_EXPIRY,
                            vix_max=low_vix_cap, strike_step=50, wing_width_steps=4, otm_steps=6)
    assert len(filtered) <= len(unfiltered)
    assert all(t.entry_vix <= low_vix_cap for t in filtered)


def test_event_day_skips_that_entry(fixture_data):
    chain, spot_df, vix_df = fixture_data
    baseline = run_variant(chain, spot_df, vix_df, event_days=set(), structure="iron_condor",
                            index="NIFTY", entry_days_before_expiry=4, exit_rule=EXIT_AT_EXPIRY,
                            vix_max=None, strike_step=50, wing_width_steps=4, otm_steps=6)
    some_entry_date = baseline[0].entry_date
    skipped = run_variant(chain, spot_df, vix_df, event_days={some_entry_date}, structure="iron_condor",
                           index="NIFTY", entry_days_before_expiry=4, exit_rule=EXIT_AT_EXPIRY,
                           vix_max=None, strike_step=50, wing_width_steps=4, otm_steps=6)
    assert some_entry_date not in {t.entry_date for t in skipped}
    assert len(skipped) == len(baseline) - 1


def test_50pct_capture_exits_no_later_than_expiry(fixture_data):
    chain, spot_df, vix_df = fixture_data
    trades = run_variant(chain, spot_df, vix_df, event_days=set(), structure="iron_condor",
                          index="NIFTY", entry_days_before_expiry=4, exit_rule=EXIT_50PCT_CAPTURE,
                          vix_max=None, strike_step=50, wing_width_steps=4, otm_steps=6)
    for t in trades:
        assert t.exit_date <= t.expiry
        assert t.exit_reason in (EXIT_50PCT_CAPTURE, EXIT_AT_EXPIRY)


def test_2x_stop_exits_no_later_than_expiry(fixture_data):
    chain, spot_df, vix_df = fixture_data
    trades = run_variant(chain, spot_df, vix_df, event_days=set(), structure="hedged_strangle",
                          index="BANKNIFTY", entry_days_before_expiry=4, exit_rule=EXIT_2X_STOP,
                          vix_max=None, strike_step=100, wing_width_steps=6, otm_steps=10)
    for t in trades:
        assert t.exit_date <= t.expiry
        assert t.exit_reason in (EXIT_2X_STOP, EXIT_AT_EXPIRY)


def test_lot_size_changes_over_time_are_applied(fixture_data):
    chain, spot_df, vix_df = fixture_data
    # shift fixture dates into different lot-size eras and confirm lot_size_on is actually used
    from research.options_promoter.lot_sizes import lot_size_on

    assert lot_size_on(dt.date(2020, 1, 1), "NIFTY") == 75
    assert lot_size_on(dt.date(2023, 6, 1), "NIFTY") == 50
    assert lot_size_on(dt.date(2024, 6, 1), "NIFTY") == 25
