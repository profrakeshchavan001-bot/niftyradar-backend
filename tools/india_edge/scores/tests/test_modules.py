import json
import time
import unittest

import numpy as np
import pandas as pd

from helpers import mk, fixture_panels
from scores import build, data, engine, feargreed, health, rotation

CFG = engine.load_cfg()


class FearGreed(unittest.TestCase):
    def test_trailing_percentile_hand(self):
        s = pd.Series([1.0, 2, 3, 4, 5])
        out = feargreed._trail_pct(s, window=5, min_window=5)
        # today=5 among [1,2,3,4,5]: 4 below + 0.5*1 equal = 4.5 of 5 -> 90
        self.assertEqual(out.iloc[-1], 90.0)
        self.assertTrue(out.iloc[:4].isna().all())            # not enough history yet
        out2 = feargreed._trail_pct(pd.Series([3.0, 3, 3, 3, 3]), 5, 5)
        self.assertEqual(out2.iloc[-1], 50.0)                  # all equal -> middle

    def test_labels(self):
        b = [25, 45, 55, 75]
        self.assertEqual([feargreed.label(x, b) for x in (0, 24, 25, 44, 45, 54, 55, 74, 75, 100)],
                         ["Extreme fear", "Extreme fear", "Fear", "Fear", "Neutral", "Neutral", "Greed", "Greed",
                          "Extreme greed", "Extreme greed"])

    def test_pcr_hand(self):
        d = pd.bdate_range(end="2026-10-28", periods=3)
        fo = pd.DataFrame({"date": list(d) * 2, "instr": "STO", "opt_type": ["PE"] * 3 + ["CE"] * 3,
                           "oi": [300.0, 150, 100, 200, 200, 400]})
        p = data._pcr(fo, d)
        # PE/CE per day: 300/200 = 1.5 ; 150/200 = 0.75 ; 100/400 = 0.25
        self.assertEqual(p.tolist(), [1.5, 0.75, 0.25])
        self.assertIsNone(data._pcr(fo[fo.opt_type == "CE"], d))   # no puts -> no PCR, not a fake number
        self.assertIsNone(data._pcr(None, d))

    def test_late_rally_scores_greedier_than_late_selloff(self):
        # The meter places today against the market's OWN last year, so build a calm year then a
        # sharp final stretch: 80 days up vs 80 days down.
        n, tail = 400, 80
        rng = np.random.default_rng(3)

        def world(sign):
            noise = rng.normal(0, 0.004, (n, 12))
            noise[-tail:] += sign * 0.006
            return {f"S{i}": 100 * np.exp(np.cumsum(noise[:, i])) for i in range(12)}, 20000 * np.exp(np.cumsum(noise.mean(axis=1)))

        (cu, nu), (cd, nd) = world(+1), world(-1)
        Pu, Pd = mk(cu, nifty=nu), mk(cd, nifty=nd)
        mu = feargreed.compute(Pu, engine.compute(Pu, CFG), CFG)["meter"].iloc[-1]
        md = feargreed.compute(Pd, engine.compute(Pd, CFG), CFG)["meter"].iloc[-1]
        self.assertGreater(mu, 65)
        self.assertLess(md, 35)

    def test_uses_vix_when_loaded_else_labels_proxy(self):
        n = 300
        base = {"A": np.linspace(100, 120, n), "B": np.linspace(100, 90, n)}
        P1 = mk(base)
        k1 = list(feargreed.readings(P1, engine.compute(P1, CFG)))
        self.assertTrue(any("India VIX not loaded" in k for k in k1))
        P2 = mk(base, vix=np.linspace(20, 12, n))
        k2 = list(feargreed.readings(P2, engine.compute(P2, CFG)))
        self.assertIn("India VIX", k2)


