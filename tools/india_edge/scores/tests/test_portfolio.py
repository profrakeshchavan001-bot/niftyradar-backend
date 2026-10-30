import copy
import unittest

import numpy as np
import pandas as pd

from helpers import mk
from scores import costs, engine, portfolio, report, screeners, stats, validate

CFG = engine.load_cfg()
C = CFG["costs"]


def cfg_with(**over):
    c = copy.deepcopy(CFG)
    for k, v in over.items():
        sec, key = k.split("__")
        c[sec][key] = v
    return c


class Costs(unittest.TestCase):
    def test_statutory_buy_sell_hand(self):
        # Rs 1,00,000 buy: brokerage 30 + exchange 2.97 + SEBI 0.10 = 33.07; GST 18% of that = 5.9526;
        # STT 100; stamp 15  ->  30 + 2.97 + 0.10 + 5.9526 + 100 + 15 = 154.0226  -> 0.1540226 %
        self.assertAlmostEqual(costs.statutory_fraction("buy", 1e5, C) * 1e5, 154.0226, places=4)
        # sell: same without stamp (139.0226) plus depository charge 15.93 = 154.9526
        self.assertAlmostEqual(costs.statutory_fraction("sell", 1e5, C) * 1e5, 154.9526, places=4)

    def test_slippage_is_fraction_of_atr_and_costs_are_doubled(self):
        # ATR 2% of price, slippage 5% of ATR = 0.1% per side = Rs 100 on 1,00,000
        one = costs.side_fraction("buy", 1e5, 0.02, C, multiplier=1.0) * 1e5
        self.assertAlmostEqual(one, 154.0226 + 100, places=4)
        two = costs.side_fraction("buy", 1e5, 0.02, C) * 1e5                      # default multiplier 2
        self.assertAlmostEqual(two, 2 * (154.0226 + 100), places=4)
        self.assertEqual(C["multiplier"], 2.0)

    def test_dp_charge_flat_so_small_trades_cost_more(self):
        self.assertGreater(costs.statutory_fraction("sell", 10_000, C), costs.statutory_fraction("sell", 1_000_000, C))

    def test_bad_side_and_nan_atr(self):
        with self.assertRaises(ValueError):
            costs.statutory_fraction("hold", 1e5, C)
        self.assertAlmostEqual(costs.side_fraction("buy", 1e5, float("nan"), C, multiplier=1.0) * 1e5, 154.0226, places=4)


