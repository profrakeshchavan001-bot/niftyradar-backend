import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backtest.engine import (breakdown, build_panel, equity_curve, fractions, pick_best,  # noqa: E402
                             prepare_candidates, select_trades, simulate_side, stats,
                             weight_grid, tune)
from backtest.run import run_pipeline  # noqa: E402
from common import load_config  # noqa: E402
from score import components  # noqa: E402

CFG = load_config()


def wide(rows):
    """rows: list of (open, high, low, close) per day for one symbol -> O,H,L,C frames."""
    d = pd.bdate_range("2026-01-05", periods=len(rows))
    a = np.array(rows, dtype=float)
    return [pd.DataFrame({"X": a[:, i]}, index=d) for i in range(4)], d


def atr_df(d, v):
    return pd.DataFrame({"X": np.full(len(d), float(v))}, index=d)


class ExecutionTests(unittest.TestCase):
    # signal day 0; entry = day-1 open = 100; ATR 2 -> risk = 1.5*2 = 3; stop 97 / target 106 (long)
    def run_long(self, days, side="long"):
        rows = [(100, 100, 100, 100)] + days
        (O, H, L, C), d = wide(rows)
        R, K = simulate_side(O, H, L, C, atr_df(d, 2), side)
        return R["X"].iloc[0], K["X"].iloc[0]

    def test_stop_hit(self):
        self.assertEqual(self.run_long([(100, 101, 96.5, 98)] + [(98, 99, 97.5, 98)] * 4), (-1.0, 1))

    def test_target_hit(self):
        self.assertEqual(self.run_long([(100, 107, 99, 105)] + [(105, 106, 104, 105)] * 4), (2.0, 1))

    def test_same_day_stop_and_target_is_stop(self):
        self.assertEqual(self.run_long([(100, 107, 96, 100)] + [(100, 101, 99, 100)] * 4), (-1.0, 1))

    def test_gap_through_stop_fills_at_open(self):
        # day 2 opens 95: (95-100)/3 = -1.6667
        r, k = self.run_long([(100, 101, 99, 100), (95, 96, 94, 95)] + [(95, 96, 94, 95)] * 3)
        self.assertAlmostEqual(r, -5 / 3)
        self.assertEqual(k, 2)

    def test_time_stop_exits_at_day5_close(self):
        r, k = self.run_long([(100, 101, 99, 100)] * 4 + [(100, 102, 99, 101.5)])
        self.assertAlmostEqual(r, 0.5)  # (101.5-100)/3
        self.assertEqual(k, 5)

    def test_short_mirror(self):
        # short entry 100, stop 103, target 94
        r, _ = self.run_long([(100, 101, 93, 95)] + [(95, 96, 94, 95)] * 4, side="short")
        self.assertEqual(r, 2.0)
        r, _ = self.run_long([(100, 103.5, 99, 102)] + [(102, 103, 101, 102)] * 4, side="short")
        self.assertEqual(r, -1.0)


class StatsTests(unittest.TestCase):
    def trades(self, gross):
        d = pd.bdate_range("2026-01-05", periods=len(gross))
        return pd.DataFrame({"date": d, "exit_date": d, "gross_R": gross,
                             "R": np.array(gross) - 0.1, "grade": "A", "symbol": "X",
                             "direction": "long", "setup": "trend"})

    def test_hand_computed(self):
        # gross [2,-1,2,-1] -> net [1.9,-1.1,1.9,-1.1]: win 50%, avg gross .5, expectancy .4,
        # PF 3.8/2.2 = 1.7273, cum 1.9,.8,2.7,1.6 -> max DD 1.1
        s = stats(self.trades([2, -1, 2, -1]))
        self.assertEqual(s["trades"], 4)
        self.assertAlmostEqual(s["win_pct"], 50.0)
        self.assertAlmostEqual(s["avg_R"], 0.5)
        self.assertAlmostEqual(s["expectancy"], 0.4)
        self.assertAlmostEqual(s["profit_factor"], 3.8 / 2.2)
        self.assertAlmostEqual(s["max_dd_R"], 1.1)

    def test_equity_compounds_one_percent_per_R(self):
        e = equity_curve(self.trades([2, -1]), "t")
        self.assertAlmostEqual(e["equity"].iloc[0], 100 * (1 + 0.01 * 1.9))
        self.assertAlmostEqual(e["equity"].iloc[1], 100 * (1 + 0.01 * 1.9) * (1 - 0.01 * 1.1))

    def test_breakdown_by_grade(self):
        t = self.trades([2, -1])
        t["grade"] = ["A", "B"]
        self.assertEqual(breakdown(t, "grade").loc["A", "trades"], 1)


class TuningTests(unittest.TestCase):
    def test_grid_normalised_unique(self):
        g = weight_grid()
        self.assertTrue(all(abs(sum(w.values()) - 100) < 1e-9 for w in g))
        self.assertEqual(len({tuple(round(v, 6) for v in w.values()) for w in g}), len(g))

    def test_pick_best_needs_min_trades(self):
        a = ({"x": 1}, dict(trades=300, expectancy=0.1))
        b = ({"x": 2}, dict(trades=150, expectancy=0.9))
        c = ({"x": 3}, dict(trades=250, expectancy=0.3))
        self.assertEqual(pick_best([a, b, c])[0], {"x": 3})
        self.assertIsNone(pick_best([b]))


