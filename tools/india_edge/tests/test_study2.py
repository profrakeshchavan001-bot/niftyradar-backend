"""Study 2 helpers (grid, per-year table, pass rule, out-of-sample fit) and the engine options they rely on
(stop levels, expiry-day and 2-DTE entries). Synthetic chains in a temp folder; no network, no real data."""
import sys
import tempfile
from pathlib import Path

import pandas as pd
import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE.parent / "backtest"))
import options_real as R  # noqa: E402
import options_real_study2 as S  # noqa: E402
from test_options_real import _fixture  # noqa: E402


@pytest.fixture(scope="module")
def days_env():
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        days = _fixture(tmp, n=330)
        old = R.DATA_DIR
        R.DATA_DIR = tmp
        R.configure("NIFTY", 2.0)
        yield days
        R.DATA_DIR = old
        R.configure("NIFTY", 2.0)


def _tr(rows):
    return pd.DataFrame([{"entry": pd.Timestamp(e), "net": n} for e, n in rows])


def test_param_sets_are_one_at_a_time_and_include_base():
    for name in ("strangle_d18", "strangle_p100", "condor"):
        for mode in S.MODES:
            ps = S.param_sets(name, mode)
            assert len(ps) == 7 and ps["base"] == S.MODES[mode]
            for k, p in ps.items():
                if k != "base":
                    extra = set(p) - set(S.MODES[mode])
                    assert len(extra) == 1, (name, mode, k)


def test_year_table_and_pass_rule():
    tr = _tr([("2019-03-01", 100), ("2020-03-01", -50), ("2021-03-01", 10), ("2022-03-01", 10), ("2023-03-01", 10),
              ("2024-03-01", -5), ("2025-03-01", 7)])
    yt = S.year_table(tr)
    assert yt["2019"] == 100 and yt["2020"] == -50 and yt["2026"] == 0 and len(yt) == 8
    assert S.passes({"survivor": True}, tr)["positive_years_2019_26"] == 5
    assert S.passes({"survivor": True}, tr)["passes"] is True
    assert S.passes({"survivor": False}, tr)["passes"] is False
    assert S.passes({"survivor": True}, _tr([("2019-03-01", 1), ("2020-03-01", -1)]))["passes"] is False


def test_half_net_boundaries():
    tr = _tr([("2021-12-31", 5), ("2022-01-01", 7)])
    assert S.half_net(tr, hi=S.OOS_SPLIT)["net_inr"] == 5
    assert S.half_net(tr, lo=S.OOS_SPLIT)["net_inr"] == 7
    assert S.half_net(tr.iloc[0:0])["win_pct"] is None


def test_oos_fit_chooses_on_fit_half_only():
    fit = [(f"2016-{m:02d}-01", 10) for m in range(1, 13)] + [(f"2017-{m:02d}-01", 10) for m in range(1, 13)]
    sets = {"a": _tr(fit + [("2022-05-01", -999)]),                       # best fit, bad OOS
            "b": _tr([(d, 1) for d, _ in fit] + [("2022-05-01", 500)]),   # worse fit, great OOS: must NOT be picked
            "tiny": _tr([("2016-01-01", 10 ** 6)])}                     # < 15 fit trades: not eligible
    o = S.oos_fit(sets)
    assert o["chosen"]["set"] == "a" and o["chosen"]["oos"]["net_inr"] == -999
    assert o["sets_positive_oos"] == "1/2"
    assert S.oos_fit({"x": _tr([("2016-01-01", 1)])})["chosen"] is None


def test_stop_levels_are_applied(days_env):
    tight, *_ = R.run("strangle_d18", days_env, {"sl": 500})
    wide, *_ = R.run("strangle_d18", days_env, {"sl": 10 ** 9, "tp": 10 ** 9})
    assert any(t["reason"] == "SL" and t["sl_inr"] == 500 for t in tight)
    assert not any(t["reason"] in ("SL", "TP") for t in wide)
    cond, *_ = R.run("condor", days_env, {"sl_mult": 0.25})
    assert all(abs(t["sl_inr"] - 0.25 * t["credit_inr"]) < 0.02 for t in cond) and cond


def test_default_params_unchanged_by_new_options(days_env):
    a, *_ = R.run("strangle_d18", days_env)
    b, *_ = R.run("strangle_d18", days_env, {"sl": 13000, "tp": 13000, "unstable_dte": 7})
    assert [(t["entry"], t["exit"], t["net"]) for t in a] == [(t["entry"], t["exit"], t["net"]) for t in b] and a


def test_expiry_day_entries_settle_the_same_day(days_env):
    trades, *_ = R.run("strangle_d18", days_env, S.MODES["weekly0"])
    assert trades
    for t in trades:
        assert t["reason"] == "EXPIRY0" and t["days_held"] == 0 and t["entry"] == t["exit"]


def test_two_dte_entries_are_two_days_before_expiry(days_env):
    trades, *_ = R.run("strangle_d18", days_env, S.MODES["weekly2"])
    assert trades
    for t in trades:
        assert (t["exit"] - t["entry"]).days >= 2 and t["reason"] != "7DTE_UNSTABLE"
        assert t["entry"].weekday() == 1  # fixture expiries are Thursdays
    cond, *_ = R.run("condor", days_env, S.MODES["weekly2"])
    assert all(t["reason"] != "15DTE" for t in cond)