class Stats(unittest.TestCase):
    def test_cagr_dd_sharpe_hand(self):
        # 2 periods of +10% with 2 periods a year -> 1.21 over exactly one year -> 21 %
        self.assertAlmostEqual(stats.cagr(np.array([0.1, 0.1]), 126), 0.21)
        # equity 1.10 -> 0.88 -> 0.968: peak 1.10, trough 0.88 -> 0.88/1.10 - 1 = -20 %
        self.assertAlmostEqual(stats.max_drawdown(np.array([0.1, -0.2, 0.1])), -0.2)
        # mean 0.02, std(ddof=1) of [0.01,0.03,0.02] = 0.01 -> Sharpe 2 * sqrt(252/10)
        self.assertAlmostEqual(stats.sharpe(np.array([0.01, 0.03, 0.02]), 10), 2 * np.sqrt(25.2))
        self.assertIsNone(stats.sharpe(np.array([0.01, 0.01, 0.01]), 10))

    def test_holm_and_bh_hand(self):
        p = [0.01, 0.04, 0.03]
        # Holm: sorted .01 <= .05/3=.0167 reject; .03 > .05/2=.025 -> stop. Only the first.
        self.assertEqual(stats.holm(p, 0.05), [True, False, False])
        # BH: thresholds .05*k/3 = .0167,.0333,.05 ; .01<=,.03<=,.04<= -> all three rejected
        self.assertEqual(stats.benjamini_hochberg(p, 0.05), [True, True, True])
        self.assertEqual(stats.holm([None, 0.001], 0.05), [False, True])

    def test_multiple_testing_reports_chance(self):
        m = stats.multiple_testing({"a": 0.01, "b": 0.04, "c": 0.5, "d": 0.2}, 0.05)
        self.assertEqual((m["tests"], m["expected_false_positives"]), (4, 0.2))
        self.assertEqual(m["pass_raw"], ["a", "b"])
        self.assertEqual(m["pass_holm"], ["a"])                       # .01 <= .05/4 = .0125 ; .04 > .05/3

    def test_bootstrap_ci_zero_mean_includes_zero_and_strong_mean_rejects(self):
        rng = np.random.default_rng(1)
        noise = rng.normal(0, 0.02, 120)
        b0 = stats.bootstrap(noise - noise.mean(), 1000, 3, 7, 10)
        self.assertLess(b0["ci"][0], 0)
        self.assertGreater(b0["ci"][1], 0)
        self.assertGreater(b0["p_mean_gt0"], 0.3)
        b1 = stats.bootstrap(noise + 0.03, 1000, 3, 7, 10)
        self.assertLess(b1["p_mean_gt0"], 0.01)
        self.assertGreater(b1["ci"][0], 0)
        self.assertEqual(stats.bootstrap(noise + 0.03, 1000, 3, 7, 10), b1)             # seeded -> reproducible
        self.assertIsNone(stats.bootstrap(noise[:5], 100, 3, 7, 10)["mean"])

    def test_mc_drawdown_constant_gain_has_no_drawdown_and_noisy_has(self):
        self.assertEqual(stats.mc_drawdown(np.full(30, 0.01), 200, 3, 1)["median_pct"], 0.0)
        rng = np.random.default_rng(3)
        d = stats.mc_drawdown(rng.normal(0, 0.03, 60), 500, 3, 1)
        self.assertLess(d["median_pct"], 0)
        self.assertLessEqual(d["p95_worst_pct"], d["median_pct"])


def flat_world(n=80, extra=None, volume=1e6, **kw):
    """10 flat stocks + A rising 1% a day; zero range so ATR comes only from closes."""
    c = {s: np.full(n, 100.0) for s in "BCDEFGHIJ"}
    c["A"] = 100 * 1.01 ** np.arange(n)
    if extra:
        c.update(extra)
    return mk(c, volume=volume, **kw)


