import unittest

import numpy as np
import pandas as pd

from helpers import mk
from scores import engine

CFG = engine.load_cfg()


class Helpers(unittest.TestCase):
    def test_sub(self):
        s = pd.DataFrame({"a": [-0.10, 0.0, 0.05, 0.5]})
        # (x - lo)/(hi - lo) clipped: lo=-0.10 hi=0.10 -> 0, 50, 75, 100
        for got, exp in zip(engine.sub(s, -0.10, 0.10)["a"].tolist(), [0, 50, 75, 100]):
            self.assertAlmostEqual(got, exp)
        # inverted scale: lo=2 hi=0 -> 2->0, 1->50, 0->100
        self.assertEqual(engine.sub(pd.DataFrame({"a": [2.0, 1.0, 0.0]}), 2, 0)["a"].tolist(), [0, 50, 100])

    def test_percentile_rank(self):
        df = pd.DataFrame({"A": [1.0], "B": [2.0], "C": [3.0]})
        # ranks 1,2,3 of 3 -> pct 1/3, 2/3, 1 -> 33.33, 66.67, 100
        self.assertEqual(engine.pr(df).iloc[0].round(2).tolist(), [33.33, 66.67, 100.0])

    def test_wmean_renormalises_over_missing(self):
        a = engine.Comp("a", None, pd.DataFrame({"x": [80.0, 60.0, np.nan]}), 1, str)
        b = engine.Comp("b", None, pd.DataFrame({"x": [40.0, np.nan, np.nan]}), 3, str)
        out = engine.wmean([a, b])["x"]
        # row0: (80*1 + 40*3)/4 = 50 ; row1: only a -> 60 ; row2: nothing -> NaN
        self.assertEqual(out.iloc[0], 50.0)
        self.assertEqual(out.iloc[1], 60.0)
        self.assertTrue(np.isnan(out.iloc[2]))


class TrendMomentum(unittest.TestCase):
    def test_trend_hand_computed(self):
        # 250 days rising 1/day from 100 -> close 349. ma20 = mean(330..349)=339.5, ma50 = mean(300..349)=324.5,
        # ma200 = mean(150..349)=249.5. dist20 = 349/339.5-1 = 2.798% -> sub(-5,5)=77.99;
        # dist50 = 349/324.5-1 = 7.550% -> sub(-10,10)=87.75; dist200 = 349/249.5-1 = 39.88% -> 100;
        # alignment 20>50>200 -> 100; ma50 10 days ago = mean(290..339)=314.5 -> slope 3.18% -> 100.
        # weights 1,1.5,1.5,1,1 -> (77.98 + 87.75*1.5 + 100*1.5 + 100 + 100) / 6 = 559.6 / 6 = 93.27
        P = mk({"AAA": np.arange(100.0, 350.0)})
        R = engine.compute(P, CFG)
        d = P.dates[-1]
        t = R.scores["trend"].at[d, "AAA"]
        self.assertAlmostEqual(t, 93.3, delta=0.1)

    def test_downtrend_scores_zero(self):
        P = mk({"AAA": np.arange(350.0, 100.0, -1)})
        t = engine.compute(P, CFG).scores["trend"].at[P.dates[-1], "AAA"]
        self.assertEqual(t, 0.0)

    def test_momentum_orders_by_return(self):
        n = 300
        P = mk({"UP": np.linspace(100, 200, n), "FLAT": np.full(n, 100.0), "DN": np.linspace(100, 50, n)})
        R = engine.compute(P, CFG)
        m = R.scores["momentum"].loc[P.dates[-1]]
        self.assertGreater(m["UP"], m["FLAT"])
        self.assertGreater(m["FLAT"], m["DN"])

    def test_relative_strength_vs_nifty(self):
        n = 300
        nifty = np.linspace(20000, 22000, n)            # +10% over the window
        P = mk({"A": np.linspace(100, 150, n), "B": np.linspace(100, 105, n)}, nifty=nifty)
        rs = engine.compute(P, CFG).scores["relative_strength"].loc[P.dates[-1]]
        self.assertGreater(rs["A"], rs["B"])
        raw = engine.compute(P, CFG).comps["relative_strength"][0].raw.at[P.dates[-1], "A"]
        # 63-day return of A minus 63-day return of Nifty, computed by hand from the linear paths
        a = 150 / (100 + 50 * (n - 1 - 63) / (n - 1)) - 1
        nf = 22000 / (20000 + 2000 * (n - 1 - 63) / (n - 1)) - 1
        self.assertAlmostEqual(raw, a - nf, places=9)


class VolumeVolatility(unittest.TestCase):
    def test_volume_ratio_hand(self):
        n = 120
        v = {"A": np.r_[np.full(n - 5, 1e6), np.full(5, 2e6)], "B": np.full(n, 1e6)}
        P = mk({"A": np.full(n, 100.0), "B": np.full(n, 100.0)}, volume=v)
        R = engine.compute(P, CFG)
        vr = R.extra["ind"]["vr"]
        # A: 5-day mean 2e6 / prior-20-day mean 1e6 = 2.0 ; B = 1.0
        self.assertEqual(vr.at[P.dates[-1], "A"], 2.0)
        self.assertEqual(vr.at[P.dates[-1], "B"], 1.0)
        c = R.comps["volume_delivery"][0].score
        # sub(2.0, 0.7, 2.0) = 100 ; sub(1.0, 0.7, 2.0) = 23.08
        self.assertEqual(c.at[P.dates[-1], "A"], 100.0)
        self.assertAlmostEqual(c.at[P.dates[-1], "B"], 23.0769, places=3)

    def test_calmer_stock_scores_higher_stability(self):
        rng = np.random.default_rng(1)
        n = 200
        calm = 100 * np.exp(np.cumsum(rng.normal(0, 0.003, n)))
        wild = 100 * np.exp(np.cumsum(rng.normal(0, 0.03, n)))
        P = mk({"CALM": calm, "WILD": wild}, high_pad=0.005)
        v = engine.compute(P, CFG).scores["volatility"].loc[P.dates[-1]]
        self.assertGreater(v["CALM"], v["WILD"])


