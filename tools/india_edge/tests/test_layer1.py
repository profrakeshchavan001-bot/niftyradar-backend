import sys
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import load_config  # noqa: E402
from features import build_features, oi_quadrant  # noqa: E402
from score import direction, grade, score_row, top_n, score_frame  # noqa: E402
from universe import compute_universe  # noqa: E402

CFG = load_config()


def row(**kw):
    base = dict(quadrant="neutral", deliv_ratio=1.0, rs=0.0, sector_rs=0.0, unusual_oi=1.0)
    base.update(kw)
    return base


class QuadrantTests(unittest.TestCase):
    def test_four_quadrants(self):
        self.assertEqual(oi_quadrant(1.2, 5), "long_buildup")
        self.assertEqual(oi_quadrant(-1.2, 5), "short_buildup")
        self.assertEqual(oi_quadrant(1.2, -5), "short_covering")
        self.assertEqual(oi_quadrant(-1.2, -5), "long_unwinding")

    def test_flat_or_missing_is_neutral(self):
        self.assertEqual(oi_quadrant(0, 5), "neutral")
        self.assertEqual(oi_quadrant(1, 0), "neutral")
        self.assertEqual(oi_quadrant(np.nan, 5), "neutral")


class ScoreTests(unittest.TestCase):
    def test_strong_long_hand_computed(self):
        # quadrant 1.0*30=30; delivery (2.0-1)/(2.0-1)=1 -> 20; RS 5/10=.5 -> 10;
        # sector 2.5/5=.5 -> 7.5; unusual (2-1)/(3-1)=.5 -> 7.5; total 75
        r = score_row(row(quadrant="long_buildup", deliv_ratio=2.0, rs=5, sector_rs=2.5,
                          unusual_oi=2.0), CFG)
        self.assertEqual(r["score"], 75.0)
        self.assertEqual(r["grade"], "A")
        self.assertEqual(r["direction"], "long")
        self.assertEqual(r["setup"], "trend")

    def test_short_reversal_hand_computed(self):
        # long_unwinding 0.6*30=18; delivery (1.5-1)/1=.5 -> 10; RS (-1*-10)/10=1 -> 20;
        # sector (-1*-5)/5=1 -> 15; unusual NaN -> 0; total 63
        r = score_row(row(quadrant="long_unwinding", deliv_ratio=1.5, rs=-10, sector_rs=-5,
                          unusual_oi=np.nan), CFG)
        self.assertEqual(r["score"], 63.0)
        self.assertEqual(r["grade"], "B")
        self.assertEqual(r["direction"], "short")
        self.assertEqual(r["setup"], "pullback")

    def test_rs_against_bias_earns_nothing(self):
        # long buildup but negative RS: RS and sector points 0, direction none
        r = score_row(row(quadrant="long_buildup", rs=-4, sector_rs=-2), CFG)
        self.assertEqual(r["score"], 30.0)
        self.assertEqual(r["direction"], "none")

    def test_neutral_scores_zero_grade_c(self):
        r = score_row(row(rs=8, sector_rs=3), CFG)
        self.assertEqual((r["score"], r["grade"], r["direction"]), (0.0, "C", "none"))

    def test_index_setup(self):
        # sector comp 5/5=1 (>=.5), stock RS comp 2/10=.2 (<=.3) -> index
        r = score_row(row(quadrant="long_buildup", rs=2, sector_rs=5), CFG)
        self.assertEqual(r["setup"], "index")

    def test_weights_editable(self):
        cfg = {**CFG, "weights": {**CFG["weights"], "quadrant": 60}}
        r = score_row(row(quadrant="short_buildup", rs=-1), cfg)
        self.assertEqual(r["components"]["quadrant"], 60.0)

    def test_grade_boundaries(self):
        self.assertEqual([grade(s, CFG) for s in (70, 69.9, 50, 49.9, 0)],
                         ["A", "B", "B", "C", "C"])

    def test_direction_rules(self):
        self.assertEqual(direction("short_covering", 1), "long")
        self.assertEqual(direction("short_buildup", -1), "short")
        self.assertEqual(direction("short_buildup", 1), "none")
        self.assertEqual(direction("long_buildup", np.nan), "none")


