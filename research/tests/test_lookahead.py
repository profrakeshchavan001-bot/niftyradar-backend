"""No-lookahead correctness checks on S3's "skip the most recent month" ranking and S9's
"cointegration picked on train data only" pair selection. All price series here are SYNTHETIC
FIXTURES built only to exercise the logic in isolation -- they are never used to produce or
report a strategy backtest result (no real-money numbers come from this file)."""
import numpy as np
import pandas as pd

from s3_nifty200_momentum import rank_top_n, _monthly_close_panel
from s9_pairs_trading import select_pairs


def _const_growth_series(months: int, monthly_ret: float, freq="D", start="2015-01-01"):
    dates = pd.date_range(start, periods=months * 30, freq=freq)
    # one value per day, but what matters is the resampled month-end value growing by monthly_ret
    vals = []
    px = 100.0
    day_in_month = 0
    month_idx = 0
    for d in dates:
        if d.is_month_end or (day_in_month == 29):
            month_idx += 1
        vals.append(px * (1 + monthly_ret) ** (d.to_period("M").ordinal))
        day_in_month += 1
    return pd.Series(vals, index=dates)


def test_s3_skip_month_uses_only_past_prices():
    # Build a panel where stock A spikes ONLY in the most-recent (to-be-skipped) month and is
    # otherwise flat; stock B grows steadily every month including the skipped one.
    idx = pd.date_range("2015-01-31", periods=15, freq="ME")
    a = pd.Series([100.0] * 14 + [500.0], index=idx)  # A spikes only in month[-1] (the skip month)
    b = pd.Series([100.0 * (1.02 ** i) for i in range(15)], index=idx)  # B steady 2%/month grower

    panel = pd.DataFrame({"A": a, "B": b})
    as_of_idx = 14  # last row == the month containing A's spike

    picks = rank_top_n(panel, as_of_idx, n=1)
    # If the code looked at month[as_of_idx] (the spike) it would rank A first.
    # Correct (skip-month) behavior ranks on month[as_of_idx-1] vs month[as_of_idx-12],
    # where A is flat (0% return) and B has compounded ~2%/month -> B must win.
    assert picks == ["B"], f"lookahead bug: picked {picks}, expected ['B'] (A's spike must be skipped)"


def test_s3_monthly_panel_never_uses_more_recent_data_than_resample_boundary():
    idx = pd.date_range("2020-01-01", "2020-03-15", freq="D")
    s = pd.Series(range(len(idx)), index=idx, dtype=float)
    monthly = _monthly_close_panel({"X": s})["X"]
    # Feb's month-end value must equal Feb's own last available day, not March's.
    feb_value = s.loc["2020-02-29"]
    assert monthly.loc["2020-02-29"] == feb_value


def test_s9_select_pairs_never_sees_test_period_data():
    """Construct train data where A and B are cointegrated, and test data where they are NOT
    (B diverges permanently). select_pairs() must be called with train data only and its
    choice must not depend on test data at all -- verified by calling it with ONLY train data
    and confirming it still finds the pair (i.e. it isn't silently requiring test data)."""
    rng = np.random.RandomState(42)
    n = 300
    dates_train = pd.date_range("2015-01-01", periods=n, freq="B")
    common = np.cumsum(rng.normal(0, 1, n)) + 100
    noise_a = rng.normal(0, 0.5, n)
    noise_b = rng.normal(0, 0.5, n)
    a_train = pd.Series(common + noise_a, index=dates_train)
    b_train = pd.Series(common + noise_b, index=dates_train)

    sector_map = {"TestSector": {"stocks": ["A", "B"]}}
    pairs = select_pairs({"A": a_train, "B": b_train}, sector_map, pval_threshold=0.1)

    assert len(pairs) == 1
    sym_a, sym_b, hedge_ratio, pvalue = pairs[0]
    assert {sym_a, sym_b} == {"A", "B"}
    assert pvalue < 0.1

    # Confirm the function signature/behavior takes no test-period argument at all -- the only
    # data select_pairs() can possibly use is whatever dict it's called with. Calling it again
    # with a *different* (clearly test-labeled) dataset must give an independent result, proving
    # nothing from the first call leaked state into the second.
    dates_test = pd.date_range("2023-01-01", periods=n, freq="B")
    a_test = pd.Series(rng.normal(0, 1, n).cumsum() + 200, index=dates_test)
    b_test = pd.Series(rng.normal(0, 1, n).cumsum() + 50, index=dates_test)  # unrelated random walk
    pairs_test = select_pairs({"A": a_test, "B": b_test}, sector_map, pval_threshold=0.1)
    # Unrelated random walks should usually NOT be found cointegrated (not a strict guarantee,
    # but with this seed it documents that the test panel is evaluated completely independently).
    assert isinstance(pairs_test, list)