class VectorisedScoreTests(unittest.TestCase):
    def test_fractions_match_scalar_components(self):
        rng = np.random.default_rng(0)
        n = 200
        df = pd.DataFrame({
            "quadrant": rng.choice(["long_buildup", "short_buildup", "short_covering",
                                    "long_unwinding", "neutral"], n),
            "deliv_ratio": rng.uniform(0.3, 3, n), "rs": rng.normal(0, 8, n),
            "sector_rs": rng.normal(0, 4, n), "unusual_oi": rng.uniform(0, 5, n)})
        df.loc[::17, "unusual_oi"] = np.nan
        fr = fractions(df, CFG)
        for i in range(0, n, 7):
            c = components(df.iloc[i], CFG)
            for k in c:
                self.assertAlmostEqual(fr[k].iloc[i], c[k], places=9)


# ---------------------------------------------------------------- synthetic market
def synthetic(n_days=130, n_sym=12, plant=True, seed=3):
    """Flat Nifty, quiet random-walk stocks. Planted: on event day t a stock shows a
    long-buildup signature (price +3%, OI +10%, delivery x2, option OI x4); on t+1 it opens
    at the previous close and closes +6% (hits the 2R target)."""
    rng = np.random.default_rng(seed)
    dates = pd.bdate_range("2026-01-05", periods=n_days)
    syms = [f"S{i:02d}" for i in range(n_sym)]
    cash, fo = [], []
    events = {s: set(range(40 + 3 * i, n_days - 8, 17)) for i, s in enumerate(syms)} if plant else {}
    for s in syms:
        c = 100.0
        for i, d in enumerate(dates):
            prev = c
            if i - 1 in events.get(s, ()):
                o, c = prev, prev * 1.06
                oi_chg = -1.0   # next-day follow-through: short covering, not a fresh signal
            elif i in events.get(s, ()):
                o, c = prev, prev * 1.03
                oi_chg = 100.0
            else:
                o = prev * (1 + rng.normal(0, 0.001))
                c = o * (1 + rng.normal(0, 0.002))
                oi_chg = rng.normal(0, 20)
            h, l = max(o, c) * 1.002, min(o, c) * 0.998
            if i - 1 in events.get(s, ()):
                l = o * 0.999
            ev = i in events.get(s, ())
            cash.append(dict(date=d, symbol=s, prev_close=prev, open=o, high=h, low=l, close=c,
                             volume=5e6, deliv_qty=1, deliv_pct=80.0 if ev else 40.0 + rng.normal(0, 1)))
            fo.append(dict(date=d, instr="STF", symbol=s, expiry="x", strike=0.0, opt_type="",
                           close=c, oi=1000.0, chg_oi=oi_chg, volume=1e5))
            fo.append(dict(date=d, instr="STO", symbol=s, expiry="x", strike=1.0, opt_type="CE",
                           close=1.0, oi=1000.0, chg_oi=(400.0 if ev else rng.choice([-100.0, 100.0])),
                           volume=1e6))
    idx = pd.DataFrame(dict(date=dates, index_name="Nifty 50", close=1000.0))
    return pd.DataFrame(cash), pd.DataFrame(fo), idx


class LookaheadAuditTests(unittest.TestCase):
    def setUp(self):
        self.cfg = {**CFG, "min_adv_cr": 0}
        self.cash, self.fo, self.idx = synthetic()
        self.sectors = {f"S{i:02d}": "Test" for i in range(12)}

    def result(self, shift):
        panel = build_panel(self.cash, self.fo, self.idx, self.cfg, self.sectors, feature_shift=shift)
        cand = prepare_candidates(panel, self.cfg)
        t = select_trades(cand, self.cfg, self.cfg["weights"], "2026-01-01", "2026-12-31")
        return stats(t[t["grade"] == "A"])  # the planted signature scores >= 70

    def test_shifting_features_one_day_collapses_edge(self):
        base, shifted = self.result(0), self.result(1)
        self.assertGreater(base["trades"], 10)
        self.assertGreater(base["avg_R"], 1.5)          # planted next-day jump is captured
        # stale features: signals fire a day late and miss the jump
        self.assertTrue(shifted["trades"] == 0 or shifted["avg_R"] < 0.3 * base["avg_R"])

    def test_no_planted_edge_means_no_edge(self):
        self.cash, self.fo, self.idx = synthetic(plant=False)
        r = self.result(0)
        self.assertTrue(r["trades"] == 0 or abs(r["avg_R"]) < 0.8)


class PipelineSmokeTests(unittest.TestCase):
    def test_writes_report_equity_and_tuned(self):
        cash, fo, idx = synthetic(n_days=200)
        cfg = {**CFG, "min_adv_cr": 0}
        with tempfile.TemporaryDirectory() as t:
            t = Path(t)
            r = run_pipeline(cash, fo, idx, cfg, {}, out_dir=t, tuned_path=t / "tuned.yaml",
                             train=("2026-01-01", "2026-07-31"), test_start="2026-08-01",
                             min_trades=5, grid=weight_grid((10, 30)))
            self.assertTrue(r["report"].exists())
            self.assertTrue((t / "equity.csv").exists())
            self.assertTrue((t / "tuned.yaml").exists())
            self.assertIn("train", r["stats"])
            self.assertIn("test", r["stats"])


if __name__ == "__main__":
    unittest.main()