class RankingTests(unittest.TestCase):
    def test_top_n_filters_and_orders(self):
        d = pd.Timestamp("2026-10-28")
        df = pd.DataFrame([
            dict(date=d, symbol="A", **row(quadrant="long_buildup", rs=10, sector_rs=5), adv_cr=100),
            dict(date=d, symbol="B", **row(quadrant="long_buildup", rs=5, sector_rs=5), adv_cr=100),
            dict(date=d, symbol="ILLIQ", **row(quadrant="long_buildup", rs=10, sector_rs=5), adv_cr=1),
            dict(date=d, symbol="NODIR", **row(quadrant="long_buildup", rs=-5), adv_cr=100),
        ])
        out = top_n(score_frame(df, CFG), CFG, d)
        self.assertEqual(list(out["symbol"]), ["A", "B"])  # 30+20+15=65 beats 30+10+15=55


class FeatureTests(unittest.TestCase):
    def test_features_hand_computed(self):
        n, lb = 12, 5
        dates = pd.bdate_range("2026-10-01", periods=n)
        close = 100.0 + np.arange(n)
        deliv = np.where(np.arange(n) == n - 1, 80.0, 40.0)
        cash = pd.DataFrame(dict(date=dates, symbol="AAA", prev_close=close - 1, close=close,
                                 volume=1e6, deliv_pct=deliv))
        nifty = np.where(np.arange(n) == n - 1, 1010.0, 1000.0)
        idx = pd.DataFrame(dict(date=dates, index_name="Nifty 50", close=nifty))
        last = np.arange(n) == n - 1
        fut = pd.DataFrame(dict(date=dates, instr="STF", symbol="AAA",
                                oi=np.where(last, 1100.0, 1000.0),
                                chg_oi=np.where(last, 100.0, 0.0)))
        opt = pd.DataFrame(dict(date=dates, instr="STO", symbol="AAA", oi=500.0,
                                chg_oi=np.where(last, -30.0, 10.0)))
        f = build_features(cash, pd.concat([fut, opt]), idx, ["AAA"], {"AAA": "IT"}, lb)
        t = f[f["date"] == dates[-1]].iloc[0]
        # price: 111/110-1 = 0.909%; OI: 100/(1100-100)=10%
        self.assertAlmostEqual(t["price_chg_pct"], (111 / 110 - 1) * 100, places=6)
        self.assertAlmostEqual(t["oi_chg_pct"], 10.0, places=6)
        self.assertEqual(t["quadrant"], "long_buildup")
        self.assertAlmostEqual(t["deliv_ratio"], 2.0)       # 80 / avg(40 x5)
        self.assertAlmostEqual(t["unusual_oi"], 3.0)        # |-30| / avg(10 x5)
        # 5d return 111/106-1 ; Nifty 1010/1000-1 = 1%
        self.assertAlmostEqual(t["rs"], (111 / 106 - 1) * 100 - 1.0, places=6)
        self.assertAlmostEqual(t["sector_rs"], t["rs"], places=6)  # single-member sector
        self.assertAlmostEqual(t["adv_cr"], np.mean(close[-5:]) * 1e6 / 1e7, places=6)


class UniverseTests(unittest.TestCase):
    def test_top_by_avg_option_contracts(self):
        d = pd.bdate_range("2026-10-01", periods=3)
        rows = []
        for day in d:
            rows += [dict(date=day, instr="STO", symbol="BIG", volume=100),
                     dict(date=day, instr="STO", symbol="BIG", volume=50),
                     dict(date=day, instr="STO", symbol="MID", volume=120),
                     dict(date=day, instr="STO", symbol="LOW", volume=10),
                     dict(date=day, instr="STF", symbol="FUTONLY", volume=9999)]
        u = compute_universe(pd.DataFrame(rows), d[-1], size=2, lookback=20)
        self.assertEqual(u["symbols"], ["BIG", "MID"])  # BIG 150/day > MID 120/day
        self.assertEqual(u["avg_option_contracts"]["BIG"], 150.0)


if __name__ == "__main__":
    unittest.main()