class Fundamentals(unittest.TestCase):
    def test_quality_valuation_hand(self):
        n = 120
        fund = pd.DataFrame({"symbol": ["A", "B"], "roe": [25.0, 5.0], "debt_equity": [0.0, 2.0],
                             "profit_margin": [20.0, 0.0], "pe": [10.0, 60.0], "pb": [1.0, 8.0],
                             "promoter_pct": [65.0, 20.0], "promoter_pledge_pct": [0.0, 30.0]})
        P = mk({"A": np.full(n, 100.0), "B": np.full(n, 100.0)}, fund=fund)
        R = engine.compute(P, CFG)
        d = P.dates[-1]
        # A is at the top of every quality scale, B at the bottom -> 100 and 0
        self.assertEqual(R.scores["quality"].at[d, "A"], 100.0)
        self.assertEqual(R.scores["quality"].at[d, "B"], 0.0)
        # pe_rel: median PE = 35 -> A 10/35=0.286 -> sub(1.5,0.6)=100; B 60/35=1.714 -> 0. pe level 10->100, 60->0, pb 1->100, 8->0
        self.assertEqual(R.scores["valuation"].at[d, "A"], 100.0)
        self.assertEqual(R.scores["valuation"].at[d, "B"], 0.0)

    def test_no_fundamentals_no_quality_score_and_weights_renormalise(self):
        n = 120
        P = mk({"A": np.linspace(100, 130, n)})
        R = engine.compute(P, CFG)
        self.assertNotIn("quality", R.scores)
        d = P.dates[-1]
        W = CFG["weights"]
        have = ["trend", "momentum", "relative_strength", "volume_delivery", "volatility"]
        parts = {k: R.scores[k].at[d, "A"] for k in have if not np.isnan(R.scores[k].at[d, "A"])}
        exp = sum(parts[k] * W[k] for k in parts) / sum(W[k] for k in parts)
        self.assertAlmostEqual(R.scores["overall"].at[d, "A"], exp, delta=0.06)

    def test_fundamentals_missing_symbol_row_is_nan_not_zero(self):
        n = 120
        fund = pd.DataFrame({"symbol": ["A"], "roe": [25.0]})
        P = mk({"A": np.full(n, 100.0), "B": np.full(n, 100.0)}, fund=fund)
        R = engine.compute(P, CFG)
        self.assertTrue(np.isnan(R.scores["quality"].at[P.dates[-1], "B"]))


class StatusEdgeCases(unittest.TestCase):
    def test_new_listing_suspended_illiquid(self):
        n = 150
        d = pd.bdate_range(end="2026-10-28", periods=n)
        closes = {"OLD": np.linspace(100, 120, n), "NEW": np.r_[np.full(n - 30, np.nan), np.linspace(50, 55, 30)],
                  "SUSP": np.r_[np.linspace(100, 110, n - 3), np.full(3, np.nan)],
                  "ILLQ": np.linspace(100, 101, n)}
        vol = {"OLD": np.full(n, 1e6), "NEW": np.full(n, 1e6), "SUSP": np.full(n, 1e6), "ILLQ": np.r_[np.full(n - 4, 1e6), np.zeros(4)]}
        P = mk({k: np.nan_to_num(v, nan=1.0) for k, v in closes.items()}, volume=vol)
        # blank the NaN stretches the way a real feed would: no row at all
        cash = P.close.copy()
        for k in ("NEW", "SUSP"):
            cash[k] = pd.Series(closes[k], index=P.dates)
        P.close = cash
        for a in ("open", "high", "low", "volume", "deliv"):
            fr = getattr(P, a).copy()
            for k in ("NEW", "SUSP"):
                fr[k] = fr[k].where(cash[k].notna())
            setattr(P, a, fr)
        R = engine.compute(P, CFG)
        st = R.status.iloc[-1]
        self.assertEqual(st["OLD"], "ok")
        self.assertEqual(st["NEW"], "new_listing")
        self.assertEqual(st["SUSP"], "suspended")
        self.assertEqual(st["ILLQ"], "illiquid")
        for k in ("NEW", "SUSP", "ILLQ"):
            self.assertTrue(np.isnan(R.scores["overall"].iloc[-1][k]), k)
        self.assertFalse(np.isnan(R.scores["overall"].iloc[-1]["OLD"]))

    def test_short_history_has_no_200d_but_still_scores(self):
        P = mk({"A": np.linspace(100, 130, 80)})
        R = engine.compute(P, CFG)
        self.assertFalse(np.isnan(R.scores["trend"].iloc[-1]["A"]))   # 200-day component drops out, rest renormalises


if __name__ == "__main__":
    unittest.main()
