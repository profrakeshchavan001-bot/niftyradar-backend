import unittest

import numpy as np
import pandas as pd

from helpers import mk
from scores import engine, validate

CFG = engine.load_cfg()


class Hand(unittest.TestCase):
    def test_spearman_hand(self):
        a = pd.Series(np.arange(10.0))
        self.assertAlmostEqual(validate.spearman(a, a * 2 + 1), 1.0)
        self.assertAlmostEqual(validate.spearman(a, -a), -1.0)
        self.assertTrue(np.isnan(validate.spearman(a[:5], a[:5])))            # fewer than 8 pairs

    def test_forward_has_one_day_delay(self):
        c = pd.DataFrame({"A": [100.0, 101, 103, 106, 110, 115]})
        f = validate.forward(c, 2)
        # signal day 0 -> entry close day 1 (101), exit close day 3 (106): 106/101 - 1
        self.assertAlmostEqual(f.at[0, "A"], 106 / 101 - 1)
        self.assertTrue(np.isnan(f.at[3, "A"]))                              # exit would be beyond the data

    def test_cost_is_doubled_round_trip(self):
        # base 0.10% per side, doubled 0.20% per side, two sides = 0.40% round trip
        P = mk({f"S{i}": np.linspace(100, 110, 400) for i in range(25)})
        out = validate.run(P, engine.compute(P, CFG), CFG)
        self.assertEqual(out["round_trip_cost_pct"], 0.4)

    def test_verdict_words(self):
        none = {"periods": 50, "ic_overall_mean": 0.01, "ic_overall_t": 0.5, "top_quintile_minus_all_net_pct": -0.2}
        self.assertIn("No edge found", validate.verdict(none))
        pos = {"periods": 50, "ic_overall_mean": 0.05, "ic_overall_t": 3.0, "top_quintile_minus_all_net_pct": 0.3}
        self.assertIn("lead to re-check", validate.verdict(pos))
        self.assertIn("Not enough", validate.verdict({"periods": 0}))


class HarnessIsHonest(unittest.TestCase):
    def setUp(self):
        rng = np.random.default_rng(11)
        n = 1500
        c = {f"S{i}": 100 * np.exp(np.cumsum(rng.normal(0.0002, 0.015, n))) for i in range(60)}
        self.P = mk(c, nifty=20000 * np.exp(np.cumsum(rng.normal(0.0002, 0.008, n))), sectors={s: f"X{i % 6}" for i, s in enumerate(c)})
        self.R = engine.compute(self.P, CFG)

    def test_random_walk_world_shows_no_link(self):
        o = validate.run(self.P, self.R, CFG)
        self.assertLess(abs(o["all"]["ic_overall_t"]), 3.0)
        self.assertLess(abs(o["all"]["ic_overall_mean"]), 0.05)

    def test_planted_leak_is_caught(self):
        # control: a "score" built from the very returns it is judged on must give a perfect rank link
        self.R.scores["overall"] = validate.forward(self.P.close, CFG["validate"]["horizon"]).rank(axis=1, pct=True) * 100
        o = validate.run(self.P, self.R, CFG)
        self.assertAlmostEqual(o["all"]["ic_overall_mean"], 1.0, places=6)

    def test_fixture_verdict_never_claims_edge(self):
        self.P.source = "fixtures"
        self.assertIn("meaningless as evidence", validate.run(self.P, self.R, CFG)["verdict"])

    def test_caveats_present(self):
        o = validate.run(self.P, self.R, CFG)
        self.assertTrue(any("survivorship" in c.lower() for c in o["caveats"]))


if __name__ == "__main__":
    unittest.main()


class Drawdown(unittest.TestCase):
    def test_max_drawdown_hand(self):
        # equity 1.10 -> 0.88 -> 0.968: peak 1.10, trough 0.88 => 0.88/1.10 - 1 = -20%
        P = mk({f"S{i}": np.linspace(100, 110, 400) for i in range(25)})
        out = validate.run(P, engine.compute(P, CFG), CFG)
        self.assertIn("top_quintile_max_drawdown_pct", out["all"])
