"""Study 3 helpers: bootstrap p-values, Holm / Benjamini-Hochberg, bootstrap interval, worst days, random-entry picks, and the
engine options they use (entries N sessions before expiry, pre-drawn entry days). Synthetic data only."""
import sys
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE.parent / "backtest"))
import options_real as R  # noqa: E402
import options_real_study3 as T  # noqa: E402
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


def test_boot_pvalue_separates_signal_from_noise():
    rng = np.random.default_rng(0)
    assert T.boot_pvalue(rng.normal(300, 100, 120), B=2000) < 0.01
    assert T.boot_pvalue(rng.normal(0, 100, 120), B=2000) > 0.05
    assert T.boot_pvalue([5.0], B=100) == 1.0
    assert T.boot_pvalue(np.zeros(50), B=500) > 0.9  # no edge at all must not look significant


def test_holm_and_bh_match_hand_values():
    p = [0.01, 0.04, 0.03]
    assert np.allclose(T.holm(p), [0.03, 0.06, 0.06])
    assert np.allclose(T.benjamini_hochberg(p), [0.03, 0.04, 0.04])
    assert np.all(T.holm(p) >= np.array(p)) and np.all(T.benjamini_hochberg(p) <= T.holm(p) + 1e-12)


def test_correct_pads_untested_hypotheses():
    out = T.correct({"a": 0.01, "b": 0.5}, n_untested=98)
    assert out["a"]["p_holm"] == 1.0 and not out["a"]["holm_pass"] and not out["a"]["bh_pass"]
    small = T.correct({"a": 0.01, "b": 0.5}, 0)
    assert small["a"]["holm_pass"] and small["a"]["bh_pass"] and not small["b"]["holm_pass"]


def test_total_ci_excludes_zero_only_for_a_real_edge():
    yrs = np.repeat(np.arange(2015, 2027), 10)
    good = T.total_ci(np.full(120, 100.0) + np.random.default_rng(1).normal(0, 5, 120), yrs)
    assert good["iid"]["lo"] > 0 and good["year_block"]["lo"] > 0 and good["iid"]["p_total_le_0"] == 0
    flat = T.total_ci(np.random.default_rng(2).normal(0, 100, 120), yrs)
    assert flat["iid"]["lo"] < 0 < flat["iid"]["hi"]


def test_worst_days_orders_by_loss_and_reports_index_move():
    idx = pd.bdate_range("2020-03-02", periods=6)
    eq = pd.Series([0, 10, -90, -80, -85, -40.0], index=idx)
    spot = pd.Series([100, 101, 90, 91, 92, 93.0], index=idx)
    w = T.worst_days(eq, spot, k=2)
    assert w[0]["date"] == str(idx[2].date()) and w[0]["pnl_per_lot"] == -100 and w[0]["index_move_pct"] == pytest.approx(-10.89, abs=0.01)
    assert w[1]["pnl_per_lot"] == -5


def test_random_picks_one_session_per_expiry_inside_window():
    sessions = pd.bdate_range("2020-01-01", "2020-06-30")
    exps = [pd.Timestamp("2020-03-26"), pd.Timestamp("2020-04-30")]
    a = T.random_picks(exps, sessions, 25, 60, np.random.default_rng(3))
    b = T.random_picks(exps, sessions, 25, 60, np.random.default_rng(3))
    assert a == b and set(a) == set(exps)
    for e, d in a.items():
        assert 25 <= (e - d).days <= 60 and d in sessions


def test_entry_tdays_counts_sessions_and_records_expiry(days_env):
    trades, *_ = R.run("strangle_d18", days_env, T.S.MODES["weekly2t"])
    pos = {d: i for i, d in enumerate(days_env)}
    assert trades
    for t in trades:
        assert pos[t["expiry"]] - pos[t["entry"]] == 2 and t["reason"] != "7DTE_UNSTABLE"


def test_entry_pick_forces_the_fill_day(days_env):
    ref, *_ = R.run("strangle_d18", days_env, T.S.MODES["weekly2t"])
    e = ref[3]["expiry"]
    forced = days_env[days_env.index(e) - 5]
    trades, *_ = R.run("strangle_d18", days_env, {"weekly": True, "entry_pick": {e: forced}, "exit_dte": -1, "unstable_dte": -1})
    assert [t["entry"] for t in trades] == [forced] and trades[0]["expiry"] == e


def test_change_date_is_first_tuesday_expiry_of_2025_on(monkeypatch):
    exps = [pd.Timestamp(x) for x in ("2025-08-28", "2025-09-02", "2025-09-04", "2025-09-09", "2025-07-03")]
    monkeypatch.setattr(T, "_expiries", lambda symbol: sorted(exps))
    assert T.change_date() == pd.Timestamp("2025-09-02")


def test_seg_summarises_a_trade_table():
    tr = pd.DataFrame({"entry": pd.to_datetime(["2020-01-01", "2021-01-01", "2021-06-01"]),
                       "exit": pd.to_datetime(["2020-01-03", "2021-01-03", "2021-06-03"]), "net": [100.0, -40.0, 60.0]})
    s = T.seg(tr)
    assert s["trades"] == 3 and s["total_inr"] == 120 and s["worst_trade"] == -40 and s["max_dd_inr"] == 40
    assert s["positive_years"] == 2 and s["years"] == 2 and T.seg(tr.iloc[0:0]) == {"trades": 0}


def test_entry_tdays_finds_expiry_beyond_the_last_stored_session(days_env):
    full, *_ = R.run("strangle_d18", days_env, T.S.MODES["weekly2t"])
    t = full[6]
    cut = days_env[:days_env.index(t["entry"]) + 1]  # data ends on the fill day; the expiry is two sessions later
    assert t["expiry"] not in cut
    R.run("strangle_d18", cut, T.S.MODES["weekly2t"])
    book = R.LAST_STATE["book"]
    assert len(book) == 1 and book[0].entry_date == t["entry"] and book[0].meta["E"] == t["expiry"]