class Rotation(unittest.TestCase):
    def test_stage_mapping(self):
        self.assertEqual(rotation.stage(1, 1), "Leading")
        self.assertEqual(rotation.stage(1, -1), "Weakening")
        self.assertEqual(rotation.stage(-1, 1), "Improving")
        self.assertEqual(rotation.stage(-1, -1), "Lagging")
        self.assertEqual(rotation.stage(0, 0), "Leading")      # zero counts as non-negative

    def test_leader_sector_and_min_stocks(self):
        n = 200
        c = {}
        sec = {}
        for i in range(3):
            t = np.linspace(0, 1, n) ** 2                   # accelerating, so strength AND its change are positive
            c[f"H{i}"] = 100 + 60 * t; sec[f"H{i}"] = "HOT"
            c[f"C{i}"] = 100 - 25 * t; sec[f"C{i}"] = "COLD"
        c["LONE"] = np.linspace(100, 300, n); sec["LONE"] = "TINY"
        P = mk(c, sectors=sec, nifty=np.linspace(20000, 21000, n))
        R = engine.compute(P, CFG)
        b = {r["sector"]: r for r in rotation.board(P, R, P.dates[-1], CFG)}
        self.assertEqual(b["HOT"]["stage"], "Leading")
        self.assertGreater(b["HOT"]["strength"], 0)
        self.assertLess(b["COLD"]["strength"], 0)
        self.assertNotIn("TINY", b)                           # one stock is not a sector

    def test_equal_weight_sector_return_hand(self):
        n = 120
        P = mk({"A": np.r_[np.full(n - 1, 100.0), 110.0], "B": np.r_[np.full(n - 1, 100.0), 100.0],
                "C": np.full(n, 100.0)}, sectors={"A": "X", "B": "X", "C": "X"})
        R = engine.compute(P, CFG)
        r1 = P.close.pct_change(1, fill_method=None).where(R.status == "ok")
        # last-day returns A +10%, B 0, C 0 -> equal-weight sector return = 10/3 = 3.333%
        self.assertAlmostEqual(r1.iloc[-1].mean(), 0.10 / 3, places=12)


class Health(unittest.TestCase):
    def test_flags(self):
        P = mk({"A": np.linspace(100, 130, 120), "B": np.linspace(100, 130, 120)})
        R = engine.compute(P, CFG)
        h = health.check(P, R, P.dates[-1])
        self.assertEqual(h["checks"]["stocks_total"], 2)
        self.assertEqual(h["grade"], "bad")                   # fewer than 5 scored stocks
        self.assertTrue(any("fundamentals" in n for n in h["notes"]))

    def test_price_jump_counted(self):
        a = np.r_[np.full(100, 100.0), np.full(20, 40.0)]     # -60% one-day drop = possible unadjusted split
        P = mk({"A": a, "B": np.full(120, 100.0)})
        h = health.check(P, engine.compute(P, CFG), P.dates[-1])
        self.assertEqual(h["checks"]["price_jumps_over_40pct_1y"], 1)


class PublicSafety(unittest.TestCase):
    def test_no_weights_thresholds_or_formulas_in_public_json(self):
        out, _ = build.build(fixture_panels())
        blob = json.dumps(out)
        for bad in ("weight", "formula", "rolling", "percentile", "band_strong", "min_history", "0.075", "wmean"):
            self.assertNotIn(bad, blob.lower(), bad)
        card = next(c for c in out["scores"]["stocks"] if c["status"] == "ok")
        self.assertEqual(set(card["scores"]["trend"]), {"score", "band", "says", "components"})
        self.assertEqual(set(card["scores"]["trend"]["components"][0]), {"name", "reading", "score"})
        self.assertEqual(set(card["scores"]["overall"]), {"score", "band", "says", "coverage"})

    def test_strict_json(self):
        out, _ = build.build(fixture_panels())
        json.dumps(out, allow_nan=False)                      # raises on NaN/inf


class Speed(unittest.TestCase):
    def test_200_stocks_full_history(self):
        rng = np.random.default_rng(5)
        n = 3000
        closes = {f"S{i:03d}": 100 * np.exp(np.cumsum(rng.normal(0.0003, 0.015, n))) for i in range(200)}
        sec = {s: f"SEC{i % 12}" for i, s in enumerate(closes)}
        P = mk(closes, sectors=sec, nifty=20000 * np.exp(np.cumsum(rng.normal(0.0003, 0.008, n))))
        t = time.time()
        out, _ = build.build(P)
        dt = time.time() - t
        print(f"\n200 stocks x {n} days full build: {dt:.1f}s")
        self.assertLess(dt, 30.0)


if __name__ == "__main__":
    unittest.main()