class Simulate(unittest.TestCase):
    def setUp(self):
        self.cfg = cfg_with(portfolio__n_positions=1, portfolio__hold_days=5, costs__slippage_atr_frac=0.0)
        self.cfg["min_history"] = 1                                 # tiny hand-built worlds: let every stock be scored

    def sim(self, P, mult=1.0, rank=None, **kw):
        R = engine.compute(P, self.cfg)
        cand = pd.DataFrame(True, index=P.dates, columns=P.symbols)
        rank = rank if rank is not None else pd.DataFrame({s: (1.0 if s == "A" else 0.0) for s in P.symbols}, index=P.dates)
        return portfolio.simulate(P, R, cand, rank, self.cfg, cost_mult=mult, **kw), R

    def test_single_position_hand_computed(self):
        P = flat_world()
        s, _ = self.sim(P)
        # first rebalance r=1: signal day 0. Buy A at close[1] = 101. Buy fraction (slippage 0, multiplier 1):
        #   (0.03 + 0.00297 + 0.0001) * 1.18 + 0.10 = 0.139023 %, plus stamp 0.015 %  ->  f = 0.00154023
        f = ((0.03 + 0.00297 + 0.0001) * 1.18 + 0.10 + 0.015) / 100
        price = 101.0
        shares = int(np.floor(1_000_000 / (price * (1 + f))))
        self.assertEqual(shares, 9_885)                           # 1,000,000 / (101 x 1.00154023) = 9885.5 -> 9885 whole shares
        cash = 1_000_000 - shares * price - shares * price * f
        r1 = 6                                                    # next rebalance 5 sessions later; A has grown 1.01^6 from 100
        self.assertAlmostEqual(s["equity"][1], cash + shares * 100 * 1.01 ** r1, places=4)
        self.assertEqual(s["positions"][0], 1)

    def test_no_costs_continuing_position_earns_the_price_return(self):
        P = flat_world()
        s, _ = self.sim(P, mult=0.0)
        # 1,000,000 / 101 = 9900.99 -> 9900 whole shares = Rs 999,900 invested, Rs 100 left as cash.
        # Held every period (A stays top ranked, no trade, no cost): each 5-session period earns (1.01^5 - 1) on 999,900 / ~1,000,000.
        self.assertAlmostEqual(s["ret"][3], (1.01 ** 5 - 1) * 0.9999, delta=0.0002)
        self.assertEqual(s["costs_paid"], 0.0)

    def test_costs_double_when_multiplier_doubles(self):
        P = flat_world(extra={"X": 100 * (1 + 0.02 * np.sin(np.arange(80)))})
        rng = np.random.default_rng(2)
        rank = pd.DataFrame(rng.random((80, len(P.symbols))), index=P.dates, columns=P.symbols)   # churns, so costs are real
        c1 = self.sim(P, 1.0, rank)[0]["costs_paid"]
        c2 = self.sim(P, 2.0, rank)[0]["costs_paid"]
        self.assertGreater(c1, 0)
        self.assertAlmostEqual(c2 / c1, 2.0, delta=0.06)

    def test_capacity_caps_position_to_share_of_traded_value(self):
        P = flat_world(volume=10_000)
        s, _ = self.sim(P, 0.0, start=12)                          # r=12, signal day 11 (20-day traded value needs 10+ days)
        t = 11
        adv = np.mean([100 * 1.01 ** i * 10_000 for i in range(t + 1)])      # mean of price x volume over days 0..11
        cap = 0.05 * adv                                           # Rs the position may hold (5 % of average daily value)
        self.assertLess(cap, 1_000_000 / 10)                       # the cap, not the slot, binds
        shares = int(np.floor(cap / (100 * 1.01 ** 12)))           # bought at close[12], no cost (multiplier 0)
        expected_E1 = 1_000_000 - shares * 100 * 1.01 ** 12 + shares * 100 * 1.01 ** 17
        self.assertAlmostEqual(s["equity"][1], expected_E1, places=3)
        self.assertAlmostEqual(s["capacity_inr"][0], cap, places=3)          # n_pos = 1

    def test_delisted_holding_is_sold_at_last_price_not_dropped(self):
        n = 80
        a = np.r_[100 * 1.01 ** np.arange(30), np.full(n - 30, np.nan)]
        P = flat_world(extra={"A": a})
        s, _ = self.sim(P, 0.0)
        self.assertTrue(np.isfinite(s["equity"]).all())
        last = 100 * 1.01 ** 29
        # bought ~Rs 1m of A at about close 101..; its value is frozen at the last traded price, so equity stays near 1m x (last / entry)
        self.assertGreater(s["equity"][-1], 1_000_000 * last / (100 * 1.01 ** 6) * 0.98)
        self.assertLess(s["equity"][-1], 1_000_000 * last / 101 * 1.02)

    def test_unfilled_slots_stay_cash(self):
        cfg = cfg_with(portfolio__n_positions=10, portfolio__hold_days=5, costs__slippage_atr_frac=0.0)
        cfg["min_history"] = 1
        P = flat_world()
        R = engine.compute(P, cfg)
        cand = pd.DataFrame(False, index=P.dates, columns=P.symbols)
        cand["A"] = True                                           # only one candidate for ten slots
        rank = pd.DataFrame(1.0, index=P.dates, columns=P.symbols)
        s = portfolio.simulate(P, R, cand, rank, cfg, cost_mult=0.0)
        self.assertEqual(s["positions"].max(), 1)
        # one tenth of equity invested (990 shares x 101 = 99,990 of 1,000,000) -> a 5-session +5.1% move adds ~0.51% to equity, not 5.1%
        self.assertAlmostEqual(s["ret"][0], 0.099990 * (1.01 ** 5 - 1), delta=0.00005)

    def test_cut_the_future_equity_prefix_is_identical(self):
        rng = np.random.default_rng(8)
        n = 300
        P = mk({f"S{i}": 100 * np.exp(np.cumsum(rng.normal(0.0004, 0.013, n))) for i in range(30)},
               nifty=20000 * np.exp(np.cumsum(rng.normal(0.0003, 0.007, n))), sectors={f"S{i}": f"X{i % 4}" for i in range(30)})
        cfg = cfg_with(portfolio__n_positions=5)
        R = engine.compute(P, cfg)
        m, o, _ = screeners.masks(P, R, cfg["screeners"])
        full = portfolio.simulate(P, R, m["strong_trend"], o["strong_trend"], cfg)
        cut = 200
        Q = copy.copy(P)
        keep = P.dates < P.dates[cut]
        for a in ("close", "open", "high", "low", "volume", "deliv"):
            setattr(Q, a, getattr(P, a)[keep])
        Q.nifty, Q.dates = P.nifty[keep], P.dates[keep]
        Rq = engine.compute(Q, cfg)
        mq, oq, _ = screeners.masks(Q, Rq, cfg["screeners"])
        part = portfolio.simulate(Q, Rq, mq["strong_trend"], oq["strong_trend"], cfg)
        k = int((part["dates"] < P.dates[cut - 12]).sum())         # periods that ended well before the cut
        self.assertGreater(k, 5)
        np.testing.assert_allclose(full["equity"][:k], part["equity"][:k])


