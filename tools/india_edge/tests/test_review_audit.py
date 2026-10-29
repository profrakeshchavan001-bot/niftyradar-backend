import sys
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import audit_lookahead as AU  # noqa: E402
import weekly_review as WR  # noqa: E402
from common import load_config  # noqa: E402
from features import build_features, load_sectors  # noqa: E402
from layer1 import build_feature_frame  # noqa: E402
from loader import Market, load_fixtures  # noqa: E402


def trades():
    rows = [("2026-10-05", "A", "trend", "long", 20000, 2.0), ("2026-10-06", "B", "trend", "short", -10000, -1.0),
            ("2026-10-07", "B", "pullback", "long", 5000, 0.5), ("2026-10-08", "A", "index", "short", -10000, -1.0),
            ("2026-10-12", "A", "trend", "long", 20000, 2.0)]
    return pd.DataFrame(rows, columns=["trade_date", "grade", "setup", "side", "pnl", "r"]).assign(
        status="closed", exit_reason="target")


class WeeklyReviewTests(unittest.TestCase):
    def test_hand_computed_week(self):
        r = WR.review(trades(), "2026-10-11")           # Mon 10-05 .. Sun 10-11, excludes 10-12
        w = r["week"]
        self.assertEqual(w["trades"], 4)
        self.assertAlmostEqual(w["win_pct"], 50.0)
        self.assertAlmostEqual(w["expectancy_r"], 0.125)                     # (2 - 1 + .5 - 1) / 4
        self.assertAlmostEqual(w["profit_factor"], 25000 / 20000)            # (20000+5000) / (10000+10000)
        self.assertAlmostEqual(w["pnl"], 5000.0)
        self.assertAlmostEqual(r["by_grade"]["A"]["expectancy_r"], 0.5)      # (2 - 1) / 2
        self.assertAlmostEqual(r["by_grade"]["B"]["expectancy_r"], -0.25)    # (-1 + .5) / 2
        self.assertEqual(r["by_setup"]["trend"]["trades"], 2)
        self.assertAlmostEqual(r["by_setup"]["index"]["expectancy_r"], -1.0)
        self.assertEqual(r["all_time"]["trades"], 5)

    def test_week_ending_and_markdown(self):
        self.assertEqual(WR.week_ending_for("2026-10-08"), pd.Timestamp("2026-10-11"))   # Thursday -> that Sunday
        self.assertEqual(WR.week_ending_for("2026-10-11"), pd.Timestamp("2026-10-11"))   # Sunday -> itself
        self.assertEqual(WR.week_ending_for("2026-10-05"), pd.Timestamp("2026-10-11"))   # Monday
        md = WR.render_md(WR.review(trades(), "2026-10-11"))
        self.assertIn("## By setup type (this week)", md)
        self.assertIn("| trend | 2 |", md)

    def test_empty_week(self):
        r = WR.review(trades(), "2026-09-27")
        self.assertEqual(r["week"]["trades"], 0)
        self.assertIsNone(r["week"]["win_pct"])


class LookaheadAuditTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        m = load_fixtures()
        first = m.dates[-260]
        keep = lambda df: df[df["date"] >= first].reset_index(drop=True) if len(df) else df  # noqa: E731
        cls.m = Market(keep(m.cash), keep(m.fo), keep(m.idx), keep(m.iv), m.events, "fixtures")
        cls.syms = sorted(cls.m.cash["symbol"].unique())[:12]
        cls.cut = [cls.m.dates[-5], cls.m.dates[-60]]

    def test_real_features_are_clean(self):
        cfg = load_config()
        fn = lambda m: build_feature_frame(m, cfg, symbols=self.syms)  # noqa: E731
        self.assertEqual(AU.audit_feature_fn(fn, self.m, self.cut), [])

    def test_detects_a_leaky_feature(self):
        cfg = load_config()

        def leaky(m):
            f = build_feature_frame(m, cfg, symbols=self.syms).sort_values(["symbol", "date"])
            f["rs"] = f.groupby("symbol")["close"].shift(-1) / f["close"]   # tomorrow's close: future data
            return f

        msgs = AU.audit_feature_fn(leaky, self.m, self.cut)
        self.assertTrue(any("'rs'" in x for x in msgs), msgs)

    def test_detects_full_sample_statistic(self):
        cfg = load_config()

        def leaky(m):
            f = build_feature_frame(m, cfg, symbols=self.syms)
            f["rs"] = f["rs"] - f["rs"].mean()                                # uses the whole sample
            return f

        self.assertTrue(AU.audit_feature_fn(leaky, self.m, self.cut))

    def test_backtest_signal_inputs_are_clean(self):
        self.assertEqual(AU.audit_signals(self.m, self.cut[:1]), [])

    def test_paper_session_does_not_peek(self):
        self.assertEqual(AU.audit_session(self.m, n_days=4), [])

    def test_timing_rules_do_not_peek(self):
        self.assertEqual(AU.audit_timing(self.m, n_cases=6), [])

    def test_compare_prefix_ignores_rows_after_cutoff(self):
        d = pd.bdate_range("2026-10-05", periods=4)
        a = pd.DataFrame({"date": d, "symbol": "X", "v": [1.0, 2.0, 3.0, 4.0]})
        b = pd.DataFrame({"date": d, "symbol": "X", "v": [1.0, 2.0, 3.0, 999.0]})
        self.assertEqual(AU.compare_prefix(a, b, d[2]), {})
        self.assertIn("v", AU.compare_prefix(a, b, d[3]))


if __name__ == "__main__":
    unittest.main()