class Controls(unittest.TestCase):
    """Random-walk and leaked-score controls stay in the suite."""

    @classmethod
    def setUpClass(cls):
        rng = np.random.default_rng(11)
        n = 1500
        cls.P = mk({f"S{i}": 100 * np.exp(np.cumsum(rng.normal(0.0002, 0.015, n))) for i in range(50)},
                   nifty=20000 * np.exp(np.cumsum(rng.normal(0.0002, 0.008, n))), sectors={f"S{i}": f"X{i % 6}" for i in range(50)})
        cls.cfg = cfg_with(stats__bootstrap_reps=400, stats__random_null_runs=12, stats__mc_paths=300)
        cls.R = engine.compute(cls.P, cls.cfg)

    def test_random_walk_world_gives_no_edge(self):
        out = report.run(self.P, self.R, self.cfg)
        mt = out["multiple_testing_test_period"]
        self.assertEqual(mt["pass_holm"], [])
        self.assertTrue(out["verdict"].startswith("No edge found"))
        for r in out["strategies"].values():
            self.assertLess(r["test"]["cagr_pct"] or 0, 25)

    def test_leaked_score_is_caught_by_the_portfolio_harness(self):
        leak = validate.forward(self.P.close, self.cfg["portfolio"]["hold_days"])      # label used as the "score"
        # the harness enters at t+1 and exits t+1+h, exactly the label's window: a perfect forecast
        ev = report.evaluate(self.P, self.R, "leak", self.R.status == "ok", leak, self.cfg)
        self.assertGreater(ev["all"]["cagr_pct"], 100)
        self.assertLess(ev["all"]["p_excess_gt0"], 0.01)               # 400 bootstrap reps -> smallest possible p is 1/401

    def test_markdown_has_one_table_per_screener_and_fixture_banner(self):
        out = report.run(self.P, self.R, self.cfg)
        md = report.to_markdown(out)
        self.assertEqual(md.count("\n## ") - 3, len(out["strategies"]))               # minus multiple-testing, summary and caveats
        self.assertNotIn("FIXTURE DATA", md)
        self.P.source = "fixtures"
        try:
            out2 = report.run(self.P, self.R, self.cfg)
            self.assertIn("FIXTURE DATA", report.to_markdown(out2))
            self.assertIn("meaningless as evidence", out2["verdict"])
        finally:
            self.P.source = "unknown"

    def test_deterministic(self):
        a = report.run(self.P, self.R, self.cfg)
        b = report.run(self.P, self.R, self.cfg)
        self.assertEqual(a, b)


if __name__ == "__main__":
    unittest.main()
